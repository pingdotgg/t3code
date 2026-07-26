import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import {
  ThreadControlToolkit,
  ThreadReadAmbiguousError,
  ThreadReadFailedError,
  ThreadReadNotFoundError,
  ThreadReadUnavailableError,
  type ReadThreadInput,
  type ReadThreadResult,
} from "./tools.ts";

const DEFAULT_RESULT_LIMIT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readProviderThreadId(
  binding: Pick<ProviderRuntimeBindingWithMetadata, "provider" | "resumeCursor">,
): string | undefined {
  if (!isRecord(binding.resumeCursor)) {
    return undefined;
  }
  if (binding.provider === "codex") {
    return typeof binding.resumeCursor.threadId === "string"
      ? binding.resumeCursor.threadId
      : undefined;
  }
  if (binding.provider === "claude") {
    if (typeof binding.resumeCursor.resume === "string") {
      return binding.resumeCursor.resume;
    }
    return typeof binding.resumeCursor.threadId === "string"
      ? binding.resumeCursor.threadId
      : undefined;
  }
  return typeof binding.resumeCursor.sessionId === "string"
    ? binding.resumeCursor.sessionId
    : undefined;
}

function mapReadFailure(operation: string) {
  return (cause: unknown) =>
    Effect.logWarning("cross-thread read failed", { operation, cause }).pipe(
      Effect.andThen(Effect.fail(new ThreadReadFailedError({ operation }))),
    );
}

export const readThread = Effect.fn("ThreadControlToolkit.readThread")(function* (
  input: ReadThreadInput,
): Effect.fn.Return<
  ReadThreadResult,
  | ThreadReadUnavailableError
  | ThreadReadNotFoundError
  | ThreadReadAmbiguousError
  | ThreadReadFailedError,
  McpInvocationContext.McpInvocationContext | ProjectionSnapshotQuery | ProviderSessionDirectory
> {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("thread-read")) {
    return yield* new ThreadReadUnavailableError({ threadId: input.threadId });
  }

  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const sessionDirectory = yield* ProviderSessionDirectory;
  const directThreadId = ThreadId.make(input.threadId);
  const directThread = yield* snapshotQuery
    .getThreadDetailById(directThreadId)
    .pipe(Effect.catch(mapReadFailure("resolve T3 thread ID")));

  let targetThreadId = directThreadId;
  let thread = Option.getOrUndefined(directThread);
  let targetBinding: ProviderRuntimeBindingWithMetadata | undefined;

  const bindings = yield* sessionDirectory
    .listBindings()
    .pipe(Effect.catch(mapReadFailure("list provider bindings")));

  if (!thread) {
    const matches = bindings.filter((binding) => readProviderThreadId(binding) === input.threadId);
    if (matches.length > 1) {
      return yield* new ThreadReadAmbiguousError({
        threadId: input.threadId,
        matchCount: matches.length,
      });
    }
    targetBinding = matches[0];
    if (!targetBinding) {
      return yield* new ThreadReadNotFoundError({ threadId: input.threadId });
    }
    targetThreadId = targetBinding.threadId;
    const resolved = yield* snapshotQuery
      .getThreadDetailById(targetThreadId)
      .pipe(Effect.catch(mapReadFailure("read provider thread")));
    thread = Option.getOrUndefined(resolved);
  } else {
    targetBinding = bindings.find((binding) => binding.threadId === targetThreadId);
  }

  if (!thread) {
    return yield* new ThreadReadNotFoundError({ threadId: input.threadId });
  }

  const project = yield* snapshotQuery
    .getProjectShellById(thread.projectId)
    .pipe(Effect.catch(mapReadFailure("read thread project")), Effect.map(Option.getOrUndefined));
  if (!project) {
    return yield* new ThreadReadNotFoundError({ threadId: input.threadId });
  }

  const messageLimit = input.messageLimit ?? DEFAULT_RESULT_LIMIT;
  const activityLimit = input.activityLimit ?? DEFAULT_RESULT_LIMIT;
  const messages = thread.messages.slice(-messageLimit).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    streaming: message.streaming,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  }));
  const activities = thread.activities.slice(-activityLimit).map((activity) => ({
    id: activity.id,
    tone: activity.tone,
    kind: activity.kind,
    summary: activity.summary,
    createdAt: activity.createdAt,
  }));
  const providerThreadId =
    thread.session?.providerThreadId ??
    (targetBinding ? readProviderThreadId(targetBinding) : undefined);

  return {
    threadId: thread.id,
    ...(providerThreadId ? { providerThreadId } : {}),
    title: thread.title,
    project: {
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    },
    provider: thread.session?.providerName ?? targetBinding?.provider ?? null,
    status: thread.session?.status ?? "idle",
    latestTurn: thread.latestTurn
      ? {
          id: thread.latestTurn.turnId,
          state: thread.latestTurn.state,
          startedAt: thread.latestTurn.startedAt,
          completedAt: thread.latestTurn.completedAt,
        }
      : null,
    messages,
    activities,
    totals: {
      messages: thread.messages.length,
      activities: thread.activities.length,
    },
    truncated: {
      messages: messages.length < thread.messages.length,
      activities: activities.length < thread.activities.length,
    },
  };
});

export const ThreadControlToolkitHandlersLive = ThreadControlToolkit.toLayer({
  read_thread: readThread,
});
