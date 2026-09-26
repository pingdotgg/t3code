import { NativeHeaderToolbar } from "../native/StackHeader";
import type { ScreenHeaderMenu, ScreenHeaderMenuItem } from "./ScreenHeader.types";

function renderMenuItems(items: ReadonlyArray<ScreenHeaderMenuItem>) {
  return items.map((item) =>
    "items" in item ? (
      <NativeHeaderToolbar.Menu
        key={item.id}
        title={item.title}
        icon={item.icon}
        inline={item.inline}
      >
        {renderMenuItems(item.items)}
      </NativeHeaderToolbar.Menu>
    ) : (
      <NativeHeaderToolbar.MenuAction
        key={item.id}
        icon={item.icon}
        subtitle={item.subtitle}
        disabled={item.disabled}
        isOn={item.selected}
        onPress={item.onPress}
      >
        {item.title}
      </NativeHeaderToolbar.MenuAction>
    ),
  );
}

/** Returns direct native items for toolbar serialization, including nested menu data. */
export function createNativeHeaderMenu(menu: ScreenHeaderMenu) {
  return (
    <NativeHeaderToolbar.Menu
      key={menu.title}
      title={menu.title}
      accessibilityLabel={menu.title}
      icon={typeof menu.icon === "string" ? menu.icon : menu.icon.ios}
      separateBackground={menu.separateBackground ?? true}
    >
      {menu.status ? <NativeHeaderToolbar.Label>{menu.status}</NativeHeaderToolbar.Label> : null}
      {renderMenuItems(menu.items)}
    </NativeHeaderToolbar.Menu>
  );
}
