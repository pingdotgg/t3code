export type ClientProfileOs = "mac" | "windows" | "linux";
export type ClientProfileSurface =
  | { readonly kind: "mobile" }
  | { readonly kind: "browser" | "desktop"; readonly os: ClientProfileOs };

export const CUSTOM_THEME_KEY_PREFIX = "customTheme.";

const REGISTRY = {
  everySurface: [
    "themeMode",
    "themeLight",
    "themeDark",
    "toolCallVisibility",
    "followUpBehavior",
    "mathRenderingEnabled",
    "sidebarProjectGroupingMode",
    "sidebarWorkingShelfEnabled",
    "chatWidth",
  ],
  browserAndDesktop: [
    "appearanceContrast",
    "glassOpacity",
    "panelAnimationDurationMs",
    "wordWrap",
    "timestampFormat",
    "effortDisplay",
    "environmentIdentificationMode",
    "fontSizeInterface",
    "fontSizePrompt",
    "fontSizeCode",
    "fontSizeTerminal",
    "typographyAdvanced",
    "sendShortcut",
    "composerRichTextEnabled",
    "showSkillsInSlashMenu",
    "persistComposerContextStrip",
    "proactivePanelsEnabled",
    "threadDetailsUsageEnabled",
    "threadDetailsItems",
    "sidebarProjectGroupingOverrides",
    "sidebarProjectSortOrder",
    "sidebarThreadSortOrder",
    "sidebarUsageBarEnabled",
    "sidebarUsageBarStyle",
    "sidebarUsageBarAlignment",
    "sidebarUsageBarFocus",
    "sidebarUsageBarPaceMarks",
    "sidebarUsageBarHidden",
    "boringSidebarEnabled",
    "boringSidebarMultilineRows",
    "diffColorScheme",
    "diffLayout",
    "diffIgnoreWhitespace",
    "diffFilesCollapsed",
    "confirmThreadArchive",
    "confirmThreadDelete",
    "confirmThreadUnpin",
    "notificationMode",
    "inAppNotificationsEnabled",
    "voiceShortcutMode",
    "speechLanguage",
    "speechTranslateToEnglish",
    "speechCustomWords",
    "speechSilenceFiltering",
    "speechRemoveFillerWords",
    "speechPostProcessingPrompt",
    "speechCorrectionWord",
    "pullRequestMergeMethodOverrides",
    "pullRequestLinksOpenInApp",
    "loadBalancingEnabled",
    "loadBalancingWeights",
  ],
  desktopOnly: [
    "confirmQuit",
    "autoInstallDesktopUpdates",
    "snapShotIncludeAccessibility",
    "snapShotPlaySound",
    "snapShotSound",
    "snapShotFlash",
    "snapShotAnimations",
    "browserDefaultViewport",
    "browserDefaultZoomFactor",
    "browserDefaultAppearance",
    "browserRecordingFrameRate",
    "browserRecordingShowKeyPresses",
    "browserRecordingShowMousePresses",
    "browserLinkTarget",
    "browserSearchEngine",
    "browserCustomSearchUrl",
    "browserAutoShowFloatingPreview",
  ],
  perOsBrowserAndDesktop: [
    "fontFamilySans",
    "fontFamilyCode",
    "fontFamilyComposer",
    "fontFamilyTerminal",
    "fontSmoothing",
    "lastEditor",
  ],
  perOsDesktopOnly: ["snapShotShortcut"],
} as const;

const KEYS_BY_KIND = {
  mobile: [...REGISTRY.everySurface],
  browser: [
    ...REGISTRY.everySurface,
    ...REGISTRY.browserAndDesktop,
    ...REGISTRY.perOsBrowserAndDesktop,
  ],
  desktop: [
    ...REGISTRY.everySurface,
    ...REGISTRY.browserAndDesktop,
    ...REGISTRY.desktopOnly,
    ...REGISTRY.perOsBrowserAndDesktop,
    ...REGISTRY.perOsDesktopOnly,
  ],
} as const satisfies Record<ClientProfileSurface["kind"], ReadonlyArray<string>>;

const KEY_SETS = {
  mobile: new Set<string>(KEYS_BY_KIND.mobile),
  browser: new Set<string>(KEYS_BY_KIND.browser),
  desktop: new Set<string>(KEYS_BY_KIND.desktop),
};

const PER_OS_KEYS = new Set<string>([
  ...REGISTRY.perOsBrowserAndDesktop,
  ...REGISTRY.perOsDesktopOnly,
]);

export function clientProfileBaseKeys(surface: ClientProfileSurface): ReadonlyArray<string> {
  return KEYS_BY_KIND[surface.kind];
}

function isCustomThemeBase(base: string): boolean {
  return base.startsWith(CUSTOM_THEME_KEY_PREFIX) && base.length > CUSTOM_THEME_KEY_PREFIX.length;
}

export function isClientProfileBaseKey(base: string, surface: ClientProfileSurface): boolean {
  return KEY_SETS[surface.kind].has(base) || isCustomThemeBase(base);
}

export function clientProfileKeyName(base: string, surface: ClientProfileSurface): string {
  return surface.kind !== "mobile" && PER_OS_KEYS.has(base) ? `${base}@${surface.os}` : base;
}

export function clientProfileBaseName(name: string, surface: ClientProfileSurface): string | null {
  if (surface.kind !== "mobile") {
    const suffix = `@${surface.os}`;
    if (name.endsWith(suffix)) {
      const base = name.slice(0, -suffix.length);
      if (PER_OS_KEYS.has(base)) {
        return KEY_SETS[surface.kind].has(base) ? base : null;
      }
    }
  }
  if (PER_OS_KEYS.has(name)) return null;
  return isClientProfileBaseKey(name, surface) ? name : null;
}
