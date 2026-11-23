import type { OrchestrationV2AppThread, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ThreadProfile } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { scratchFolderRoot } from "../project/ManagedProjectFolders.ts";
import { KompasSettingsStore } from "./KompasSettingsStore.ts";
import { MemoryService } from "./MemoryService.ts";
import { PluginStore } from "./PluginStore.ts";
import {
  CHAT_PROMPT,
  coordinatorPrompt,
  MEMORY_PROMPT,
  SESSION_SEARCH_PROMPT,
  workerPrompt,
} from "./profilePrompts.ts";
import { type StoredWorkstream, WorkstreamStore } from "./WorkstreamStore.ts";

type ProfiledThread = Pick<OrchestrationV2AppThread, "id" | "projectId" | "lineage">;

export interface ThreadMembership {
  readonly profile: ThreadProfile;
  readonly workstream: StoredWorkstream | null;
}

export interface SessionProfile {
  readonly profile: Exclude<ThreadProfile, "developer">;
  readonly instructions: string;
}

/** What kind of conversation a thread is, and what its sessions start with. */
export class ThreadProfiles extends Context.Service<
  ThreadProfiles,
  {
    readonly membership: (thread: ProfiledThread) => Effect.Effect<ThreadMembership>;
    /** Undefined for developer threads. Frozen until `forget`, so memory writes keep the prompt cache. */
    readonly forSession: (
      thread: ProfiledThread,
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<SessionProfile | undefined>;
    readonly plugins: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<{ readonly id: string; readonly name: string }>>;
    /** The thread's session ended: its next one reads memory again. */
    readonly forget: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/kompas/ThreadProfiles") {}

// Sessions that were never released must not grow the cache without bound.
const MAX_FROZEN = 512;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const workstreams = yield* WorkstreamStore;
  const memory = yield* MemoryService;
  const plugins = yield* PluginStore;
  const settings = yield* KompasSettingsStore;
  const scratchRoot = scratchFolderRoot(config.baseDir, path);

  const isChatProject = (projectId: ProfiledThread["projectId"]) =>
    projects.get(projectId).pipe(
      Effect.map(Option.exists((project) => path.resolve(project.workspaceRoot) === scratchRoot)),
      Effect.orElseSucceed(() => false),
    );

  const membership: ThreadProfiles["Service"]["membership"] = Effect.fn(
    "ThreadProfiles.membership",
  )(
    function* (thread) {
      const coordinated = yield* workstreams.byCoordinator(thread.id);
      if (coordinated !== undefined) {
        return { profile: "coordinator" as const, workstream: coordinated };
      }
      const parentId = thread.lineage.parentThreadId;
      const parent = parentId === null ? undefined : yield* workstreams.byCoordinator(parentId);
      if (parent !== undefined) return { profile: "worker" as const, workstream: parent };
      return {
        profile: (yield* isChatProject(thread.projectId))
          ? ("chat" as const)
          : ("developer" as const),
        workstream: null,
      };
    },
    (effect) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the thread's profile.", { cause }).pipe(
            Effect.as({ profile: "developer" as const, workstream: null }),
          ),
        ),
      ),
  );

  const compose = Effect.fn("ThreadProfiles.compose")(function* (thread: ProfiledThread) {
    const { profile, workstream } = yield* membership(thread);
    if (profile === "developer") return undefined;
    const { memorySearchEnabled } = yield* settings.get;
    const library = workstream === null ? [] : yield* workstreams.library(workstream.id);
    const instructions = [
      CHAT_PROMPT,
      ...(workstream === null
        ? []
        : [
            profile === "coordinator"
              ? coordinatorPrompt(workstream, library)
              : workerPrompt(workstream, library),
          ]),
      memorySearchEnabled ? `${MEMORY_PROMPT}\n${SESSION_SEARCH_PROMPT}` : MEMORY_PROMPT,
      yield* memory.promptBlock(workstream?.id ?? null),
    ].join("\n\n");
    return { profile, instructions } satisfies SessionProfile;
  });

  const frozen = new Map<string, SessionProfile | undefined>();
  const key = (threadId: ThreadId, instanceId: string) => `${threadId}\n${instanceId}`;

  const forSession: ThreadProfiles["Service"]["forSession"] = Effect.fn(
    "ThreadProfiles.forSession",
  )(function* (thread, providerInstanceId) {
    const cacheKey = key(thread.id, providerInstanceId);
    if (frozen.has(cacheKey)) return frozen.get(cacheKey);
    const composed = yield* compose(thread).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read the thread's instructions.", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    for (const oldest of frozen.keys()) {
      if (frozen.size < MAX_FROZEN) break;
      frozen.delete(oldest);
    }
    frozen.set(cacheKey, composed);
    return composed;
  });

  return ThreadProfiles.of({
    membership,
    forSession,
    plugins: Effect.fn("ThreadProfiles.plugins")((threadId) =>
      plugins
        .forThread(threadId)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not read plugins; this session gets none.", { cause }).pipe(
              Effect.as([]),
            ),
          ),
        ),
    ),
    forget: Effect.fn("ThreadProfiles.forget")((threadId) =>
      Effect.sync(() => {
        for (const cacheKey of frozen.keys()) {
          if (cacheKey.startsWith(key(threadId, ""))) frozen.delete(cacheKey);
        }
      }),
    ),
  });
});

export const layer = Layer.effect(ThreadProfiles, make);
