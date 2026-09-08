import { makeDeployTarget } from "../../core/index.ts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TARGET_SPECIFIER,
  isVocsTarget,
  selectVocsTargetInput,
} from "../Target.ts";

describe("Vocs target selection", () => {
  it("uses the Vocs Cloudflare target by default", () => {
    expect(selectVocsTargetInput()).toEqual({
      input: DEFAULT_TARGET_SPECIFIER,
      config: undefined,
    });
  });

  it("unwraps the E2E harness Cloudflare worker configuration", () => {
    const worker = { compatibilityDate: "2026-03-10" };
    expect(
      selectVocsTargetInput({ target: { cloudflare: { worker } } }),
    ).toEqual({ input: DEFAULT_TARGET_SPECIFIER, config: worker });
  });

  it("preserves an explicit target and its factory configuration", () => {
    const factory = () =>
      makeDeployTarget({
        platform: "test",
        config: undefined,
        adapter: () => {
          throw new Error("not called");
        },
        vitePlugins: () => {
          throw new Error("not called");
        },
      });
    const config = { region: "test" };
    expect(selectVocsTargetInput({ target: factory, vite: config })).toEqual({
      input: factory,
      config,
    });
  });

  it("recognizes only deploy targets with the Waku runtime hooks", () => {
    expect(
      isVocsTarget(
        makeDeployTarget({
          platform: "test",
          config: undefined,
          adapter: () => {
            throw new Error("not called");
          },
          vitePlugins: () => {
            throw new Error("not called");
          },
        }),
      ),
    ).toBe(true);
    expect(
      isVocsTarget(makeDeployTarget({ platform: "test", config: undefined })),
    ).toBe(false);
  });
});
