import { DAEMON_WS_METHODS, type DaemonIdInput, type DaemonUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DaemonService } from "./DaemonService.ts";

export const DAEMON_RPC_AGGREGATES = {
  [DAEMON_WS_METHODS.subscribe]: "daemons",
  [DAEMON_WS_METHODS.upsert]: "daemons",
  [DAEMON_WS_METHODS.delete]: "daemons",
  [DAEMON_WS_METHODS.restart]: "daemons",
} as const;

export const daemonRpcHandlers = (daemons: DaemonService["Service"]) => ({
  [DAEMON_WS_METHODS.subscribe]: (_input: {}) => daemons.subscribe(),
  [DAEMON_WS_METHODS.upsert]: (input: DaemonUpsertInput) => daemons.upsert(input),
  [DAEMON_WS_METHODS.delete]: (input: DaemonIdInput) =>
    Effect.annotateCurrentSpan({ "daemon.id": input.id }).pipe(
      Effect.andThen(daemons.delete(input)),
    ),
  [DAEMON_WS_METHODS.restart]: (input: DaemonIdInput) =>
    Effect.annotateCurrentSpan({ "daemon.id": input.id }).pipe(
      Effect.andThen(daemons.restart(input)),
    ),
});
