/**
 * SazabiAdapter — scaffolded, "empty" adapter for the Sazabi cloud provider.
 *
 * PR T1 ships the structure only. Every session/turn operation that would talk
 * to the Sazabi public API returns a clear "not implemented" error, and the
 * canonical `streamEvents` PubSub is wired up but never published to yet. This
 * keeps the driver constructable at boot (so the provider appears in the
 * catalog + settings and reports its availability) without pretending to run
 * remote work.
 *
 * PR T2 replaces the not-implemented bodies with the real
 * `messages send` / SSE stream mapping, `interruptTurn → cancel`, and the tool
 * item lifecycle. The `streamEvents` PubSub is intentionally left in place so
 * that wiring is a fill-in rather than a restructure.
 *
 * @module provider/Layers/SazabiAdapter
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type SazabiSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { type SazabiAdapterShape } from "../Services/SazabiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("sazabi");

/**
 * Shared detail for every not-yet-implemented adapter operation. Referenced by
 * tests so the "scaffold" contract is asserted in one place.
 */
export const SAZABI_ADAPTER_NOT_IMPLEMENTED_DETAIL =
  "Sazabi is a scaffold: the streaming adapter (Sazabi public API messages/stream/cancel) " +
  "arrives in PR T2.";

export interface SazabiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  /**
   * Native NDJSON logger for raw provider events. Unused by the scaffold; T2
   * writes Sazabi SSE frames through it, matching the other adapters.
   */
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export function makeSazabiAdapter(
  sazabiSettings: SazabiSettings,
  options?: SazabiAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("sazabi");
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    yield* Effect.addFinalizer(() => PubSub.shutdown(runtimeEventPubSub));

    // Record what the (future) adapter would connect to. Keeps the scaffolded
    // config threaded through so T2's fill-in has an obvious construction site.
    yield* Effect.logDebug("Sazabi adapter constructed (scaffold; streaming lands in PR T2).", {
      instanceId: boundInstanceId,
      hasApiBaseUrl: sazabiSettings.apiBaseUrl.trim().length > 0,
    });

    const notImplemented = (method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `${SAZABI_ADAPTER_NOT_IMPLEMENTED_DETAIL} (instance ${boundInstanceId})`,
        }),
      );

    const startSession: SazabiAdapterShape["startSession"] = () => notImplemented("session/start");

    const sendTurn: SazabiAdapterShape["sendTurn"] = () => notImplemented("session/prompt");

    // Interrupt/stop are safe no-ops: the scaffold never opens a remote run, so
    // there is nothing to cancel or tear down. T2 maps these to Sazabi cancel.
    const interruptTurn: SazabiAdapterShape["interruptTurn"] = () => Effect.void;

    const respondToRequest: SazabiAdapterShape["respondToRequest"] = () =>
      notImplemented("session/request_permission");

    const respondToUserInput: SazabiAdapterShape["respondToUserInput"] = () =>
      notImplemented("session/user_input");

    const stopSession: SazabiAdapterShape["stopSession"] = () => Effect.void;

    const listSessions: SazabiAdapterShape["listSessions"] = () => Effect.succeed([]);

    const hasSession: SazabiAdapterShape["hasSession"] = () => Effect.succeed(false);

    const readThread: SazabiAdapterShape["readThread"] = () => notImplemented("thread/read");

    const rollbackThread: SazabiAdapterShape["rollbackThread"] = () =>
      notImplemented("thread/rollback");

    const stopAll: SazabiAdapterShape["stopAll"] = () => Effect.void;

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies SazabiAdapterShape;
  });
}
