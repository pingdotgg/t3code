import { ProviderSessionId, type ProviderKind } from "@t3tools/contracts";
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

function decodeProviderKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderKind, ProviderSessionDirectoryPersistenceError> {
  if (providerName === "codex" || providerName === "claudeCode" || providerName === "cursor") {
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
                  adapterKey: value.adapterKey,
                  providerThreadId: value.providerThreadId,
                  runtimeMode: value.runtimeMode,
                  status: value.status,
                  resumeCursor: value.resumeCursor,
                  runtimePayload: value.runtimePayload,
                }),
              ),
            ),
        }),
      ),
    );

  const upsert: ProviderSessionDirectoryShape["upsert"] = Effect.fn(function* (binding) {
    const existing = yield* repository
      .getBySessionId({
        providerSessionId: binding.sessionId,
      })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getBySessionId")));

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
    if (!resolvedThreadId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "threadId must be a non-empty string.",
      });
    }

    const now = new Date().toISOString();
    yield* repository
      .upsert({
        providerSessionId: binding.sessionId,
        threadId: resolvedThreadId,
        providerName: binding.provider,
        adapterKey: binding.adapterKey ?? existingRuntime?.adapterKey ?? binding.provider,
        providerThreadId:
          binding.providerThreadId !== undefined
            ? binding.providerThreadId
            : (existingRuntime?.providerThreadId ?? null),
        runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
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

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (sessionId) =>
    getBinding(sessionId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () => Effect.fail(new ProviderSessionNotFoundError({ sessionId })),
        }),
      ),
    );

  const getBindingBySessionId: ProviderSessionDirectoryShape["getBinding"] = (sessionId) =>
    getBinding(sessionId);

  const getThreadId: ProviderSessionDirectoryShape["getThreadId"] = (sessionId) =>
    getBinding(sessionId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(Option.fromNullishOr(value.threadId)),
          onNone: () => Effect.fail(new ProviderSessionNotFoundError({ sessionId })),
        }),
      ),
    );

  const remove: ProviderSessionDirectoryShape["remove"] = (sessionId) =>
    repository
      .deleteBySessionId({ providerSessionId: sessionId })
      .pipe(
        Effect.mapError(toPersistenceError("ProviderSessionDirectory.remove:deleteBySessionId")),
      );

  const listSessionIds: ProviderSessionDirectoryShape["listSessionIds"] = () =>
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
      Effect.map((bindings) => bindings.map((binding) => binding.sessionId)),
    );

  return {
    upsert,
    getProvider,
    getBinding: getBindingBySessionId,
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
