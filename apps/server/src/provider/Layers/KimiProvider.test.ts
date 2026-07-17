import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { KimiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildInitialKimiProviderSnapshot,
  buildKimiDiscoveredModelsFromConfigOptions,
  buildKimiDiscoveredProviderSnapshot,
  checkKimiProviderStatus,
} from "./KimiProvider.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

describe("buildInitialKimiProviderSnapshot", () => {
  it.effect("builds a disabled snapshot with the built-in fallback models", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(
        decodeKimiSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
      ]);
    }),
  );

  it.effect("builds a checking snapshot for enabled Kimi", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(decodeKimiSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Checking Kimi Code");
    }),
  );
});

describe("buildKimiDiscoveredModelsFromConfigOptions", () => {
  it("reads and deduplicates Kimi model select options", () => {
    const models = buildKimiDiscoveredModelsFromConfigOptions([
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "kimi-for-coding",
        options: [
          { value: "kimi-for-coding", name: "Kimi for Coding" },
          { value: "kimi-for-coding", name: "Duplicate" },
          { value: "kimi-for-coding-highspeed", name: "Kimi Highspeed" },
        ],
      },
    ]);

    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["kimi-for-coding", "Kimi for Coding"],
      ["kimi-for-coding-highspeed", "Kimi Highspeed"],
    ]);
  });

  it("returns no models for the logged-out empty model select", () => {
    expect(
      buildKimiDiscoveredModelsFromConfigOptions([
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "",
          options: [],
        },
      ]),
    ).toEqual([]);
  });
});

describe("buildKimiDiscoveredProviderSnapshot", () => {
  const fallbackModels = [
    { slug: "kimi-for-coding", name: "Kimi for Coding", isCustom: false, capabilities: {} },
  ] as const;
  const baseInput = {
    kimiSettings: decodeKimiSettings({ enabled: true }),
    checkedAt: "2026-07-17T00:00:00.000Z",
    fallbackModels,
    version: "0.26.0",
  };

  it("reports ready/authenticated when models were discovered", () => {
    const snapshot = buildKimiDiscoveredProviderSnapshot({
      ...baseInput,
      discovery: {
        models: [
          { slug: "kimi-for-coding", name: "Kimi for Coding", isCustom: false, capabilities: {} },
        ],
        catalogEmpty: false,
      },
    });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.auth.status).toBe("authenticated");
  });

  it("reports unauthenticated when the model catalog is empty (signed out)", () => {
    const snapshot = buildKimiDiscoveredProviderSnapshot({
      ...baseInput,
      discovery: { models: [], catalogEmpty: true },
    });

    expect(snapshot.status).toBe("error");
    expect(snapshot.auth.status).toBe("unauthenticated");
    expect(snapshot.message).toMatch(/kimi login/);
  });

  it("reports a discovery error, not an auth failure, when there is no model option", () => {
    const snapshot = buildKimiDiscoveredProviderSnapshot({
      ...baseInput,
      discovery: { models: [], catalogEmpty: false },
    });

    expect(snapshot.status).toBe("error");
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.message).not.toMatch(/kimi login/);
    expect(snapshot.message).toMatch(/incompatible|misconfigured|no models/);
  });
});

it.layer(NodeServices.layer)("checkKimiProviderStatus", (it) => {
  it.effect("reports a missing configured Kimi binary without throwing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKimiProviderStatus(
        decodeKimiSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/kimi-binary",
        }),
      );

      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
      ]);
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );
});
