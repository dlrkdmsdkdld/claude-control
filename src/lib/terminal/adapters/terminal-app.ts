import { APPLESCRIPT_FOCUS_DELAY_S } from "../../constants";
import type { TerminalInfo } from "../types";
import {
  escapeForAppleScript,
  execFileAsync,
  mapKeystrokeToSystemEvents,
  OSASCRIPT_TIMEOUT_MS,
  systemEventsScript,
  withFocusDelay,
} from "./shared";
import type { CreateSessionOpts, TerminalAdapter } from "./types";

function focusScript(ttyPath: string): string {
  const safeTty = escapeForAppleScript(ttyPath);
  // Uses a flag variable instead of `return` to break out of nested loops.
  // In AppleScript, `return` exits the entire script — when this focus script
  // is composed with an action via withFocusDelay(), `return` would prevent
  // the action (keystroke, text) from ever executing.
  return `tell application "Terminal"
  activate
  set found to false
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      if tty of aTab is "${safeTty}" then
        set selected tab of aWindow to aTab
        set index of aWindow to 1
        set found to true
        exit repeat
      end if
    end repeat
    if found then exit repeat
  end repeat
end tell`;
}

/**
 * Abort the script unless the front window's selected tab is the target —
 * keystrokes go to whatever is frontmost, so never type into another window.
 */
function frontTabGuard(ttyPath: string): string {
  const safeTty = escapeForAppleScript(ttyPath);
  return `tell application "Terminal"
  if tty of selected tab of front window is not "${safeTty}" then error "focus-mismatch"
end tell
`;
}

/**
 * Close the Terminal tab whose tty matches. A single-tab window is closed by
 * id through Terminal's dictionary. The dictionary can't close one tab of a
 * multi-tab window, so that case selects the tab and uses cmd-W — but only
 * after re-checking that the front window's selected tab is the target, so
 * the keystroke can never land on another window.
 */
export function closeScript(ttyPath: string): string {
  const safeTty = escapeForAppleScript(ttyPath);
  return `set targetId to missing value
set tabCount to 0
tell application "Terminal"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      if tty of aTab is "${safeTty}" then
        set targetId to id of aWindow
        set tabCount to count of tabs of aWindow
        set selected tab of aWindow to aTab
      end if
    end repeat
  end repeat
  if targetId is missing value then return "not-found"
  if tabCount is 1 then
    close window id targetId
    return "closed-window"
  end if
  set index of window id targetId to 1
  activate
end tell
delay ${APPLESCRIPT_FOCUS_DELAY_S}
tell application "Terminal"
  if id of front window is not targetId then return "focus-mismatch"
  if tty of selected tab of front window is not "${safeTty}" then return "focus-mismatch"
end tell
tell application "System Events" to tell process "Terminal" to keystroke "w" using command down
return "closed-tab"`;
}

export const terminalAppAdapter: TerminalAdapter = {
  async focus(info: TerminalInfo): Promise<void> {
    await execFileAsync("osascript", ["-e", focusScript(info.tty)], { timeout: OSASCRIPT_TIMEOUT_MS });
  },

  async sendText(info: TerminalInfo, text: string): Promise<void> {
    const asEscaped = escapeForAppleScript(text);
    const action =
      frontTabGuard(info.tty) + systemEventsScript("Terminal", `keystroke "${asEscaped}"\n    keystroke return`);
    const script = withFocusDelay(focusScript(info.tty), action, APPLESCRIPT_FOCUS_DELAY_S);
    await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
  },

  async sendKeystroke(info: TerminalInfo, keystroke: string): Promise<void> {
    const asKeystroke = mapKeystrokeToSystemEvents(keystroke);
    const action = frontTabGuard(info.tty) + systemEventsScript("Terminal", asKeystroke);
    const script = withFocusDelay(focusScript(info.tty), action, APPLESCRIPT_FOCUS_DELAY_S);
    await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
  },

  async closeSession(info: TerminalInfo): Promise<void> {
    const { stdout } = await execFileAsync("osascript", ["-e", closeScript(info.tty)], {
      timeout: OSASCRIPT_TIMEOUT_MS,
    });
    const result = stdout.trim();
    if (result !== "closed-window" && result !== "closed-tab") {
      throw new Error(`Terminal tab not closed (${result || "no result"})`);
    }
  },

  async createSession(command: string, opts: CreateSessionOpts): Promise<void> {
    const asCmd = escapeForAppleScript(command);
    // "do script in front window" opens a tab; plain "do script" opens a new window.
    // When requesting a tab, check that a window exists first — "in front window"
    // fails if Terminal has no open windows.
    const script =
      opts.openIn === "tab"
        ? `tell application "Terminal"
  activate
  if (count of windows) > 0 then
    do script "${asCmd}" in front window
  else
    do script "${asCmd}"
  end if
end tell`
        : `tell application "Terminal"
  activate
  do script "${asCmd}"
end tell`;
    await execFileAsync("osascript", ["-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
  },
};
