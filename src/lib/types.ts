export type ViewMode = "grid" | "list";

/** Editors offered as explicit "Open in …" choices on every card, regardless of the default editor. */
export const QUICK_OPEN_EDITOR_IDS = ["vscode", "android-studio"];

export type SessionStatus = "working" | "done" | "idle" | "waiting" | "errored" | "finished" | "unknown";

export const statusLabels: Record<SessionStatus, string> = {
  working: "Working",
  done: "Done",
  idle: "Idle",
  waiting: "Waiting",
  errored: "Error",
  finished: "Finished",
  unknown: "상태 확인 불가",
};

/** What a claude process runs under. */
export type SessionHostKind = "terminal" | "tmux" | "vscode-extension" | "vscode-terminal" | "app" | "unknown";

export interface SessionHost {
  kind: SessionHostKind;
  /** e.g. "iTerm2", "Visual Studio Code", "GitKraken" */
  appName: string | null;
  /** .app bundle running the session, when known (VS Code family / other apps) */
  bundlePath: string | null;
  /** URL scheme of a VS Code–family editor ("vscode", "cursor", …) */
  uriScheme: string | null;
}

/**
 * How the transcript was linked to the process:
 * - registry: the CLI's own <configDir>/sessions/<pid>.json
 * - hook: claude-control status hook event keyed by PID
 * - args: --resume / --session-id on the command line
 * - inferred: the only unlinked process in that project, transcript written after it started
 * - lock: Codex thread-writer lock held by the process
 * - null: no evidence — transcript not linked
 */
export type TranscriptLinkSource = "registry" | "hook" | "args" | "inferred" | "lock";

export type SessionAgent = "claude" | "codex";

export interface ClaudeSession {
  id: string;
  /** Which coding agent runs the session */
  agent: SessionAgent;
  pid: number | null;
  workingDirectory: string;
  repoName: string | null;
  parentRepo: string | null;
  isWorktree: boolean;
  branch: string | null;
  status: SessionStatus;
  lastActivity: string;
  startedAt: string | null;
  git: GitSummary | null;
  preview: ConversationPreview;
  taskSummary: TaskSummary | null;
  hasPendingToolUse: boolean;
  jsonlPath: string | null;
  prUrl: string | null;
  orphaned: boolean;
  tmuxSession: string | null;
  host: SessionHost;
  /** CLI entrypoint ("cli", "claude-vscode", …) when known */
  entrypoint: string | null;
  /** Claude config dir the session belongs to (e.g. ~/.claude-acct2), when known */
  configDir: string | null;
  linkSource: TranscriptLinkSource | null;
  /** Where the status came from; "none" means it could not be determined */
  statusSource: "registry" | "hook" | "transcript" | "process-exit" | "none";
  /** Workspace folder of the VS Code window hosting the session, when known */
  editorWorkspace: string | null;
  /** Whether the hosting VS Code extension supports opening this conversation by ID */
  canOpenConversation: boolean;
  /** Whether typed input (Create PR, quick reply) can be delivered */
  acceptsInput: boolean;
  /** The process also hosts other conversations (Codex app-server) — never end it from here */
  sharedProcess: boolean;
}

export interface GitSummary {
  branch: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  untrackedFiles: number;
  shortStat: string;
}

export interface ToolInfo {
  name: string;
  input: string | null;
  description: string | null;
  warnings: string[];
}

export interface ConversationPreview {
  lastUserMessage: string | null;
  lastAssistantText: string | null;
  /** Whether the assistant text came after the last user message */
  assistantIsNewer: boolean;
  lastTools: ToolInfo[];
  messageCount: number;
}

export interface TaskSummary {
  title: string;
  description: string | null;
  source: "linear" | "prompt" | "user";
  ticketId: string | null;
  ticketUrl: string | null;
}

export type PrChecks = "passing" | "failing" | "pending" | "none";
export type PrReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export interface PrStatus {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  checks: PrChecks;
  reviewDecision: PrReviewDecision;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
  checksDetail?: { total: number; passing: number; failing: number; pending: number };
  unresolvedThreads: number;
  commentCount: number;
}

export interface SessionDetail extends ClaudeSession {
  conversation: ConversationMessage[];
  gitDiff: string | null;
}

export interface ConversationMessage {
  type: "user" | "assistant";
  timestamp: string;
  text: string | null;
  toolUses: { name: string; input?: Record<string, unknown> }[];
}

export interface SessionGroup {
  repoName: string;
  repoPath: string;
  sessions: ClaudeSession[];
}
