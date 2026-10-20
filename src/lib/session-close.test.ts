import { describe, expect, it } from "vitest";
import { extractConversationTitle, findTabShell, windowShowsConversation } from "./session-close";
import type { ProcessTreeEntry } from "./terminal/types";

function tree(entries: [number, number, string][]): Map<number, ProcessTreeEntry> {
  return new Map(entries.map(([pid, ppid, comm]) => [pid, { ppid, cpuPercent: 0, comm }]));
}

describe("findTabShell", () => {
  it("finds the tab's shell through a launcher wrapper (GitKraken terminal)", () => {
    const t = tree([
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
    expect(findTabShell(21792, t)).toBe(16006);
  });

  it("picks the topmost shell when shells are nested, and stops at login", () => {
    const t = tree([
      [100, 200, "claude"],
      [200, 300, "bash"],
      [300, 400, "-zsh"],
      [400, 500, "login"],
      [500, 1, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"],
    ]);
    expect(findTabShell(100, t)).toBe(300);
  });

  it("returns null for the VS Code extension (no shell between claude and the app)", () => {
    const t = tree([
      [30812, 29392, "/Users/me/.vscode/extensions/anthropic.claude-code-2.1.301/resources/native-binary/claude"],
      [
        29392,
        1727,
        "/Users/me/Desktop/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
      ],
      [1727, 1, "/Users/me/Desktop/Visual Studio Code.app/Contents/MacOS/Code"],
    ]);
    expect(findTabShell(30812, t)).toBeNull();
  });
});

describe("extractConversationTitle", () => {
  it("returns the latest AI title, escaped characters included", () => {
    const jsonl = [
      '{"type":"ai-title","aiTitle":"Old title"}',
      '{"type":"user","message":{"content":"hi"}}',
      '{"type":"ai-title","aiTitle":"Play 데이터 \\"보안\\" 실행"}',
    ].join("\n");
    expect(extractConversationTitle(jsonl)).toBe('Play 데이터 "보안" 실행');
  });

  it("prefers a user-set custom title", () => {
    const jsonl = '{"type":"custom-title","customTitle":"My tab"}\n{"type":"ai-title","aiTitle":"AI"}';
    expect(extractConversationTitle(jsonl)).toBe("My tab");
  });

  it("returns null without a title", () => {
    expect(extractConversationTitle('{"type":"user"}')).toBeNull();
  });
});

describe("windowShowsConversation", () => {
  it("matches the active editor part of a VS Code window title", () => {
    expect(
      windowShowsConversation(
        "Play 데이터 보안 자동화 패키지 실행 — play-data-safety-mac",
        "Play 데이터 보안 자동화 패키지 실행",
      ),
    ).toBe(true);
  });

  it("matches titles VS Code truncated with an ellipsis", () => {
    expect(windowShowsConversation("TravelBit_jpkr_final CSV… — Downloads", "TravelBit_jpkr_final CSV 정리")).toBe(
      true,
    );
  });

  it("does not match another editor tab", () => {
    expect(windowShowsConversation("robo-summary.md — remoteConfigInsert", "Robo summary review")).toBe(false);
    expect(windowShowsConversation("● main.ts — app", "main")).toBe(false);
  });

  it("refuses very short truncated prefixes", () => {
    expect(windowShowsConversation("Fi… — app", "Fix the build")).toBe(false);
  });
});
