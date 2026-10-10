import * as sshKeys from "@distilled.cloud/hetzner/ssh_keys";
import * as Hetzner from "@/Hetzner";
import { isActionState, State } from "@/State/State.ts";
import * as Test from "@/Test/Alchemy";
import * as servers from "@distilled.cloud/hetzner/servers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Hetzner.providers() });

for (const name of [undefined, "alchemy-server-recovery-explicit"]) {
  test.provider(
    `destroy recovers a ${name === undefined ? "generated" : "named"} server without recorded attributes`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const server = yield* stack.deploy(
          Hetzner.Server("Box", {
            name,
            serverType: "cpx12",
            image: "ubuntu-24.04",
            location: "nbg1",
            startAfterCreate: false,
          }),
        );
        const keyId = server.deploySshKeyId;
        if (keyId === undefined) {
          return yield* Effect.die(new Error("Expected a deploy SSH key"));
        }
        expect((yield* servers.getServer({ id: server.id })).server?.name).toBe(
          server.name,
        );
        expect((yield* sshKeys.getSshKey({ id: keyId })).ssh_key.id).toBe(
          keyId,
        );

        // Reproduce a crash after cloud creation but before attributes were committed.
        yield* Effect.gen(function* () {
          const state = yield* yield* State;
          const address = { stack: stack.name, stage: stack.stage, fqn: "Box" };
          const stored = yield* state.get(address);
          if (!stored || isActionState(stored) || stored.status !== "created") {
            return yield* Effect.die(
              new Error("Expected a created server row"),
            );
          }
          const { attr, ...creating } = stored;
          yield* state.set({
            ...address,
            value: { ...creating, status: "creating" },
          });
        }).pipe(Effect.provide(stack.state));

        yield* stack.destroy();

        expect(
          yield* servers.getServer({ id: server.id }).pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        ).toBe(true);
        expect(
          yield* sshKeys.getSshKey({ id: keyId }).pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        ).toBe(true);

        yield* stack.destroy();
      }),
    {
      tags: [
        "provider:hetzner",
        "provider:hetzner:server",
        "provider:hetzner:service",
        "live",
      ],
      timeout: 120_000,
      exclusive: true,
    },
  );
}
