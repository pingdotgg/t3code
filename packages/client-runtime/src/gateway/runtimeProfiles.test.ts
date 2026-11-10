import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  WS_METHODS,
  type ServerSettings,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
        let resourcesSupported = true;
        const session = yield* SubscriptionRef.make(
          Option.some({
            initialConfig: Effect.sync(() => ({
              environment: { capabilities: { agentSkillResources: resourcesSupported } },
            })),
            client: {
              [WS_METHODS.serverGetConfig]: () => Effect.succeed({ settings }),
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
          entries: yield* SubscriptionRef.make(new Map()),
          run: <A, E>(_id: EnvironmentId, effect: Effect.Effect<A, E, EnvironmentSupervisor>) =>
            effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisor)),
        } as unknown as EnvironmentRegistry["Service"];
        let counter = 0;
        const crypto = SecureRandom.make((size) => new Uint8Array(size).fill(++counter));
        const context = yield* Effect.context<never>();
        const port = createGatewayRuntimePort({
          runPromise: (effect) =>
            // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The port exposes a Promise boundary; exercise its injected runner using this test's Effect context.
            Effect.runPromiseWith(context)(
              effect.pipe(
                Effect.provideService(EnvironmentRegistry, registry),
                Effect.provideService(SecureRandom.SecureRandom, crypto),
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
        const skillInput = {
          name: "Review",
          description: "Review PRs",
          content: "# Review\nCheck correctness",
          resources: [{ path: "scripts/check.sh", contentBase64: "b2s=", executable: true }],
        };
        const skills = yield* Effect.promise(() =>
          Promise.all([
            port.createSkill!("local", skillInput),
            port.createSkill!("local", { ...skillInput, name: "Tests" }),
          ]),
        );
        expect(settings.agentSkills).toHaveLength(2);
        const skillId = skills[0]!.skillId;
        const revised = yield* Effect.promise(() =>
          port.updateSkill!("local", skillId, { content: "# Review\nCheck regressions" }),
        );
        expect(revised.content).toContain("regressions");
        expect(revised.skillId).toBe(skillId);
        expect(revised.resources).toEqual(skillInput.resources);
        const cleared = yield* Effect.promise(() =>
          port.updateSkill!("local", skillId, { resources: [] }),
        );
        expect(cleared.resources).toEqual([]);
        resourcesSupported = false;
        yield* Effect.promise(() =>
          expect(
            port.updateSkill!("local", skillId, { resources: skillInput.resources }),
          ).rejects.toThrow("Update T3"),
        );
        expect(settings.agentSkills[0]?.resources).toEqual([]);
        resourcesSupported = true;
        expect(
          (yield* Effect.promise(() => port.listSkills!("local"))).map((skill) => skill.name),
        ).toEqual(["Review", "Tests"]);
        yield* Effect.promise(() => port.updateProfile!("local", id, { skillIds: [skillId] }));
        expect(settings.mcpGatewayProfiles[0]?.skillIds).toEqual([skillId]);
        yield* Effect.promise(() => port.deleteSkill!("local", skillId));
        expect(settings.agentSkills.map((skill) => skill.name)).toEqual(["Tests"]);
        expect(writes.at(-1)).toMatchObject({ patch: { agentSkills: [{ name: "Tests" }] } });
        yield* Effect.promise(() => port.deleteProfile!("local", id));
        expect(settings.mcpGatewayProfiles).toEqual([]);
      }),
  );
});
