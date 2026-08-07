import { assert, it as effectIt } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  clampOpenCode2Variant,
  openCode2InteractionModeForAgent,
  openCode2SessionSelectionParameters,
  planOpenCode2VariantAlignment,
  resolveOpenCode2SessionAgent,
  retryEmptyOpenCode2VariantCatalog,
} from "./OpenCode2AdapterV2.ts";

describe("openCode2InteractionModeForAgent", () => {
  it("maps every native pair event so matching echoes supersede queued reflections", () => {
    expect(openCode2InteractionModeForAgent("build")).toBe("default");
    expect(openCode2InteractionModeForAgent("plan")).toBe("plan");
    expect(openCode2InteractionModeForAgent("Release-Captain")).toBeNull();
  });
});

describe("openCode2SessionSelectionParameters", () => {
  it("sends the canonical option id when creating or switching a native session", () => {
    expect(
      openCode2SessionSelectionParameters({
        instanceId: ProviderInstanceId.make("opencode2"),
        model: "opencode/glm-5.2",
        options: [{ id: "agent", value: "build" }],
      }),
    ).toEqual({
      model: { id: "glm-5.2", providerID: "opencode" },
      agent: "build",
    });
  });

  it("preserves custom executable agent ids verbatim", () => {
    expect(
      openCode2SessionSelectionParameters({
        instanceId: ProviderInstanceId.make("opencode2"),
        model: "opencode/glm-5.2",
        options: [{ id: "agent", value: "Release-Captain" }],
      }).agent,
    ).toBe("Release-Captain");
  });

  it("sends the selected variant on the model ref", () => {
    expect(
      openCode2SessionSelectionParameters({
        instanceId: ProviderInstanceId.make("opencode2"),
        model: "opencode/claude-opus-5",
        options: [{ id: "variant", value: "high" }],
      }).model,
    ).toEqual({ id: "claude-opus-5", providerID: "opencode", variant: "high" });
  });

  // The 2.x server resolves an unset variant to a synthetic id literally named
  // "default" that is not in any model's catalog, and an unknown bound variant
  // silently swallows the next prompt, so the sentinel must never hit the wire.
  it("treats the synthetic default variant as unset", () => {
    expect(
      openCode2SessionSelectionParameters({
        instanceId: ProviderInstanceId.make("opencode2"),
        model: "opencode/claude-opus-5",
        options: [{ id: "variant", value: "default" }],
      }).model,
    ).toEqual({ id: "claude-opus-5", providerID: "opencode" });
  });

  it("derives the agent from the interaction mode when no option is set", () => {
    expect(
      openCode2SessionSelectionParameters(
        {
          instanceId: ProviderInstanceId.make("opencode2"),
          model: "opencode/glm-5.2",
        },
        "plan",
      ).agent,
    ).toBe("plan");
  });
});

describe("resolveOpenCode2SessionAgent", () => {
  it("keeps a custom agent over the toggle", () => {
    expect(resolveOpenCode2SessionAgent("Release-Captain", "plan")).toBe("Release-Captain");
    expect(resolveOpenCode2SessionAgent("Release-Captain", "default")).toBe("Release-Captain");
    expect(resolveOpenCode2SessionAgent("Release-Captain", undefined)).toBe("Release-Captain");
  });

  // The descriptor's Auto sentinel means "defer to the toggle".
  it("treats the auto sentinel as no explicit selection", () => {
    expect(resolveOpenCode2SessionAgent("auto", "plan")).toBe("plan");
    expect(resolveOpenCode2SessionAgent("auto", "default")).toBe("build");
    expect(resolveOpenCode2SessionAgent("auto", undefined)).toBeUndefined();
  });

  // Every pre-toggle thread has a persisted `agent: "build"` selection; it
  // must not pin the Build/Plan toggle inert.
  it("lets plan mode override a stale build option", () => {
    expect(resolveOpenCode2SessionAgent("build", "plan")).toBe("plan");
  });

  it("honors an explicit plan option in default mode", () => {
    expect(resolveOpenCode2SessionAgent("plan", "default")).toBe("plan");
    expect(resolveOpenCode2SessionAgent("plan", "plan")).toBe("plan");
  });

  it("maps the toggle onto the native pair when no option is set", () => {
    expect(resolveOpenCode2SessionAgent(undefined, "default")).toBe("build");
    expect(resolveOpenCode2SessionAgent(undefined, "plan")).toBe("plan");
    expect(resolveOpenCode2SessionAgent("build", "default")).toBe("build");
  });

  it("drops an agent that the live catalog does not contain", () => {
    const buildOnly = new Set(["build"]);
    expect(resolveOpenCode2SessionAgent(undefined, "default", buildOnly)).toBe("build");
    expect(resolveOpenCode2SessionAgent(undefined, "plan", buildOnly)).toBeUndefined();
    expect(resolveOpenCode2SessionAgent("Release-Captain", "default", buildOnly)).toBeUndefined();
  });

  // Subagent child sessions and text generation pass no interaction mode and
  // must keep their explicit-option-only behavior.
  it("passes the explicit option through when no mode is given", () => {
    expect(resolveOpenCode2SessionAgent("build", undefined)).toBe("build");
    expect(resolveOpenCode2SessionAgent("plan", undefined)).toBe("plan");
    expect(resolveOpenCode2SessionAgent(undefined, undefined)).toBeUndefined();
  });
});

