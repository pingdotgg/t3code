import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";

import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";

export type ThreadInspectorMode = "route" | "git" | "files";

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
          <RenderFailureView {...fallback} title="The inspector couldn't be displayed" />
        )}
      >
        {props.children}
      </RenderErrorBoundary>
    </View>
  );
}

export function ThreadInspectorContentStack(props: {
  readonly renderFiles: () => ReactNode;
  readonly renderGit?: () => ReactNode;
  readonly mode: ThreadInspectorMode;
  readonly resetKeys: readonly [string | null, string | null];
  readonly renderRoute?: () => ReactNode;
}) {
  const [mountedModes, setMountedModes] = useState<ReadonlySet<ThreadInspectorMode>>(
    () => new Set([props.mode]),
  );

  useEffect(() => {
    setMountedModes((current) => {
      if (current.has(props.mode)) {
        return current;
      }
      return new Set([...current, props.mode]);
    });

    if (props.mode === "route") {
      return;
    }

    // The file tree is expensive to detach because UIKit rebuilds its focus
    // graph. Keep both chat inspectors alive after the opening animation so a
    // later Files/Git switch only changes visibility.
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
