/**
 * Pure view-model for the Agents panel. Two halves:
 *
 * - checked-in `t3.json` script derivation plus the script-run terminal plan
 *   over `t3.terminal/control` (the native settings script list has no
 *   public read contract; the checked-in file is readable through
 *   `t3.workspace/files` `readText`), and
 * - the live fleet view over `t3.orchestration/status` + `t3.orchestration/
 *   control`: the subscribe stream already delivers
 *   the server-folded `RuntimeSubagent[]`, pending requests, checkpoints,
 *   session and turn — this module derives the panel model (workflow groups,
 *   status visuals, activity lines, counts), the per-operation capability
 *   gating, and the verified checkpoint-diff reassembly.
 *
 * The roster/status derivation ports `deriveAgentPanelModel` and friends from
 * the native fold module semantics — the server adapter delivers rows in the
 * same shape the native panel renders, and the port keeps the plugin's
 * grouping/count rules identical rather than approximated.
 */
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import type {
  AgentsEvent,
  AgentsState,
  ApprovalOption,
  OrchestrationCapabilities,
  OrchestrationCheckpoint,
  OrchestrationControlMethods,
  OrchestrationReceipt,
  PendingApproval,
  RuntimeSubagent,
  RuntimeSubagentStatus,
  UserInputQuestion,
  VcsDiffPreviewStreamEvent,
  VcsDiffStreamSource,
} from "@t3tools/extension-sdk/catalogue";

/** One runnable entry parsed from the checked-in t3.json (`T3ProjectFileScript` shape). */
export interface WorkspaceScript {
  readonly name: string;
  readonly command: string;
  readonly icon: string | null;
  readonly runOnWorktreeCreate: boolean;
  readonly previewUrl: string | null;
}

export type ScriptSourceState =
  | { readonly kind: "ready"; readonly scripts: readonly WorkspaceScript[] }
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string };

/** `T3_PROJECT_FILE_MAX_SCRIPTS` — a longer scripts array fails the native decode too. */
export const T3_PROJECT_FILE_MAX_SCRIPTS = 50;
/** `ProjectScriptIcon` literals from `@t3tools/contracts` (kept package-local). */
const SCRIPT_ICONS = new Set(["play", "test", "lint", "configure", "build", "debug"]);

const trimmedNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Parse the checked-in `t3.json` scripts array into runnable entries. The
 * native loader treats an unparseable or invalid file as absent; the panel
 * instead shows the invalid state by name (the settings UI does the same —
 * "t3.json is invalid").
 */
export function parseT3ProjectFile(contents: string): ScriptSourceState {
  let root: unknown;
  try {
    root = JSON.parse(contents);
  } catch {
    return { kind: "invalid", message: "t3.json is not valid JSON" };
  }
  if (root === null || typeof root !== "object" || Array.isArray(root))
    return { kind: "invalid", message: "t3.json must be a JSON object" };
  const scripts = (root as { readonly scripts?: unknown }).scripts;
  if (scripts === undefined) return { kind: "empty" };
  if (!Array.isArray(scripts))
    return { kind: "invalid", message: "t3.json scripts must be an array" };
  if (scripts.length > T3_PROJECT_FILE_MAX_SCRIPTS)
    return {
      kind: "invalid",
      message: `t3.json declares ${scripts.length} scripts (max ${T3_PROJECT_FILE_MAX_SCRIPTS})`,
    };
  const parsed: WorkspaceScript[] = [];
  for (const [index, entry] of scripts.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return { kind: "invalid", message: `t3.json script #${index + 1} must be an object` };
    const record = entry as Record<string, unknown>;
    if (!trimmedNonEmpty(record.name))
      return { kind: "invalid", message: `t3.json script #${index + 1} needs a non-empty name` };
    if (!trimmedNonEmpty(record.command))
      return {
        kind: "invalid",
        message: `t3.json script "${record.name as string}" needs a non-empty command`,
      };
    if (
      record.icon !== undefined &&
      (typeof record.icon !== "string" || !SCRIPT_ICONS.has(record.icon))
    )
      return {
        kind: "invalid",
        message: `t3.json script "${record.name}" has an unknown icon "${String(record.icon)}"`,
      };
    if (record.runOnWorktreeCreate !== undefined && typeof record.runOnWorktreeCreate !== "boolean")
      return {
        kind: "invalid",
        message: `t3.json script "${record.name}" runOnWorktreeCreate must be a boolean`,
      };
    if (record.previewUrl !== undefined && !trimmedNonEmpty(record.previewUrl))
      return {
        kind: "invalid",
        message: `t3.json script "${record.name}" previewUrl must be a non-empty string`,
      };
    parsed.push({
      name: record.name.trim(),
      command: record.command.trim(),
      icon: (record.icon as string | undefined) ?? null,
      runOnWorktreeCreate: record.runOnWorktreeCreate === true,
      previewUrl: (record.previewUrl as string | undefined)?.trim() || null,
    });
  }
  return parsed.length === 0 ? { kind: "empty" } : { kind: "ready", scripts: parsed };
}

/**
 * The launch identity the extension view context carries: the host's
 * `extensionWorkspaceRevision` payload, JSON `[workspaceRoot, worktreePath|null]`.
 * Same parse the terminal package runs on the same field.
 */
export interface ScriptWorkspace {
  /** The cwd a launched terminal must claim — worktree when the thread has one. */
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
}

