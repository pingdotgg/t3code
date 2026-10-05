import { retryContainerPublication } from "@/Cloudflare/Containers/ContainerPublication.ts";
import {
  DockerRegistryBlobUnknown,
  DockerRegistryUnavailable,
} from "@/Docker/RegistryError.ts";
import { describe, expect, it } from "alchemy-test";
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
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:container",
      "local",
    ],
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
