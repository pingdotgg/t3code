import {
  retryContainerBuild,
  retryContainerPublication,
} from "@alchemy.run/cloudflare/Containers/ContainerPublication";
import {
  DockerRegistryBlobUnknown,
  DockerRegistryUnavailable,
} from "@alchemy.run/docker/RegistryError";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { PlatformError, SystemError } from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

const cause = new PlatformError(
  new SystemError({
    _tag: "Unknown",
    module: "Docker",
    method: "buildx.build",
    description: "publication failed",
  }),
);

describe(
  "container publication retries",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:container", "local"],
  },
  () => {
    for (const error of [
      new DockerRegistryBlobUnknown({ cause }),
      new DockerRegistryUnavailable({ cause }),
    ]) {
      it.effect(
        `recovers from ${error._tag}`,
        () =>
          Effect.gen(function* () {
            let attempts = 0;
            const fiber = yield* Effect.suspend(() =>
              ++attempts < 3 ? Effect.fail(error) : Effect.succeed("published"),
            ).pipe(retryContainerPublication, Effect.forkChild);
            yield* TestClock.adjust("15 seconds");
            expect(yield* Fiber.join(fiber)).toBe("published");
            expect(attempts).toBe(3);
          }),
        { tags: ["provider:docker", "provider:docker:registry"] },
      );

      it.effect(
        `bounds retries for ${error._tag}`,
        () =>
          Effect.gen(function* () {
            let attempts = 0;
            const fiber = yield* Effect.suspend(() => {
              attempts++;
              return Effect.fail(error);
            }).pipe(retryContainerPublication, Effect.flip, Effect.forkChild);
            yield* TestClock.adjust("1 minute");
            expect(yield* Fiber.join(fiber)).toBe(error);
            expect(attempts).toBe(6);
          }),
        { tags: ["provider:docker", "provider:docker:registry"] },
      );
    }

    it.effect("retries a build attempt that stalls past its deadline", () =>
      Effect.gen(function* () {
        let attempts = 0;
        const fiber = yield* Effect.suspend(() =>
          ++attempts === 1 ? Effect.never : Effect.succeed("published"),
        ).pipe(retryContainerBuild, Effect.forkChild);
        yield* TestClock.adjust("3 minutes");
        yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(fiber)).toBe("published");
        expect(attempts).toBe(2);
      }),
    );

    it.effect("gives up on a build that keeps stalling", () =>
      Effect.gen(function* () {
        let attempts = 0;
        const fiber = yield* Effect.suspend(() => {
          attempts++;
          return Effect.never;
        }).pipe(retryContainerBuild, Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("20 minutes");
        expect((yield* Fiber.join(fiber))._tag).toBe("TimeoutError");
        expect(attempts).toBe(6);
      }),
    );

    it.effect("propagates other Docker errors without retrying", () =>
      Effect.gen(function* () {
        let attempts = 0;
        const error = yield* Effect.suspend(() => {
          attempts++;
          return Effect.fail(cause);
        }).pipe(retryContainerPublication, Effect.flip);
        expect(error).toBe(cause);
        expect(attempts).toBe(1);
      }),
    );
  },
);
