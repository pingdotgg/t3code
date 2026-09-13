import { describe, expect, it } from "vite-plus/test";

import { createAndroidSidebarAction } from "./android-sidebar-action";

describe("createAndroidSidebarAction", () => {
  it("toggles between hiding and showing the tablet sidebar", () => {
    const onPress = () => undefined;

    expect(createAndroidSidebarAction({ visible: true, onPress })).toMatchObject({
      accessibilityLabel: "Maximize content",
      icon: "arrow.up.left.and.arrow.down.right",
      onPress,
    });
    expect(createAndroidSidebarAction({ visible: false, onPress })).toMatchObject({
      accessibilityLabel: "Show thread sidebar",
      icon: "sidebar.left",
      onPress,
    });
  });
});
