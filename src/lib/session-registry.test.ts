import { describe, expect, it } from "vitest";
import {
  isAuxiliaryKind,
  parseRegistryEntry,
  type RegistryEntry,
  sameProcessStart,
  selectRegistryEntry,
  statusFromRegistry,
} from "./session-registry";

// Shape written by Claude Code 2.1.30x for a VS Code extension session
const VSCODE_ENTRY = JSON.stringify({
  pid: 17399,
  sessionId: "a5ab01fe-5fdc-43c3-af6d-6d21edc198bd",
  cwd: "/Users/dev_mac_01/prompt_tester",
  startedAt: 1792478964298,
  procStart: "Tue Oct 20 06:49:23 2026",
  version: "2.1.300",
  kind: "interactive",
  entrypoint: "claude-vscode",
  messagingSocketPath: "/tmp/cc-socks/17399.sock",
  name: "prompt-tester-c9",
  status: "idle",
  updatedAt: 1792480065374,
});

function entry(overrides: Partial<RegistryEntry>): RegistryEntry {
  return { ...parseRegistryEntry(VSCODE_ENTRY, "/home/.claude-acct2")!, ...overrides };
}

describe("parseRegistryEntry", () => {
  it("extracts the linking fields and remembers the config dir", () => {
    const e = parseRegistryEntry(VSCODE_ENTRY, "/home/.claude-acct2");
    expect(e).toMatchObject({
      pid: 17399,
      sessionId: "a5ab01fe-5fdc-43c3-af6d-6d21edc198bd",
      entrypoint: "claude-vscode",
      status: "idle",
      configDir: "/home/.claude-acct2",
    });
  });

  it("rejects malformed files", () => {
    expect(parseRegistryEntry("not json", "/x")).toBeNull();
    expect(parseRegistryEntry(JSON.stringify({ sessionId: "abc" }), "/x")).toBeNull();
  });
});

describe("selectRegistryEntry", () => {
  it("accepts an entry whose procStart matches the live process (UTC)", () => {
    expect(selectRegistryEntry([entry({})], "Tue Oct 20 06:49:23 2026")).not.toBeNull();
  });

  it("rejects a stale entry left by an earlier process with the same PID", () => {
    expect(selectRegistryEntry([entry({})], "Wed Oct 21 10:00:00 2026")).toBeNull();
  });

  it("prefers the matching, most recently updated entry across config dirs", () => {
    const stale = entry({ configDir: "/home/.claude", procStart: "Mon Oct 19 01:00:00 2026", updatedAt: 9e12 });
    const live = entry({ configDir: "/home/.claude-acct2" });
    expect(selectRegistryEntry([stale, live], "Tue Oct 20 06:49:23 2026")?.configDir).toBe("/home/.claude-acct2");
  });

  it("returns null when there is no entry", () => {
    expect(selectRegistryEntry(undefined, null)).toBeNull();
  });
});

describe("sameProcessStart", () => {
  it("tolerates a second of skew", () => {
    expect(sameProcessStart("Tue Oct 20 06:49:23 2026", "Tue Oct 20 06:49:24 2026")).toBe(true);
    expect(sameProcessStart("Tue Oct 20 06:49:23 2026", "Tue Oct 20 06:59:23 2026")).toBe(false);
  });
});

describe("statusFromRegistry", () => {
  it("maps the CLI's statuses", () => {
    expect(statusFromRegistry("busy")).toBe("working");
    expect(statusFromRegistry("shell")).toBe("working");
    expect(statusFromRegistry("waiting")).toBe("waiting");
    expect(statusFromRegistry("idle")).toBe("idle");
  });

  it("returns null for missing or unknown values instead of guessing idle", () => {
    expect(statusFromRegistry(null)).toBeNull();
    expect(statusFromRegistry("something-new")).toBeNull();
  });
});

describe("isAuxiliaryKind", () => {
  it("treats daemons as helpers, interactive and bg sessions as conversations", () => {
    expect(isAuxiliaryKind("daemon")).toBe(true);
    expect(isAuxiliaryKind("daemon-worker")).toBe(true);
    expect(isAuxiliaryKind("interactive")).toBe(false);
    expect(isAuxiliaryKind("bg")).toBe(false);
    expect(isAuxiliaryKind(null)).toBe(false);
  });
});
