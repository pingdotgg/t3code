import { createContext, useRef, useState } from "react";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { PaneContext } from "../../components/ui/Pane";
import { PaneSheet } from "../../components/ui/PaneSheet";
import { RoutedFormSheetContext } from "../../components/ui/RoutedFormSheetContext";
import { formSheetDetents } from "../../native/sheet-surface";
import { InspectorPanes } from "./inspector-host";
import type { InspectorContent } from "./inspector-panes";

/**
 * Closes the inspector sheet around the inspector, then runs `then` once it is gone: a route
 * presented over a sheet that isn't one of the stack's own would race its dismissal.
 */
export const InspectorSheetContext = createContext<((then?: () => void) => void) | null>(null);

/** The inspector where the window has no column for it. Its panes draw their own bars. */
export function WorkspaceInspectorSheet(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly content: InspectorContent | undefined;
}) {
  const insets = useSafeAreaInsets();
  // Stays mounted until the sheet has finished closing, so it doesn't empty as it slides away.
  // Each opening gets a fresh native sheet, even one that starts while the last is closing.
  const [presented, setPresented] = useState({
    open: props.open,
    mounted: props.open,
    session: 0,
  });
  if (presented.open !== props.open) {
    setPresented({
      open: props.open,
      mounted: presented.mounted || props.open,
      session: props.open ? presented.session + 1 : presented.session,
    });
  }
  const afterClose = useRef<(() => void) | null>(null);
  const closed = () => {
    setPresented((current) => ({ ...current, mounted: false }));
    const then = afterClose.current;
    afterClose.current = null;
    then?.();
  };
  const close = (then?: () => void) => {
    afterClose.current = then ?? null;
    props.onClose();
  };
  if (!presented.mounted) return null;
  return (
    <PaneSheet
      key={presented.session}
      isOpen={props.open}
      detents={formSheetDetents(0.6, 0.95)}
      // The inspector's bar holds its actions, so the Duo needs no rail inside this sheet.
      prefersHorizontalBars
      onDismiss={closed}
      onNativeDismiss={() => {
        props.onClose();
        closed();
      }}
    >
      <InspectorSheetContext value={close}>
        <RoutedFormSheetContext value={false}>
          {/* The sheet starts below the status bar. */}
          <SafeAreaInsetsContext value={{ ...insets, top: 0 }}>
            <PaneContext value="inspector">
              <InspectorPanes content={props.content} onClose={() => close()} />
            </PaneContext>
          </SafeAreaInsetsContext>
        </RoutedFormSheetContext>
      </InspectorSheetContext>
    </PaneSheet>
  );
}
