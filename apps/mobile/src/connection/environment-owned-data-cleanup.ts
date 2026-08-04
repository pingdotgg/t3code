import type { EnvironmentId } from "@t3tools/contracts";
import { EnvironmentOwnedDataCleanupError } from "@t3tools/client-runtime/platform";
import { Effect, Exit } from "effect";

import { clearThreadOutboxEnvironment } from "../state/thread-outbox";
import { clearComposerDraftsEnvironment } from "../state/use-composer-drafts";

export function clearMobileEnvironmentOwnedData(
  environmentId: EnvironmentId,
  operations: {
    readonly clearThreadOutbox: (id: EnvironmentId) => Promise<void>;
    readonly clearComposerDrafts: (id: EnvironmentId) => Promise<void>;
  } = {
    clearThreadOutbox: clearThreadOutboxEnvironment,
    clearComposerDrafts: clearComposerDraftsEnvironment,
  },
) {
  return Effect.gen(function* () {
    const [outbox, drafts] = yield* Effect.all(
      [
        Effect.tryPromise(() => operations.clearThreadOutbox(environmentId)).pipe(Effect.exit),
        Effect.tryPromise(() => operations.clearComposerDrafts(environmentId)).pipe(Effect.exit),
      ],
      { concurrency: "unbounded" },
    );
    const failures = [
      ...(Exit.isFailure(outbox)
        ? [{ resource: "thread-outbox" as const, cause: outbox.cause }]
        : []),
      ...(Exit.isFailure(drafts)
        ? [{ resource: "composer-drafts" as const, cause: drafts.cause }]
        : []),
    ];
    if (failures.length > 0) {
      return yield* new EnvironmentOwnedDataCleanupError({ environmentId, failures });
    }
  });
}
