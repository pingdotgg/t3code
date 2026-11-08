import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadButtonScratchEnvironment } from "./new-thread-button-target";

const pc = EnvironmentId.make("pc");
const laptop = EnvironmentId.make("laptop");
type ScratchConfig = Pick<ServerConfig, "scratchWorkspaceRoot">;
const withScratch: ScratchConfig = { scratchWorkspaceRoot: "/scratch" };
const withoutScratch: ScratchConfig = {};

describe("resolveNewThreadButtonScratchEnvironment", () => {
  it("keeps the picker unless No project is chosen", () => {
    for (const target of [undefined, "pick-project"] as const) {
      expect(
        resolveNewThreadButtonScratchEnvironment({
          target,
          connectedEnvironmentIds: [pc],
          serverConfigs: new Map([[pc, withScratch]]),
          preferredEnvironmentIds: [pc],
        }),
      ).toBeNull();
    }
  });

  it("starts on the sole connected server that offers No project folders", () => {
    expect(
      resolveNewThreadButtonScratchEnvironment({
        target: "no-project",
        connectedEnvironmentIds: [pc, laptop],
        serverConfigs: new Map([
          [pc, withScratch],
          [laptop, withoutScratch],
        ]),
        preferredEnvironmentIds: [laptop],
      }),
    ).toBe(pc);
  });

  it("prefers the current environment when several offer No project folders", () => {
    const input = {
      target: "no-project" as const,
      connectedEnvironmentIds: [pc, laptop],
      serverConfigs: new Map([
        [pc, withScratch],
        [laptop, withScratch],
      ]),
    };
    expect(
      resolveNewThreadButtonScratchEnvironment({
        ...input,
        preferredEnvironmentIds: [undefined, "laptop"],
      }),
    ).toBe(laptop);
    expect(
      resolveNewThreadButtonScratchEnvironment({ ...input, preferredEnvironmentIds: [] }),
    ).toBe(null);
  });

  it("falls back to the picker when no connected server offers No project folders", () => {
    expect(
      resolveNewThreadButtonScratchEnvironment({
        target: "no-project",
        connectedEnvironmentIds: [laptop],
        serverConfigs: new Map([
          [pc, withScratch],
          [laptop, withoutScratch],
        ]),
        preferredEnvironmentIds: [pc],
      }),
    ).toBeNull();
  });
});
