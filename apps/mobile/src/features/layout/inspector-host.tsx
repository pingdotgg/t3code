import { useSyncExternalStore, type ReactNode } from "react";
import { Split, Stack } from "react-native-screens";

import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { PaneContext } from "../../components/ui/Pane";
import { GLASS_HEADER_OPTIONS } from "../../native/glass-header-options";
import { NativeColumnContent } from "../../native/NativeColumnContent.ios";
import { V5StackHeader } from "../../native/V5StackHeader.ios";
import { WorkspaceSlotOptionsContext } from "../../native/v5-workspace-context";
import {
  InspectorCloseContext,
  useInspectorBarSlot,
  type InspectorBarStore,
} from "./inspector-bar-store";
import {
  useMountedInspectorPanes,
  type InspectorContent,
  type InspectorPane,
} from "./inspector-panes";

// A pane without an AppBar has no bar; one with it gets the glass the workspace's screens get.
const PANE_HEADER_OPTIONS = { ...GLASS_HEADER_OPTIONS, headerShown: false };

function PaneHeader(props: { readonly store: InspectorBarStore }) {
  const options = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  return <V5StackHeader options={{ ...PANE_HEADER_OPTIONS, ...options }} canGoBack={false} />;
}

function PaneScreenContent(props: {
  readonly pane: InspectorPane;
  readonly resetKeys: ReadonlyArray<unknown> | undefined;
  readonly onClose: () => void;
}) {
  const { store, slot } = useInspectorBarSlot();
  const content = (
    <WorkspaceSlotOptionsContext value={slot}>
      <RenderErrorBoundary
        resetKeys={props.resetKeys}
        renderFallback={(fallback) => (
          <RenderFailureView {...fallback} title="The inspector couldn't be displayed" />
        )}
      >
        {props.pane.render()}
      </RenderErrorBoundary>
    </WorkspaceSlotOptionsContext>
  );
  return (
    <InspectorCloseContext value={props.onClose}>
      <PaneContext value="inspector">
        {props.pane.nativeStack ? (
          content
        ) : (
          <>
            <PaneHeader store={store} />
            <NativeColumnContent>{content}</NativeColumnContent>
          </>
        )}
      </PaneContext>
    </InspectorCloseContext>
  );
}

/**
 * The inspector column's panes, each a screen of the column like the detail column's routes.
 * Only the active one is attached, so UIKit sees one bar, one toolbar and one scroll view.
 */
export function InspectorColumnScreens(props: {
  readonly content: InspectorContent | undefined;
  readonly onClose: () => void;
  /** Drawn over the active pane. */
  readonly overlay?: ReactNode;
}) {
  const panes = useMountedInspectorPanes(props.content);
  return panes.map((pane) => {
    const active = pane.key === props.content?.active;
    return (
      <Split.Inspector
        key={pane.key}
        screenKey={`inspector:${pane.key}`}
        activityMode={active ? "attached" : "detached"}
      >
        <PaneScreenContent
          pane={pane}
          resetKeys={props.content?.resetKeys}
          onClose={props.onClose}
        />
        {active ? props.overlay : null}
      </Split.Inspector>
    );
  });
}

/** The inspector's panes where it has no column: a native stack with the active one attached. */
export function InspectorPanes(props: {
  readonly content: InspectorContent | undefined;
  readonly onClose: () => void;
}) {
  const panes = useMountedInspectorPanes(props.content);
  if (panes.length === 0) return null;
  return (
    <Stack.Host>
      {panes.map((pane) => (
        <Stack.Screen
          key={pane.key}
          screenKey={`inspector:${pane.key}`}
          activityMode={pane.key === props.content?.active ? "attached" : "detached"}
        >
          <PaneScreenContent
            pane={pane}
            resetKeys={props.content?.resetKeys}
            onClose={props.onClose}
          />
        </Stack.Screen>
      ))}
    </Stack.Host>
  );
}
