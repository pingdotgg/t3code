import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../connection/runtime";

export const completionNotificationSnapshot = createEnvironmentQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:thread:completion-notification-snapshot",
    staleTimeMs: 60_000,
    idleTtlMs: 30_000,
    execute: (input: {
      readonly threadId: ThreadId;
      /** Makes each completed shell state a distinct query cache entry. */
      readonly updatedAt: string;
    }) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const loader = yield* ThreadSnapshotLoader;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) {
          return Option.none();
        }
        return yield* loader.load(
          prepared.value,
          input.threadId,
          { turnLimit: 1 },
          { timeoutMs: 1_000 },
        );
      }),
  },
);
