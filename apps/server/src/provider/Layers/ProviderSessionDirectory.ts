import { Effect, Layer, Option } from "effect";

import { ProviderSessionRepository } from "../../persistence/Services/ProviderSessions.ts";
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
  return {
    sessionId: binding.sessionId.trim(),
    provider: binding.provider,
    ...(binding.threadId?.trim() ? { threadId: binding.threadId.trim() } : {}),
  };
}

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRepository;

  const persistUpsert = (binding: ProviderSessionBinding) =>
    repository
      .upsertSession({
        sessionId: binding.sessionId,
        provider: binding.provider,
        ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
      })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsertSession")));

  const persistDelete = (sessionId: string) =>
    repository
      .deleteSession({ sessionId })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.remove:deleteSession")));

  const getBinding = (sessionId: string) =>
    repository.getSession({ sessionId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getSession")),
      Effect.map((entry) =>
        Option.map(entry, (value) => ({
          sessionId: value.sessionId,
          provider: value.provider,
          ...(value.threadId !== undefined ? { threadId: value.threadId } : {}),
        })),
      ),
    );

  const listBindings = () =>
    repository.listSessions().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listSessionIds:listSessions")),
      Effect.map((rows) =>
        rows.map((row) => ({
          sessionId: row.sessionId,
          provider: row.provider,
          ...(row.threadId !== undefined ? { threadId: row.threadId } : {}),
        })),
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
