import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { escapeProjectDirName, findTranscriptForSession, listClaudeConfigDirs } from "./claude-config";

describe("escapeProjectDirName", () => {
  it("replaces slashes", () => {
    expect(escapeProjectDirName("/Users/me/project")).toBe("-Users-me-project");
  });

  it("replaces underscores, dots and spaces like the CLI does", () => {
    expect(escapeProjectDirName("/Users/dev_mac_01/prompt_tester")).toBe("-Users-dev-mac-01-prompt-tester");
    expect(escapeProjectDirName("/a/my.app v2")).toBe("-a-my-app-v2");
  });

  it("replaces each Korean character with one dash", () => {
    // Observed on disk: /Volumes/X31/WORKSPACE/성경일독/bibleapps → -Volumes-X31-WORKSPACE------bibleapps
    expect(escapeProjectDirName("/Volumes/X31/WORKSPACE/성경일독/bibleapps")).toBe(
      "-Volumes-X31-WORKSPACE------bibleapps",
    );
  });
});

describe("findTranscriptForSession", () => {
  let root: string;
  const sid = "a5ab01fe-5fdc-43c3-af6d-6d21edc198bd";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-config-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds the transcript in the session's own config dir", async () => {
    const acct2 = join(root, ".claude-acct2");
    const dir = join(acct2, "projects", "-Users-me-my-app");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sid}.jsonl`), "{}\n");
    await mkdir(join(root, ".claude", "projects"), { recursive: true });

    const found = await findTranscriptForSession([join(root, ".claude"), acct2], "/Users/me/my_app", sid);
    expect(found).toBe(join(dir, `${sid}.jsonl`));
  });

  it("falls back to scanning project dirs when the escaped name differs", async () => {
    const dir = join(root, ".claude", "projects", "-some-hashed-long-name-1a2b3c");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sid}.jsonl`), "{}\n");

    expect(await findTranscriptForSession([join(root, ".claude")], "/x/y", sid)).toBe(join(dir, `${sid}.jsonl`));
  });

  it("never returns another session's transcript, even the newest one in the project", async () => {
    const dir = join(root, ".claude", "projects", "-x-y");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "11111111-1111-1111-1111-111111111111.jsonl"), "{}\n");

    expect(await findTranscriptForSession([join(root, ".claude")], "/x/y", sid)).toBeNull();
  });
});

describe("listClaudeConfigDirs", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-dirs-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("includes extra dirs (e.g. CLAUDE_CONFIG_DIR) that look like config dirs", async () => {
    const custom = join(root, "my claude cfg");
    await mkdir(join(custom, "sessions"), { recursive: true });
    const notConfig = join(root, "random");
    await mkdir(notConfig, { recursive: true });

    const dirs = await listClaudeConfigDirs([custom, notConfig]);
    expect(dirs).toContain(custom);
    expect(dirs).not.toContain(notConfig);
  });
});
