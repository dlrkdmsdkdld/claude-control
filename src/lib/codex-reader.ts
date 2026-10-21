import { PREVIEW_TEXT_MAX_LENGTH } from "./constants";
import type { ConversationMessage, ConversationPreview, ToolInfo } from "./types";

/**
 * Codex CLI rollout lines (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl):
 * { timestamp, type: "event_msg" | "response_item" | "turn_context" | …, payload: { type, … } }
 */
export interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    message?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    content?: Array<{ type?: string; text?: string }>;
    approval_policy?: string;
    last_agent_message?: string;
  };
}

export interface CodexTurnState {
  /** A turn started and has not completed or been aborted */
  inTurn: boolean;
  /** Last turn ended with an error event */
  errored: boolean;
  /** Tool calls in the current turn still waiting for their output */
  pendingCalls: { name: string; at: number | null }[];
  /** Latest approval policy ("never" means tools never wait for approval) */
  approvalPolicy: string | null;
}

const TURN_START = new Set(["task_started", "turn_started"]);
const TURN_END = new Set(["task_complete", "turn_complete", "turn_aborted"]);

/** function_call, custom_tool_call, local_shell_call… (outputs end in "_call_output") */
function isCall(t: string | undefined): boolean {
  return !!t && t.endsWith("_call");
}

/**
 * `truncated`: lines are only the tail of the rollout. A long turn writes more
 * than the tail holds, so its task_started falls outside it; with no turn
 * boundary in a truncated tail, the turn is still in progress (after
 * task_complete Codex writes almost nothing until the next turn).
 */
export function codexTurnState(lines: CodexLine[], opts: { truncated?: boolean } = {}): CodexTurnState {
  let inTurn = false;
  let sawBoundary = false;
  let errored = false;
  let approvalPolicy: string | null = null;
  let pending = new Map<string, { name: string; at: number | null }>();

  for (const line of lines) {
    const p = line.payload;
    if (!p) continue;
    if (line.type === "turn_context" && p.approval_policy) approvalPolicy = p.approval_policy;
    if (line.type === "event_msg") {
      if (TURN_START.has(p.type ?? "")) {
        sawBoundary = true;
        inTurn = true;
        errored = false;
        pending = new Map();
      } else if (TURN_END.has(p.type ?? "")) {
        sawBoundary = true;
        inTurn = false;
        pending = new Map();
      } else if (p.type === "error" || p.type === "stream_error") {
        errored = true;
      }
    } else if (line.type === "response_item") {
      if (isCall(p.type) && p.call_id) {
        const at = line.timestamp ? Date.parse(line.timestamp) : NaN;
        pending.set(p.call_id, { name: p.name ?? p.type ?? "tool", at: isNaN(at) ? null : at });
      } else if (p.type?.endsWith("_call_output") && p.call_id) {
        pending.delete(p.call_id);
      }
    }
  }
  if (!sawBoundary && opts.truncated) inTurn = true;
  return { inTurn, errored: !inTurn && errored, pendingCalls: Array.from(pending.values()), approvalPolicy };
}

/** Text Codex injects as a "user" message (AGENTS.md, environment context), not typed by the user. */
const INJECTED_USER_TEXT = /^\s*(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<[a-z_]+>)/;

/**
 * A chat message from either rollout format: newer threads only record
 * response_item messages, older ones also record event_msg user/agent messages.
 * `useEvents` picks one format so messages aren't counted twice.
 */
function chatMessage(line: CodexLine, useEvents: boolean): { role: "user" | "assistant"; text: string } | null {
  const p = line.payload;
  if (!p) return null;
  if (useEvents) {
    if (line.type !== "event_msg" || !p.message) return null;
    if (p.type === "user_message") return { role: "user", text: p.message };
    if (p.type === "agent_message") return { role: "assistant", text: p.message };
    return null;
  }
  if (line.type !== "response_item" || p.type !== "message") return null;
  if (p.role !== "user" && p.role !== "assistant") return null;
  const text = (p.content ?? [])
    .filter((b) => b.type === "input_text" || b.type === "output_text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  if (!text || (p.role === "user" && INJECTED_USER_TEXT.test(text))) return null;
  return { role: p.role, text };
}

function hasEventMessages(lines: CodexLine[]): boolean {
  return lines.some(
    (l) => l.type === "event_msg" && (l.payload?.type === "user_message" || l.payload?.type === "agent_message"),
  );
}

function truncate(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > PREVIEW_TEXT_MAX_LENGTH ? `${t.slice(0, PREVIEW_TEXT_MAX_LENGTH)}…` : t;
}

export function codexPreview(lines: CodexLine[]): ConversationPreview {
  let lastUserMessage: string | null = null;
  let lastAssistantText: string | null = null;
  let userIdx = -1;
  let assistantIdx = -1;
  let messageCount = 0;
  let toolsSinceUser: ToolInfo[] = [];
  const useEvents = hasEventMessages(lines);

  lines.forEach((line, i) => {
    const p = line.payload;
    if (!p) return;
    const msg = chatMessage(line, useEvents);
    if (msg?.role === "user") {
      lastUserMessage = truncate(msg.text);
      userIdx = i;
      messageCount++;
      toolsSinceUser = [];
    } else if (msg?.role === "assistant") {
      lastAssistantText = truncate(msg.text);
      assistantIdx = i;
      messageCount++;
    } else if (line.type === "response_item" && isCall(p.type)) {
      toolsSinceUser.push({ name: p.name ?? p.type ?? "tool", input: null, description: null, warnings: [] });
    }
  });

  return {
    lastUserMessage,
    lastAssistantText,
    assistantIsNewer: assistantIdx > userIdx,
    lastTools: toolsSinceUser.slice(-3),
    messageCount,
  };
}

export function codexLinesToConversation(lines: CodexLine[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  const useEvents = hasEventMessages(lines);
  for (const line of lines) {
    const p = line.payload;
    if (!p) continue;
    const timestamp = line.timestamp ?? "";
    const msg = chatMessage(line, useEvents);
    if (msg) {
      out.push({ type: msg.role, timestamp, text: msg.text, toolUses: [] });
    } else if (line.type === "response_item" && isCall(p.type)) {
      let input: Record<string, unknown> | undefined;
      try {
        input = p.arguments ? JSON.parse(p.arguments) : undefined;
      } catch {
        input = undefined;
      }
      out.push({ type: "assistant", timestamp, text: null, toolUses: [{ name: p.name ?? p.type ?? "tool", input }] });
    }
  }
  return out;
}