export function workspaceFromRevision(
  workspaceRevision: string | undefined,
): ScriptWorkspace | null {
  if (workspaceRevision === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(workspaceRevision);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      parsed[0].trim().length === 0 ||
      (parsed[1] !== null && (typeof parsed[1] !== "string" || parsed[1].trim().length === 0))
    )
      return null;
    const workspaceRoot = parsed[0];
    const worktreePath = parsed[1];
    return { cwd: worktreePath ?? workspaceRoot, workspaceRoot, worktreePath };
  } catch {
    return null;
  }
}

/** Runtime env for the spawned terminal — the same helper native runProjectScript uses. */
export function scriptRuntimeEnv(workspace: ScriptWorkspace): Record<string, string> {
  return projectScriptRuntimeEnv({
    project: { cwd: workspace.workspaceRoot },
    worktreePath: workspace.worktreePath,
  });
}

/** New-terminal bounds mirror the native script-run spawn (ChatView SCRIPT_TERMINAL_*). */
export const SCRIPT_TERMINAL_COLS = 120;
export const SCRIPT_TERMINAL_ROWS = 30;

/**
 * Terminal id slug for a script name. Same normalization as the native
 * script-id rule (trim, lowercase, non-alphanumerics collapse to dashes, edge
 * dashes trimmed), bounded so `t3-agents-<slug>-NN` always fits the 128-char
 * terminal id limit.
 */
const SCRIPT_SLUG_MAX = 24;
export function scriptSlug(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "script";
  if (cleaned.length <= SCRIPT_SLUG_MAX) return cleaned;
  return cleaned.slice(0, SCRIPT_SLUG_MAX).replace(/-+$/g, "") || "script";
}

export const SCRIPT_TERMINAL_PREFIX = "t3-agents-";
export function scriptTerminalBaseId(script: Pick<WorkspaceScript, "name">): string {
  return `${SCRIPT_TERMINAL_PREFIX}${scriptSlug(script.name)}`;
}

/**
 * Per-mount nonce baked into overflow ids. A recreated panel generates a new
 * nonce and therefore never re-picks ids a previous incarnation may have left
 * running, and concurrent clients allocate disjoint families — neither
 * `open` nor `attach` is create-exclusive, so a deterministic `-2` suffix is
 * not safe allocation on its own.
 */
export function scriptRunNonce(random: () => number = Math.random): string {
  return `${Date.now().toString(36)}${random().toString(36).slice(2, 8)}`;
}

/** Dedicated id plus bounded nonce-keyed overflow candidates for one run. */
export const SCRIPT_RUN_MAX_CANDIDATES = 4;
export function scriptTerminalCandidates(baseId: string, nonce: string): readonly string[] {
  const candidates = [baseId];
  for (let index = 2; index <= SCRIPT_RUN_MAX_CANDIDATES; index += 1)
    candidates.push(`${baseId}-${nonce}-${index}`);
  return candidates;
}

/** The busy half of the native allocation rule: a running subprocess means "allocate new". */
export function terminalBusy(
  metadata: { readonly hasRunningSubprocess?: boolean } | null | undefined,
): boolean {
  return metadata?.hasRunningSubprocess === true;
}

/** Session metadata the run glue consumes — structural over the control contract's result. */
export interface ScriptTerminalMetadata {
  readonly terminalId: string;
  readonly status: string;
  readonly hasRunningSubprocess: boolean;
}

/**
 * Whether a returned session is safe to write a script command into: it must
 * be the session that was asked for, alive, and running no foreground
 * subprocess. The control contract returns an existing session for a claimed
 * id instead of failing, so every returned session is verified before write —
 * a busy terminal must never receive script input.
 */
export function claimableTerminal(
  metadata: ScriptTerminalMetadata | null,
  expectedId: string,
): metadata is ScriptTerminalMetadata {
  return (
    metadata !== null &&
    metadata.terminalId === expectedId &&
    (metadata.status === "starting" || metadata.status === "running") &&
    metadata.hasRunningSubprocess === false
  );
}

function terminalRejection(metadata: ScriptTerminalMetadata | null, expectedId: string): string {
  if (metadata === null) return "no session returned";
  if (metadata.terminalId !== expectedId)
    return `identity mismatch (server returned ${metadata.terminalId})`;
  if (metadata.status !== "starting" && metadata.status !== "running")
    return `session ${metadata.status}`;
  return "busy — foreground process running";
}

/** Minimal `t3.terminal/control` surface the run glue needs (injected for tests). */
export interface ScriptRunControlOps {
  attach(input: {
    readonly terminalId: string;
    readonly restartIfNotRunning: boolean;
    readonly cwd: string;
    readonly worktreePath: string | null;
    readonly env: Record<string, string>;
    readonly cols: number;
    readonly rows: number;
  }): Promise<ScriptTerminalMetadata | null>;
  write(input: { readonly terminalId: string; readonly data: string }): Promise<unknown>;
}

/**
 * Row-18 run glue. Walks the candidate ids — the dedicated per-script id
 * first, then nonce-keyed overflow ids — attaching each with
 * `restartIfNotRunning` (spawn when absent, respawn when stopped, return
 * as-is when running). The returned session is checked before write, so a
 * collision with a live terminal owned by a previous panel or another client
 * skips to the next candidate instead of feeding its foreground process. If
 * every candidate is unclaimable the run fails by name with each rejection —
 * a missing write beats a misdirected one.
 */
