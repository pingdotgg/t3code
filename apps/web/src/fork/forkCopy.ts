// The fork does not translate: upstream files take the fork's English text from here.

export const FORK_SETTING_TITLES = {
  worktreeReflink: "Reflink worktrees",
  newThreadDisplayMode: "Display mode",
  previewBrowserMode: "Preview browser",
  rightPanel: "Right panel",
  fileLinkPathDepth: "File link folders",
};

export const COMPACT_WHEN_IDLE_LABEL = "Compact when idle";
export const COMPACT_IDLE_THREADS_DESCRIPTION =
  "When to compact a large idle Claude thread: after you return, just before its prompt cache expires, when idle, or never. Each Claude provider can override this.";

export const OLD_READING_LABEL = "As of";

export const RIGHT_PANEL_SETTINGS_COPY = {
  intro:
    "These choices apply to this browser and override this machine's defaults. Letters work while the + menu or an empty panel is open.",
  section: "Menu items",
  resetAll: "Reset all",
  shown: "Shown",
  hidden: "Hidden",
  noLetter: "No letter",
  none: "none",
  byDefault: (value: string) => `Default (${value})`,
  resetItem: (label: string) => `Reset ${label} to default`,
  visibilityOf: (label: string) => `${label}: shown or hidden`,
  letterOf: (label: string) => `${label}: menu letter`,
};
