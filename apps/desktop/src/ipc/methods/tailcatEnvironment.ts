import {
  DesktopTailcatConnectionIdInputSchema,
  DesktopTailcatEnvironmentBootstrapSchema,
  DesktopTailcatEnvironmentEnsureInputSchema,
  TailcatConnectionDiagnostics,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopTailcatEnvironment from "../../tailcat/DesktopTailcatEnvironment.ts";

/**
 * Renderer-facing Tailcat transport methods. The renderer never touches the
 * private key or the child process; it receives a loopback endpoint and
 * diagnostics, and asks for lifecycle changes by connection id.
 */

export const ensureTailcatEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_TAILCAT_ENVIRONMENT_CHANNEL,
  payload: DesktopTailcatEnvironmentEnsureInputSchema,
  result: DesktopTailcatEnvironmentBootstrapSchema,
  handler: Effect.fn("desktop.ipc.tailcatEnvironment.ensureEnvironment")(function* (input) {
    const tailcat = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
    return yield* tailcat.ensureEnvironment(input);
  }),
});

export const restartTailcatEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESTART_TAILCAT_ENVIRONMENT_CHANNEL,
  payload: DesktopTailcatConnectionIdInputSchema,
  result: DesktopTailcatEnvironmentBootstrapSchema,
  handler: Effect.fn("desktop.ipc.tailcatEnvironment.restartEnvironment")(function* ({
    connectionId,
  }) {
    const tailcat = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
    return yield* tailcat.restartEnvironment(connectionId);
  }),
});

export const disconnectTailcatEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_TAILCAT_ENVIRONMENT_CHANNEL,
  payload: DesktopTailcatConnectionIdInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.tailcatEnvironment.disconnectEnvironment")(function* ({
    connectionId,
  }) {
    const tailcat = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
    yield* tailcat.disconnectEnvironment(connectionId);
  }),
});

export const getTailcatConnectionDiagnostics = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_TAILCAT_CONNECTION_DIAGNOSTICS_CHANNEL,
  payload: DesktopTailcatConnectionIdInputSchema,
  result: Schema.NullOr(TailcatConnectionDiagnostics),
  handler: Effect.fn("desktop.ipc.tailcatEnvironment.diagnostics")(function* ({ connectionId }) {
    const tailcat = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
    return Option.getOrNull(yield* tailcat.diagnostics(connectionId));
  }),
});

export const probeTailcatConnectionPath = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PROBE_TAILCAT_CONNECTION_PATH_CHANNEL,
  payload: DesktopTailcatConnectionIdInputSchema,
  result: Schema.NullOr(TailcatConnectionDiagnostics),
  handler: Effect.fn("desktop.ipc.tailcatEnvironment.probePath")(function* ({ connectionId }) {
    const tailcat = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
    return Option.getOrNull(yield* tailcat.probePath(connectionId));
  }),
});

export const methods = [
  ensureTailcatEnvironment,
  restartTailcatEnvironment,
  disconnectTailcatEnvironment,
  getTailcatConnectionDiagnostics,
  probeTailcatConnectionPath,
] as const;