export async function runWorkspaceScript(options: {
  readonly control: ScriptRunControlOps;
  readonly script: WorkspaceScript;
  readonly workspace: ScriptWorkspace;
  readonly nonce: string;
  readonly report: (run: ScriptRun) => void;
}): Promise<ScriptRun> {
  const { control, script, workspace, nonce, report } = options;
  const launch = {
    cwd: workspace.cwd,
    worktreePath: workspace.worktreePath,
    env: scriptRuntimeEnv(workspace),
    cols: SCRIPT_TERMINAL_COLS,
    rows: SCRIPT_TERMINAL_ROWS,
  } as const;
  const rejections: string[] = [];
  let terminalId: string | null = null;
  for (const [index, candidate] of scriptTerminalCandidates(
    scriptTerminalBaseId(script),
    nonce,
  ).entries()) {
    terminalId = candidate;
    const stage: ScriptRunStage = index === 0 ? "attach" : "claim";
    report({ kind: "running", stage, terminalId });
    let metadata: ScriptTerminalMetadata | null;
    try {
      metadata = await control.attach({
        terminalId,
        restartIfNotRunning: true,
        ...launch,
      });
    } catch (error) {
      rejections.push(
        `${terminalId}: ${error instanceof Error ? error.message : "terminal control unavailable"}`,
      );
      continue;
    }
    if (!claimableTerminal(metadata, terminalId)) {
      rejections.push(`${terminalId}: ${terminalRejection(metadata, terminalId)}`);
      continue;
    }
    report({ kind: "running", stage: "write", terminalId });
    try {
      await control.write({ terminalId, data: scriptWriteData(script.command) });
    } catch (error) {
      const failure: ScriptRun = {
        kind: "failed",
        stage: "write",
        terminalId,
        message: error instanceof Error ? error.message : "terminal control unavailable",
      };
      report(failure);
      return failure;
    }
    const sent: ScriptRun = { kind: "sent", terminalId, status: metadata.status };
    report(sent);
    return sent;
  }
  const failure: ScriptRun = {
    kind: "failed",
    stage: "claim",
    terminalId,
    message: `no claimable script terminal — ${rejections.join("; ")}`,
  };
  report(failure);
  return failure;
}

/** Native writes `${command}\r` to run a project script (ChatView runProjectScript). */
export function scriptWriteData(command: string): string {
  return `${command}\r`;
}

/** Script-run state machine for the panel's run rows. */
export type ScriptRunStage = "attach" | "claim" | "write";
export type ScriptRun =
  | {
      readonly kind: "running";
      readonly stage: ScriptRunStage;
      readonly terminalId: string;
    }
  | { readonly kind: "sent"; readonly terminalId: string; readonly status: string }
  | {
      readonly kind: "failed";
      readonly stage: ScriptRunStage;
      readonly terminalId: string | null;
      readonly message: string;
    };

export function describeScriptRun(run: ScriptRun): string {
  switch (run.kind) {
    case "running":
      return run.stage === "write"
        ? `Sending command to ${run.terminalId}…`
        : run.stage === "claim"
          ? `Dedicated terminal busy — trying ${run.terminalId}…`
          : `Opening terminal ${run.terminalId}…`;
    case "sent":
      return `Sent to ${run.terminalId} (session ${run.status}) — output appears in the terminal surface`;
    case "failed":
      return `Run failed while ${
        run.stage === "write"
          ? "writing the command"
          : run.stage === "claim"
            ? "claiming a free script terminal"
            : "opening the terminal"
      }${run.terminalId ? ` (${run.terminalId})` : ""}: ${run.message}`;
  }
}

export interface DeferredSection {
  readonly title: string;
  readonly blocker: string;
}

/**
 * Every capability the panel names but cannot serve. Rendered as static text —
 * a deferred section is a statement about a missing contract, not a promise of
 * data in flight.
 */
export const DEFERRED_SECTIONS: readonly DeferredSection[] = [
  {
    title: "Workflow launch",
    blocker: "no native binding exists to extract — net-new design, not fakeable",
  },
  {
    title: "Agent logs and session deep links",
    blocker: "no native web/desktop binding exists — net-new design",
  },
  {
    title: "Agent session scan/import (welcome wizard)",
    blocker:
      "native provisioning scan exists (agentSessions scan/import RPC) but is not in the shipped contract surface — needs a narrow public scan contract",
  },
  {
    title: "Mobile Agents surface",
    blocker: "web/desktop only — the same client restriction the native manifest declares",
  },
];

/** Why the scripts list covers only the checked-in file — the settings-backed half is deferred. */
export const SCRIPTS_SCOPE_NOTE =
  "Checked-in t3.json scripts only. Project scripts stored in settings (machine defaults and per-project overrides) are not readable through public contracts yet.";

/** The host-rendered half of Agents navigation, stated where a user would look for it. */
export const HOST_CHROME_NOTE =
  "The chat badge and spawn CTA rows are host chat UI a plugin cannot install; this surface is the plugin-owned half of Agents navigation.";

/**
 * The status contract does not project whether the thread is settled, so a
 * capability-gated settle control cannot render a stateful toggle — both
 * directions are offered and the command receipt reports the outcome.
 */
export const SETTLED_STATE_NOTE =
  "Thread settled state is not projected by t3.orchestration/status, so Settle and Unsettle are both offered when the provider supports them; the receipt reports the outcome.";

