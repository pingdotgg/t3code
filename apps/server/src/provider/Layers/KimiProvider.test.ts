import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { KimiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildInitialKimiProviderSnapshot,
  buildKimiDiscoveredModelsFromConfigOptions,
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
