import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.hoisted(() => vi.fn());

vi.mock("./pire-browser-runner", () => ({
  splitCommand: (command: string) => command.split(/\s+/).filter(Boolean),
  run: runMock,
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Text: class Text {
    constructor(
      public value: string,
      public x: number,
      public y: number
    ) {}
  },
}));

vi.mock("typebox", () => ({
  Type: {
    Object: (schema: unknown) => schema,
    String: (schema: unknown) => schema,
  },
}));

import registerPireBrowser, {
  reapStaleBrowserSessions,
  scopeCommandToPiSession,
  terminateSessionRemnants,
} from "./pire-browser";

function registerTool() {
  const tools: any[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  registerPireBrowser({
    registerTool(tool: any) {
      tools.push(tool);
    },
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
  } as any);
  return { tool: tools[0], handlers };
}

describe("pire-browser Pi wrapper", () => {
  beforeEach(() => {
    runMock.mockReset();
    delete process.env.PIRE_BROWSER_PI_MAX_TOOL_CALLS;
    delete process.env.PIRE_BROWSER_PI_DISABLE_REAPER;
    process.env.PIRE_BROWSER_SESSIONS_ROOT = join(tmpdir(), `pire-no-sessions-${process.pid}`);
  });

  afterEach(() => {
    delete process.env.PIRE_BROWSER_PI_MAX_TOOL_CALLS;
    delete process.env.PIRE_BROWSER_PI_DISABLE_REAPER;
    delete process.env.PIRE_BROWSER_SESSIONS_ROOT;
  });

  it("keeps inline prompt guidance compact and points to installed skill content", () => {
    const { tool } = registerTool();
    expect(tool.promptSnippet).toContain("pire-browser skills get core");
    expect(tool.promptGuidelines).toContain(
      "Run `pire-browser skills get core` for quickstart recipes; use `pire-browser open` with no URL to launch or reuse Firefox before staging state, cookies, routes, or init scripts."
    );
    expect(tool.promptGuidelines).toContain(
      "Inspect with `pire-browser snapshot --compact` before page actions, use fresh quoted refs such as `click '@e4'`, and use `get`/`is` for targeted verification."
    );
    expect(tool.promptGuidelines).toContain(
      "If navigation is recovered or returns a page-readiness warning, continue with `pire-browser snapshot`."
    );
    expect(tool.promptGuidelines.length).toBeLessThanOrEqual(7);
  });

  it("enforces the Pi smoke tool call cap", async () => {
    process.env.PIRE_BROWSER_PI_MAX_TOOL_CALLS = "1";
    runMock.mockResolvedValue({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      finishReason: "close",
      timedOut: false,
      recovered: false,
    });

    const { tool } = registerTool();
    await tool.execute("call-1", { command: "status" }, new AbortController().signal);
    const second = await tool.execute("call-2", { command: "snapshot" }, new AbortController().signal);

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(second.content[0].text).toContain("stopped after 1 tool call");
    expect(second.isError).toBe(true);
    expect(second.details).toMatchObject({
      exitCode: 1,
      finishReason: "tool-call-limit",
      timedOut: false,
      recovered: false,
    });
  });

  it("redacts command and diagnostic details while preserving successful stdout", async () => {
    runMock.mockResolvedValue({
      stdout: "page text token=visible-success",
      stderr: "Authorization: Bearer diagnostic-secret",
      exitCode: 0,
      finishReason: "close",
      timedOut: false,
      recovered: false,
      probe: {
        status: {
          stdout: "active https://example.test/?code=probe-secret",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
        liveSession: true,
        liveTabs: false,
      },
    });

    const { tool } = registerTool();
    const result = await tool.execute(
      "call-1",
      { command: "open https://example.test/?access_token=command-secret" },
      new AbortController().signal
    );

    expect(result.content[0].text).toBe("page text token=visible-success");
    expect(JSON.stringify(result.details)).toContain("[REDACTED]");
    expect(JSON.stringify(result.details)).not.toContain("command-secret");
    expect(JSON.stringify(result.details)).not.toContain("diagnostic-secret");
    expect(JSON.stringify(result.details)).not.toContain("probe-secret");
  });

  it("marks unrecovered nonzero commands as Pi tool errors", async () => {
    runMock.mockResolvedValue({
      stdout: "",
      stderr: "command failed",
      exitCode: 2,
      finishReason: "close",
      timedOut: false,
      recovered: false,
    });

    const { tool } = registerTool();
    const result = await tool.execute("call-1", { command: "open https://example.test" }, new AbortController().signal);

    expect(result.content[0].text).toBe("command failed");
    expect(result.isError).toBe(true);
  });

  it("keeps recovered navigation as success so agents can inspect next", async () => {
    runMock.mockResolvedValue({
      stdout: "Recovered after lazy setup\nOpened https://example.test in @t1",
      stderr: "",
      exitCode: 0,
      finishReason: "close",
      timedOut: false,
      recovered: true,
    });

    const { tool } = registerTool();
    const result = await tool.execute("call-1", { command: "open https://example.test" }, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(result.details.recovered).toBe(true);
  });

  it("keeps confirmation-required flows non-error for user approval", async () => {
    runMock.mockResolvedValue({
      stdout: "ConfirmationRequired: run `pire-browser confirm abc123`",
      stderr: "",
      exitCode: 75,
      finishReason: "close",
      timedOut: false,
      recovered: false,
    });

    const { tool } = registerTool();
    const result = await tool.execute("call-1", { command: "click '@e1'" }, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("ConfirmationRequired");
  });

  it("binds browser commands to the current Pi session", () => {
    expect(scopeCommandToPiSession(["open", "https://example.test"], "pi-session")).toEqual({
      args: ["--session", "pi-session", "open", "https://example.test"],
      usesCurrentSession: true,
      closesCurrentSession: false,
    });
    expect(scopeCommandToPiSession(["status", "--json"], "pi-session")).toEqual({
      args: ["status", "--json"],
      usesCurrentSession: false,
      closesCurrentSession: false,
    });
  });

  it("does not take ownership of an explicitly targeted session", () => {
    expect(scopeCommandToPiSession(["--session", "other", "snapshot"], "pi-session")).toEqual({
      args: ["--session", "other", "snapshot"],
      usesCurrentSession: false,
      closesCurrentSession: false,
    });
  });

  it("closes the Pi-owned Firefox session during session shutdown", async () => {
    runMock.mockResolvedValue({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      finishReason: "close",
      timedOut: false,
      recovered: false,
    });
    const { tool, handlers } = registerTool();
    handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "pi-session" } });

    await tool.execute("call-1", { command: "snapshot" }, new AbortController().signal);
    await handlers.get("session_shutdown")?.({}, {});

    expect(runMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--session", "pi-session", "snapshot"]),
      expect.any(AbortSignal)
    );
    expect(runMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--session", "pi-session", "close"]),
      expect.any(AbortSignal),
      { toolTimeoutMs: 10_000 }
    );
  });

  it("issues the close command on shutdown even after an explicit in-tool close", async () => {
    runMock.mockResolvedValue({
      stdout: "closed",
      stderr: "",
      exitCode: 0,
      finishReason: "close",
      timedOut: false,
      recovered: false,
    });
    const { tool, handlers } = registerTool();
    handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "pi-session" } });

    await tool.execute("call-1", { command: "close" }, new AbortController().signal);
    await handlers.get("session_shutdown")?.({}, {});

    // Closing an already-closed session is a documented no-op, so shutting down
    // always issues close instead of trying to track usage it cannot observe.
    const closeCalls = runMock.mock.calls.filter((call) => call[1]?.includes("close"));
    expect(closeCalls.length).toBeGreaterThanOrEqual(2);
    expect(runMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.arrayContaining(["--session", "pi-session", "close"]),
      expect.any(AbortSignal),
      { toolTimeoutMs: 10_000 }
    );
  });

  it("still closes the Pi-owned session when the browser was only used through bash", async () => {
    runMock.mockResolvedValue({
      stdout: "No live pire-browser Firefox session to close.",
      stderr: "",
      exitCode: 0,
      finishReason: "close",
      timedOut: false,
      recovered: false,
    });
    const { handlers } = registerTool();
    handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "pi-session" } });

    await handlers.get("session_shutdown")?.({}, {});

    expect(runMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--session", "pi-session", "close"]),
      expect.any(AbortSignal),
      { toolTimeoutMs: 10_000 }
    );
  });
});