// ---------------------------------------------------------------------------
// t3.ui/theme consumption
// ---------------------------------------------------------------------------

/**
 * The roles this panel consumes, each republished as a `--t3-agents-*` custom
 * property on the view root. Component styles chain `var(--t3-agents-x, …)`
 * onto their pre-contract fallbacks, so a host that cannot serve the contract
 * (ungranted or provider-less) renders exactly what it rendered before
 * adoption. Roles absent here stay theme-independent on purpose: `--info` and
 * `--success` are host constants outside the contract's role set, and the
 * `font-*` vars are not color tokens.
 */
export const AGENTS_THEME_VARS = {
  mutedForeground: "--t3-agents-muted-foreground",
  border: "--t3-agents-border",
  error: "--t3-agents-error",
  text: "--t3-agents-text",
  canvas: "--t3-agents-canvas",
} as const;

/**
 * `getTokens` output → root-level custom properties. Each override carries the
 * contract's advertised var name with the resolved value as its fallback, so
 * the panel tracks `--app-theme-*` paints live and still gets the right color
 * on hosts that answer the contract without painting those variables. A role
 * missing from `tokens` is skipped entirely rather than overridden with a lie.
 */
export function themeVarOverrides(
  tokens: Readonly<Record<string, string>>,
  cssVars: Readonly<Record<string, string>>,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [role, property] of Object.entries(AGENTS_THEME_VARS)) {
    const value = tokens[role];
    if (value === undefined) continue;
    const contractVar = cssVars[role];
    overrides[property] = contractVar ? `var(${contractVar}, ${value})` : value;
  }
  return overrides;
}

/** `getTokens` output shape (the contract's resolved effective-theme pair). */
export interface UiThemeTokensResult {
  readonly tokens: Readonly<Record<string, string>>;
  readonly cssVars: Readonly<Record<string, string>>;
}

/** The two `t3.ui/theme` operations the panel needs, injected for tests. */
export interface ThemeVarsSource {
  getTokens(signal: AbortSignal): Promise<UiThemeTokensResult>;
  subscribeState(signal: AbortSignal): AsyncIterable<{ readonly type: string }>;
}

/**
 * Drives the `t3.ui/theme` read/subscribe pair and reports the custom-property
 * map through `emit`. `getTokens` resolves the host's effective theme — the
 * provider folds stored preference, session overlays, and external previews
 * into the painted state — and each `subscribeState` frame re-reads.
 *
 * The design's no-stale-fallback rule: the overrides exist only while the
 * contract can vouch for what the host is painting. A failed `getTokens` and
 * a closed, errored, or ended `subscribeState` stream both emit `null` so the
 * legacy `var()` chain takes over — a retained map would keep painting a
 * theme the panel can no longer observe changing. Once the stream is gone no
 * further read is trusted (in-flight resolutions are invalidated), and an
 * aborted signal silences the tracker entirely.
 */
export function trackThemeVars(
  source: ThemeVarsSource,
  signal: AbortSignal,
  emit: (vars: Record<string, string> | null) => void,
): void {
  let generation = 0;
  let live = true;
  const refresh = () => {
    const at = ++generation;
    void source.getTokens(signal).then(
      (snapshot) => {
        if (live && !signal.aborted && at === generation)
          emit(themeVarOverrides(snapshot.tokens, snapshot.cssVars));
      },
      () => {
        if (live && !signal.aborted && at === generation) emit(null);
      },
    );
  };
  refresh();
  void (async () => {
    try {
      for await (const frame of source.subscribeState(signal)) {
        if (signal.aborted) return;
        if (frame.type === "closed") break;
        refresh();
      }
    } catch {
      // A rejected or errored stream is stream loss, same as a closed frame.
    }
    if (signal.aborted) return;
    live = false;
    generation += 1;
    emit(null);
  })();
}

// ---------------------------------------------------------------------------
// Live orchestration model — t3.orchestration/status + t3.orchestration/control
// ---------------------------------------------------------------------------

/** Native terminal-status set (the client-runtime subagent fold). */
const TERMINAL_AGENT_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const isTerminalAgentStatus = (status: RuntimeSubagentStatus): boolean =>
  TERMINAL_AGENT_STATUSES.has(status);

/** pending/running/waiting — the statuses the native panel groups as "Working". */
export const isActiveAgentStatus = (status: RuntimeSubagentStatus): boolean =>
  status === "pending" || status === "running" || status === "waiting";

export type AgentStatusTone = "info" | "muted" | "success" | "danger";

export interface AgentStatusVisual {
  readonly tone: AgentStatusTone;
  readonly label: string;
}

/** Native visual collapse: working/idle/completed/failed/stopped. */
export const AGENT_STATUS_VISUALS: Record<RuntimeSubagentStatus, AgentStatusVisual> = {
  pending: { tone: "info", label: "Working" },
  running: { tone: "info", label: "Working" },
  waiting: { tone: "info", label: "Working" },
  idle: { tone: "muted", label: "Idle · resumable" },
  completed: { tone: "success", label: "Completed" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "muted", label: "Stopped" },
  interrupted: { tone: "muted", label: "Stopped" },
};

export const agentStatusVisual = (status: RuntimeSubagentStatus): AgentStatusVisual =>
  AGENT_STATUS_VISUALS[status] ?? { tone: "muted", label: status };

