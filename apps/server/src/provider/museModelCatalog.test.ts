import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { MuseSettings } from "@t3tools/contracts";
import type { MuseSdkHost } from "./museSdk.ts";

import {
  museModelCapabilities,
  discoverMuseModels,
  resolveMuseReasoningEffort,
} from "./museModelCatalog.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const choices = (model: string, variants?: ReadonlyArray<{ tier: string }>) => {
  const descriptor = museModelCapabilities(model, variants).optionDescriptors?.[0];
  return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
};

describe("Muse effort fallbacks", () => {
  it("offers verified fallback efforts until the native catalog advertises more", () => {
    const base = ["low", "medium", "high", "xhigh"];
    expect(choices("muse-spark-1.3")).toEqual([...base, "max"]);
    expect(choices("muse-spark-1.3-contributor")).toEqual([...base, "max"]);
    expect(choices("custom-muse")).toEqual([...base, "max"]);
    for (const model of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
      expect(choices(model)).toEqual(base);
    }
  });

  it("lets catalog availability override model fallbacks, sorts tiers and removes duplicates", () => {
    expect(
      choices("muse-spark-1.3-contributor", [
        { tier: "ultra" },
        { tier: "future-effort" },
        { tier: "max" },
        { tier: "low" },
        { tier: "max" },
      ]),
    ).toEqual(["low", "max", "ultra"]);
    expect(choices("muse-spark-1.3", [])).toEqual([]);
    expect(choices("muse-spark-1.3", [{ tier: "future-effort" }])).toEqual([]);
  });

  it("uses a supported default and preserves provider descriptions", () => {
    const caps = museModelCapabilities("muse-spark-1.3", [
      { tier: "xhigh", description: "Deep analysis" },
    ]);
    expect(caps.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "xhigh",
        options: [
          { id: "xhigh", label: "Extra High", isDefault: true, description: "Deep analysis" },
        ],
      },
    ]);
  });

  it("normalizes saved and implicit efforts against the selected model before dispatch", () => {
    const contributor = museModelCapabilities("muse-spark-1.3-contributor");
    expect(resolveMuseReasoningEffort(contributor, undefined)).toBe("max");
    expect(resolveMuseReasoningEffort(contributor, "ultra")).toBe("max");
    expect(resolveMuseReasoningEffort(contributor, "max")).toBe("max");
    expect(resolveMuseReasoningEffort(contributor, "xhigh")).toBe("xhigh");
    expect(resolveMuseReasoningEffort(museModelCapabilities("muse-spark-1.3"), "max")).toBe("max");
    const restricted = museModelCapabilities("muse-spark-1.3", [{ tier: "xhigh" }]);
    expect(resolveMuseReasoningEffort(restricted, undefined)).toBe("xhigh");
    expect(resolveMuseReasoningEffort(restricted, "medium")).toBe("xhigh");
    expect(
      resolveMuseReasoningEffort(museModelCapabilities("muse-spark-1.3", []), "max"),
    ).toBeUndefined();
    expect(resolveMuseReasoningEffort(undefined, "max")).toBe("max");
  });
});

const cachedChoices = (home: string) =>
  discoverMuseModels(
    Schema.decodeSync(MuseSettings)({}),
    {},
    undefined,
    async () =>
      ({
        connection: {
          request: async () => ({
            providerId: "meta",
            profileId: "active",
            source: "providerCatalog",
            models: [
              {
                modelId: "muse-spark-1.3",
                displayLabel: "Spark",
                providerId: "meta",
                profileId: "active",
                isDefault: true,
              },
            ],
          }),
          command: async () => ({}),
          mintCommandId: () => "test",
          onNotification: () => {},
          onServerRequest: () => {},
          onProtocolError: () => {},
          closed: new Promise<void>(() => {}),
        },
        initializeResult: {
          experimentalApi: false,
          grantedCapabilities: [],
          museHome: home,
          platformFamily: "unix",
          platformOs: "linux",
          schema: { version: 1, fingerprint: "test" },
          serverInfo: { name: "muse", version: "test" },
          userAgent: "test",
        },
        exited: new Promise(() => {}),
        close: async () => {},
      }) satisfies MuseSdkHost,
  ).pipe(
    Effect.scoped,
    Effect.map((models) => {
      const descriptor = models[0]?.capabilities?.optionDescriptors?.[0];
      return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
    }),
  );

it.layer(NodeServices.layer)("Muse cached model catalog", (it) => {
  it.effect("tolerates a missing cache", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "muse-catalog-test-" });
        expect(yield* cachedChoices(home)).toEqual(["low", "medium", "high", "xhigh", "max"]);
      }),
    ),
  );

  it.effect("ignores incompatible caches and rows outside the active profile and provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "muse-catalog-test-" });
        const directory = `${home}/model-catalog`;
        yield* fs.makeDirectory(directory);
        const row = {
          model_id: "muse-spark-1.3",
          provider_id: "meta",
          profile_id: "active",
          visibility: "visible",
          reasoning_effort_variants: [{ tier: "max" }],
        };
        const cache = {
          schema_version: 1,
          provider_id: "meta",
          profile_id: "active",
          source: "provider_catalog",
          rows: [row],
        };
        const incompatible = [
          { ...cache, schema_version: 2 },
          { ...cache, provider_id: "foreign" },
          { ...cache, profile_id: "other-profile" },
          { ...cache, source: "bundled_catalog" },
          {
            ...cache,
            rows: [
              { ...row, provider_id: "foreign" },
              { ...row, profile_id: "other-profile" },
              { ...row, visibility: "hidden" },
              { ...row, reasoning_effort_variants: null },
            ],
          },
        ];
        for (const [index, content] of incompatible.entries()) {
          yield* fs.writeFileString(`${directory}/${index}.json`, encodeJson(content));
        }
        yield* fs.writeFileString(`${directory}/broken.json`, "{invalid");
        expect(yield* cachedChoices(home)).toEqual(["low", "medium", "high", "xhigh", "max"]);
        yield* fs.writeFileString(`${directory}/valid.json`, encodeJson(cache));
        expect(yield* cachedChoices(home)).toEqual(["max"]);
      }),
    ),
  );
});
