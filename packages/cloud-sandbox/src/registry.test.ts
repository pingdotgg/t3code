import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createCloudSandboxDriver, supportedCloudSandboxDrivers } from "./registry.ts";

it.effect("constructs the supported provider and refuses unimplemented providers", () =>
  Effect.gen(function* () {
    expect(supportedCloudSandboxDrivers).toEqual([{ kind: "boat", label: "Boat.dev" }]);
    expect((yield* createCloudSandboxDriver("boat", { apiKey: "boat_test" })).kind).toBe("boat");
    const unsupported = yield* createCloudSandboxDriver("daytona", { apiKey: "unused" }).pipe(
      Effect.result,
    );
    expect(unsupported._tag).toBe("Failure");
  }),
);
