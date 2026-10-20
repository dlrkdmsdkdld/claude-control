import { describe, expect, it } from "vitest";
import { appBundleFromComm, detectSessionHost, hostAcceptsTerminalInput } from "./session-host";
import { isOrphaned } from "./terminal/detect";
import type { ProcessTreeEntry } from "./terminal/types";

const VSCODE = "/Users/me/Desktop/Visual Studio Code.app";
const EXT_CLAUDE =
  "/Users/me/.vscode/extensions/anthropic.claude-code-2.1.301-darwin-arm64/resources/native-binary/claude";

function tree(entries: [number, number, string][]): Map<number, ProcessTreeEntry> {
  return new Map(entries.map(([pid, ppid, comm]) => [pid, { ppid, cpuPercent: 0, comm }]));
}

// Trees observed on a real machine (paths shortened)
const vscodeExtension = tree([
  [30812, 29392, EXT_CLAUDE],
  [29392, 1727, `${VSCODE}/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`],
  [1727, 1, `${VSCODE}/Contents/MacOS/Code`],
]);
const vscodeTerminal = tree([
  [82537, 33400, "claude"],
  [33400, 1838, "/bin/zsh"],
  [1838, 1727, `${VSCODE}/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper`],
  [1727, 1, `${VSCODE}/Contents/MacOS/Code`],
]);
const gitkrakenTerminal = tree([
  [21792, 21789, "claude"],
  [21789, 16006, "node"],
  [16006, 15816, "/bin/zsh"],
  [
    15816,
    15706,
    "/Applications/GitKraken.app/Contents/Frameworks/GitKraken Helper (Renderer).app/Contents/MacOS/GitKraken Helper (Renderer)",
  ],
  [15706, 1, "/Applications/GitKraken.app/Contents/MacOS/GitKraken"],
]);
const itermTerminal = tree([
  [100, 200, "claude"],
  [200, 300, "-zsh"],
  [300, 1, "/Applications/iTerm.app/Contents/MacOS/iTerm2"],
]);
const closedTerminal = tree([
  [100, 200, "claude"],
  [200, 1, "zsh"],
]);

const noHints = { entrypoint: null, hasTty: true, tmuxSession: null };

describe("detectSessionHost", () => {
  it("recognises a VS Code extension session by its entrypoint", () => {
    const host = detectSessionHost(30812, vscodeExtension, { ...noHints, entrypoint: "claude-vscode", hasTty: false });
    expect(host).toEqual({
      kind: "vscode-extension",
      appName: "Visual Studio Code",
      bundlePath: VSCODE,
      uriScheme: "vscode",
    });
  });

  it("recognises an extension session without entrypoint info (no TTY under the plugin host)", () => {
    expect(detectSessionHost(30812, vscodeExtension, { ...noHints, hasTty: false }).kind).toBe("vscode-extension");
  });

  it("distinguishes the VS Code integrated terminal from the extension", () => {
    const host = detectSessionHost(82537, vscodeTerminal, { ...noHints, entrypoint: "cli" });
    expect(host.kind).toBe("vscode-terminal");
    expect(host.bundlePath).toBe(VSCODE);
  });

  it("keeps known terminals detected as terminals", () => {
    expect(detectSessionHost(100, itermTerminal, noHints)).toMatchObject({ kind: "terminal", appName: "iTerm2" });
  });

  it("reports other GUI apps hosting a terminal", () => {
    expect(detectSessionHost(21792, gitkrakenTerminal, noHints)).toMatchObject({
      kind: "app",
      appName: "GitKraken",
      bundlePath: "/Applications/GitKraken.app",
    });
  });

  it("prefers tmux when the session is in a tmux pane", () => {
    expect(detectSessionHost(100, itermTerminal, { ...noHints, tmuxSession: "main" }).kind).toBe("tmux");
  });

  it("is unknown when no host exists", () => {
    expect(detectSessionHost(100, closedTerminal, noHints).kind).toBe("unknown");
  });
});

describe("isOrphaned with app hosts", () => {
  it("does not mark VS Code extension sessions as orphaned", () => {
    expect(isOrphaned(30812, vscodeExtension, false)).toBe(false);
  });

  it("does not mark VS Code integrated-terminal sessions as orphaned", () => {
    expect(isOrphaned(82537, vscodeTerminal, false)).toBe(false);
  });

  it("does not mark sessions in other apps' terminals as orphaned", () => {
    expect(isOrphaned(21792, gitkrakenTerminal, false)).toBe(false);
  });

  it("still marks a session whose terminal closed as orphaned", () => {
    expect(isOrphaned(100, closedTerminal, false)).toBe(true);
  });

  it("ignores an .app path in the claude process's own executable", () => {
    const t = tree([
      [100, 200, "/Applications/Some.app/Contents/Resources/claude"],
      [200, 1, "zsh"],
    ]);
    expect(isOrphaned(100, t, false)).toBe(true);
  });
});

describe("hostAcceptsTerminalInput", () => {
  it("allows input only for terminals and tmux", () => {
    const h = (kind: Parameters<typeof hostAcceptsTerminalInput>[0]["kind"]) => ({
      kind,
      appName: null,
      bundlePath: null,
      uriScheme: null,
    });
    expect(hostAcceptsTerminalInput(h("terminal"))).toBe(true);
    expect(hostAcceptsTerminalInput(h("tmux"))).toBe(true);
    expect(hostAcceptsTerminalInput(h("vscode-extension"))).toBe(false);
    expect(hostAcceptsTerminalInput(h("vscode-terminal"))).toBe(false);
    expect(hostAcceptsTerminalInput(h("app"))).toBe(false);
  });
});

describe("appBundleFromComm", () => {
  it("returns the outermost bundle, keeping spaces", () => {
    expect(appBundleFromComm(`${VSCODE}/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper`)).toBe(VSCODE);
    expect(appBundleFromComm("/bin/zsh")).toBeNull();
  });
});
