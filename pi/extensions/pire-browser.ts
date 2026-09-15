import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { run, splitCommand, type FinishReason } from "./pire-browser-runner";
import { redactDiagnosticText, redactProbe } from "./redaction";

const PireBrowserParams = Type.Object({
  command: Type.String({
    description:
      "pire-browser command string, for example: status --json, doctor, skills get core, open, open https://example.com, snapshot, get title, is visible '@e4', click '@e4', upload '#file' ./fixture.txt, or find label Email fill hello@example.com. The CLI auto-launches Firefox for browser commands when no live session exists.",
  }),
});

type PireBrowserInput = Static<typeof PireBrowserParams>;
let smokePiToolCallCount = 0;
const SESSIONLESS_COMMANDS = new Set([
  "activity",
  "completion",
  "dashboard",
  "doctor",
  "help",
  "install",
  "install-status",
  "mcp",
  "plugin",
  "profiles",
  "session",
  "skill",
  "skills",
  "status",
  "stream",
  "version",
]);
const SESSION_CLOSE_TIMEOUT_MS = 10_000;
const SESSION_MARKER_FILE = ".pire-browser-session.json";
const STALE_SESSION_MIN_AGE_MS = 10 * 60_000;
const REAPER_DISABLE_ENV = "PIRE_BROWSER_PI_DISABLE_REAPER";
const SESSIONS_ROOT_ENV = "PIRE_BROWSER_SESSIONS_ROOT";
const LIVE_SESSION_QUERY_TIMEOUT_MS = 15_000;
const SESSION_SETTLE_MS = 500;