describe("clampOpenCode2Variant", () => {
  const KNOWN = new Set(["low", "high"]);

  it("passes a catalog variant through", () => {
    expect(clampOpenCode2Variant("high", KNOWN)).toEqual({
      variant: "high",
      droppedVariant: null,
    });
  });

  it("drops a variant the catalog does not list", () => {
    expect(clampOpenCode2Variant("bogus", KNOWN)).toEqual({
      variant: undefined,
      droppedVariant: "bogus",
    });
  });

  // Covers a failed catalog fetch, the empty bootstrap catalog, and a model
  // missing from the catalog: none can positively validate, so fail closed.
  it("drops any variant when the catalog is unavailable", () => {
    expect(clampOpenCode2Variant("high", null)).toEqual({
      variant: undefined,
      droppedVariant: "high",
    });
  });

  it("leaves an unset variant alone without reporting a drop", () => {
    expect(clampOpenCode2Variant(undefined, null)).toEqual({
      variant: undefined,
      droppedVariant: null,
    });
  });
});

describe("planOpenCode2VariantAlignment", () => {
  const MODEL = "opencode/claude-opus-5";
  const KNOWN = new Set(["low", "high"]);

  // Subagent child threads and pre-variant selections carry no variant
  // option; that must not reset a variant the native session already has.
  it("leaves the bound variant alone when the selection has no opinion", () => {
    expect(
      planOpenCode2VariantAlignment({
        boundModel: MODEL,
        boundVariant: "high",
        model: MODEL,
        rawVariant: undefined,
        knownVariants: KNOWN,
      }),
    ).toEqual({ switchNeeded: false, variant: undefined, droppedVariant: null });
  });

  it("switches on a variant-only change between turns", () => {
    expect(
      planOpenCode2VariantAlignment({
        boundModel: MODEL,
        boundVariant: "high",
        model: MODEL,
        rawVariant: "low",
        knownVariants: KNOWN,
      }),
    ).toEqual({ switchNeeded: true, variant: "low", droppedVariant: null });
  });

  it("does not switch when the selected variant is already bound", () => {
    expect(
      planOpenCode2VariantAlignment({
        boundModel: MODEL,
        boundVariant: "high",
        model: MODEL,
        rawVariant: "high",
        knownVariants: KNOWN,
      }).switchNeeded,
    ).toBe(false);
  });

  it("resets a bound variant when the synthetic default is selected", () => {
    expect(
      planOpenCode2VariantAlignment({
        boundModel: MODEL,
        boundVariant: "high",
        model: MODEL,
        rawVariant: "default",
        knownVariants: null,
      }),
    ).toEqual({ switchNeeded: true, variant: undefined, droppedVariant: null });
  });

  it("rebinds on a model change even without a variant option", () => {
    expect(
      planOpenCode2VariantAlignment({
        boundModel: "opencode/glm-5.2",
        boundVariant: "high",
        model: MODEL,
        rawVariant: undefined,
        knownVariants: null,
      }),
    ).toEqual({ switchNeeded: true, variant: undefined, droppedVariant: null });
  });

  it("clamps an unknown variant to the server default and still switches", () => {
    expect(
      planOpenCode2VariantAlignment({
        boundModel: MODEL,
        boundVariant: "high",
        model: MODEL,
        rawVariant: "bogus",
        knownVariants: KNOWN,
      }),
    ).toEqual({ switchNeeded: true, variant: undefined, droppedVariant: "bogus" });
  });
});

describe("retryEmptyOpenCode2VariantCatalog", () => {
  const POPULATED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["opencode/glm-5.2", new Set(["high", "max"])],
  ]);

  // The bootstrap window: the server is up but reports an empty catalog, which
  // would otherwise make the fail-closed clamp eat a valid first-turn variant.
  effectIt.effect("retries an empty bootstrap catalog until it populates", () =>
    Effect.gen(function* () {
      let reads = 0;
      const catalog = yield* retryEmptyOpenCode2VariantCatalog(
        Effect.sync(() => {
          reads += 1;
          return reads < 3 ? new Map<string, ReadonlySet<string>>() : POPULATED;
        }),
        { maxAttempts: 5, retryDelayMs: 0 },
      );

      assert.strictEqual(reads, 3);
      assert.strictEqual(catalog?.get("opencode/glm-5.2")?.has("max"), true);
    }),
  );

  effectIt.effect("retries a failed fetch and stops after the configured attempts", () =>
    Effect.gen(function* () {
      let reads = 0;
      const catalog = yield* retryEmptyOpenCode2VariantCatalog(
        Effect.sync(() => {
          reads += 1;
          return null;
        }),
        { maxAttempts: 3, retryDelayMs: 0 },
      );

      assert.strictEqual(reads, 3);
      assert.strictEqual(catalog, null);
    }),
  );

  effectIt.effect("returns a populated catalog immediately", () =>
    Effect.gen(function* () {
      let reads = 0;
      const catalog = yield* retryEmptyOpenCode2VariantCatalog(
        Effect.sync(() => {
          reads += 1;
          return POPULATED;
        }),
        { maxAttempts: 5, retryDelayMs: 0 },
      );

      assert.strictEqual(reads, 1);
      assert.strictEqual(catalog, POPULATED);
    }),
  );
});
