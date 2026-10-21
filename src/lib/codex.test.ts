import { describe, expect, it } from "vitest";
import {
  codexStatus,
  findCodexPids,
  isAppServerDaemon,
  isSubagentThread,
  matchTuiForThread,
  parseLockHolders,
} from "./codex-discovery";
import { type CodexLine, codexLinesToConversation, codexPreview, codexTurnState } from "./codex-reader";
import type { ProcessTreeEntry } from "./terminal/types";

const ev = (type: string, extra: Record<string, unknown> = {}, timestamp?: string): CodexLine => ({
  timestamp,
  type: "event_msg",
  payload: { type, ...extra },
});
const item = (payload: Record<string, unknown>, timestamp?: string): CodexLine => ({
  timestamp,
  type: "response_item",
  payload,
});
const userItem = (text: string) => item({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistantItem = (text: string) =>
  item({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

describe("codexTurnState", () => {
  it("is in a turn between task_started and task_complete", () => {
    expect(codexTurnState([ev("task_started")]).inTurn).toBe(true);
    expect(codexTurnState([ev("task_started"), ev("task_complete")]).inTurn).toBe(false);
    expect(codexTurnState([ev("task_started"), ev("turn_aborted")]).inTurn).toBe(false);
  });

  it("tracks tool calls without output and the approval policy", () => {
    const state = codexTurnState([
      { type: "turn_context", payload: { approval_policy: "on-request" } },
      ev("task_started"),
      item({ type: "function_call", name: "exec_command", call_id: "a" }, "2026-10-21T00:00:00Z"),
      item({ type: "function_call", name: "apply_patch", call_id: "b" }, "2026-10-21T00:00:01Z"),
      item({ type: "function_call_output", call_id: "a" }),
    ]);
    expect(state.approvalPolicy).toBe("on-request");
    expect(state.pendingCalls).toEqual([{ name: "apply_patch", at: Date.parse("2026-10-21T00:00:01Z") }]);
  });

  it("reports an error only when the turn ended", () => {
    expect(codexTurnState([ev("task_started"), ev("error"), ev("task_complete")]).errored).toBe(true);
    expect(codexTurnState([ev("task_started"), ev("error")]).errored).toBe(false);
  });
});

describe("codexStatus", () => {
  const now = Date.parse("2026-10-21T00:01:00Z");
  const base = { inTurn: true, errored: false, pendingCalls: [], approvalPolicy: "on-request" };

  it("is idle outside a turn and working inside one", () => {
    expect(codexStatus({ ...base, inTurn: false }, { now, toolRunning: () => false })).toBe("idle");
    expect(codexStatus(base, { now, toolRunning: () => false })).toBe("working");
  });

  it("is waiting when a call has no output, nothing runs it, and approvals are possible", () => {
    const state = { ...base, pendingCalls: [{ name: "exec_command", at: now - 30_000 }] };
    expect(codexStatus(state, { now, toolRunning: () => false })).toBe("waiting");
    expect(codexStatus(state, { now, toolRunning: () => true })).toBe("working");
    expect(codexStatus({ ...state, approvalPolicy: "never" }, { now, toolRunning: () => false })).toBe("working");
  });

  it("gives a fresh call time to start before calling it waiting", () => {
    const state = { ...base, pendingCalls: [{ name: "exec_command", at: now - 500 }] };
    expect(codexStatus(state, { now, toolRunning: () => false })).toBe("working");
  });
});

describe("codexPreview / codexLinesToConversation", () => {
  it("reads event messages (older rollouts) without double counting response items", () => {
    const lines = [
      ev("user_message", { message: "Fix the build" }),
      userItem("Fix the build"),
      ev("agent_message", { message: "Done." }),
      assistantItem("Done."),
    ];
    const preview = codexPreview(lines);
    expect(preview).toMatchObject({ lastUserMessage: "Fix the build", lastAssistantText: "Done.", messageCount: 2 });
    expect(codexLinesToConversation(lines).map((m) => m.type)).toEqual(["user", "assistant"]);
  });

  it("falls back to response items and skips injected AGENTS.md / environment context", () => {
    const lines = [
      userItem("# AGENTS.md instructions for /repo\n..."),
      userItem("<environment_context>\n  <cwd>/repo</cwd>"),
      userItem("광고 테스트 프로그램 만들 수 있나?"),
      item({ type: "function_call", name: "exec_command", call_id: "x", arguments: '{"cmd":"ls"}' }),
      assistantItem("네, 가능합니다."),
    ];
    const preview = codexPreview(lines);
    expect(preview.lastUserMessage).toBe("광고 테스트 프로그램 만들 수 있나?");
    expect(preview.assistantIsNewer).toBe(true);
    expect(preview.lastTools.map((t) => t.name)).toEqual(["exec_command"]);
    expect(preview.messageCount).toBe(2);
    const convo = codexLinesToConversation(lines);
    expect(convo.map((m) => m.type)).toEqual(["user", "assistant", "assistant"]);
    expect(convo[1].toolUses[0]).toEqual({ name: "exec_command", input: { cmd: "ls" } });
  });
});

describe("Codex process / thread linking", () => {
  const tree = (entries: [number, number, string][]) =>
    new Map<number, ProcessTreeEntry>(entries.map(([pid, ppid, comm]) => [pid, { ppid, cpuPercent: 0, comm }]));

  // Observed: TUI 14386 spawned the shared daemon 14421; a second TUI 4462 uses it too
  const t = tree([
    [14386, 14383, "/Users/me/.npm-global/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex"],
    [14421, 14386, "/Users/me/.codex-acct5/packages/app-server-daemon/releases/0.163.0/bin/codex"],
    [15376, 14421, "/Users/me/.codex-acct5/packages/app-server-daemon/releases/0.163.0/bin/codex-code-mode-host"],
    [4462, 4461, "/Users/me/.npm-global/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex"],
    [1816, 1793, "/Users/me/.vscode/extensions/openai.chatgpt-26.1007/bin/macos-aarch64/codex"],
    [
      1793,
      1727,
      "/Users/me/Desktop/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
    ],
  ]);

  it("finds codex binaries but not their helper processes", () => {
    expect(findCodexPids(t).sort((a, b) => a - b)).toEqual([1816, 4462, 14386, 14421]);
  });

  it("recognises the shared app-server daemon, not the VS Code app-server", () => {
    expect(isAppServerDaemon(14421, t)).toBe(true);
    expect(isAppServerDaemon(1816, t)).toBe(false);
  });

  it("parses lock holders from lsof", () => {
    const out = [
      "p14421",
      "n/Users/me/.codex-acct5/thread-writer-locks/01a157d2-699f-7602-9e97-7db837a66efe.lock",
      "n/Users/me/.codex-acct5/thread-writer-locks/01a152b9-e751-76b3-aa8c-0b0cb16484bd.lock",
      "p1816",
      "n/Users/me/.codex-acct5/thread-writer-locks/01a0c6a1-e089-7533-9e93-14070a933918.lock",
      "n/Users/me/.codex-acct5/thread-writer-locks/.coordination.lock",
    ].join("\n");
    expect(Object.fromEntries(parseLockHolders(out))).toEqual({
      "01a157d2-699f-7602-9e97-7db837a66efe": 14421,
      "01a152b9-e751-76b3-aa8c-0b0cb16484bd": 14421,
      "01a0c6a1-e089-7533-9e93-14070a933918": 1816,
    });
  });

  it("matches a daemon-held thread to the TUI in the same folder (Korean path, any normalization)", () => {
    const tuis = [
      { pid: 14386, cwd: "/Volumes/X31/WORKSPACE/bibleOnlybbq" },
      { pid: 4462, cwd: "/Volumes/X31/WORKSPACE/성경일독/bibleapps".normalize("NFD") },
    ];
    expect(matchTuiForThread("/Volumes/X31/WORKSPACE/성경일독/bibleapps", tuis)).toEqual({
      pid: 4462,
      ambiguous: false,
    });
    expect(matchTuiForThread("/elsewhere", tuis)).toBeNull();
  });

  it("flags an ambiguous match when two TUIs share a folder", () => {
    const tuis = [
      { pid: 1, cwd: "/repo" },
      { pid: 2, cwd: "/repo" },
    ];
    expect(matchTuiForThread("/repo", tuis)?.ambiguous).toBe(true);
  });

  it("skips sub-agent threads", () => {
    expect(isSubagentThread({ source: '{"subagent":{"thread_spawn":{}}}' })).toBe(true);
    expect(isSubagentThread({ source: "vscode" })).toBe(false);
  });
});
