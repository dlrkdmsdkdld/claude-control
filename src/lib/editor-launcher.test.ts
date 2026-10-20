import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDITOR_OPTIONS } from "./config";
import {
  LaunchError,
  parseOpenJetBrainsProjects,
  readBundleId,
  resolveEditorApp,
  runningBundles,
  standardAppLocations,
} from "./editor-launcher";
import type { ProcessTreeEntry } from "./terminal/types";

const vscode = EDITOR_OPTIONS.find((e) => e.id === "vscode")!;
const studio = EDITOR_OPTIONS.find((e) => e.id === "android-studio")!;

async function makeApp(dir: string, name: string, bundleId: string): Promise<string> {
  const app = join(dir, `${name}.app`);
  await mkdir(join(app, "Contents"), { recursive: true });
  await writeFile(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`,
  );
  return app;
}

describe("editor options", () => {
  it("offers Android Studio with its bundle IDs", () => {
    expect(studio).toMatchObject({ label: "Android Studio", appName: "Android Studio", processName: "studio" });
    expect(studio.bundleIds).toContain("com.google.android.studio");
  });
});

describe("standardAppLocations", () => {
  it("includes the Desktop, not only /Applications", () => {
    const locs = standardAppLocations("Visual Studio Code");
    expect(locs).toContain("/Applications/Visual Studio Code.app");
    expect(locs).toContain(join(homedir(), "Desktop", "Visual Studio Code.app"));
  });
});

describe("runningBundles", () => {
  it("finds the bundle of a running editor's main executable only", () => {
    const tree = new Map<number, ProcessTreeEntry>([
      [1, { ppid: 0, cpuPercent: 0, comm: "/Users/me/Desktop/Visual Studio Code.app/Contents/MacOS/Code" }],
      [
        2,
        {
          ppid: 1,
          cpuPercent: 0,
          comm: "/Users/me/Desktop/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
        },
      ],
      [3, { ppid: 0, cpuPercent: 0, comm: "/Applications/Android Studio.app/Contents/MacOS/studio" }],
    ]);
    expect(runningBundles(tree, vscode)).toEqual(["/Users/me/Desktop/Visual Studio Code.app"]);
    expect(runningBundles(tree, studio)).toEqual(["/Applications/Android Studio.app"]);
  });
});

describe("resolveEditorApp (macOS)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-apps-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(process.platform === "darwin")("uses a user-chosen app in a folder with spaces and Korean", async () => {
    const dir = join(root, "내 앱 폴더");
    await mkdir(dir);
    const app = await makeApp(dir, "Visual Studio Code", "com.microsoft.VSCode");
    expect(await readBundleId(app)).toBe("com.microsoft.VSCode");
    expect(await resolveEditorApp(vscode, app, null)).toEqual({ bundlePath: app, source: "settings" });
  });

  it.runIf(process.platform === "darwin")("rejects a chosen app with the wrong bundle ID", async () => {
    const app = await makeApp(root, "Visual Studio Code", "com.example.fake");
    await expect(resolveEditorApp(vscode, app, null)).rejects.toBeInstanceOf(LaunchError);
  });

  it("explains how to fix a missing chosen app", async () => {
    const err = await resolveEditorApp(studio, join(root, "Missing.app"), null).catch((e) => e);
    expect(err).toBeInstanceOf(LaunchError);
    expect((err as LaunchError).hint).toContain("Settings");
  });

  it.runIf(process.platform === "darwin")("prefers the running copy over other installs", async () => {
    const app = await makeApp(root, "Visual Studio Code", "com.microsoft.VSCode");
    const tree = new Map<number, ProcessTreeEntry>([
      [1, { ppid: 0, cpuPercent: 0, comm: `${app}/Contents/MacOS/Code` }],
    ]);
    expect(await resolveEditorApp(vscode, undefined, tree)).toEqual({ bundlePath: app, source: "running" });
  });
});

describe("parseOpenJetBrainsProjects", () => {
  const nfd = "/Volumes/X31/WORKSPACE/성경일독/bibleapps".normalize("NFD");
  const xml = `<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>
    <entry key="${nfd}">
      <value>
        <RecentProjectMetaInfo frameTitle="Bible" opened="true" projectWorkspaceId="a">
        </RecentProjectMetaInfo>
      </value>
    </entry>
    <entry key="$USER_HOME$/orca/workspaces/app/dev-wt">
      <value>
        <RecentProjectMetaInfo opened="true" projectWorkspaceId="b">
        </RecentProjectMetaInfo>
      </value>
    </entry>
    <entry key="/Users/me/closed-project">
      <value>
        <RecentProjectMetaInfo projectWorkspaceId="c">
        </RecentProjectMetaInfo>
      </value>
    </entry>
  </map></option></component></application>`;

  it("lists only projects flagged as open, expanding $USER_HOME$", () => {
    expect(parseOpenJetBrainsProjects(xml, "/Users/me")).toEqual([
      "/Volumes/X31/WORKSPACE/성경일독/bibleapps".normalize("NFC"),
      "/Users/me/orca/workspaces/app/dev-wt",
    ]);
  });

  it("matches a Korean path regardless of Unicode normalization", () => {
    const open = parseOpenJetBrainsProjects(xml, "/Users/me");
    expect(open.includes("/Volumes/X31/WORKSPACE/성경일독/bibleapps".normalize("NFD").normalize("NFC"))).toBe(true);
  });
});
