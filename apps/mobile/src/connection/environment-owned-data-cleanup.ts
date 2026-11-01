import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { Persistence } from "@t3tools/client-runtime/platform";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { clearThreadComposerErrorsForEnvironment } from "../state/thread-composer-error";
import { clearThreadOutboxEnvironment } from "../state/thread-outbox-removal";
import { clearComposerDraftsEnvironment } from "../state/use-composer-drafts";

export const layer = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: Effect.fn("Persistence.EnvironmentOwnedDataCleanup.clear")(function (environmentId) {
      // Each clear settles on its own: a failure must not interrupt a clear that is still running.
      const settle = (
        operation: "outbox" | "drafts",
        clear: (environmentId: EnvironmentId) => Promise<void>,
      ) =>
        Effect.tryPromise(() => clear(environmentId)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not clear mobile environment-owned data.", {
              environmentId,
              operation,
              ...safeErrorLogAttributes(error.cause),
            }),
          ),
        );
      return Effect.all(
        [
          settle("outbox", clearThreadOutboxEnvironment),
          settle("drafts", clearComposerDraftsEnvironment),
          Effect.sync(() => clearThreadComposerErrorsForEnvironment(environmentId)),
        ],
        { concurrency: "unbounded", discard: true },
      );
    }),
  }),
);
