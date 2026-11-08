import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";

/** Title long-press menu for settle / snooze. Git and Terminal stay as bar icons. */
export function buildThreadTitleMenu(
  lifecycleItems: ReadonlyArray<AppBarMenuItem>,
): AppBarMenu | null {
  if (lifecycleItems.length === 0) return null;
  return {
    title: "Thread actions",
    icon: "ellipsis.circle",
    separateBackground: false,
    items: lifecycleItems,
  };
}
