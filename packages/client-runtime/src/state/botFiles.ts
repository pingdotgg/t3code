import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** A Bot's notes.md and preferences.md (a save refreshes the read), and starting a Bot. */
export function createBotFilesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const files = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-files:read",
    tag: WS_METHODS.botFilesRead,
  });
  return {
    files,
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot-files:write",
      tag: WS_METHODS.botFilesWrite,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(files({ environmentId, input: { threadId: input.threadId } })),
        ),
    }),
    // Launches a thread, so a double click must not start two Bots.
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot:start",
      tag: WS_METHODS.botStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}
