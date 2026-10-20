import { describe, expect, it, vi } from "vitest";
import type { HookStatus } from "./hooks-reader";
import { chooseSessionId, pickInferredTranscript, resolveStatus } from "./session-link";
import type { RegistryEntry } from "./session-registry";

const registry = (sessionId: string | null, status: string | null = "idle"): RegistryEntry => ({
  pid: 1,
  sessionId,
  cwd: "/p",
  procStart: null,
  kind: "interactive",
  entrypoint: "claude-vscode",
  status,
  waitingFor: null,
  name: null,
  updatedAt: 0,
  configDir: "/home/.claude-acct2",
});

const hook = (sessionId: string): HookStatus => ({
  status: "working",
  event: "UserPromptSubmit",
  ts: 0,
  cwd: "/p",
  sessionId,
  transcriptPath: `/t/${sessionId}.jsonl`,
});

describe("chooseSessionId", () => {
  it("prefers the CLI registry over hooks and arguments", () => {
    expect(chooseSessionId({ registry: registry("reg"), hook: hook("hook"), argsSessionId: "arg" })).toEqual({
      sessionId: "reg",
      source: "registry",
    });
  });

  it("falls back to the hook, then --resume", () => {
    expect(chooseSessionId({ registry: null, hook: hook("hook"), argsSessionId: "arg" })?.source).toBe("hook");
    expect(chooseSessionId({ registry: registry(null), hook: undefined, argsSessionId: "arg" })).toEqual({
      sessionId: "arg",
      source: "args",
    });
  });

  it("returns null when there is no evidence", () => {
    expect(chooseSessionId({ registry: null, hook: undefined, argsSessionId: null })).toBeNull();
  });
});

describe("resolveStatus", () => {
  const base = {
    registryStatus: null,
    registryStale: false,
    hookStatus: null,
    transcriptLinked: false,
    hasError: false,
  };

  it("uses the registry status first", () => {
    const heuristic = vi.fn(() => "idle" as const);
    expect(resolveStatus({ ...base, registryStatus: "busy", hookStatus: "idle", heuristic })).toEqual({
      status: "working",
      source: "registry",
    });
    expect(heuristic).not.toHaveBeenCalled();
  });

  it("reports waiting from the registry (permission / input prompt)", () => {
    expect(resolveStatus({ ...base, registryStatus: "waiting", heuristic: () => "idle" }).status).toBe("waiting");
  });

  it("marks an idle session with an API error as errored", () => {
    expect(resolveStatus({ ...base, registryStatus: "idle", hasError: true, heuristic: () => "idle" }).status).toBe(
      "errored",
    );
  });

  it("ignores a stale registry status when the transcript is newer (CLI stopped refreshing it)", () => {
    expect(
      resolveStatus({
        ...base,
        registryStatus: "idle",
        registryStale: true,
        transcriptLinked: true,
        heuristic: () => "working",
      }),
    ).toEqual({ status: "working", source: "transcript" });
  });

  it("uses hooks when there is no registry", () => {
    expect(resolveStatus({ ...base, hookStatus: "finished", heuristic: () => "idle" })).toEqual({
      status: "finished",
      source: "hook",
    });
  });

  it("uses the transcript heuristic only when a transcript is linked", () => {
    expect(resolveStatus({ ...base, transcriptLinked: true, heuristic: () => "working" })).toEqual({
      status: "working",
      source: "transcript",
    });
  });

  it("is unknown — not idle — when nothing links the process", () => {
    expect(resolveStatus({ ...base, heuristic: () => "idle" })).toEqual({ status: "unknown", source: "none" });
  });
});

describe("pickInferredTranscript", () => {
  const files = [
    { path: "/p/a.jsonl", mtimeMs: 2000 },
    { path: "/p/b.jsonl", mtimeMs: 3000 },
    { path: "/p/old.jsonl", mtimeMs: 500 },
  ];

  it("picks the newest unclaimed transcript written after the process started", () => {
    expect(pickInferredTranscript(files, new Set(), 1000, 1)).toBe("/p/b.jsonl");
    expect(pickInferredTranscript(files, new Set(["/p/b.jsonl"]), 1000, 1)).toBe("/p/a.jsonl");
  });

  it("refuses when several unlinked sessions share the project", () => {
    expect(pickInferredTranscript(files, new Set(), 1000, 2)).toBeNull();
  });

  it("refuses transcripts older than the process", () => {
    expect(pickInferredTranscript(files, new Set(), 4000, 1)).toBeNull();
  });

  it("refuses without a known process start time", () => {
    expect(pickInferredTranscript(files, new Set(), null, 1)).toBeNull();
  });
});
