import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";

import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { NativeInspectorContent } from "../../native/NativeInspectorContent";

export type ThreadInspectorMode = "route" | "git" | "files" | "preview";

const INSPECTOR_PREWARM_DELAY_MS = 350;

function InspectorContentPane(props: {
  readonly children: ReactNode;
  readonly mounted: boolean;
  readonly resetKeys: readonly [string | null, string | null];
  readonly visible: boolean;
}) {
  if (!props.mounted) {
    return null;
  }

  return (
    <View
      accessibilityElementsHidden={!props.visible}
      focusable={props.visible}
      importantForAccessibility={props.visible ? "auto" : "no-hide-descendants"}
      pointerEvents={props.visible ? "auto" : "none"}
      style={{
        position: "absolute",
        inset: 0,
        opacity: props.visible ? 1 : 0,
        zIndex: props.visible ? 1 : 0,
      }}
    >
      <RenderErrorBoundary
        resetKeys={props.resetKeys}
        renderFallback={(fallback) => (
          <NativeInspectorContent>
            <RenderFailureView {...fallback} title="The inspector couldn't be displayed" />
          </NativeInspectorContent>
        )}
      >
        {props.children}
      </RenderErrorBoundary>
    </View>
  );
}

export function ThreadInspectorContentStack(props: {
  readonly renderPreview?: () => ReactNode;
  readonly renderFiles: () => ReactNode;
  readonly renderGit?: () => ReactNode;
  readonly mode: ThreadInspectorMode;
  readonly resetKeys: readonly [string | null, string | null];
  readonly renderRoute?: () => ReactNode;
}) {
  const [mountedModes, setMountedModes] = useState<ReadonlySet<ThreadInspectorMode>>(
    () => new Set([props.mode]),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps opened UIKit inspector views mounted and prewarms the alternate inspector after a timer
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Keeps opened inspector views mounted so UIKit keeps their focus and scroll.
    setMountedModes((current) => {
      if (current.has(props.mode)) {
        return current;
      }
      return new Set([...current, props.mode]);
    });

    if (props.mode === "route" || props.mode === "preview") {
      return;
    }

    // Keep both inspectors alive after opening; detaching the file tree makes UIKit rebuild its expensive focus graph.
    const alternateMode = props.mode === "files" ? "git" : "files";
    const timeout = setTimeout(() => {
      setMountedModes((current) => {
        if (current.has(alternateMode)) {
          return current;
        }
        return new Set([...current, alternateMode]);
      });
    }, INSPECTOR_PREWARM_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [props.mode]);

  return (
    <View className="flex-1">
      {props.mode === "preview" && props.renderPreview ? (
        <InspectorContentPane mounted resetKeys={props.resetKeys} visible>
          <InspectorRenderer render={props.renderPreview} />
        </InspectorContentPane>
      ) : null}
      <InspectorContentPane
        mounted={mountedModes.has("files") || props.mode === "files"}
        resetKeys={props.resetKeys}
        visible={props.mode === "files"}
      >
        <InspectorRenderer render={props.renderFiles} />
      </InspectorContentPane>
      {props.renderGit ? (
        <InspectorContentPane
          mounted={mountedModes.has("git") || props.mode === "git"}
          resetKeys={props.resetKeys}
          visible={props.mode === "git"}
        >
          <InspectorRenderer render={props.renderGit} />
        </InspectorContentPane>
      ) : null}
      {props.renderRoute ? (
        <InspectorContentPane
          mounted={mountedModes.has("route") || props.mode === "route"}
          resetKeys={props.resetKeys}
          visible={props.mode === "route"}
        >
          <InspectorRenderer render={props.renderRoute} />
        </InspectorContentPane>
      ) : null}
    </View>
  );
}

// Render callbacks carry changing route data; they are not component types.
function InspectorRenderer(props: { readonly render: () => ReactNode }) {
  return <>{props.render()}</>;
}
