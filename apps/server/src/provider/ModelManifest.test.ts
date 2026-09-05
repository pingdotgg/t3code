import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  applyManifestDefault,
  BUNDLED_MODEL_MANIFEST,
  classifyModels,
  make,
  resolveProviderCatalog,
  type ModelManifestData,
  manifestUpdatedAtMs,
  encodeManifestCache,
} from "./ModelManifest.ts";

/**
 * Test policy: this file covers manifest machinery, not manifest contents.
 * Do not add assertions for real model slugs, names, status, aliases, or
 * profiles when editing model-manifest.json. Add tests only when fetch/cache
 * behavior or the provider-neutral resolver semantics change, and use
 * synthetic models for resolver coverage.
 */

const CODEX = ProviderDriverKind.make("codex");
const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("classifyModels", () => {
  it("flags non-current models, clears stale flags, and skips custom models", () => {
    const manifest: ModelManifestData = {
      version: 1,
      currentModels: { codex: ["current-a", "current-b"] },
    };
    const models = [
      model({ slug: "current-a" }),
      // Stale flag from a previous classification pass must be cleared.
      model({ slug: "current-b", isLegacy: true }),
      model({ slug: "old-model" }),
      // Custom models are user-defined and never reclassified.
      model({ slug: "my-own-model", isCustom: true }),
    ];
    assert.deepStrictEqual(
      classifyModels(models, manifest, CODEX).map((entry) => [entry.slug, entry.isLegacy ?? false]),
      [
        ["current-a", false],
        ["current-b", false],
        ["old-model", true],
        ["my-own-model", false],
      ],
    );
  });
});

describe("applyManifestDefault", () => {
  it("moves the default flag and its aliases to the manifest's chat default", () => {
    const driver = ProviderDriverKind.make("antigravity");
    const manifest: ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        antigravity: {
          defaults: { chat: "gemini-new" },
          profiles: {},
          models: [{ slug: "gemini-new", name: "New", status: "current" }],
        },
      },
    };
    const models = [
      model({ slug: "gemini-old", isDefault: true, aliases: ["antigravity-default"] }),
      model({ slug: "gemini-new" }),
    ];
    assert.deepStrictEqual(applyManifestDefault(models, manifest, driver), [
      model({ slug: "gemini-old" }),
      model({ slug: "gemini-new", isDefault: true, aliases: ["antigravity-default"] }),
    ]);
    // The account does not offer the manifest default: keep the runtime's choice.
    assert.deepStrictEqual(
      applyManifestDefault(models.slice(0, 1), manifest, driver),
      models.slice(0, 1),
    );
  });
});

describe("resolveProviderCatalog", () => {
  it("resolves generic model presentation through a reusable profile", () => {
    const manifest: ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          defaults: { chat: "model-next" },
          profiles: {
            standard: {
              capabilities: {
                optionDescriptors: [
                  {
                    id: "mode",
                    label: "Mode",
                    type: "select",
                    options: [{ id: "fast", label: "Fast", isDefault: true }],
                  },
                ],
              },
              adapter: { opaque: true },
            },
          },
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              aliases: ["next"],
              status: "current",
              badge: "new",
              profile: "standard",
            },
          ],
        },
      },
    };

    const catalog = resolveProviderCatalog(manifest, ProviderDriverKind.make("synthetic"));
    assert.deepStrictEqual(catalog?.models[0], {
      model: {
        slug: "model-next",
        name: "Model Next",
        aliases: ["next"],
        badge: "new",
        isCustom: false,
        isDefault: true,
        capabilities: manifest.providers!.synthetic!.profiles.standard!.capabilities!,
      },
      adapter: undefined,
      profileAdapter: { opaque: true },
    });
  });

  it("rejects invalid catalog references", () => {
    const invalidCatalog = (input: {
      readonly models: NonNullable<ModelManifestData["providers"]>[string]["models"];
      readonly defaultChat?: string;
    }): ModelManifestData => ({
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          ...(input.defaultChat ? { defaults: { chat: input.defaultChat } } : {}),
          profiles: {},
          models: input.models,
        },
      },
    });

    for (const invalid of [
      invalidCatalog({
        models: [
          { slug: "duplicate", name: "First", status: "current" },
          { slug: "duplicate", name: "Second", status: "current" },
        ],
      }),
      invalidCatalog({
        models: [
          {
            slug: "missing-profile",
            name: "Missing Profile",
            status: "current",
            profile: "missing",
          },
        ],
      }),
      invalidCatalog({
        models: [{ slug: "present", name: "Present", status: "current" }],
        defaultChat: "absent",
      }),
    ]) {
      assert.isNull(resolveProviderCatalog(invalid, ProviderDriverKind.make("synthetic")));
    }
  });
});

// Remote fixtures date after the bundle so a fetch still outranks it.
const REMOTE_UPDATED_AT = "2099-01-01T00:00:00Z";

const REMOTE_MANIFEST: ModelManifestData = {
  version: 1,
  updatedAt: REMOTE_UPDATED_AT,
  currentModels: {
    codex: ["remote-model"],
    claudeAgent: ["remote-agent-model"],
  },
};

const REMOTE_CLAUDE_MANIFEST: ModelManifestData = {
  version: 1,
  updatedAt: REMOTE_UPDATED_AT,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          adapter: { claudeCode: { effortMap: { extreme: "high" } } },
        },
      },
      models: [
        {
          slug: "remote-only-model",
          name: "Remote Only Model",
          status: "current",
          profile: "synthetic",
        },
      ],
    },
  },
};

