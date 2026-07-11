import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  buildKiloPermissionRules,
  parseKiloModelSlug,
  toKiloPermissionReply,
} from "./kiloRuntime.ts";

describe("kiloRuntime", () => {
  it("parses canonical upstream provider/model selections", () => {
    expect(parseKiloModelSlug("anthropic/claude-sonnet")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
    });
    expect(parseKiloModelSlug("invalid")).toBeNull();
    expect(parseKiloModelSlug("/missing-provider")).toBeNull();
  });

  it("maps approval decisions without broadening access", () => {
    expect(toKiloPermissionReply("accept")).toBe("once");
    expect(toKiloPermissionReply("acceptForSession")).toBe("always");
    expect(toKiloPermissionReply("decline")).toBe("reject");
    expect(toKiloPermissionReply("cancel")).toBe("reject");
  });

  it("uses explicit ask rules outside full-access mode", () => {
    expect(buildKiloPermissionRules("full-access")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
    expect(buildKiloPermissionRules("approval-required")).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "question", pattern: "*", action: "allow" },
    ]);
    expect(buildKiloPermissionRules("auto-accept-edits")).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "write", pattern: "*", action: "allow" },
      { permission: "patch", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "allow" },
    ]);
  });

  it("keeps Kilo as one top-level instance while model slugs remain upstream-qualified", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("kilo"),
      model: "openai/gpt-5",
    };
    expect(selection.instanceId).toBe("kilo");
    expect(parseKiloModelSlug(selection.model)).toEqual({ providerID: "openai", modelID: "gpt-5" });
  });
});
