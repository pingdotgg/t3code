import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

it.effect("does not store a lookup that an invalidation overtook", () =>
  Effect.gen(function* () {
    const latestVersions = yield* ProviderLatestVersions.make();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const staleLookup = yield* latestVersions
      .cached(
        "package",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("1.0.0"),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);

    yield* latestVersions.invalidate("package");
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(staleLookup)).toBe("1.0.0");

    expect(yield* latestVersions.cached("package", Effect.succeed("2.0.0"))).toBe("2.0.0");
  }),
);
