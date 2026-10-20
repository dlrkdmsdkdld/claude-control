import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conversationUri,
  extensionDirFromBinary,
  extensionSupportsOpenSession,
  parseOpenFolders,
  resolveWorkspaceForCwd,
} from "./vscode";

describe("parseOpenFolders", () => {
  it("reads open window folders, decoding spaces and Korean", () => {
    const storage = JSON.stringify({
      windowsState: {
        lastActiveWindow: { folder: "file:///Users/me/My%20Project" },
        openedWindows: [
          { folder: "file:///Users/me/%EC%84%B1%EA%B2%BD" },
          { workspace: { configPath: "file:///x.code-workspace" } },
          { folder: "vscode-remote://ssh-remote+box/home" },
        ],
      },
    });
    expect(parseOpenFolders(storage).sort()).toEqual(["/Users/me/My Project", "/Users/me/성경"]);
  });

  it("returns [] for invalid content", () => {
    expect(parseOpenFolders("{")).toEqual([]);
  });
});

describe("resolveWorkspaceForCwd", () => {
  const folders = ["/Users/me", "/Users/me/app", "/Users/me/app-tools"];

  it("prefers the exact or deepest containing folder", () => {
    expect(resolveWorkspaceForCwd("/Users/me/app", folders)).toBe("/Users/me/app");
    expect(resolveWorkspaceForCwd("/Users/me/app/src", folders)).toBe("/Users/me/app");
  });

  it("does not treat a name prefix as a parent folder", () => {
    expect(resolveWorkspaceForCwd("/Users/me/application", ["/Users/me/app"])).toBeNull();
  });
});

describe("extension URI support", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-ext-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("derives the extension dir from the bundled CLI path", () => {
    expect(
      extensionDirFromBinary(
        "/Users/me/.vscode/extensions/anthropic.claude-code-2.1.301-darwin-arm64/resources/native-binary/claude",
      ),
    ).toBe("/Users/me/.vscode/extensions/anthropic.claude-code-2.1.301-darwin-arm64");
    expect(extensionDirFromBinary("/Users/me/.local/bin/claude")).toBeNull();
  });

  it("only reports support when extension.js handles /open?session=", async () => {
    const supported = join(root, "anthropic.claude-code-2.1.301");
    const legacy = join(root, "anthropic.claude-code-1.0.0");
    await mkdir(supported);
    await mkdir(legacy);
    await writeFile(
      join(supported, "extension.js"),
      'x.registerUriHandler({handleUri(O){let R=new URLSearchParams(O.query);switch(O.path){case"/open":{let x=R.get("session")}}}})',
    );
    await writeFile(join(legacy, "extension.js"), "x.registerCommand('claude-vscode.editor.open')");

    expect(await extensionSupportsOpenSession(supported)).toBe(true);
    expect(await extensionSupportsOpenSession(legacy)).toBe(false);
    expect(await extensionSupportsOpenSession(null)).toBe(false);
  });

  it("builds the conversation URI", () => {
    expect(conversationUri("vscode", "ae6c2ca6-ecef-47b3-ad9e-7953af450f1b")).toBe(
      "vscode://anthropic.claude-code/open?session=ae6c2ca6-ecef-47b3-ad9e-7953af450f1b",
    );
  });
});
