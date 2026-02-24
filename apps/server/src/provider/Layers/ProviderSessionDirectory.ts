import {
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type ProviderKind,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import {
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionBinding,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

function normalizeBinding(binding: ProviderSessionBinding): ProviderSessionBinding {
  const sessionId = binding.sessionId.trim();
  const threadId = binding.threadId?.trim();
  const adapterKey = binding.adapterKey?.trim();
  const providerThreadId =
    binding.providerThreadId === null ? null : binding.providerThreadId?.trim();

  return {
    sessionId: ProviderSessionId.makeUnsafe(sessionId),
    provider: binding.provider,
    ...(adapterKey !== undefined && adapterKey.length > 0 ? { adapterKey } : {}),
    ...(threadId !== undefined && threadId.length > 0
      ? { threadId: ThreadId.makeUnsafe(threadId) }
      : {}),
    ...(providerThreadId === null
      ? { providerThreadId: null }
      : providerThreadId !== undefined && providerThreadId.length > 0
        ? { providerThreadId: ProviderThreadId.makeUnsafe(providerThreadId) }
        : {}),
    ...(binding.status !== undefined ? { status: binding.status } : {}),
    ...(binding.resumeCursor !== undefined ? { resumeCursor: binding.resumeCursor } : {}),
    ...(binding.runtimePayload !== undefined ? { runtimePayload: binding.runtimePayload } : {}),
  };
}

function decodeProviderKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderKind, ProviderSessionDirectoryPersistenceError> {
  if (providerName === "codex" || providerName === "claudeCode") {
    return Effect.succeed(providerName);
  }
  return Effect.fail(
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Unknown persisted provider '${providerName}'.`,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    return {
      ...existing,
      ...next,
    };
  }
  return next;
}

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntimeRepository;

  const persistUpsert = (binding: ProviderSessionBinding) =>
    Effect.gen(function* () {
      const existing = yield* repository
        .getBySessionId({
          providerSessionId: binding.sessionId,
        })
        .pipe(
          Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getBySessionId")),
        );

      const existingRuntime = Option.getOrUndefined(existing);
      const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
      if (!resolvedThreadId) {
        return yield* Effect.fail(
          new ProviderValidationError({
            operation: "ProviderSessionDirectory.upsert",
            issue: "threadId must be a non-empty string.",
          }),
        );
      }

      const now = new Date().toISOString();
      yield* repository
        .upsert({
          providerSessionId: binding.sessionId,
          threadId: resolvedThreadId,
          providerName: binding.provider,
          adapterKey: binding.adapterKey ?? existingRuntime?.adapterKey ?? binding.provider,
          providerThreadId: binding.providerThreadId ?? existingRuntime?.providerThreadId ?? null,
          status: binding.status ?? existingRuntime?.status ?? "running",
          lastSeenAt: now,
          resumeCursor:
            binding.resumeCursor !== undefined
              ? binding.resumeCursor
              : (existingRuntime?.resumeCursor ?? null),
          runtimePayload: mergeRuntimePayload(
            existingRuntime?.runtimePayload ?? null,
            binding.runtimePayload,
          ),
        })
        .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsert")));
    });

  const persistDelete = (sessionId: ProviderSessionId) =>
    repository
      .deleteBySessionId({ providerSessionId: sessionId })
      .pipe(
        Effect.mapError(toPersistenceError("ProviderSessionDirectory.remove:deleteBySessionId")),
      );

  const getBinding = (sessionId: ProviderSessionId) =>
    repository.getBySessionId({ providerSessionId: sessionId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getBySessionId")),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderSessionBinding>()),
          onSome: (value) =>
            decodeProviderKind(value.providerName, "ProviderSessionDirectory.getBinding").pipe(
              Effect.map((provider) =>
                Option.some({
                  sessionId: value.providerSessionId,
                  provider,
                  threadId: value.threadId,
                }),
              ),
            ),
        }),
      ),
    );

  const listBindings = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listSessionIds:list")),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeProviderKind(row.providerName, "ProviderSessionDirectory.listSessionIds").pipe(
              Effect.map((provider) => ({
                sessionId: row.providerSessionId,
                provider,
                threadId: row.threadId,
              })),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const upsert: ProviderSessionDirectoryShape["upsert"] = (binding) => {
    const normalized = normalizeBinding(binding);
    if (normalized.sessionId.length === 0) {
      return Effect.fail(
        new ProviderValidationError({
          operation: "ProviderSessionDirectory.upsert",
          issue: "sessionId must be a non-empty string.",
        }),
      );
    }

    return persistUpsert(normalized);
  };

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (sessionId) =>
    getBinding(sessionId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () => Effect.fail(new ProviderSessionNotFoundError({ sessionId })),
        }),
      ),
    );

  const getThreadId: ProviderSessionDirectoryShape["getThreadId"] = (sessionId) =>
    getBinding(sessionId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(Option.fromNullishOr(value.threadId)),
          onNone: () => Effect.fail(new ProviderSessionNotFoundError({ sessionId })),
        }),
      ),
    );

  const remove: ProviderSessionDirectoryShape["remove"] = (sessionId) => persistDelete(sessionId);

  const listSessionIds: ProviderSessionDirectoryShape["listSessionIds"] = () =>
    listBindings().pipe(Effect.map((bindings) => bindings.map((binding) => binding.sessionId)));

  return {
    upsert,
    getProvider,
    getThreadId,
    remove,
    listSessionIds,
  } satisfies ProviderSessionDirectoryShape;
});

export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);

export function makeProviderSessionDirectoryLive() {
  return Layer.effect(ProviderSessionDirectory, makeProviderSessionDirectory);
}
