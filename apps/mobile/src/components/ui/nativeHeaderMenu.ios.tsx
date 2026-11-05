import { Toolbar } from "./Toolbar";

import type { AppBarMenu, AppBarMenuItem } from "./AppBar.types";

function renderMenuItems(items: ReadonlyArray<AppBarMenuItem>) {
  return items.map((item) =>
    "items" in item ? (
      <Toolbar.Menu key={item.id} title={item.title} icon={item.icon} inline={item.inline}>
        {renderMenuItems(item.items)}
      </Toolbar.Menu>
    ) : (
      <Toolbar.MenuAction
        key={item.id}
        icon={item.icon}
        subtitle={item.subtitle}
        disabled={item.disabled}
        isOn={item.selected}
        onPress={item.onPress}
      >
        {item.title}
      </Toolbar.MenuAction>
    ),
  );
}

export function createNativeHeaderMenu(menu: AppBarMenu) {
  return (
    <Toolbar.Menu
      key={menu.title}
      title={menu.title}
      accessibilityLabel={menu.title}
      icon={typeof menu.icon === "string" ? menu.icon : menu.icon.ios}
      separateBackground={menu.separateBackground ?? true}
    >
      {menu.status ? <Toolbar.Label>{menu.status}</Toolbar.Label> : null}
      {renderMenuItems(menu.items)}
    </Toolbar.Menu>
  );
}
