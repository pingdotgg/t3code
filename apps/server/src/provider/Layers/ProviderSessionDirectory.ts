/**
 * ProviderSessionDirectoryLive - In-memory session ownership index layer.
 *
 * Tracks provider ownership and optional thread id by `sessionId` so
 * `ProviderService` can route session-scoped API calls to the right adapter.
 * This layer stores metadata only and does not call provider adapters directly.
 *
 * @module ProviderSessionDirectoryLive
 */
import { Effect, Layer, Option, Ref } from "effect";

import { ProviderSessionNotFoundError, ProviderValidationError } from "../Errors.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionBinding,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory.ts";

const makeProviderSessionDirectory = Effect.gen(function* () {
  const bindingsRef = yield* Ref.make(new Map<string, ProviderSessionBinding>());

  const upsert: ProviderSessionDirectoryShape["upsert"] = (binding) => {
    const sessionId = binding.sessionId.trim();
    if (sessionId.length === 0) {
      return Effect.fail(
        new ProviderValidationError({
          operation: "ProviderSessionDirectory.upsert",
          issue: "sessionId must be a non-empty string.",
        }),
      );
    }

    const normalized: ProviderSessionBinding = {
      sessionId,
      provider: binding.provider,
      ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
    };

    return Ref.update(bindingsRef, (current) => {
      const next = new Map(current);
      next.set(sessionId, normalized);
      return next;
    });
  };

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (sessionId) =>
    Ref.get(bindingsRef).pipe(
      Effect.flatMap((bindings) => {
        const binding = bindings.get(sessionId);
        if (!binding) {
          return Effect.fail(new ProviderSessionNotFoundError({ sessionId }));
        }
        return Effect.succeed(binding.provider);
      }),
    );

  const getThreadId: ProviderSessionDirectoryShape["getThreadId"] = (sessionId) =>
    Ref.get(bindingsRef).pipe(
      Effect.flatMap((bindings) => {
        const binding = bindings.get(sessionId);
        if (!binding) {
          return Effect.fail(new ProviderSessionNotFoundError({ sessionId }));
        }
        return Effect.succeed(Option.fromNullishOr(binding.threadId));
      }),
    );

  const remove: ProviderSessionDirectoryShape["remove"] = (sessionId) =>
    Ref.update(bindingsRef, (current) => {
      if (!current.has(sessionId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });

  const listSessionIds: ProviderSessionDirectoryShape["listSessionIds"] = () =>
    Ref.get(bindingsRef).pipe(Effect.map((bindings) => Array.from(bindings.keys())));

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
