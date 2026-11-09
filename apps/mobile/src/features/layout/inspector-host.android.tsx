import { View } from "react-native";

import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { PaneContext } from "../../components/ui/Pane";
import { WorkspaceSlotOptionsContext } from "../../native/v5-workspace-context";
import { InspectorCloseContext, useInspectorBarSlot } from "./inspector-bar-store";
import {
  useMountedInspectorPanes,
  type InspectorContent,
  type InspectorPane,
} from "./inspector-panes";

// AppBar draws the bar inline on Android; the slot keeps a pane's options off the thread's route.
function PaneContent(props: {
  readonly pane: InspectorPane;
  readonly resetKeys: ReadonlyArray<unknown> | undefined;
}) {
  const { slot } = useInspectorBarSlot();
  return (
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
}

/** The inspector's panes, stacked in place: Android draws no native chrome a hidden pane could leave. */
export function InspectorPanes(props: {
  readonly content: InspectorContent | undefined;
  readonly onClose: () => void;
}) {
  const panes = useMountedInspectorPanes(props.content);
  return (
    <InspectorCloseContext value={props.onClose}>
      <PaneContext value="inspector">
        <View className="flex-1">
          {panes.map((pane) => {
            const visible = pane.key === props.content?.active;
            return (
              <View
                key={pane.key}
                accessibilityElementsHidden={!visible}
                focusable={visible}
                importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
                pointerEvents={visible ? "auto" : "none"}
                style={{
                  position: "absolute",
                  inset: 0,
                  opacity: visible ? 1 : 0,
                  // A lower zIndex mounts first, and Material sheet drags follow the first scroll view.
                  zIndex: visible ? 0 : 1,
                }}
              >
                <PaneContent pane={pane} resetKeys={props.content?.resetKeys} />
              </View>
            );
          })}
        </View>
      </PaneContext>
    </InspectorCloseContext>
  );
}
