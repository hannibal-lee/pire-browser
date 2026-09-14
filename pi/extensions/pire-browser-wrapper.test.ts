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

import registerPireBrowser, { scopeCommandToPiSession } from "./pire-browser";

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
  });

  afterEach(() => {
    delete process.env.PIRE_BROWSER_PI_MAX_TOOL_CALLS;
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

    expect(runMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.arrayContaining(["--session", "pi-session", "snapshot"]),
      expect.any(AbortSignal)
    );
    expect(runMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.arrayContaining(["--session", "pi-session", "close"]),
      expect.any(AbortSignal),
      { toolTimeoutMs: 10_000 }
    );
  });

  it("does not close again after the tool explicitly closed the Pi session", async () => {
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

    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
