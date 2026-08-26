import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  BUNDLED_MODEL_MANIFEST,
  classifyModels,
  isLegacyModel,
  make,
  type ModelManifestData,
} from "./ModelManifest.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");

describe("isLegacyModel (bundled manifest)", () => {
  it("keeps current Codex models out of legacy models", () => {
    assert.deepStrictEqual(
      [
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "gpt-daybreak-blue-latest",
        "gpt-daybreak-red-latest",
        "gpt-5.4",
      ].map((model) => [model, isLegacyModel(BUNDLED_MODEL_MANIFEST, CODEX, model)]),
      [
        ["gpt-5.6-luna", false],
        ["gpt-5.6-terra", false],
        ["gpt-5.6-sol", false],
        ["gpt-daybreak-blue-latest", false],
        ["gpt-daybreak-red-latest", false],
        ["gpt-5.4", true],
      ],
    );
  });

  it("keeps only the Claude 5 family out of legacy models", () => {
    assert.deepStrictEqual(
      ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"].map((model) => [
        model,
        isLegacyModel(BUNDLED_MODEL_MANIFEST, CLAUDE, model),
      ]),
      [
        ["claude-fable-5", false],
        ["claude-opus-5", false],
        ["claude-sonnet-5", false],
        ["claude-opus-4-8", true],
      ],
    );
  });

  it("leaves driver kinds without a manifest entry unflagged", () => {
    assert.isFalse(isLegacyModel(BUNDLED_MODEL_MANIFEST, CURSOR, "composer-1.5"));
  });
});

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("classifyModels", () => {
  it("flags non-current models, clears stale flags, and skips custom models", () => {
    const models = [
      model({ slug: "gpt-5.6-sol" }),
      // Stale flag from a previous classification pass must be cleared.
      model({ slug: "gpt-5.6-luna", isLegacy: true }),
      model({ slug: "gpt-5.4" }),
      // Custom models are user-defined and never reclassified.
      model({ slug: "my-own-model", isCustom: true }),
    ];
    assert.deepStrictEqual(
      classifyModels(models, BUNDLED_MODEL_MANIFEST, CODEX).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["gpt-5.6-sol", false],
        ["gpt-5.6-luna", false],
        ["gpt-5.4", true],
        ["my-own-model", false],
      ],
    );
  });
});

const REMOTE_MANIFEST: ModelManifestData = {
  version: 1,
  currentModels: {
    codex: ["gpt-5.4"],
    claudeAgent: ["claude-fable-5"],
  },
};

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
      assert.isTrue(isLegacyModel(refreshed, CODEX, "gpt-5.6-sol"));
      assert.isFalse(isLegacyModel(refreshed, CODEX, "gpt-5.4"));

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
