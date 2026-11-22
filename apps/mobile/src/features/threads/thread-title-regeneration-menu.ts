import type { MenuAction } from "@react-native-menu/menu";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export function buildThreadTitleRegenerationMenuItems(
  input: {
    readonly supported: boolean;
    readonly isRegenerating: boolean;
  },
  resolve: MessageResolver = m,
): MenuAction[] {
  if (!input.supported) return [];

  return [
    {
      id: "regenerate-title",
      title: input.isRegenerating
        ? resolve(msg("Regenerating…"))
        : resolve(msg("Regenerate title")),
      image: "arrow.clockwise",
      ...(input.isRegenerating ? { attributes: { disabled: true } } : {}),
    },
  ];
}
