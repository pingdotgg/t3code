import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  WS_METHODS,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { createGatewayRuntimePort } from "./runtimePort.ts";

describe("runtime profile persistence", () => {
  it.effect(
    "serializes edits, delegates revision ownership, and sends replica metadata explicitly",
    () =>
      Effect.gen(function* () {
        let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
        const writes: unknown[] = [];
        const session = yield* SubscriptionRef.make(
          Option.some({
            client: {
              [WS_METHODS.serverGetSettings]: () => Effect.succeed(settings),
              [WS_METHODS.serverUpdateSettings]: (input: {
                patch: Partial<ServerSettings>;
                replicateProfiles?: boolean;
              }) =>
                Effect.sync(() => {
                  writes.push(input);
                  settings = {
                    ...settings,
                    ...input.patch,
                    mcpGatewayProfiles:
                      input.patch.mcpGatewayProfiles?.map((profile) =>
                        input.replicateProfiles || settings.mcpGatewayProfiles.includes(profile)
                          ? profile
                          : {
                              ...profile,
                              revision:
                                (settings.mcpGatewayProfiles.find(
                                  (p) => p.profileId === profile.profileId,
                                )?.revision ?? 0) + 1,
                            },
                      ) ?? settings.mcpGatewayProfiles,
                  };
                  return settings;
                }),
            },
          }),
        );
        const supervisor = {
          target: { environmentId: EnvironmentId.make("local"), label: "Local" },
          session,
        } as unknown as EnvironmentSupervisor["Service"];
        const registry = {
          run: <A, E>(_id: EnvironmentId, effect: Effect.Effect<A, E, EnvironmentSupervisor>) =>
            effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
        } as unknown as EnvironmentRegistry["Service"];
        let counter = 0;
        const crypto = Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(++counter),
          digest: (_algorithm, bytes) => Effect.succeed(bytes),
        });
        const context = yield* Effect.context<never>();
        const port = createGatewayRuntimePort({
          runPromise: (effect) =>
            // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The port exposes a Promise boundary; exercise its injected runner using this test's Effect context.
            Effect.runPromiseWith(context)(
              effect.pipe(
                Effect.provideService(EnvironmentRegistry, registry),
                Effect.provideService(Crypto.Crypto, crypto),
              ),
            ),
        });
        const profile = {
          name: "Write",
          providerLabel: "Codex",
          modelLabel: "GPT",
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
        };
        const created = yield* Effect.promise(() =>
          Promise.all([
            port.createProfile!("local", profile),
            port.createProfile!("local", { ...profile, name: "Review" }),
          ]),
        );
        expect(settings.mcpGatewayProfiles).toHaveLength(2);
        expect(created[0]?.revision).toBe(1);
        const id = created[0]!.profileId!;
        const updated = yield* Effect.promise(() =>
          port.updateProfile!("local", id, { modelLabel: "New GPT" }),
        );
        expect(updated.revision).toBe(2);
        expect(updated.profileId).toBe(id);
        yield* Effect.promise(() => port.replicateProfiles!("remote", [updated]));
        expect(writes.at(-1)).toMatchObject({
          replicateProfiles: true,
          patch: { mcpGatewayProfiles: [{ revision: 2 }] },
        });
        yield* Effect.promise(() => port.deleteProfile!("local", id));
        expect(settings.mcpGatewayProfiles).toEqual([]);
      }),
  );
});
