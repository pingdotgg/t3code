import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

const layerTestServices = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const labelFor = (environment: NodeJS.ProcessEnv) =>
  resolveServerEnvironmentLabel({ cwdBaseName: "t3code" }).pipe(
    Effect.provide(layerTestServices),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Environment, environment),
  );

describe("resolveServerEnvironmentLabel", () => {
  it.effect("names a WSL backend apart from its Windows host", () =>
    Effect.gen(function* () {
      assert.equal(yield* labelFor({ WSL_DISTRO_NAME: "Ubuntu-24.04" }), "WSL (Ubuntu-24.04)");
    }),
  );

  it.effect("names WSL without a distro when only the interop socket is present", () =>
    Effect.gen(function* () {
      assert.equal(yield* labelFor({ WSL_INTEROP: "/run/WSL/8_interop" }), "WSL");
    }),
  );
});
