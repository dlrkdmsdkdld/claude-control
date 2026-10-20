import { describe, expect, it } from "vitest";
import { decodeLsofName, isAuxiliaryClaudeArgs, parseEnvHints, sessionIdFromArgs } from "./process-utils";

describe("decodeLsofName", () => {
  it("decodes lsof's \\xNN escapes back into UTF-8 (Korean folder names)", () => {
    const escaped =
      "/Volumes/X31/WORKSPACE/\\xe1\\x84\\x89\\xe1\\x85\\xa5\\xe1\\x86\\xbc\\xe1\\x84\\x80\\xe1\\x85\\xa7\\xe1\\x86\\xbc\\xe1\\x84\\x8b\\xe1\\x85\\xb5\\xe1\\x86\\xaf\\xe1\\x84\\x83\\xe1\\x85\\xa9\\xe1\\x86\\xa8/bibleapps";
    expect(decodeLsofName(escaped).normalize("NFC")).toBe("/Volumes/X31/WORKSPACE/성경일독/bibleapps");
  });

  it("leaves plain paths (including spaces) untouched", () => {
    expect(decodeLsofName("/Users/me/My Project")).toBe("/Users/me/My Project");
  });
});

describe("sessionIdFromArgs", () => {
  it("reads --resume=<id> as passed by the VS Code extension", () => {
    expect(
      sessionIdFromArgs(
        "/x/claude --output-format stream-json --resume=ae6c2ca6-ecef-47b3-ad9e-7953af450f1b --setting-sources=user",
      ),
    ).toBe("ae6c2ca6-ecef-47b3-ad9e-7953af450f1b");
  });

  it("reads --session-id <id>", () => {
    expect(sessionIdFromArgs("claude --session-id AE6C2CA6-ECEF-47B3-AD9E-7953AF450F1B")).toBe(
      "ae6c2ca6-ecef-47b3-ad9e-7953af450f1b",
    );
  });

  it("returns null for a new session or a bare --resume picker", () => {
    expect(sessionIdFromArgs("claude --output-format stream-json")).toBeNull();
    expect(sessionIdFromArgs("claude --resume")).toBeNull();
  });
});

describe("isAuxiliaryClaudeArgs", () => {
  it("flags helper processes", () => {
    expect(isAuxiliaryClaudeArgs("/Users/me/.local/bin/claude --chrome-native-host")).toBe(true);
    expect(isAuxiliaryClaudeArgs("claude mcp serve")).toBe(true);
  });

  it("keeps conversations", () => {
    expect(isAuxiliaryClaudeArgs("claude")).toBe(false);
    expect(isAuxiliaryClaudeArgs("claude --output-format stream-json --input-format stream-json")).toBe(false);
  });
});

describe("parseEnvHints", () => {
  it("keeps only whitelisted variables", () => {
    const env =
      " ANTHROPIC_API_KEY=sk-secret CLAUDE_CONFIG_DIR=/Users/me/.claude-acct2 CLAUDE_CODE_ENTRYPOINT=claude-vscode TOKEN=x";
    const hints = parseEnvHints(env);
    expect(hints).toEqual({ configDir: "/Users/me/.claude-acct2", entrypoint: "claude-vscode" });
    expect(JSON.stringify(hints)).not.toContain("secret");
  });

  it("does not match a variable whose name merely ends with the key", () => {
    expect(parseEnvHints(" MY_CLAUDE_CONFIG_DIR=/tmp").configDir).toBeNull();
  });
});