describe("pire-browser session remnant cleanup", () => {
  it("kills surviving browsers for the closed profile and removes the directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "pire-remnants-"));
    const sessionDir = join(root, "session-1");
    const profile = join(sessionDir, "profile");
    mkdirSync(profile, { recursive: true });
    const killed: number[] = [];

    const result = await terminateSessionRemnants(profile, {
      listProcesses: () => [
        { pid: 111, command: `firefox -profile ${profile}` },
        { pid: 222, command: `firefox -profile /elsewhere/profile` },
      ],
      killProcess: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([111]);
    expect(result).toEqual({ killed: [111], removed: true });
    expect(existsSync(sessionDir)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves other sessions alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "pire-remnants-other-"));
    const sessionDir = join(root, "session-2");
    const profile = join(sessionDir, "profile");
    mkdirSync(profile, { recursive: true });

    const result = await terminateSessionRemnants(profile, {
      listProcesses: () => [{ pid: 333, command: `firefox -profile /other/session/profile` }],
      killProcess: () => undefined,
    });

    expect(result.killed).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("pire-browser stale session reaper", () => {
  const marker = ".pire-browser-session.json";

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pire-reaper-"));
    const sessions = join(root, "default", "sessions");
    mkdirSync(sessions, { recursive: true });
    return { root, sessions };
  }

  function makeSession(sessions: string, id: string, options: { marker?: boolean; ageMs?: number } = {}) {
    const directory = join(sessions, id);
    mkdirSync(join(directory, "profile"), { recursive: true });
    if (options.marker) writeFileSync(join(directory, marker), "{}");
    const when = new Date(Date.now() - (options.ageMs ?? 60 * 60_000));
    utimesSync(directory, when, when);
    return directory;
  }

  it("removes unmarked stale sessions and kills their browser", async () => {
    const { root, sessions } = fixture();
    const stale = makeSession(sessions, "stale-1");
    const killed: number[] = [];

    const result = await reapStaleBrowserSessions({
      sessionsRoot: root,
      listLiveProfiles: async () => [],
      listProcesses: () => [{ pid: 4242, command: `firefox -profile ${join(stale, "profile")}` }],
      killProcess: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([4242]);
    expect(existsSync(stale)).toBe(false);
    expect(result.killed).toEqual([4242]);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps marked sessions and sessions that are still starting up", async () => {
    const { root, sessions } = fixture();
    const live = makeSession(sessions, "live-1", { marker: true });
    const starting = makeSession(sessions, "starting-1", { ageMs: 0 });

    const result = await reapStaleBrowserSessions({
      sessionsRoot: root,
      listLiveProfiles: async () => [],
      listProcesses: () => [],
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(starting)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a registered live session even when its ownership marker is gone", async () => {
    const { root, sessions } = fixture();
    const unmarkedLive = makeSession(sessions, "unmarked-live-1");
    const killed: number[] = [];

    const result = await reapStaleBrowserSessions({
      sessionsRoot: root,
      listLiveProfiles: async () => [join(unmarkedLive, "profile")],
      listProcesses: () => [{ pid: 5150, command: `firefox -profile ${join(unmarkedLive, "profile")}` }],
      killProcess: (pid) => killed.push(pid),
    });

    expect(result).toEqual({ removed: [], killed: [] });
    expect(killed).toEqual([]);
    expect(existsSync(unmarkedLive)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("does nothing when liveness cannot be determined", async () => {
    const { root, sessions } = fixture();
    const stale = makeSession(sessions, "stale-unknown-liveness");

    const result = await reapStaleBrowserSessions({
      sessionsRoot: root,
      listLiveProfiles: async () => {
        throw new Error("session list failed");
      },
      listProcesses: () => [],
    });

    expect(result).toEqual({ removed: [], killed: [] });
    expect(existsSync(stale)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("respects the disable switch", async () => {
    const { root, sessions } = fixture();
    const stale = makeSession(sessions, "stale-2");
    process.env.PIRE_BROWSER_PI_DISABLE_REAPER = "1";

    try {
      const result = await reapStaleBrowserSessions({
        sessionsRoot: root,
        listLiveProfiles: async () => [],
        listProcesses: () => [],
      });
      expect(result.removed).toEqual([]);
      expect(existsSync(stale)).toBe(true);
    } finally {
      delete process.env.PIRE_BROWSER_PI_DISABLE_REAPER;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
