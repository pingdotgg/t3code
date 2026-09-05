import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { createGatewayRuntimePortFromContext } from "./runtimePort.ts";

const environmentId = EnvironmentId.make("remote-1");
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});

describe("Gateway Runtime Port", () => {
  it.effect("projects the existing registry without starting or replacing it", () =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make(
        new Map([
          [
            environmentId,
            {
              target: {
                _tag: "RelayConnectionTarget" as const,
                environmentId,
                label: "Build machine",
              },
              profile: { _tag: "None" as const },
            },
          ],
        ]),
      );
      const start = vi.fn(() => Effect.void);
      const registry = EnvironmentRegistry.of({
        entries,
        start,
        state: () =>
          Effect.succeed({
            desired: true,
            network: "online",
            phase: "connected",
            stage: null,
            attempt: 1,
            generation: 1,
            lastFailure: null,
            retryAt: null,
          }),
      } as unknown as EnvironmentRegistry["Service"]);

      yield* Effect.gen(function* () {
        const context = yield* Effect.context<EnvironmentRegistry | Crypto.Crypto>();
        const port = createGatewayRuntimePortFromContext(context);
        const result = yield* Effect.promise(() => port.listEnvironments());

        expect(result).toEqual([
          {
            environmentId: "remote-1",
            label: "Build machine",
            targetKind: "relay",
            connectionState: "connected",
          },
        ]);
        expect(start).not.toHaveBeenCalled();
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(Crypto.Crypto, testCrypto),
      );
    }),
  );
});
