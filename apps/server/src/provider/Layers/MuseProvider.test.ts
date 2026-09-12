import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { MuseSettings } from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import type { MuseSdkHost } from "../museSdk.ts";
import { COMPACT_SLASH_COMMAND } from "../providerSnapshot.ts";
import {
  checkMuseProviderStatus,
  discoverMuseModels,
  makePendingMuseProvider,
} from "./MuseProvider.ts";

const settings = Schema.decodeSync(MuseSettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const makeHost = (catalog: Record<string, unknown>, museHome = "/fake/muse") => {
  const host: MuseSdkHost = {
    initializeResult: {
      experimentalApi: false,
      grantedCapabilities: [],
      museHome,
      platformFamily: "unix",
      platformOs: "linux",
      schema: { fingerprint: "test", version: 1 },
      serverInfo: { name: "muse", version: "1.0.3" },
      userAgent: "test",
    },
    connection: {
      request: vi.fn(async () => catalog),
      command: vi.fn(async () => ({})),
      mintCommandId: () => "test-command",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return host;
};
const metaCatalog = {
  providerId: "meta",
  models: [
    {
      modelId: "muse-discovered",
      displayLabel: "Muse Discovered",
      providerId: "meta",
      isDefault: true,
    },
    {
      modelId: "foreign-model",
      displayLabel: "Another provider",
      providerId: "another",
      isDefault: false,
    },
  ],
};

const fakeCli = (source = 'process.stdout.write("muse 1.0.3-R2198.1\\n");') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-test-" });
    return writeFakeCli({ directory, name: "muse", source });
  });

describe("Muse provider defaults", () => {
  it.effect("keeps the provider opt-in without inventing models before discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingMuseProvider(settings({}));
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models).toEqual([]);
      expect(snapshot.slashCommands).toEqual([]);
    }),
  );

  it.effect("advertises native compaction while an enabled provider is being checked", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingMuseProvider(settings({ enabled: true }));
      expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
    }),
  );

  it.effect(
    "applies per-model fallbacks to custom slugs while preserving explicit capabilities",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* makePendingMuseProvider(
          settings({
            customModels: [
              "muse-spark-1.3",
              "muse-spark-1.3-contributor",
              { slug: "custom-muse", capabilities: { optionDescriptors: [] } },
            ],
          }),
        );
        const choices = snapshot.models.map((model) => {
          const descriptor = model.capabilities?.optionDescriptors?.[0];
          return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
        });
        expect(choices).toEqual([
          ["low", "medium", "high", "xhigh", "max"],
          ["low", "medium", "high", "xhigh", "max"],
          [],
        ]);
      }),
  );
});

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("does not start a host when disabled", () =>
    Effect.gen(function* () {
      const createHost = vi.fn(async () => makeHost(metaCatalog));
      const snapshot = yield* checkMuseProviderStatus(settings({}), {}, undefined, createHost);
      expect(snapshot.status).toBe("disabled");
      expect(createHost).not.toHaveBeenCalled();
    }),
  );

  it.effect("gives host-local install and login guidance for a missing binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: true, binaryPath: "/definitely-missing/muse" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("muse login");
      expect(snapshot.message).toContain("this T3 server host");
    }),
  );

  it.effect("does not expose CLI stderr or start an SDK host after a failed version check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          'process.stderr.write("secret-test-value");process.exit(2);',
        );
        const createHost = vi.fn(async () => makeHost(metaCatalog));
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          createHost,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).not.toContain("secret-test-value");
        expect(createHost).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("discovers the Meta catalog without treating it as authentication proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath, customModels: ["muse-custom"] }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.version).toBe("1.0.3-R2198.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "muse-discovered",
          "muse-custom",
        ]);
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          descriptor?.type === "select" && descriptor.options.map((option) => option.id),
        ).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("uses and refreshes the initialized host's model efforts for the active profile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const museHome = yield* fs.makeTempDirectoryScoped({ prefix: "muse-catalog-test-" });
        yield* fs.makeDirectory(`${museHome}/model-catalog`);
        const modelIds = ["muse-spark-1.3", "muse-spark-1.3-contributor"];
        const host = makeHost(
          {
            providerId: "meta",
            profileId: "active",
            source: "providerCatalog",
            models: modelIds.map((modelId) => ({
              modelId,
              displayLabel: modelId,
              providerId: "meta",
              profileId: "active",
              isDefault: modelId.endsWith("contributor"),
            })),
          },
          museHome,
        );
        const cache = {
          schema_version: 1,
          provider_id: "meta",
          profile_id: "active",
          source: "provider_catalog",
          rows: modelIds.map((model_id, index) => ({
            model_id,
            provider_id: "meta",
            profile_id: "active",
            visibility: "visible",
            reasoning_effort_variants: (index === 0 ? ["max", "medium"] : ["xhigh"]).map(
              (tier) => ({ tier }),
            ),
          })),
        };
        const cachePath = `${museHome}/model-catalog/profile.json`;
        yield* fs.writeFileString(cachePath, encodeJson(cache));
        const discover = discoverMuseModels(settings({}), {}, undefined, async () => host).pipe(
          Effect.scoped,
        );
        const models = yield* discover;
        const descriptors = models.map((model) => model.capabilities?.optionDescriptors?.[0]);
        expect(
          descriptors.map((descriptor) =>
            descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
          ),
        ).toEqual([["medium", "max"], ["xhigh"]]);
        for (const previousEffort of ["max", "ultra"]) {
          const selections = [{ id: "reasoningEffort", value: previousEffort }];
          expect(
            buildExplicitProviderOptionSelectionsFromDescriptors(
              getProviderOptionDescriptors({ caps: models[1]!.capabilities!, selections }),
              selections,
            ),
          ).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
        }
        cache.rows[0]!.reasoning_effort_variants = [{ tier: "high" }, { tier: "ultra" }];
        yield* fs.writeFileString(cachePath, encodeJson(cache));
        const refreshed = (yield* discover)[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          refreshed?.type === "select" && refreshed.options.map((option) => option.id),
        ).toEqual(["high", "ultra"]);
        expect(refreshed?.currentValue).toBe("high");
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  it.effect("formats known raw catalog labels while preserving exact model identities", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entries = [
          ["muse-spark-1.3", "Muse Spark 1.3"],
          ["muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor"],
          ["muse-spark-1.2", "Muse Spark 1.2"],
          ["muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor"],
          ["muse-future-model", "muse-future-model"],
        ] as const;
        const host = makeHost({
          providerId: "meta",
          models: entries.map(([modelId]) => ({
            modelId,
            displayLabel: modelId,
            providerId: "meta",
            isDefault: modelId === "muse-spark-1.3-contributor",
          })),
        });
        const models = yield* discoverMuseModels(settings({}), {}, undefined, async () => host);
        expect(models.map(({ slug, name }) => [slug, name])).toEqual(entries);
        expect(models.find((model) => model.isDefault)?.slug).toBe("muse-spark-1.3-contributor");
      }),
    ),
  );

  it.effect("honors descriptive provider labels and retains unknown and custom labels", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = makeHost({
          providerId: "meta",
          models: [
            { modelId: "muse-spark-1.3", displayLabel: "  Spark 1.3 Official Label  " },
            { modelId: "muse-spark-1.3-contributor", displayLabel: " " },
            { modelId: "muse-future-model", displayLabel: "Future Official Label" },
            { modelId: "unknown-model", displayLabel: "" },
          ].map((model) => ({ ...model, providerId: "meta", isDefault: false })),
        });
        const models = yield* discoverMuseModels(settings({}), {}, undefined, async () => host);
        expect(models.map(({ slug, name }) => [slug, name])).toEqual([
          ["muse-spark-1.3", "Spark 1.3 Official Label"],
          ["muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor"],
          ["muse-future-model", "Future Official Label"],
          ["unknown-model", "unknown-model"],
        ]);
        const custom = yield* makePendingMuseProvider(
          settings({
            customModels: [{ slug: "custom-muse", name: "My Muse Model" }],
          }),
        );
        expect(custom.models[0]).toMatchObject({ slug: "custom-muse", name: "My Muse Model" });
      }),
    ),
  );

  it.effect("closes the host after malformed metadata and reports unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [{ modelId: 1 }] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("keeps an empty discovered catalog empty instead of advertising a fallback model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );
});