/** Native special case: a batch row at rest reads "Idle", not "Idle · resumable". */
export function agentStatusLabel(agent: RuntimeSubagent): string {
  return agent.kind === "subagent_batch" && agent.status === "idle"
    ? "Idle"
    : agentStatusVisual(agent.status).label;
}

/**
 * Native activity-line precedence (`AgentsPanel.agentActivityText`): a live
 * row shows progress, then last tool, then result, then error; a settled row
 * inverts to error, result, progress, last tool. Bounded strings only — the
 * contract already caps these fields.
 */
export function agentActivityText(agent: RuntimeSubagent): string | null {
  const tool = agent.lastToolName ? `▸ ${agent.lastToolName}` : null;
  if (isActiveAgentStatus(agent.status)) {
    return agent.progress ?? tool ?? agent.result ?? agent.error;
  }
  return agent.error ?? agent.result ?? agent.progress ?? tool;
}

/** Native elapsed format: `45s`, `3m 05s`, `1h 04m`. */
export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `startedAt` → `endIso` (or now) as elapsed text; "" on unparseable input. */
export function elapsedBetween(startedAt: string, endIso: string | null, now = Date.now()): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Compact model chip text (native `formatSubagentModelLabel`): strips vendor
 * prefixes/date-or-context suffixes; unknown ids pass through; effort appends
 * as "· high".
 */
export function formatAgentModelLabel(
  model: string | null | undefined,
  effort: string | null | undefined,
): string | null {
  if (!model) return null;
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}

/** Native token formatting (native `formatSubagentTokenCount`). */
export function formatAgentTokenCount(totalTokens: number): string {
  if (totalTokens < 1000) return `${totalTokens}`;
  if (totalTokens < 1_000_000) {
    const value = totalTokens / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`;
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}

/** Native metadata line: model chip, token count, tool uses, activation run. */
export function agentMetadataLine(agent: RuntimeSubagent): readonly string[] {
  return [
    formatAgentModelLabel(agent.model, agent.effort),
    agent.usage ? `${formatAgentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);
}

/** Native role-chip suppression: a role that just restates the title is hidden. */
export function agentVisibleRole(agent: RuntimeSubagent): string | null {
  return agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
    ? null
    : agent.role;
}

// --- Workflow grouping (port of native `deriveAgentPanelModel`) ---

export interface AgentsWorkflowPhaseGroup {
  readonly index: number;
  readonly title: string;
  readonly members: RuntimeSubagent[];
  readonly state: "pending" | "running" | "done";
  readonly activeCount: number;
  readonly settledCount: number;
}

export interface AgentsWorkflowGroup {
  readonly workflow: RuntimeSubagent;
  readonly phases: AgentsWorkflowPhaseGroup[];
  readonly unphasedMembers: RuntimeSubagent[];
}

export interface AgentsPanelModel {
  readonly workflows: AgentsWorkflowGroup[];
  readonly directAgents: RuntimeSubagent[];
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly idleCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
  readonly hasAgents: boolean;
  readonly liveCount: number;
}

const EMPTY_PANEL_MODEL: AgentsPanelModel = {
  workflows: [],
  directAgents: [],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: false,
  liveCount: 0,
};

const byFirstSeen = (a: RuntimeSubagent, b: RuntimeSubagent): number =>
  a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id);
const byAgentIndex = (a: RuntimeSubagent, b: RuntimeSubagent): number =>
  (a.agentIndex ?? 0) - (b.agentIndex ?? 0);

/**
 * Port of the native `deriveAgentPanelModel`. Workflow coordinators with
 * members are containers — they group phases but do not double-count work or
 * tokens. Members whose coordinator left the roster window fall back to the
 * flat list so nothing is silently hidden.
 */
