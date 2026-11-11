import type { ImageSourcePropType } from "react-native";

export const CONTEXT_CHIP_ICON_SOURCES = {
  bot: require("../../assets/context-chip-icons/bot.png"),
  "circle-dashed": require("../../assets/context-chip-icons/circle-dashed.png"),
  film: require("../../assets/context-chip-icons/film.png"),
  "git-merge": require("../../assets/context-chip-icons/git-merge.png"),
  "git-pull-request-arrow": require("../../assets/context-chip-icons/git-pull-request-arrow.png"),
  "git-pull-request-closed": require("../../assets/context-chip-icons/git-pull-request-closed.png"),
  "git-pull-request-draft": require("../../assets/context-chip-icons/git-pull-request-draft.png"),
  image: require("../../assets/context-chip-icons/image.png"),
  "message-circle": require("../../assets/context-chip-icons/message-circle.png"),
  "messages-square": require("../../assets/context-chip-icons/messages-square.png"),
  "mouse-pointer-click": require("../../assets/context-chip-icons/mouse-pointer-click.png"),
  quote: require("../../assets/context-chip-icons/quote.png"),
  server: require("../../assets/context-chip-icons/server.png"),
  skill: require("../../assets/context-chip-icons/skill.png"),
  terminal: require("../../assets/context-chip-icons/terminal.png"),
} as const satisfies Readonly<Record<string, ImageSourcePropType>>;

export const PROVIDER_CHIP_ICONS: Readonly<
  Record<
    string,
    {
      readonly source: ImageSourcePropType;
      readonly tintsIcon: boolean;
      readonly accent?: string;
    }
  >
> = {
  claudeAgent: {
    source: require("../../assets/context-chip-icons/provider-claudeAgent.png"),
    tintsIcon: false,
    accent: "#D97757",
  },
  codex: {
    source: require("../../assets/context-chip-icons/provider-codex.png"),
    tintsIcon: true,
  },
  cursor: {
    source: require("../../assets/context-chip-icons/provider-cursor.png"),
    tintsIcon: true,
  },
  fx: {
    source: require("../../assets/context-chip-icons/provider-fx.png"),
    tintsIcon: true,
  },
  grok: {
    source: require("../../assets/context-chip-icons/provider-grok.png"),
    tintsIcon: true,
  },
  kiro: {
    source: require("../../assets/context-chip-icons/provider-kiro.png"),
    tintsIcon: false,
    accent: "#9046FF",
  },
  muse: {
    source: require("../../assets/context-chip-icons/provider-muse.png"),
    tintsIcon: false,
    accent: "#0081fb",
  },
  opencode: {
    source: require("../../assets/context-chip-icons/provider-opencode.png"),
    tintsIcon: true,
  },
  pi: {
    source: require("../../assets/context-chip-icons/provider-pi.png"),
    tintsIcon: true,
  },
  antigravity: {
    source: require("../../assets/antigravity.png"),
    tintsIcon: false,
    accent: "#5b87bf",
  },
};
