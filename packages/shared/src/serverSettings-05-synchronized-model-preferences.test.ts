import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  ServerSettings,
  ServerSettingsPatch,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { resolveServerBackgroundActivitySettings } from "./backgroundActivitySettings.ts";
import { createModelSelection } from "./model.ts";
import { resolveProjectScripts } from "./projectScripts.ts";
import {
  applyServerSettingsPatch,
  fallbackTextGenerationModelSelection,
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
  isModelSelectionProviderEnabled,
  parsePersistedServerObservabilitySettings,
  resolveSourceControlWriterModelSelection,
} from "./serverSettings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

const FOLDED_SERVER_SETTINGS = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true };






describe("synchronized model preferences", () => {
  it("supports provider identifiers that match inherited object keys", () => {
    const provider = ProviderInstanceId.make("toString");
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelsHidden: [{ provider, model: "example", hidden: true }],
    });
    expect(next.providerModelPreferences?.[provider]?.hiddenModels).toEqual(["example"]);
  });
  const provider = ProviderInstanceId.make("codex_work");
  const legacy = {
    favorites: [{ provider, model: "sol" }],
    providerModelPreferences: { [provider]: { hiddenModels: ["astra"], modelOrder: ["sol"] } },
  };

  it("keeps concurrent adds and removes of the same favorite idempotent", () => {
    const add = { setModelFavorites: [{ provider, model: "sol", favorite: true }] };
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, add);
    expect(applyServerSettingsPatch(first, add).favorites).toEqual([{ provider, model: "sol" }]);
    const remove = { setModelFavorites: [{ provider, model: "sol", favorite: false }] };
    const removed = applyServerSettingsPatch(first, remove);
    expect(applyServerSettingsPatch(removed, remove).favorites).toEqual([]);
    expect(first.favorites).toEqual([{ provider, model: "sol" }]);
  });

  it("preserves unrelated models and providers during bulk visibility and order edits", () => {
    const otherProvider = ProviderInstanceId.make("claude_work");
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerModelPreferences: {
        ...legacy.providerModelPreferences,
        [otherProvider]: { hiddenModels: ["opus"], modelOrder: ["sonnet", "opus"] },
      },
    });
    const mobile = applyServerSettingsPatch(initial, {
      setModelsHidden: [{ provider, model: "luna", hidden: true }],
    });
    const web = applyServerSettingsPatch(mobile, {
      setModelsHidden: [
        { provider, model: "astra", hidden: false },
        { provider, model: "sol", hidden: true },
      ],
      setProviderModelOrder: { provider, modelOrder: ["sol", "luna", "astra"] },
    });
    expect(initial.providerModelPreferences?.[provider]).toEqual(
      legacy.providerModelPreferences[provider],
    );
    expect(web.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["luna", "sol"],
      modelOrder: ["sol", "luna", "astra"],
    });
    expect(web.providerModelPreferences?.[otherProvider]).toEqual(
      initial.providerModelPreferences?.[otherProvider],
    );
    expect(
      applyServerSettingsPatch(web, {
        setProviderModelOrder: { provider, modelOrder: [] },
      }).providerModelPreferences?.[provider],
    ).toEqual({ hiddenModels: ["luna", "sol"], modelOrder: [] });
  });

  it("migrates saved lists independently without claiming empty legacy lists", () => {
    expect(modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, {})).toBeNull();
    const patch = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const migrated = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
    expect(resolveModelPreferences(migrated)).toEqual(legacy);
    expect(modelPreferencesMigrationPatch(migrated, legacy)).toBeNull();
    const favoritesOnly = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { favorites: [] });
    expect(modelPreferencesMigrationPatch(favoritesOnly, legacy)).toEqual({
      migrateModelPreferences: { providerModelPreferences: legacy.providerModelPreferences },
    });
  });

  it("keeps explicit clears when a delayed migration arrives from another device", () => {
    const staleMigration = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const cleared = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      favorites: [],
      providerModelPreferences: {},
    });
    expect(
      resolveModelPreferences(applyServerSettingsPatch(cleared, staleMigration), legacy),
    ).toEqual({
      favorites: [],
      providerModelPreferences: {},
    });
  });

  it("replaces visibility records so showing every model clears removed entries", () => {
    const migrated = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!,
    );
    const cleared = applyServerSettingsPatch(migrated, { providerModelPreferences: {} });
    expect(cleared.providerModelPreferences).toEqual({});
    expect(cleared.favorites).toEqual(legacy.favorites);
  });

  it("sets favorites without losing changes from other clients", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider, model: "astra", favorite: true }],
      migrateModelPreferences: { favorites: [] },
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider, model: "astra" },
    ]);
    const removed = applyServerSettingsPatch(second, {
      setModelFavorites: [{ provider, model: "sol", favorite: false }],
    });
    expect(removed.favorites).toEqual([{ provider, model: "astra" }]);
    expect(
      applyServerSettingsPatch(removed, {
        setModelFavorites: [{ provider, model: "astra", favorite: false }],
      }).favorites,
    ).toEqual([]);
  });

  it("keeps the same model on different provider instances as separate favorites", () => {
    const otherProvider = ProviderInstanceId.make("codex_personal");
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider: otherProvider, model: "sol", favorite: true }],
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider: otherProvider, model: "sol" },
    ]);
    expect(
      applyServerSettingsPatch(second, {
        setModelFavorites: [{ provider, model: "sol", favorite: false }],
      }).favorites,
    ).toEqual([{ provider: otherProvider, model: "sol" }]);
  });
});

