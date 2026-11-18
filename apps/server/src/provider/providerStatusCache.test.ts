import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";

import { hydrateCachedProvider, isCachedProviderCorrelated } from "./providerStatusCache.ts";

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });
const NOW_MS = Date.parse("2026-04-11T12:00:00.000Z");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const makeProvider = (
  provider: ProviderDriverKind,
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(provider),
  driver: provider,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it.layer(NodeServices.layer)("providerStatusCache", (it) => {
  it("hydrates cached provider status while preserving current settings-derived models", () => {
    const cachedCodex = makeProvider(CODEX_DRIVER, {
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "gpt-5-mini",
          name: "GPT-5 Mini",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Cached message",
      skills: [
        {
          name: "github:gh-fix-ci",
          path: "/tmp/skills/gh-fix-ci/SKILL.md",
          enabled: true,
          displayName: "CI Debug",
        },
      ],
    });
    const fallbackCodex = makeProvider(CODEX_DRIVER, {
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      message: "Pending refresh",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: fallbackCodex,
        nowMs: NOW_MS,
      }),
      {
        ...fallbackCodex,
        models: [
          ...fallbackCodex.models,
          {
            slug: "gpt-5-mini",
            name: "GPT-5 Mini",
            isCustom: false,
            capabilities: emptyCapabilities,
          },
        ],
        installed: cachedCodex.installed,
        version: cachedCodex.version,
        status: cachedCodex.status,
        auth: cachedCodex.auth,
        checkedAt: cachedCodex.checkedAt,
        slashCommands: cachedCodex.slashCommands,
        skills: cachedCodex.skills,
        message: cachedCodex.message,
      },
    );
  });

  it("does not resurrect cached custom models that settings no longer declare", () => {
    const builtIn = {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: emptyCapabilities,
    } as const;
    const cachedCodex = makeProvider(CODEX_DRIVER, {
      models: [
        builtIn,
        {
          slug: "removed-custom",
          name: "removed-custom",
          isCustom: true,
          capabilities: emptyCapabilities,
        },
      ],
    });
    const fallbackCodex = makeProvider(CODEX_DRIVER, { models: [builtIn] });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: fallbackCodex,
        nowMs: NOW_MS,
      }).models,
      [builtIn],
    );
  });

  it("restores a cooldown only while it is still in force", () => {
    const fallbackCodex = makeProvider(CODEX_DRIVER);
    const hydrate = (limitedUntil: string) =>
      hydrateCachedProvider({
        cachedProvider: makeProvider(CODEX_DRIVER, { limitedUntil }),
        fallbackProvider: fallbackCodex,
        nowMs: NOW_MS,
      }).limitedUntil;

    assert.strictEqual(hydrate("2026-04-11T12:30:00.000Z"), "2026-04-11T12:30:00.000Z");
    assert.isUndefined(hydrate("2026-04-11T12:00:00.000Z"));
  });

  it("ignores stale cached status when the provider is disabled or unavailable", () => {
    const cachedCodex = makeProvider(CODEX_DRIVER, {
      checkedAt: "2026-04-10T12:00:00.000Z",
      message: "Cached ready status",
    });
    const disabledFallback = makeProvider(CODEX_DRIVER, {
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      message: "Codex is disabled in T3 Code settings.",
    });

    for (const fallbackProvider of [
      disabledFallback,
      makeProvider(CODEX_DRIVER, { status: "warning", availability: "unavailable" }),
    ]) {
      assert.strictEqual(
        hydrateCachedProvider({
          cachedProvider: cachedCodex,
          fallbackProvider,
          nowMs: NOW_MS,
        }),
        fallbackProvider,
      );
    }
  });

  it("rejects cached snapshots that are not correlated to the fallback instance", () => {
    const fallbackCodex = makeProvider(CODEX_DRIVER, {
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
    });
    const legacyCachedCodex = {
      provider: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "cached-legacy-model",
          name: "Cached Legacy Model",
          isCustom: false,
          capabilities: emptyCapabilities,
        },
      ],
      slashCommands: [],
      skills: [],
    } as unknown as ServerProvider;
    const mismatchedCachedCodex = makeProvider(CODEX_DRIVER, {
      instanceId: ProviderInstanceId.make("codex_personal"),
    });

    assert.strictEqual(
      isCachedProviderCorrelated({
        cachedProvider: legacyCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      false,
    );
    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: legacyCachedCodex,
        fallbackProvider: fallbackCodex,
        nowMs: NOW_MS,
      }),
      fallbackCodex,
    );
    assert.strictEqual(
      isCachedProviderCorrelated({
        cachedProvider: mismatchedCachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      false,
    );
    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: mismatchedCachedCodex,
        fallbackProvider: fallbackCodex,
        nowMs: NOW_MS,
      }),
      fallbackCodex,
    );
  });
});
