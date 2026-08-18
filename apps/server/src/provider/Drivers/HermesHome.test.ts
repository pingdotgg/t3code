import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeHermesContinuationGroupKey,
  makeHermesEnvironment,
  resolveHermesHomePath,
} from "./HermesHome.ts";

it.layer(NodeServices.layer)("HermesHome", (it) => {
  describe("Hermes home resolution", () => {
    it.effect("honors inherited HERMES_HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = { ...process.env, HERMES_HOME: "/tmp/hermes-shared" };
        const resolved = path.resolve("/tmp/hermes-shared");
        expect(yield* resolveHermesHomePath({ homePath: "" }, environment)).toBe(resolved);
        expect(yield* makeHermesContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `hermes:home:${resolved}`,
        );
      }),
    );

    it.effect("lets explicit settings override the inherited home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".hermes-work");
        const environment = { ...process.env, HERMES_HOME: "/tmp/hermes-shared" };
        expect(
          (yield* makeHermesEnvironment({ homePath: "~/.hermes-work" }, environment)).HERMES_HOME,
        ).toBe(resolved);
      }),
    );

    it.effect("uses the instance HOME for Hermes' default directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = { ...process.env, HOME: "/tmp/remote-home", HERMES_HOME: "" };
        expect(yield* resolveHermesHomePath({ homePath: "" }, environment)).toBe(
          path.resolve("/tmp/remote-home/.hermes"),
        );
      }),
    );
  });
});
