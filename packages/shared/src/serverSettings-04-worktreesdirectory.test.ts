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






describe("worktreesDirectory", () => {
  it("remembers previous custom locations so their worktrees stay managed", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { worktreesDirectory: "/a" });
    expect(first.previousWorktreesDirectories).toEqual([]);
    const second = applyServerSettingsPatch(first, { worktreesDirectory: "/b" });
    expect(second.previousWorktreesDirectories).toEqual(["/a"]);
    const reset = applyServerSettingsPatch(second, { worktreesDirectory: "" });
    expect(reset.previousWorktreesDirectories).toEqual(["/a", "/b"]);
    const back = applyServerSettingsPatch(reset, { worktreesDirectory: "/a" });
    expect(back.previousWorktreesDirectories).toEqual(["/b"]);
  });
});

