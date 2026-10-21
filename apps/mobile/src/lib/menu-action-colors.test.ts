import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it } from "vite-plus/test";

import { withMenuActionIconColors } from "./menu-action-colors";

describe("withMenuActionIconColors", () => {
  it.each(["#111111", "#eeeeee"])(
    "gives icons a visible color at every menu depth for the %s theme",
    (icon) => {
      const actions: MenuAction[] = [
        { id: "photos", title: "Photos", image: "photo" },
        {
          title: "Thread",
          subactions: [
            {
              title: "Pinned thread",
              image: "pin",
              subactions: [{ title: "Move up", image: "arrow.up" }],
            },
          ],
        },
      ];

      const result = withMenuActionIconColors(actions, { icon, destructiveIcon: "#ff0000" });

      expect(result[0]?.imageColor).toBe(icon);
      expect(result[1]).not.toHaveProperty("imageColor");
      expect(result[1]?.subactions?.[0]?.imageColor).toBe(icon);
      expect(result[1]?.subactions?.[0]?.subactions?.[0]?.imageColor).toBe(icon);
      expect(actions[0]).not.toHaveProperty("imageColor");
      expect(actions[1]?.subactions?.[0]).not.toHaveProperty("imageColor");
    },
  );
});
