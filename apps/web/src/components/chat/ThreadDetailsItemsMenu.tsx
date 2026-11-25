import { T, useMessages } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import {
  isDefaultThreadDetailsOrder,
  isDefaultThreadDetailsVisibility,
  moveThreadDetailsSection,
  resolveThreadDetailsOrder,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
  THREAD_DETAILS_SECTIONS,
  type ThreadDetailsSectionId,
} from "./threadDetailsItems";

/**
 * Menu body that shows and hides thread details items. The card's context menu and Settings share
 * it; right-clicking a section also offers to move that section.
 */
export function ThreadDetailsItemsMenuItems(props: {
  readonly section?: ThreadDetailsSectionId | null;
  /** Sections the card shows now. A move passes one of them, so it always changes the card. */
  readonly shown?: ReadonlyArray<ThreadDetailsSectionId> | undefined;
}) {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  const order = useClientSettings(resolveThreadDetailsOrder);
  const m = useMessages();
  const section = THREAD_DETAILS_SECTIONS.find((candidate) => candidate.id === props.section);
  // Sections shown when the menu opened, minus any turned off in this menu since.
  const shown = order.filter(
    (id) =>
      id === section?.id ||
      (props.shown?.includes(id) &&
        THREAD_DETAILS_SECTIONS.find((candidate) => candidate.id === id)?.items.some(
          (item) => visibility[item],
        )),
  );
  const neighbor = (direction: -1 | 1) =>
    section ? shown[shown.indexOf(section.id) + direction] : undefined;
  const move = (direction: -1 | 1) => {
    const passes = neighbor(direction);
    if (!section || passes === undefined) return;
    updateClientSettings({
      threadDetailsOrder: moveThreadDetailsSection(
        order,
        section.id,
        order.indexOf(passes) - order.indexOf(section.id),
      ),
    });
  };
  return (
    <>
      {section ? (
        <>
          <MenuGroup>
            <MenuGroupLabel>{m(section.label)}</MenuGroupLabel>
            <MenuItem disabled={neighbor(-1) === undefined} onClick={() => move(-1)}>
              <ArrowUpIcon aria-hidden />
              <T>Move up</T>
            </MenuItem>
            <MenuItem disabled={neighbor(1) === undefined} onClick={() => move(1)}>
              <ArrowDownIcon aria-hidden />
              <T>Move down</T>
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
        </>
      ) : null}
      <MenuGroup>
        <MenuGroupLabel>
          <T>Show in thread details</T>
        </MenuGroupLabel>
        {THREAD_DETAILS_ITEMS.map((item) => (
          <MenuCheckboxItem
            key={item.id}
            checked={visibility[item.id]}
            onCheckedChange={(checked) =>
              updateClientSettings({
                threadDetailsItems: setThreadDetailsItem(getClientSettings(), item, checked),
              })
            }
          >
            {m(item.label)}
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        disabled={
          isDefaultThreadDetailsVisibility(visibility) && isDefaultThreadDetailsOrder(order)
        }
        onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
      >
        <T>Reset to default</T>
      </MenuItem>
    </>
  );
}
