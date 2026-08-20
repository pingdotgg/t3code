import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeKimiContinuationGroupKey,
  makeKimiEnvironment,
  resolveKimiHomePath,
} from "./KimiHome.ts";

it.layer(NodeServices.layer)("KimiHome", (it) => {
  it.effect("resolves the default Kimi home without forcing it into the child environment", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnvironment = { PATH: "bin" };
      const resolvedHome = path.resolve(NodeOS.homedir(), ".kimi-code");

      expect(yield* resolveKimiHomePath({ homePath: "" })).toBe(resolvedHome);
      expect(yield* makeKimiEnvironment({ homePath: "" }, baseEnvironment)).toEqual(
        baseEnvironment,
      );
      expect(yield* makeKimiContinuationGroupKey({ homePath: "" })).toBe(
        `kimi:home:${resolvedHome}`,
      );
    }),
  );

  it.effect("expands an explicit Kimi home for the process and continuation identity", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnvironment = { PATH: "bin" };
      const resolvedHome = path.resolve(NodeOS.homedir(), ".kimi-work");

      expect(yield* resolveKimiHomePath({ homePath: "~/.kimi-work" })).toBe(resolvedHome);
      expect(
        (yield* makeKimiEnvironment({ homePath: "~/.kimi-work" }, baseEnvironment)).KIMI_CODE_HOME,
      ).toBe(resolvedHome);
      expect(yield* makeKimiContinuationGroupKey({ homePath: "~/.kimi-work" })).toBe(
        `kimi:home:${resolvedHome}`,
      );
    }),
  );

  it.effect("uses the child environment for Kimi's implicit home and continuation identity", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const environment = { HOME: path.resolve("/isolated-user") };
      const resolvedHome = path.resolve(environment.HOME, ".kimi-code");

      expect(yield* resolveKimiHomePath({ homePath: "" }, environment)).toBe(resolvedHome);
      expect(yield* makeKimiContinuationGroupKey({ homePath: "" }, environment)).toBe(
        `kimi:home:${resolvedHome}`,
      );
    }),
  );

  it.effect("honors an inherited KIMI_CODE_HOME when no explicit home is configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const environment = {
        HOME: path.resolve("/isolated-user"),
        KIMI_CODE_HOME: "~/.kimi-from-env",
      };
      const resolvedHome = path.resolve(environment.HOME, ".kimi-from-env");

      expect(yield* resolveKimiHomePath({ homePath: "" }, environment)).toBe(resolvedHome);
      expect(yield* makeKimiEnvironment({ homePath: "" }, environment)).toBe(environment);
    }),
  );
});
