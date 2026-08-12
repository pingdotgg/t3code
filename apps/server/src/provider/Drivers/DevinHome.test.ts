import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeDevinCapabilitiesCacheKey,
  makeDevinContinuationGroupKey,
  makeDevinEnvironment,
  resolveDevinHomePath,
} from "./DevinHome.ts";

it.layer(NodeServices.layer)("DevinHome", (it) => {
  describe("Devin home resolution", () => {
    it.effect("uses ~/.devin when no Devin home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".devin");

        expect(yield* resolveDevinHomePath({ homePath: "" })).toBe(resolved);
      }),
    );

    it.effect("resolves configured Devin HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.devin-work";
        const resolved = path.resolve(NodeOS.homedir(), ".devin-work");

        expect(yield* resolveDevinHomePath({ homePath })).toBe(resolved);
        expect((yield* makeDevinEnvironment({ homePath })).DEVIN_HOME).toBe(resolved);
        expect(yield* makeDevinContinuationGroupKey({ homePath })).toBe(`devin:home:${resolved}`);
        expect(yield* makeDevinCapabilitiesCacheKey({ binaryPath: "devin", homePath })).toBe(
          `devin\0${resolved}\0`,
        );
      }),
    );

    it.effect("clears an inherited DEVIN_HOME when no Devin home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".devin");

        const env = yield* makeDevinEnvironment(
          { homePath: "" },
          { ...process.env, DEVIN_HOME: "/some/other/home" },
        );

        expect(env.DEVIN_HOME).toBe(resolved);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Devin HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".devin");

        expect(yield* makeDevinContinuationGroupKey({ homePath: "" })).toBe(
          `devin:home:${resolved}`,
        );
      }),
    );
  });
});