export function deriveAgentsPanelModel(agents: readonly RuntimeSubagent[]): AgentsPanelModel {
  if (agents.length === 0) return EMPTY_PANEL_MODEL;

  const workflows = agents
    .filter((agent) => agent.kind === "workflow")
    .slice()
    .sort(byFirstSeen);
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const members = new Map<string, RuntimeSubagent[]>();
  const direct: RuntimeSubagent[] = [];

  for (const agent of agents) {
    if (agent.kind === "workflow") continue;
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      const list = members.get(agent.parentAgentId) ?? [];
      list.push(agent);
      members.set(agent.parentAgentId, list);
    } else {
      // Orphaned members (coordinator aged out) fall back to the direct list.
      direct.push(agent);
    }
  }

  const workflowGroups: AgentsWorkflowGroup[] = workflows.map((workflow) => {
    const workflowMembers = members.get(workflow.id) ?? [];
    const knownPhases =
      workflow.phases.length > 0
        ? workflow.phases
        : (() => {
            const derived = new Map<number, string>();
            for (const member of workflowMembers) {
              if (member.phaseIndex !== null && !derived.has(member.phaseIndex)) {
                derived.set(
                  member.phaseIndex,
                  member.phaseTitle ?? `Phase ${member.phaseIndex + 1}`,
                );
              }
            }
            return Array.from(derived.entries())
              .map(([index, title]) => ({ index, title }))
              .sort((a, b) => a.index - b.index);
          })();

    const knownPhaseIndices = new Set(knownPhases.map((phase) => phase.index));
    const phases = knownPhases.map((phase): AgentsWorkflowPhaseGroup => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .slice()
        .sort(byAgentIndex);
      const activeCount = phaseMembers.filter(
        // Idle members count as active for phase-liveness: a resumable member
        // has not finished the phase.
        (member) => isActiveAgentStatus(member.status) || member.status === "idle",
      ).length;
      const settledCount = phaseMembers.filter((member) =>
        isTerminalAgentStatus(member.status),
      ).length;
      return {
        index: phase.index,
        title: phase.title,
        members: phaseMembers,
        state:
          phaseMembers.length === 0
            ? "pending"
            : activeCount > 0
              ? "running"
              : settledCount === phaseMembers.length
                ? "done"
                : "pending",
        activeCount,
        settledCount,
      };
    });

    // Unknown phase indices land here too — a member must never vanish just
    // because its phase row was lost.
    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null || !knownPhaseIndices.has(member.phaseIndex))
      .slice()
      .sort(byAgentIndex);

    return { workflow: workflow, phases, unphasedMembers };
  });

  let runningCount = 0;
  let waitingCount = 0;
  let idleCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of agents) {
    // A workflow coordinator with members is a container for those members, not
    // work of its own: it reports running for the whole run and aggregates their
    // usage upstream in some providers. Counting it would report one more agent
    // working than there are, and double count tokens.
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else settledCount += 1;
    totalTokens += agent.usage?.totalTokens ?? 0;
  }

  return {
    workflows: workflowGroups,
    // Updates and the retention ranking must never reshuffle rows that remain
    // visible.
    directAgents: direct.slice().sort(byFirstSeen),
    runningCount,
    waitingCount,
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: true,
    liveCount: runningCount + waitingCount,
  };
}

// --- Stream fold -----------------------------------------------------------

export interface AgentsFeedState {
  /** Latest delivered projection, or null before the first snapshot. */
  readonly state: AgentsState | null;
  readonly streamEpoch: string | null;
  readonly revision: number;
  /** Most recent control receipt projected by the stream. */
  readonly lastReceipt: OrchestrationReceipt | null;
  /** Set when the stream closes itself (e.g. queue overflow). */
  readonly ended: { readonly reason: string } | null;
}

export const EMPTY_AGENTS_FEED: AgentsFeedState = {
  state: null,
  streamEpoch: null,
  revision: 0,
  lastReceipt: null,
  ended: null,
};

/**
 * Fold one `AgentsEvent` frame. Every snapshot/updated frame carries the full
 * bounded projection, so the fold is "latest wins" — epoch changes (adapter
 * restart) are handled by simply adopting the new frame's epoch and state.
 */
export function applyAgentsEvent(feed: AgentsFeedState, event: AgentsEvent): AgentsFeedState {
  switch (event.kind) {
    case "snapshot":
    case "updated":
      return {
        state: event,
        streamEpoch: event.streamEpoch,
        revision: event.revision,
        lastReceipt: feed.lastReceipt,
        ended: null,
      };
    case "receipt":
      return { ...feed, lastReceipt: event.receipt };
    case "closed":
      return { ...feed, ended: { reason: event.reason } };
  }
}

// --- Capability gating ------------------------------------------------------

export type OrchestrationOpName = keyof OrchestrationControlMethods;

export type OperationSupport =
  | { readonly kind: "ready" }
  | { readonly kind: "unsupported"; readonly detail: string }
  | { readonly kind: "unknown" };

/**
 * Per-operation support from the provider-advertised capability surface.
 * `unknown` covers the not-yet-loaded case so the UI can render an honest
 * pending state instead of guessing.
 */
export function operationSupport(
  capabilities: OrchestrationCapabilities | null,
  operation: string,
): OperationSupport {
  if (!capabilities) return { kind: "unknown" };
  if (capabilities.operations[operation] === true) return { kind: "ready" };
  return {
    kind: "unsupported",
    detail: `${operation} is not supported by this provider`,
  };
}

/** Receipt line shown next to a control: `accepted · seq N` or the named rejection. */
export function describeReceipt(receipt: OrchestrationReceipt): string {
  return receipt.status === "accepted"
    ? `accepted · seq ${receipt.sequence}`
    : `rejected — ${receipt.error ?? "no detail"}`;
}

// --- Pending approvals ------------------------------------------------------

export const APPROVAL_REQUEST_KIND_LABELS: Record<string, string> = {
  command: "Command approval",
  "file-read": "File read approval",
  "file-change": "File change approval",
  "mcp-elicitation": "App access approval",
};

export const approvalKindLabel = (requestKind: string): string =>
  APPROVAL_REQUEST_KIND_LABELS[requestKind] ?? requestKind;

/**
 * Native default approval options (client-runtime pendingRequests) — used when
 * a provider request carries no explicit option list.
 */
export const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
];

export const approvalOptions = (approval: PendingApproval): readonly ApprovalOption[] =>
  approval.options && approval.options.length > 0 ? approval.options : DEFAULT_APPROVAL_OPTIONS;

// --- Pending user inputs ----------------------------------------------------
//
// Draft model ported from the native pendingUserInput module: a custom answer
// (when allowed) wins over option selection; multi-select answers are string
// arrays, single-select a string; a request submits only when every question
// resolves.

export const userInputOptionValue = (option: {
  readonly label: string;
  readonly value?: string;
}): string => option.value ?? option.label;

