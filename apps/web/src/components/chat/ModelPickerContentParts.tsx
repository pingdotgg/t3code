import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useState,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import { rankModelPickerSearch } from "./modelPickerSearch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { registerModelPickerContent } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import {
  useEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "~/hooks/useSettings";
import { announce } from "~/lib/announce";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import { MODEL_LIST_ESTIMATED_ITEM_SIZE, ModelListSeparator } from "./ModelPickerContent";

export function ModelPickerList({
  listRef,
  itemKeys,
  extraData,
  renderItem,
}: {
  listRef: RefObject<LegendListRef | null>;
  itemKeys: ReadonlyArray<string>;
  extraData: unknown;
  renderItem: (props: { item: string; index: number }) => ReactNode;
}) {
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const updateScrollFades = () => {
    const scrollElement = listRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  };

  // Disabled-reason closures rebuild identical key arrays; compare contents.
  const itemListKey = JSON.stringify(itemKeys);
  const [fadesResetFor, setFadesResetFor] = useState(itemListKey);
  if (fadesResetFor !== itemListKey) {
    setFadesResetFor(itemListKey);
    setShowTopScrollFade(false);
    setShowBottomScrollFade(itemKeys.length > 5);
  }
  const measureScrollFades = useEffectEvent(updateScrollFades);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the list scroller in animation frames after a new list lays out to set scroll fades
  useLayoutEffect(() => {
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      measureScrollFades();
      nestedFrame = window.requestAnimationFrame(() => measureScrollFades());
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new list re-measures its scroll fades once it has laid out.
  }, [itemListKey]);

  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden pr-px",
        itemKeys.length > 0 ? "flex-1" : "h-0",
      )}
    >
      <ComboboxListVirtualized>
        <LegendList<string>
          ref={listRef}
          data={itemKeys}
          extraData={extraData}
          keyExtractor={(modelKey) => modelKey}
          renderItem={renderItem}
          estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
          drawDistance={480}
          recycleItems
          contentContainerClassName="pl-2 pr-px"
          ItemSeparatorComponent={ModelListSeparator}
          onLayout={updateScrollFades}
          onScroll={updateScrollFades}
          className={cn(
            "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
            getVirtualizedScrollFadeClassName({
              top: showTopScrollFade,
              bottom: showBottomScrollFade,
            }),
          )}
        />
      </ComboboxListVirtualized>
    </div>
  );
}

// Capture gives picker shortcuts priority over the composer.