export default function (pi: ExtensionAPI) {
  let piSessionId: string | undefined;
  let currentSessionWasUsed = false;

  pi.on("session_start", (_event, ctx) => {
    piSessionId = ctx.sessionManager.getSessionId();
    currentSessionWasUsed = false;
    void reapStaleBrowserSessions().catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    const sessionId = piSessionId;
    piSessionId = undefined;
    currentSessionWasUsed = false;
    if (!sessionId) return;

    // Cleanup must never block or break Pi shutdown, so every step is guarded.
    try {
      // Capture our own profile path before closing: `close` deregisters the
      // session and can leave Firefox running, and afterwards the path is gone
      // from the live registry.
      const ownedProfile = await ownedSessionProfilePath(sessionId);

      // Unconditional cleanup: closing a session that was never created is a
      // safe no-op, and this extension cannot observe browser work done through
      // bash or another host.
      const command = resolveCommand();
      const controller = new AbortController();
      await run(command.executable, [...command.args, "--session", sessionId, "close"], controller.signal, {
        toolTimeoutMs: SESSION_CLOSE_TIMEOUT_MS,
      });

      if (ownedProfile) await terminateSessionRemnants(ownedProfile);
      await reapStaleBrowserSessions();
    } catch {
      // Best effort: leftover cleanup is retried on the next session start.
    }
  });

  const register = (name: "pire-browser" | "pire_browser") =>
    pi.registerTool({
      name,
      label: "pire-browser",
      description:
        "Control the user's Firefox browser through the pire-browser Firefox extension and native host.",
      promptSnippet:
        "pire-browser: control the user's Firefox browser. For full version-matched guidance, run `pire-browser skills get core`.",
      promptGuidelines: [
        "Use pire-browser when the user asks to open, inspect, or interact with web pages in Firefox.",
        "Run `pire-browser skills get core` for quickstart recipes; use `pire-browser open` with no URL to launch or reuse Firefox before staging state, cookies, routes, or init scripts.",
        "Inspect with `pire-browser snapshot --compact` before page actions, use fresh quoted refs such as `click '@e4'`, and use `get`/`is` for targeted verification.",
        "If navigation is recovered or returns a page-readiness warning, continue with `pire-browser snapshot`.",
        "Do not claim a pire-browser action succeeded until the pire-browser tool result confirms success.",
        "If pire-browser returns `confirm <id>` or ConfirmationRequired, ask the user before running the provided confirm command.",
        "If pire-browser returns an error, report the error and next corrective step instead of saying the page was opened or changed.",
      ],
      parameters: PireBrowserParams,

      async execute(_toolCallId, params: PireBrowserInput, signal) {
        const limited = enforcePiToolCallLimit(params.command);
        if (limited) return limited;
        const command = resolveCommand();
        const scoped = scopeCommandToPiSession(splitCommand(params.command), piSessionId);
        if (scoped.usesCurrentSession) currentSessionWasUsed = true;
        const result = await run(command.executable, [...command.args, ...scoped.args], signal);
        if (scoped.closesCurrentSession && !result.exitCode && !result.timedOut) currentSessionWasUsed = false;
        const stderr = redactDiagnosticText(result.stderr);
        const text = result.stdout || stderr || "pire-browser command completed with no output";
        const isError = isErroredResult(text, result);
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
          details: {
            command: redactDiagnosticText(params.command),
            exitCode: result.exitCode,
            finishReason: result.finishReason,
            timedOut: result.timedOut,
            recovered: result.recovered,
            stderr,
            probe: result.probe ? redactProbe(result.probe) : undefined,
          },
          isError,
        };
      },

      renderCall(args: PireBrowserInput, theme) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("pire-browser "))}${theme.fg("muted", args.command)}`,
          0,
          0
        );
      },

      renderResult(result, _options, theme) {
        const text = result.content[0];
        const value = text?.type === "text" ? text.text : "";
        const details = result.details as { exitCode?: number; finishReason?: FinishReason | "tool-call-limit" } | undefined;
        const color =
          !isConfirmationRequiredResult(value, details) &&
          ((details?.exitCode && details.exitCode !== 0) || details?.finishReason === "timeout")
            ? "error"
            : "muted";
        return new Text(theme.fg(color, value), 0, 0);
      },
    });

  try {
    register("pire-browser");
  } catch {
    register("pire_browser");
  }
}

export function scopeCommandToPiSession(args: string[], piSessionId?: string) {
  if (!piSessionId || isSessionlessCommand(args)) {
    return { args, usesCurrentSession: false, closesCurrentSession: false };
  }

  const explicitSession = explicitSessionTarget(args);
  if (explicitSession) {
    const usesCurrentSession = explicitSession === piSessionId;
    return {
      args,
      usesCurrentSession,
      closesCurrentSession: usesCurrentSession && isCloseCommand(args),
    };
  }

  return {
    args: ["--session", piSessionId, ...args],
    usesCurrentSession: true,
    closesCurrentSession: isCloseCommand(args),
  };
}

function explicitSessionTarget(args: string[]) {
  const index = args.findIndex((arg) => arg === "--session" || arg === "--session-name");
  return index >= 0 ? args[index + 1] : undefined;
}

function isSessionlessCommand(args: string[]) {
  const command = args.find((arg) => !arg.startsWith("-"));
  return command ? SESSIONLESS_COMMANDS.has(command) : true;
}

function isCloseCommand(args: string[]) {
  return args.some((arg) => arg === "close" || arg === "quit" || arg === "exit");
}

export type ReaperOptions = {
  sessionsRoot?: string;
  minAgeMs?: number;
  now?: number;
  listLiveProfiles?: () => Promise<string[]>;
  listProcesses?: () => Array<{ pid: number; command: string }>;
  killProcess?: (pid: number) => void;
  removeDirectory?: (path: string) => void;
  settleMs?: number;
};

/**
 * Remove abandoned pire-browser temporary session leftovers.
 *
 * Liveness comes from the live session registry, not from the ownership marker:
 * a session whose marker was already deleted can still be registered and in use.
 * Liveness is also authoritative over the age guard, so a long-running session is
 * never reaped. When liveness cannot be determined, nothing is reaped at all.
 */
export async function reapStaleBrowserSessions(options: ReaperOptions = {}) {
  const empty = { removed: [] as string[], killed: [] as number[] };
  if (process.env[REAPER_DISABLE_ENV]) return empty;
  const root = options.sessionsRoot ?? process.env[SESSIONS_ROOT_ENV] ?? defaultSessionsRoot();
  if (!root || !existsSync(root)) return empty;

  let liveProfiles: string[];
  try {
    liveProfiles = await (options.listLiveProfiles ?? liveSessionProfiles)();
  } catch {
    // Fail closed: without a trustworthy live-session view, reaping could close
    // a browser that another Pi session is actively using.
    return empty;
  }
  const live = new Set(liveProfiles.map(normalizeProfilePath));

  const staleDirectories = staleSessionDirectories(
    root,
    (options.now ?? Date.now()) - (options.minAgeMs ?? STALE_SESSION_MIN_AGE_MS),
    live
  );
  if (staleDirectories.length === 0) return empty;

  const removed: string[] = [];
  const killed: number[] = [];
  const kill = options.killProcess ?? terminateProcess;
  const remove = options.removeDirectory ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const staleProfiles = staleDirectories.map((directory) => join(directory, "profile"));

  for (const entry of listProcessesSafely(options.listProcesses)) {
    if (entry.pid === process.pid) continue;
    if (!staleProfiles.some((profile) => entry.command.includes(profile))) continue;
    try {
      kill(entry.pid);
      killed.push(entry.pid);
    } catch {
      // Best effort: a process may exit between listing and signalling.
    }
  }

  for (const directory of staleDirectories) {
    try {
      remove(directory);
      removed.push(directory);
    } catch {
      // Best effort: keep the session usable if removal is not permitted.
    }
  }

  return { removed, killed };
}

function staleSessionDirectories(root: string, cutoff: number, live: Set<string>) {
  const stale: string[] = [];
  for (const namespace of readDirectoryNames(root)) {
    const sessionsDir = join(root, namespace, "sessions");
    for (const id of readDirectoryNames(sessionsDir)) {
      const directory = join(sessionsDir, id);
      if (live.has(normalizeProfilePath(join(directory, "profile")))) continue;
      if (existsSync(join(directory, SESSION_MARKER_FILE))) continue;
      try {
        if (statSync(directory).mtimeMs > cutoff) continue;
      } catch {
        continue;
      }
      stale.push(directory);
    }
  }
  return stale;
}

function normalizeProfilePath(path: string) {
  return path.replace(/[\\/]+$/, "");
}

async function liveSessionProfiles() {
  const sessions = await queryLiveSessions();
  return sessions
    .map((session) => session.profilePath)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
}

type LiveSession = { sessionName?: unknown; profilePath?: unknown };

async function queryLiveSessions(): Promise<LiveSession[]> {
  const command = resolveCommand();
  const result = await run(
    command.executable,
    [...command.args, "session", "list", "--json"],
    new AbortController().signal,
    { toolTimeoutMs: LIVE_SESSION_QUERY_TIMEOUT_MS }
  );
  if (result.exitCode !== 0 || result.timedOut) throw new Error("live session query failed");
  const parsed = JSON.parse(result.stdout) as { data?: { liveSessions?: unknown } };
  const sessions = parsed?.data?.liveSessions;
  if (!Array.isArray(sessions)) throw new Error("unexpected session list payload");
  return sessions as LiveSession[];
}

async function ownedSessionProfilePath(sessionId: string) {
  try {
    const sessions = await queryLiveSessions();
    const owned = sessions.find(
      (session) => session.sessionName === sessionId || session.sessionName === `pi-${sessionId}`
    );
    return typeof owned?.profilePath === "string" ? owned.profilePath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Terminate browser processes still holding a session profile that was just
 * closed, then remove the abandoned session directory. `pire-browser close`
 * deregisters the session but does not reliably stop Firefox, which is how
 * untracked windows pile up.
 */
export async function terminateSessionRemnants(profilePath: string, options: ReaperOptions = {}) {
  const killed: number[] = [];
  const kill = options.killProcess ?? terminateProcess;

  for (const entry of listProcessesSafely(options.listProcesses)) {
    if (entry.pid === process.pid) continue;
    if (!entry.command.includes(profilePath)) continue;
    try {
      kill(entry.pid);
      killed.push(entry.pid);
    } catch {
      // Best effort: the process may already be exiting.
    }
  }

  if (killed.length > 0) {
    await delay(options.settleMs ?? (options.killProcess ? 0 : SESSION_SETTLE_MS));
  }

  let removed = false;
  try {
    (options.removeDirectory ?? ((path: string) => rmSync(path, { recursive: true, force: true })))(
      dirname(profilePath)
    );
    removed = true;
  } catch {
    // Best effort: leave the directory for the stale-session reaper.
  }

  return { killed, removed };
}

function delay(ms: number) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function readDirectoryNames(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function defaultSessionsRoot() {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  return join(tmpdir(), "pire-browser");
}

function listProcessesSafely(source?: () => Array<{ pid: number; command: string }>) {
  try {
    return (source ?? listProcesses)();
  } catch {
    // Without a process view nothing is terminated; directories are still reaped.
    return [];
  }
}

function listProcesses() {
  const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      return match ? { pid: Number.parseInt(match[1], 10), command: match[2] } : null;
    })
    .filter((entry): entry is { pid: number; command: string } => entry !== null);
}

function terminateProcess(pid: number) {
  process.kill(pid, "SIGTERM");
}

export function isConfirmationRequiredResult(
  text: string,
  details?: { exitCode?: number | null; finishReason?: FinishReason | "tool-call-limit" }
) {
  if (details?.exitCode === 75) return true;
  if (text.includes("ConfirmationRequired")) return true;
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.code === "ConfirmationRequired";
  } catch {
    return false;
  }
}

function isErroredResult(
  text: string,
  details: { exitCode?: number | null; finishReason?: FinishReason | "tool-call-limit"; recovered?: boolean }
) {
  if (isConfirmationRequiredResult(text, details)) return false;
  if (details.recovered) return false;
  if (details.finishReason === "timeout" || details.finishReason === "tool-call-limit") return true;
  return Boolean(details.exitCode && details.exitCode !== 0);
}

function enforcePiToolCallLimit(command: string) {
  const max = Number.parseInt(process.env.PIRE_BROWSER_PI_MAX_TOOL_CALLS ?? "", 10);
  if (!Number.isFinite(max) || max <= 0) return null;
  smokePiToolCallCount += 1;
  if (smokePiToolCallCount <= max) return null;
  const text = `pire-browser smoke stopped after ${max} tool call(s); command was not executed: ${command}`;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      command,
      exitCode: 1,
      finishReason: "tool-call-limit",
      timedOut: false,
      recovered: false,
      stderr: text,
    },
    isError: true,
  };
}

function resolveCommand(): { executable: string; args: string[] } {
  const envPath = process.env.PIRE_BROWSER_EXE;
  if (envPath && existsSync(envPath)) return { executable: envPath, args: [] };
  const envBinary = process.env.PIRE_BROWSER_BINARY;
  if (envBinary && existsSync(envBinary)) return { executable: envBinary, args: [] };

  const suffix = process.platform === "win32" ? ".exe" : "";
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const launcher = join(packageRoot, "bin", "pire-browser.js");
  if (existsSync(launcher)) return { executable: process.execPath, args: [launcher] };
  const candidates = [
    join(packageRoot, "bin", "win32-x64", `pire-browser${suffix}`),
    join(process.cwd(), "target", "debug", `pire-browser${suffix}`),
    join(process.cwd(), "target", "release", `pire-browser${suffix}`),
    `pire-browser${suffix}`,
  ];
  const executable =
    candidates.find((candidate) => candidate === `pire-browser${suffix}` || existsSync(candidate)) ?? candidates[0];
  return { executable, args: [] };
}
