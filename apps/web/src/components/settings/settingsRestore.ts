import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

export function buildGeneralSettingsRestorePatch() {
  return {
    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
    defaultOpenChangedFiles: DEFAULT_UNIFIED_SETTINGS.defaultOpenChangedFiles,
    wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
    sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
    automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
    textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
  };
}
