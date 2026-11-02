import type { ImageSourcePropType } from "react-native";

export const CONTEXT_CHIP_ICON_SOURCES = {
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
  server: require("../../assets/context-chip-icons/server.png"),
  skill: require("../../assets/context-chip-icons/skill.png"),
  terminal: require("../../assets/context-chip-icons/terminal.png"),
} as const satisfies Readonly<Record<string, ImageSourcePropType>>;