export interface UserInputDraftAnswer {
  readonly customAnswer?: string;
  readonly selectedOptionValues?: readonly string[];
}

/** One question's resolved answer: custom text wins, else the option pick(s). */
export function resolveQuestionAnswer(
  question: UserInputQuestion,
  draft: UserInputDraftAnswer | undefined,
): string | string[] | null {
  const custom = question.allowCustomAnswer === false ? null : draft?.customAnswer?.trim() || null;
  if (custom) return custom;
  const selected = (draft?.selectedOptionValues ?? []).filter((value) =>
    question.options.some((option) => userInputOptionValue(option) === value),
  );
  if (question.multiSelect) {
    return selected.length > 0 ? [...selected] : null;
  }
  return selected[0] ?? null;
}

export function toggleQuestionOption(
  question: UserInputQuestion,
  draft: UserInputDraftAnswer | undefined,
  optionValue: string,
): UserInputDraftAnswer {
  if (question.multiSelect) {
    const selected = [...(draft?.selectedOptionValues ?? [])];
    const next = selected.includes(optionValue)
      ? selected.filter((value) => value !== optionValue)
      : [...selected, optionValue];
    return {
      customAnswer: "",
      ...(next.length > 0 ? { selectedOptionValues: next } : {}),
    };
  }
  return { customAnswer: "", selectedOptionValues: [optionValue] };
}

/** Typing a custom answer clears the option pick (native behavior). */
export function setQuestionCustomAnswer(
  _question: UserInputQuestion,
  draft: UserInputDraftAnswer | undefined,
  customAnswer: string,
): UserInputDraftAnswer {
  const selected = customAnswer.trim().length > 0 ? undefined : (draft?.selectedOptionValues ?? []);
  return {
    customAnswer,
    ...(selected && selected.length > 0 ? { selectedOptionValues: [...selected] } : {}),
  };
}

/** All-or-nothing: null until every question resolves — the native submit rule. */
export function buildUserInputAnswers(
  questions: readonly UserInputQuestion[],
  drafts: Readonly<Record<string, UserInputDraftAnswer | undefined>>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = resolveQuestionAnswer(question, drafts[question.id]);
    if (answer === null) return null;
    answers[question.id] = answer;
  }
  return answers;
}

export function countAnsweredQuestions(
  questions: readonly UserInputQuestion[],
  drafts: Readonly<Record<string, UserInputDraftAnswer | undefined>>,
): number {
  return questions.filter(
    (question) => resolveQuestionAnswer(question, drafts[question.id]) !== null,
  ).length;
}

// --- Checkpoints ------------------------------------------------------------

export type CheckpointVisualStatus = "ready" | "missing" | "error";

export function checkpointVisualStatus(
  checkpoint: OrchestrationCheckpoint,
): CheckpointVisualStatus {
  switch (checkpoint.status) {
    case "ready":
      return "ready";
    case "missing":
      return "missing";
    default:
      return "error";
  }
}

/** `turn N · M files · +a −d` — the native checkpoint list line. */
export function checkpointLabel(checkpoint: OrchestrationCheckpoint): string {
  const adds = checkpoint.files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const dels = checkpoint.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return `turn ${checkpoint.checkpointTurnCount} · ${checkpoint.files.length} file${
    checkpoint.files.length === 1 ? "" : "s"
  } · +${adds} −${dels}`;
}

// --- Verified diff reassembly -----------------------------------------------
//
// getTurnDiff/getThreadDiff stream `t3.vcs/diff` frames: a manifest snapshot,
// then chunk frames, then a complete frame carrying the whole-payload sha256.
// This assembly mirrors the diff package's verifier — manifest order, source
// indexes, chunk ordering/counts, UTF-8 byte lengths, per-source and whole
// payload hashes — and nothing is rendered until verification passes.

export interface DiffPatchSource {
  readonly id: string;
  readonly title: string;
  readonly kind: "working-tree" | "branch-range";
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly diff: string;
  readonly diffHash: string;
  readonly truncated: boolean;
}

export interface VerifiedDiffPatch {
  readonly generatedAt: string;
  readonly sources: readonly DiffPatchSource[];
}

export type DiffStreamOutcome =
  | { readonly kind: "verified"; readonly patch: VerifiedDiffPatch }
  | { readonly kind: "protocol" | "incomplete" | "mismatch"; readonly detail: string }
  | { readonly kind: "cancelled" };

/** Minimal transport frame shape — same shape the diff package declares. */
export interface StreamFrameLike<T> {
  readonly type: string;
  readonly value: T;
}

export interface DiffAssembly {
  readonly manifest: {
    readonly generatedAt: string;
    readonly sources: readonly VcsDiffStreamSource[];
  } | null;
  /** Per-source chunks in arrival order; strict `chunkIndex` sequence. */
  readonly chunks: readonly (readonly string[])[];
  readonly complete: string | null;
}

