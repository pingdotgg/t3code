import type { ScreenHeaderMenuItem } from "../../components/ScreenHeader.types";

/** Native headers can retain callbacks while their visible menu stays unchanged. */
export function nativeLifecycleItems(
  items: ReadonlyArray<ScreenHeaderMenuItem>,
  currentItems: () => ReadonlyArray<ScreenHeaderMenuItem>,
): Array<Record<string, unknown>> {
  return items.map((item) =>
    "items" in item
      ? {
          type: "submenu",
          title: item.title ?? "",
          items: nativeLifecycleItems(item.items, () => {
            const current = currentItems().find((candidate) => candidate.id === item.id);
            return current && "items" in current ? current.items : [];
          }),
        }
      : {
          type: "action",
          label: item.title,
          icon: item.icon ? { type: "sfSymbol", name: item.icon } : undefined,
          disabled: item.disabled,
          onPress: () => {
            const current = currentItems().find((candidate) => candidate.id === item.id);
            if (current && "onPress" in current && !current.disabled) current.onPress();
          },
        },
  );
}
