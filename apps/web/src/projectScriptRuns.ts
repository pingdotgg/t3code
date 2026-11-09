import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ProjectId, ProjectScript, ThreadId } from "@t3tools/contracts";

export type ProjectScriptRunStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "lost";

export interface ProjectScriptRun {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly scriptId: string;
  readonly scriptName: string;
  readonly command: string;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly threadScoped: boolean;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly sentinel: string;
  readonly startedAt: number;
  readonly status: ProjectScriptRunStatus;
  readonly exitCode: number | null;
  readonly errorMessage: string | null;
  readonly outputTail: string;
  readonly endedAt: number | null;
}

export type ProjectScriptRunPatch = Partial<
  Pick<ProjectScriptRun, "status" | "exitCode" | "errorMessage" | "outputTail" | "endedAt">
>;

export interface ProjectScriptMenuEntry {
  readonly project: EnvironmentProject;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly anchorThread: EnvironmentThreadShell | null;
  readonly environmentLabel: string;
  readonly lastActivity: number;
  readonly canOperate: boolean;
}

export const PROJECT_SCRIPT_SENTINEL_ENV = "__T3_SCRIPT_SENTINEL";
export const PROJECT_SCRIPT_BEGIN_ENV = "__T3_SCRIPT_BEGIN";
export const PROJECT_SCRIPT_SENTINEL_PREFIX = "__T3_SCRIPT_DONE__";
export const PROJECT_SCRIPT_OUTPUT_TAIL_LINES = 200;

const PROJECT_ACTIONS_THREAD_PREFIX = "__project_actions__:";

/** A terminal key for project-scoped runs, which have no thread to attach to. */
export function projectActionsThreadId(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ThreadId {
  return `${PROJECT_ACTIONS_THREAD_PREFIX}${environmentId}:${projectId}` as ThreadId;
}

const RUN_STATUS_RANK: Record<ProjectScriptRunStatus, number> = {
  failed: 0,
  running: 1,
  starting: 2,
  lost: 3,
  stopped: 4,
  succeeded: 5,
};

const ANSI_PATTERN =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function isProjectScriptRunActive(run: ProjectScriptRun): boolean {
  return run.status === "starting" || run.status === "running";
}

export function projectScriptRunStatusLabel(status: ProjectScriptRunStatus): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "lost":
      return "Terminal lost";
  }
}

export function sortProjectScriptRuns(
  runs: ReadonlyArray<ProjectScriptRun>,
): ReadonlyArray<ProjectScriptRun> {
  return [...runs].sort(
    (left, right) =>
      RUN_STATUS_RANK[left.status] - RUN_STATUS_RANK[right.status] ||
      right.startedAt - left.startedAt,
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Runs the command in a child POSIX shell and prints a begin marker and an exit-code
 * sentinel that the run coordinator parses from the terminal stream. The tokens travel
 * in the environment, so the echoed command line never contains them.
 */
export function wrapProjectScriptCommand(command: string): string {
  // The wrapper may be typed into a shell or passed as an initial command to a
  // shell's -c, so every separator has to be a real line break.
  const body = command.replace(/\r\n|\r/g, "\n");
  const script = [
    `printf "\\n%s\\n" "$${PROJECT_SCRIPT_BEGIN_ENV}"`,
    "(",
    body,
    ")",
    "__t3_status=$?",
    `printf "\\n%s%s\\n" "$${PROJECT_SCRIPT_SENTINEL_ENV}" "$__t3_status"`,
  ].join("\n");
  return `sh -c ${shellSingleQuote(script)}`;
}

export function projectScriptBeginMarker(sentinel: string): string {
  return `${sentinel}BEGIN`;
}

export function projectScriptSentinelPattern(sentinel: string): RegExp {
  return new RegExp(`${escapeRegExp(sentinel)}(-?\\d+)`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripProjectScriptOutput(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

export function projectScriptOutputTail(
  text: string,
  maxLines = PROJECT_SCRIPT_OUTPUT_TAIL_LINES,
): string {
  const lines = stripProjectScriptOutput(text).split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-maxLines).join("\n").trimEnd();
}

/** Lines the shell echoes back for the typed wrapper, which are not command output. */
export function isProjectScriptWrapperLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.includes("sh -c '") ||
    trimmed.includes("__t3_status") ||
    trimmed.includes(`$${PROJECT_SCRIPT_SENTINEL_ENV}`)
  );
}

/** Terminal text after the begin marker, without the echoed wrapper or the end sentinel. */
export function projectScriptVisibleOutput(text: string, sentinel: string): string {
  const marker = projectScriptBeginMarker(sentinel);
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return text;
  const afterMarker = text.slice(markerIndex + marker.length).replace(/^(?:\r\n|\r|\n)/, "");
  const endIndex = afterMarker.search(projectScriptSentinelPattern(sentinel));
  const body = endIndex === -1 ? afterMarker : afterMarker.slice(0, endIndex);
  return body
    .split(/\r\n|\r|\n/)
    .filter((line) => !isProjectScriptWrapperLine(line))
    .join("\n")
    .trimEnd();
}

function projectThreadActivityTimestamp(thread: EnvironmentThreadShell): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of [thread.unsettledAt, thread.settledAt, thread.updatedAt, thread.createdAt]) {
    const parsed = toSortableTimestamp(value ?? undefined);
    if (parsed !== null && parsed > latest) latest = parsed;
  }
  return latest === Number.NEGATIVE_INFINITY ? 0 : latest;
}

export function resolveProjectAnchorThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell | null {
  let anchor: EnvironmentThreadShell | null = null;
  let anchorTimestamp = Number.NEGATIVE_INFINITY;
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    const timestamp = projectThreadActivityTimestamp(thread);
    if (timestamp > anchorTimestamp) {
      anchor = thread;
      anchorTimestamp = timestamp;
    }
  }
  return anchor;
}

export function projectLastActivityTimestamp(
  project: EnvironmentProject,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): number {
  const anchor = resolveProjectAnchorThread(threads);
  if (anchor !== null) return projectThreadActivityTimestamp(anchor);
  return toSortableTimestamp(project.updatedAt) ?? 0;
}

export function sortProjectScriptMenuEntries(
  entries: ReadonlyArray<ProjectScriptMenuEntry>,
): ReadonlyArray<ProjectScriptMenuEntry> {
  return [...entries].sort(
    (left, right) =>
      right.lastActivity - left.lastActivity ||
      left.project.title.localeCompare(right.project.title),
  );
}
