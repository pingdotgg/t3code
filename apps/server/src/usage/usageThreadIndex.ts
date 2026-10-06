/**
 * Places provider sessions in T3 threads and projects for summaries grouped by
 * thread. Pure: the caller loads T3's records once per scan and asks for each
 * transcript's group while aggregating.
 */
import type {
  ProjectId,
  ThreadId,
  UsageProject,
  UsageProviderKind,
  UsageThread,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import type { UsageBucketGroup } from "./usageAggregation.ts";

/** T3's records needed for attribution, read from the orchestration read model. */
export interface UsageAttributionIndex {
  /** Keyed `driver\0nativeId`: the T3 thread a provider session belongs to. */
  readonly nativeThreads: ReadonlyMap<string, NativeThreadRef>;
  /** Keyed `driver\0nativeTaskId`: the child thread a provider sub-agent ran as. */
  readonly nativeSubagents: ReadonlyMap<string, NativeThreadRef>;
  readonly threads: ReadonlyMap<string, T3ThreadRef>;
  readonly projects: readonly T3ProjectRef[];
}

export interface NativeThreadRef {
  readonly threadId: ThreadId;
  readonly instanceId: string | null;
}

export interface T3ThreadRef {
  readonly projectId: ProjectId;
  readonly title: string | null;
  readonly parentThreadId: ThreadId | null;
}

export interface T3ProjectRef {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly deleted: boolean;
}

export const EMPTY_ATTRIBUTION: UsageAttributionIndex = {
  nativeThreads: new Map(),
  nativeSubagents: new Map(),
  threads: new Map(),
  projects: [],
};

/** What one transcript says about the session it belongs to. */
export interface UsageSessionSource {
  readonly provider: UsageProviderKind;
  readonly sessionId: string;
  readonly cwd: string | null;
  /** Provider-native sub-agent id, for a sub-agent's own transcript. */
  readonly agentId: string | null;
  /** What that sub-agent was asked to do. */
  readonly label: string | null;
  /** The only provider instance reading this transcript's directory, if just one does. */
  readonly instanceId: string | null;
}

/** Driver names T3 records native sessions under; Cursor and Antigravity have none we can match. */
const DRIVER_BY_PROVIDER: Partial<Record<UsageProviderKind, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
};