const remoteClaudeManifestWithCompatibility = (compatibility: unknown): ModelManifestData => ({
  ...REMOTE_CLAUDE_MANIFEST,
  providers: {
    claudeAgent: {
      profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
      models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models.map((model) => ({
        ...model,
        adapter: { claudeCode: compatibility },
      })),
    },
  },
});

const INVALID_REMOTE_MANIFESTS: ReadonlyArray<ModelManifestData> = [
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        profiles: {
          synthetic: {
            adapter: { claudeCode: { effortMap: { extreme: 123 } } },
          },
        },
        models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
      },
    },
  },
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        profiles: {},
        models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
      },
    },
  },
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
        models: [
          ...REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
          {
            slug: "remote-only-model",
            name: "Duplicate Remote Model",
            status: "current",
            profile: "synthetic",
          },
        ],
      },
    },
  },
  {
    ...REMOTE_CLAUDE_MANIFEST,
    providers: {
      claudeAgent: {
        defaults: { chat: "absent-model" },
        profiles: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.profiles,
        models: REMOTE_CLAUDE_MANIFEST.providers!.claudeAgent!.models,
      },
    },
  },
  remoteClaudeManifestWithCompatibility({ minVersion: "2.x" }),
  remoteClaudeManifestWithCompatibility({ maxVersionExclusive: "2.x" }),
  remoteClaudeManifestWithCompatibility({
    minVersion: "2.2",
    maxVersionExclusive: "2.1",
  }),
];

const httpClientLayer = (handler: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler()))),
  );

const serviceLayers = (input: {
  readonly prefix: string;
  readonly response: () => Response;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings ?? {})),
    Layer.provideMerge(httpClientLayer(input.response)),
  );

describe("ModelManifest service", () => {
  it.live("prefers a fetched manifest over the bundle and caches it to disk", () =>
    Effect.gen(function* () {
      const service = yield* make;
      const refreshed = yield* service.refresh;
      assert.deepStrictEqual(refreshed, REMOTE_MANIFEST);

      // A fresh service instance sees the disk cache without another fetch:
      // its HTTP layer is still stubbed, but `current` never fetches at all.
      const rebooted = yield* make;
      assert.deepStrictEqual(yield* rebooted.current, REMOTE_MANIFEST);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-manifest-fetch-test",
          response: () => Response.json(REMOTE_MANIFEST),
        }),
      ),
    ),
  );

  it.live("keeps the bundled manifest when the remote payload is malformed", () =>
    Effect.gen(function* () {
      const service = yield* make;
      assert.deepStrictEqual(yield* service.refresh, BUNDLED_MODEL_MANIFEST);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-manifest-malformed-test",
          response: () => Response.json({ version: 999, nonsense: true }),
        }),
      ),
    ),
  );

  it.effect("preserves the last-good remote cache when later payloads are invalid", () => {
    let responseIndex = 0;
    const responses = [REMOTE_CLAUDE_MANIFEST, ...INVALID_REMOTE_MANIFESTS];

    return Effect.gen(function* () {
      const service = yield* make;
      assert.deepStrictEqual(yield* service.refresh, REMOTE_CLAUDE_MANIFEST);

      for (const _invalid of INVALID_REMOTE_MANIFESTS) {
        yield* TestClock.adjust("1 hour");
        responseIndex += 1;
        assert.deepStrictEqual(yield* service.refresh, REMOTE_CLAUDE_MANIFEST);
      }

      const rebooted = yield* make;
      assert.deepStrictEqual(yield* rebooted.current, REMOTE_CLAUDE_MANIFEST);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-manifest-last-good-test",
          response: () => Response.json(responses[responseIndex]),
        }),
      ),
    );
  });

  it.live("drops a disk cache of a manifest older than the bundled one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      assert.isAbove(manifestUpdatedAtMs(BUNDLED_MODEL_MANIFEST), 0);
      const cachePath = path.join(config.stateDir, "model-manifest.json");
      // A cache of the manifest as it was before the release edited it. The
      // fetch time is irrelevant: the remote may be unreachable now, so
      // `current` must already prefer the bundle.
      const { updatedAt: _undated, ...undatedManifest } = REMOTE_MANIFEST;
      for (const stale of [
        undatedManifest,
        { ...REMOTE_MANIFEST, updatedAt: "2000-01-01T00:00:00Z" },
      ]) {
        yield* fs.writeFileString(
          cachePath,
          yield* encodeManifestCache({ fetchedAtMs: 0, manifest: stale }),
        );
        const service = yield* make;
        assert.deepStrictEqual(yield* service.current, BUNDLED_MODEL_MANIFEST);
      }

      // A cache of a newer edit still outranks the bundle.
      yield* fs.writeFileString(
        cachePath,
        yield* encodeManifestCache({ fetchedAtMs: 0, manifest: REMOTE_MANIFEST }),
      );
      const later = yield* make;
      assert.deepStrictEqual(yield* later.current, REMOTE_MANIFEST);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-manifest-newer-bundle-test",
          response: () => Response.json(REMOTE_MANIFEST),
        }),
      ),
    ),
  );

  it.live("does not fetch when provider update checks are disabled", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const service = yield* make.pipe(
        Effect.provide(
          httpClientLayer(() => {
            fetchCount += 1;
            return Response.json(REMOTE_MANIFEST);
          }),
        ),
      );
      assert.deepStrictEqual(yield* service.refresh, BUNDLED_MODEL_MANIFEST);
      assert.strictEqual(fetchCount, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-manifest-optout-test",
          response: () => Response.json(REMOTE_MANIFEST),
          settings: { enableProviderUpdateChecks: false },
        }),
      ),
    ),
  );
});