export const createDiffAssembly = (): DiffAssembly => ({
  manifest: null,
  chunks: [],
  complete: null,
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

type DiffFoldResult =
  | { readonly ok: true; readonly assembly: DiffAssembly }
  | { readonly ok: false; readonly detail: string };

/**
 * Fold one diff-stream event. Frames must arrive manifest → ordered chunks →
 * complete; out-of-order, duplicated, or undeclared chunks are protocol
 * failures — accepting them would hide transport breakage. Mirrors the diff
 * package's `applyPreviewStreamEvent`.
 */
export function applyDiffStreamEvent(
  assembly: DiffAssembly,
  event: VcsDiffPreviewStreamEvent,
): DiffFoldResult {
  if (assembly.complete !== null) {
    return { ok: false, detail: "stream continued after the complete frame" };
  }
  if (event.kind === "manifest") {
    if (assembly.manifest !== null) return { ok: false, detail: "duplicate manifest frame" };
    return {
      ok: true,
      assembly: {
        manifest: { generatedAt: event.generatedAt, sources: event.sources },
        chunks: event.sources.map(() => []),
        complete: null,
      },
    };
  }
  if (assembly.manifest === null) {
    return { ok: false, detail: `${event.kind} frame arrived before the manifest` };
  }
  if (event.kind === "chunk") {
    const source = assembly.manifest.sources[event.sourceIndex];
    if (source === undefined) {
      return { ok: false, detail: `chunk for unknown sourceIndex ${event.sourceIndex}` };
    }
    if (event.chunkIndex >= source.chunkCount) {
      return {
        ok: false,
        detail: `chunkIndex ${event.chunkIndex} exceeds declared chunkCount ${source.chunkCount} for source ${source.id}`,
      };
    }
    const received = assembly.chunks[event.sourceIndex] ?? [];
    if (event.chunkIndex !== received.length) {
      return {
        ok: false,
        detail: `out-of-order chunk ${event.chunkIndex} for source ${source.id} (expected ${received.length})`,
      };
    }
    const chunks = assembly.chunks.slice();
    chunks[event.sourceIndex] = [...received, event.data];
    return { ok: true, assembly: { ...assembly, chunks } };
  }
  return { ok: true, assembly: { ...assembly, complete: event.payloadSha256 } };
}

/**
 * Terminal verification: declared chunk counts, reassembled UTF-8 byte
 * lengths, per-source sha256, then the whole-payload sha256 — in that order,
 * before a single byte reaches the render path. Mirrors the diff package's
 * `verifyPreviewAssembly`.
 */
export async function verifyDiffAssembly(assembly: DiffAssembly): Promise<DiffStreamOutcome> {
  if (assembly.manifest === null) {
    return { kind: "incomplete", detail: "stream ended before the manifest" };
  }
  if (assembly.complete === null) {
    return { kind: "incomplete", detail: "stream ended before the complete frame" };
  }
  const manifest = assembly.manifest;
  const bodies: string[] = [];
  for (const [index, source] of manifest.sources.entries()) {
    const chunks = assembly.chunks[index] ?? [];
    if (chunks.length !== source.chunkCount) {
      return {
        kind: "incomplete",
        detail: `source ${source.id}: received ${chunks.length} of ${source.chunkCount} declared chunks`,
      };
    }
    const body = chunks.join("");
    if (utf8Length(body) !== source.diffByteLength) {
      return {
        kind: "mismatch",
        detail: `source ${source.id}: reassembled byte length does not match the manifest`,
      };
    }
    if ((await sha256Hex(body)) !== source.diffHash) {
      return {
        kind: "mismatch",
        detail: `source ${source.id}: reassembled bytes do not match the manifest hash`,
      };
    }
    bodies.push(body);
  }
  if ((await sha256Hex(bodies.join(""))) !== assembly.complete) {
    return { kind: "mismatch", detail: "reassembled payload does not match the terminal checksum" };
  }
  return {
    kind: "verified",
    patch: {
      generatedAt: manifest.generatedAt,
      sources: manifest.sources.map((source, index) => ({
        id: source.id,
        kind: source.kind,
        title: source.title,
        baseRef: source.baseRef,
        headRef: source.headRef,
        diff: bodies[index] ?? "",
        diffHash: source.diffHash,
        truncated: source.truncated,
      })),
    },
  };
}

/**
 * Consume a `getTurnDiff`/`getThreadDiff` stream into a verified patch. The
 * abort signal is checked before every frame and leaving the loop abandons
 * the iterator — the contract's cancellation mechanism. Nothing is produced
 * before the terminal checksum verifies.
 */
export async function collectDiffStream(
  stream: AsyncIterable<StreamFrameLike<VcsDiffPreviewStreamEvent>>,
  signal: AbortSignal,
): Promise<DiffStreamOutcome> {
  let assembly = createDiffAssembly();
  try {
    for await (const frame of stream) {
      if (signal.aborted) return { kind: "cancelled" };
      const next = applyDiffStreamEvent(assembly, frame.value);
      if (!next.ok) return { kind: "protocol", detail: next.detail };
      assembly = next.assembly;
    }
  } catch (error) {
    if (signal.aborted) return { kind: "cancelled" };
    return {
      kind: "protocol",
      detail: error instanceof Error ? error.message : "diff stream failed",
    };
  }
  if (signal.aborted) return { kind: "cancelled" };
  return verifyDiffAssembly(assembly);
}

// --- Footer ------------------------------------------------------------------

/** Native footer line: live/idle/settled counts plus the cumulative token total. */
export function agentsFooterSummary(model: AgentsPanelModel): string {
  const parts = [
    `${model.liveCount} working`,
    `${model.idleCount} idle`,
    `${model.settledCount} settled`,
  ];
  if (model.totalTokens > 0) parts.push(`${formatAgentTokenCount(model.totalTokens)} tokens`);
  return parts.join(" · ");
}
