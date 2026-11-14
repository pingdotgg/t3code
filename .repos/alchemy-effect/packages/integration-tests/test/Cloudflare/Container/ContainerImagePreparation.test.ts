import { waitForContainerImage } from "@alchemy.run/cloudflare/Containers/ContainerImagePreparation";
import { describe, expect, it } from "@alchemy.run/test";
import type { NoteKind } from "alchemy/Events";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

const image = "registry.cloudflare.com/account/shell@sha256:digest";
const fixture = () => {
  const notes: { message: string; kind?: NoteKind }[] = [];
  return {
    notes,
    session: {
      note: (message: string, options?: { kind?: NoteKind }) =>
        Effect.sync(() => {
          notes.push({ message, kind: options?.kind });
        }),
    },
  };
};
// A deadline measured in tens of minutes cannot run against the live API;
// these pin the deadline and failure semantics of the preparation wait.
describe(
  "container image preparation",
  { tags: ["unit", "local", "provider:cloudflare:container"] },
  () => {
    it.effect("bounds pending preparation at the default thirty-minute deadline", () =>
      Effect.gen(function* () {
        const { session } = fixture();
        const fiber = yield* waitForContainerImage({
          image,
          name: "shell",
          prepare: Effect.succeed({ image, status: "pending" }),
          session,
        }).pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("30 minutes");
        const error = yield* Fiber.join(fiber);
        expect(error._tag).toBe("ContainerImagePreparationError");
        expect(error.message).toContain("30 minutes");
        expect(error.message).toContain(image);
        expect(error.message).toContain("resume from the published image");
      }),
    );
    it.effect("applies a configured deadline to a stalled API call", () =>
      Effect.gen(function* () {
        const { session } = fixture();
        let interrupted = false;
        const prepare = Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        );
        const fiber = yield* waitForContainerImage({
          image,
          name: "shell",
          timeout: "10 seconds",
          prepare,
          session,
        }).pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("ContainerImagePreparationError");
        expect(interrupted).toBe(true);
      }),
    );
    it.effect("fails immediately with Cloudflare's preparation reason", () =>
      Effect.gen(function* () {
        const { session } = fixture();
        let calls = 0;
        const error = yield* waitForContainerImage({
          image,
          name: "shell",
          session,
          prepare: Effect.sync(() => {
            calls++;
            return { image, status: "error" as const, reason: "unsupported image" };
          }),
        }).pipe(Effect.flip);
        expect(error.message).toBe("unsupported image");
        expect(calls).toBe(1);
      }),
    );
  },
);