/** Claude Code writes each native sub-agent to `<session>/subagents/agent-<id>.jsonl`. */
export function claudeSubagentId(filePath: string): string | null {
  const match = /[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/.exec(filePath);
  return match?.[1] ?? null;
}

export class UsageThreadIndex {
  readonly #attribution: UsageAttributionIndex;
  readonly #threads: UsageThread[] = [];
  readonly #indexByKey = new Map<string, number>();
  readonly #groupBySession = new Map<string, UsageBucketGroup>();
  readonly #roots: readonly {
    readonly root: string;
    readonly projectId: ProjectId;
    readonly deleted: boolean;
  }[];

  constructor(attribution: UsageAttributionIndex) {
    this.#attribution = attribution;
    // Deepest root first, so a project nested inside another wins. A deleted
    // project keeps its threads but only claims folders no live project does.
    this.#roots = attribution.projects
      .map((project) => ({
        root: normalizeProjectPathForComparison(project.workspaceRoot),
        projectId: project.projectId,
        deleted: project.deleted,
      }))
      .filter((entry) => entry.root.length > 0)
      .sort((a, b) => Number(a.deleted) - Number(b.deleted) || b.root.length - a.root.length);
  }

  /** Account and thread for a record of this session; memoised per session. */
  groupFor(source: UsageSessionSource): UsageBucketGroup {
    if (source.sessionId.length === 0) {
      return source.instanceId === null ? {} : { instanceId: source.instanceId };
    }
    const key = `${source.provider}\u0000${source.sessionId}\u0000${source.agentId ?? ""}`;
    const cached = this.#groupBySession.get(key);
    if (cached !== undefined) return cached;
    const group = this.#resolve(source);
    this.#groupBySession.set(key, group);
    return group;
  }

  /** Threads and the projects they reference, for the summary. */
  finish(): {
    readonly threads: readonly UsageThread[];
    readonly projects: readonly UsageProject[];
  } {
    const referenced = new Set(this.#threads.flatMap((thread) => thread.projectId ?? []));
    const projects = this.#attribution.projects
      .filter((project) => referenced.has(project.projectId))
      .map((project) => ({
        projectId: project.projectId,
        title:
          project.title.trim() ||
          project.workspaceRoot.split(/[\\/]/).findLast((part) => part.length > 0) ||
          "Untitled project",
      }));
    return { threads: this.#threads, projects };
  }

  #resolve(source: UsageSessionSource): UsageBucketGroup {
    const driver = DRIVER_BY_PROVIDER[source.provider];
    if (driver === undefined) {
      return source.instanceId === null ? {} : { instanceId: source.instanceId };
    }
    if (source.agentId !== null) {
      const child = this.#attribution.nativeSubagents.get(`${driver}\u0000${source.agentId}`);
      const parent = this.#resolve({ ...source, agentId: null, label: null });
      if (child !== undefined) {
        const thread = this.#t3Thread(child.threadId);
        if (thread !== null) {
          return withInstance(thread, child.instanceId ?? parent.instanceId ?? null);
        }
      }
      const parentThread = parent.thread === undefined ? undefined : this.#threads[parent.thread];
      const index = this.#add(`agent:${source.provider}:${source.sessionId}:${source.agentId}`, {
        ...(source.label === null ? {} : { title: source.label }),
        ...(parentThread?.projectId === undefined ? {} : { projectId: parentThread.projectId }),
        ...(parent.thread === undefined ? {} : { parent: parent.thread }),
        subagent: true,
        located: parentThread?.located ?? source.cwd !== null,
      });
      return withInstance({ thread: index }, parent.instanceId ?? null);
    }
    const native = this.#attribution.nativeThreads.get(`${driver}\u0000${source.sessionId}`);
    if (native !== undefined) {
      const thread = this.#t3Thread(native.threadId);
      if (thread !== null) return withInstance(thread, native.instanceId ?? source.instanceId);
    }
    const projectId = source.cwd === null ? null : this.#projectFor(source.cwd);
    const index = this.#add(`session:${source.provider}:${source.sessionId}`, {
      ...(projectId === null ? {} : { projectId }),
      located: source.cwd !== null,
    });
    return withInstance({ thread: index }, source.instanceId);
  }

  /** The T3 thread's entry, with its ancestors, or null when T3 no longer has it. */
  #t3Thread(threadId: ThreadId, visiting = new Set<string>()): { thread: number } | null {
    const key = `t3:${threadId}`;
    const existing = this.#indexByKey.get(key);
    if (existing !== undefined) return { thread: existing };
    const record = this.#attribution.threads.get(threadId);
    if (record === undefined) return null;
    visiting.add(threadId);
    // A loop in lineage stops at the thread that closes it.
    const parent =
      record.parentThreadId === null || visiting.has(record.parentThreadId)
        ? null
        : this.#t3Thread(record.parentThreadId, visiting);
    const index = this.#add(key, {
      threadId,
      ...(record.title === null ? {} : { title: record.title }),
      projectId: record.projectId,
      ...(parent === null ? {} : { parent: parent.thread }),
      located: true,
    });
    return { thread: index };
  }

  #projectFor(cwd: string): ProjectId | null {
    // Windows drive and UNC paths compare case-insensitively, with either slash.
    const path = normalizeProjectPathForComparison(cwd);
    for (const { root, projectId } of this.#roots) {
      // A root that already ends in a separator (`/`, `C:\`) adds no second one.
      const prefix = /[\\/]$/.test(root) ? root : null;
      if (
        path === root ||
        (prefix !== null
          ? path.startsWith(prefix)
          : path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))
      ) {
        return projectId;
      }
    }
    return null;
  }

  #add(key: string, thread: Omit<UsageThread, "key">): number {
    const existing = this.#indexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = this.#threads.length;
    this.#threads.push({ key, ...thread });
    this.#indexByKey.set(key, index);
    return index;
  }
}

function withInstance(
  group: { readonly thread: number },
  instanceId: string | null,
): UsageBucketGroup {
  return instanceId === null ? group : { ...group, instanceId };
}
