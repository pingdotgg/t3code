import { describe, expect, it } from "vitest";
import {
  makeAwsTarget,
  NITRO_HANDLER_SPECIFIER,
  NITRO_PRESET,
} from "../aws.ts";
import type { NitroConfigSlice } from "../UserConfig.ts";

describe("makeAwsTarget", () => {
  it("declares the aws platform, the nitro preset, and node bundle settings", () => {
    const target = makeAwsTarget();
    expect(target.platform).toBe("aws");
    expect(target.nitroPreset).toBe(NITRO_PRESET);
    expect(target.bundle?.conditions).toEqual(["node", "import", "module"]);
    expect(target.bundle?.external).toEqual(["@aws-sdk/"]);
    // Nitro's aws-lambda output is already a complete Node deployment unit.
    expect(target.finish).toBeUndefined();
  });

  it("runs the build in a disposable child process", () => {
    expect(typeof makeAwsTarget().build).toBe("function");
  });

  it("enables response streaming by default", () => {
    const config: NitroConfigSlice = {};
    makeAwsTarget().configureNitro?.(config, { root: "/project" });
    expect(config.awsLambda).toEqual({ streaming: true });
  });

  it("honors an explicit streaming opt-out (buffered handler)", () => {
    const config: NitroConfigSlice = {};
    makeAwsTarget({ streaming: false }).configureNitro?.(config, {
      root: "/project",
    });
    expect(config.awsLambda).toEqual({ streaming: false });
  });

  it("preserves foreign awsLambda keys while overriding the owned one", () => {
    const config: NitroConfigSlice = {
      awsLambda: { streaming: false, someOtherKey: 1 },
    };
    makeAwsTarget().configureNitro?.(config, { root: "/project" });
    expect(config.awsLambda).toEqual({ streaming: true, someOtherKey: 1 });
  });

  it("carries the caller's nitro overrides on the target config", () => {
    const target = makeAwsTarget({ nitro: { prerender: { routes: ["/"] } } });
    expect(target.config.nitro).toEqual({ prerender: { routes: ["/"] } });
  });

  it("exports the wrappable-handler specifier for custom entries", () => {
    expect(NITRO_HANDLER_SPECIFIER).toBe(
      "nitropack/presets/aws-lambda/runtime/aws-lambda-streaming",
    );
  });
});
