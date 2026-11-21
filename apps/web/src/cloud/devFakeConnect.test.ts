import { Connectivity, Wakeups } from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { Discovery, ManagedRelay } from "@t3tools/client-runtime/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  DEV_FAKE_CONNECT_TOKEN,
  decodeDevFakeConnect,
  layerDevFakeManagedRelay,
} from "./devFakeConnect";

const config = Option.getOrThrow(
  decodeDevFakeConnect(
    JSON.stringify({
      account: { email: "demo@example.com" },
      environments: [
        { environmentId: "studio", label: "Studio", online: true, machine: "mac-studio" },
        { environmentId: "vps", label: "VPS", online: false },
      ],
    }),
  ),
);

describe("dev fake T3 Connect", () => {
  it.effect("discovery lists the staged machines with their online state", () =>
    Effect.gen(function* () {
      const discovery = yield* Discovery.RelayEnvironmentDiscovery;
      yield* discovery.refresh;
      const state = yield* SubscriptionRef.get(discovery.state);
      expect(state.listed).toBe(true);
      expect(Option.isNone(state.error)).toBe(true);
      const studio = state.environments.get("studio");
      expect(studio?.availability).toBe("online");
      expect(Option.getOrThrow(studio!.status).descriptor?.platform.machine).toBe("mac-studio");
      expect(state.environments.get("vps")?.availability).toBe("offline");

      const relay = yield* ManagedRelay.ManagedRelayClient;
      const connect = yield* relay
        .connectEnvironment({
          clerkToken: DEV_FAKE_CONNECT_TOKEN,
          scopes: [],
          environmentId: studio!.environment.environmentId,
        })
        .pipe(Effect.flip);
      expect(connect._tag).toBe("ManagedRelayRequestFailedError");
    }).pipe(
      Effect.provide(
        Discovery.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              layerDevFakeManagedRelay(config),
              Layer.succeed(
                ClientCapabilities.CloudSession,
                ClientCapabilities.CloudSession.of({
                  identity: Effect.succeedSome({ accountId: config.account.email }),
                  clerkToken: Effect.succeed(DEV_FAKE_CONNECT_TOKEN),
                }),
              ),
              Layer.succeed(Connectivity.Connectivity, {
                status: Effect.succeed("online" as const),
                changes: Stream.never,
              }),
              Layer.succeed(Wakeups.ConnectionWakeups, { changes: Stream.never }),
            ),
          ),
        ),
      ),
    ),
  );
});
