import {
  EnvironmentTheme,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Themes from "../../../environmentTheme.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    Themes.EnvironmentThemeService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const themeTarget = { environmentId: OrchestratorMcpEnvironmentTarget };
const themeId = { ...themeTarget, id: EnvironmentThemeId };
const ThemeList = Tool.make("t3_theme_list", {
  ...shared,
  description:
    "List built-in and environment-published themes. Personal client-local themes are inaccessible.",
  parameters: Schema.Struct(themeTarget),
  success: Schema.Array(
    Schema.Struct({
      id: EnvironmentThemeId,
      name: EnvironmentThemeFile.fields.name,
      appearance: EnvironmentThemeFile.fields.appearance,
      builtin: Schema.Boolean,
    }),
  ),
}).annotate(Tool.Readonly, true);
const ThemeRead = Tool.make("t3_theme_read", {
  ...shared,
  description:
    "Read a built-in or environment-published theme, including partial colors and variants.",
  parameters: Schema.Struct(themeId),
  success: EnvironmentTheme,
}).annotate(Tool.Readonly, true);
const ThemeCreate = Tool.make("t3_theme_create", {
  ...shared,
  description:
    "Publish a new theme in this environment. Does not apply it or set the default. IDs must be unique; built-ins are protected.",
  parameters: Schema.Struct({ ...themeId, theme: EnvironmentThemeFile }),
  success: EnvironmentTheme,
});
const ThemeUpdate = Tool.make("t3_theme_update", {
  ...shared,
  description:
    "Replace an environment-published theme's definition. Does not apply it or set the default. Send the complete definition; omitted palette fields remain absent.",
  parameters: Schema.Struct({ ...themeId, theme: EnvironmentThemeFile }),
  success: EnvironmentTheme,
}).annotate(Tool.Destructive, true);
const ThemeDuplicate = Tool.make("t3_theme_duplicate", {
  ...shared,
  description:
    "Copy a built-in or published theme to a new ID and name. Does not apply it or set the default.",
  parameters: Schema.Struct({
    ...themeId,
    sourceId: EnvironmentThemeId,
    name: EnvironmentThemeFile.fields.name,
  }),
  success: EnvironmentTheme,
});
const ThemeDelete = Tool.make("t3_theme_delete", {
  ...shared,
  description:
    "Delete a published theme. Clear or change the environment default first if it names this theme. Clients resolve removed themes using their existing fallback behavior.",
  parameters: Schema.Struct(themeId),
  success: Schema.Void,
}).annotate(Tool.Destructive, true);
const ThemeApply = Tool.make("t3_theme_apply", {
  ...shared,
  description:
    "Apply a built-in or published theme by setting the environment default with a fresh timestamp. Only web clients served by this server and desktop clients using their local environment follow this default. Cannot select a personal client-local theme.",
  parameters: Schema.Struct(themeId),
  success: Schema.Void,
}).annotate(Tool.Destructive, true);
const ThemeClear = Tool.make("t3_theme_clear_default", {
  ...shared,
  description:
    "Clear the environment theme default. Clients keep their current choice; this does not reset a client's theme.",
  parameters: Schema.Struct(themeTarget),
  success: Schema.Void,
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  ThemeList,
  ThemeRead,
  ThemeCreate,
  ThemeUpdate,
  ThemeDuplicate,
  ThemeDelete,
  ThemeApply,
  ThemeClear,
);
