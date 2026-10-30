import { createContext, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { FormSheet } from "react-native-screens";
import { useResolveClassNames } from "uniwind";

import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { PaneContext } from "../../components/ui/Pane";
import { RoutedFormSheetContext } from "../../components/ui/RoutedFormSheetContext";
import { formSheetDetents } from "../../native/sheet-surface";

/**
 * Closes the inspector sheet around the inspector, then runs `then` once it is gone: a route
 * presented over a sheet that isn't one of the stack's own would race its dismissal.
 */
export const InspectorSheetContext = createContext<((then?: () => void) => void) | null>(null);

/** The inspector where the window has no column for it. Its content draws its own bar. */
export function WorkspaceInspectorSheet(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const containerStyle = useResolveClassNames(Platform.OS === "android" ? "bg-header" : "bg-sheet");
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
    <FormSheet
      key={presented.session}
      isOpen={props.open}
      detents={formSheetDetents(0.6, 0.95)}
      prefersGrabberVisible={Platform.OS === "ios"}
      // The inspector's bar holds its actions, so the Duo needs no rail inside this sheet.
      prefersHorizontalBars
      preferredCornerRadius={Platform.OS === "android" ? 28 : undefined}
      nativeContainerStyle={containerStyle}
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
              {/* Android FormSheet does not bound flex children. */}
              <View
                collapsable={false}
                className={
                  Platform.OS === "android" ? "absolute inset-0 bg-header pt-3" : "flex-1 bg-sheet"
                }
              >
                <RenderErrorBoundary
                  renderFallback={(fallback) => (
                    <RenderFailureView {...fallback} title="The inspector couldn't be displayed" />
                  )}
                >
                  {props.children}
                </RenderErrorBoundary>
                {Platform.OS === "android" ? (
                  <View
                    pointerEvents="none"
                    className="absolute top-1 h-1 w-8 self-center rounded-full bg-header-foreground/40"
                  />
                ) : null}
              </View>
            </PaneContext>
          </SafeAreaInsetsContext>
        </RoutedFormSheetContext>
      </InspectorSheetContext>
    </FormSheet>
  );
}
