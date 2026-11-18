import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { subscribe } from "../rpc/client.ts";
import { ShellSnapshotLoader } from "./shellSnapshotHttp.ts";

/** How long the socket fallback waits for its snapshot before the caller retries later. */
const SOCKET_SNAPSHOT_TIMEOUT = "30 seconds";

/**
 * Conn: every active thread, older settled and idle subagents included; null to retry later.
 * HTTP first, the socket when HTTP refuses (as the shell does), never with omissions or cursor.
 * The socket read ends at its first full snapshot and never touches the live shell.
 */
export const readShellThreadInventory = Effect.fn("ShellInventory.read")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const loader = yield* ShellSnapshotLoader;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isSome(prepared)) {
    const answer = yield* loader.load(prepared.value, {});
    if (Option.isSome(answer) && !("resumable" in answer.value)) {
      return answer.value.threads;
    }
  }
  const snapshot = yield* subscribe(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.runHead,
    Effect.timeoutOption(SOCKET_SNAPSHOT_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none()),
  );
  return Option.isSome(snapshot) ? snapshot.value.snapshot.threads : null;
});
