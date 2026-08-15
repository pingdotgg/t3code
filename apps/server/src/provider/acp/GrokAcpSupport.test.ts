import { describe, expect, it } from "@effect/vitest";

import {
  buildGrokAcpSpawnInput,
  grokAcpRuntimeProcessOwnership,
  resolveGrokAcpBaseModelId,
} from "./GrokAcpSupport.ts";

describe("grokAcpRuntimeProcessOwnership", () => {
  it("opts Grok into detached process-tree ownership on the injected host platform", () => {
    expect(grokAcpRuntimeProcessOwnership("linux")).toEqual({
      ownDescendantProcessGroups: true,
      ownDetachedProcessGroup: true,
      processGroupPlatform: "linux",
    });
  });

  it("uses the prior provider-group path on Darwin and Windows", () => {
    expect(grokAcpRuntimeProcessOwnership("darwin")).toEqual({
      ownDescendantProcessGroups: false,
      ownDetachedProcessGroup: true,
      processGroupPlatform: "darwin",
    });
    expect(grokAcpRuntimeProcessOwnership("win32")).toEqual({
      ownDescendantProcessGroups: false,
      ownDetachedProcessGroup: true,
      processGroupPlatform: "win32",
    });
  });
});

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
  });
});

describe("buildGrokAcpSpawnInput", () => {
  it("passes the T3 Code referrer through Grok OAuth env", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project", {
      XAI_API_KEY: "secret",
      GROK_OAUTH2_REFERRER: "other-client",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/grok",
      args: ["agent", "stdio"],
      cwd: "/tmp/project",
      env: {
        XAI_API_KEY: "secret",
        GROK_OAUTH2_REFERRER: "t3code",
      },
    });
  });
});
