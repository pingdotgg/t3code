import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { environmentCatalog } from "../../connection/catalog";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { resolveNativeGlbViewer } from "./nativeGlbViewer";
import { workspaceFileGlbPreviewState } from "./workspaceFileGlbPreviewState";

const NATIVE_VIEWER_STYLE = { flex: 1 } as const;

type GlbLoadStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly hasAnimation: boolean }
  | { readonly kind: "error"; readonly message: string };

function ResolvedWorkspaceFileGlbPreview(props: {
  readonly accessibilityLabel: string;
  readonly uri: string;
  readonly onRetry: () => void;
}) {
  const backgroundColor = String(useThemeColor("--color-sheet-solid"));
  const NativeGlbViewer = resolveNativeGlbViewer();
  const [status, setStatus] = useState<GlbLoadStatus>({ kind: "loading" });

  // Callers gate on `hasNativeGlbViewer()`, so this only narrows the type.
  if (NativeGlbViewer === null) {
    return null;
  }

  return (
    <View className="relative flex-1 bg-sheet">
      <NativeGlbViewer
        accessible
        accessibilityLabel={`${props.accessibilityLabel}. Interactive 3D preview. Drag to orbit, pinch to zoom, and use two fingers to pan.`}
        backgroundColor={backgroundColor}
        style={NATIVE_VIEWER_STYLE}
        uri={props.uri}
        onLoadStart={() => {
          setStatus({ kind: "loading" });
        }}
        onLoad={(event) => {
          setStatus({ kind: "loaded", hasAnimation: event.nativeEvent.hasAnimation === true });
        }}
        onError={(event) => {
          setStatus({
            kind: "error",
            message: event.nativeEvent.message || "The 3D model could not be rendered.",
          });
        }}
      />

      {status.kind === "loading" ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 z-10 items-center justify-center gap-3 bg-sheet px-6"
          style={{ elevation: 1 }}
        >
          <ActivityIndicator />
          <Text className="text-center text-sm text-foreground-muted">Loading 3D model...</Text>
        </View>
      ) : null}

      {status.kind === "error" ? (
        <View
          className="absolute inset-0 z-10 items-center justify-center bg-sheet px-6"
          style={{ elevation: 1 }}
        >
          <EmptyState
            title="3D model unavailable"
            detail={status.message}
            actionLabel="Try again"
            onAction={props.onRetry}
          />
        </View>
      ) : null}

      {status.kind === "loaded" ? (
        <View
          pointerEvents="none"
          className="absolute inset-x-4 bottom-4 items-center rounded-full bg-card-translucent px-4 py-2"
        >
          <Text className="text-center text-xs text-foreground-muted">
            {status.hasAnimation
              ? "Drag to orbit · Pinch to zoom · Tap to replay"
              : "Drag to orbit · Pinch to zoom · Two-finger drag to pan"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Owns its own environment subscription so the connection notice stays available without every
 * other file preview re-rendering on unrelated connection churn.
 */
export function WorkspaceFileGlbPreview(props: {
  readonly accessibilityLabel: string;
  readonly environmentId: EnvironmentId | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly uri: string | null;
  readonly onRetry: () => void;
}) {
  const environment = useEnvironmentPresentation(props.environmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const state = workspaceFileGlbPreviewState({
    connection: environment.presentation?.connection ?? null,
    error: props.error,
    isPending: props.isPending,
    uri: props.uri,
  });

  if (state.kind === "connection-unavailable") {
    return (
      <EnvironmentConnectionNotice
        environmentLabel={environment.presentation?.entry.target.label ?? "Environment"}
        connection={state.connection}
        resourceName="3D model"
        onRetry={() => {
          if (props.environmentId !== null) {
            void retryEnvironment(props.environmentId);
          }
        }}
      />
    );
  }

  if (state.kind === "asset-error") {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState
          title="3D preview unavailable"
          detail={state.message}
          actionLabel="Try again"
          onAction={props.onRetry}
        />
      </View>
    );
  }

  if (state.kind === "preparing") {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Preparing 3D preview...</Text>
      </View>
    );
  }

  // Remounting on a new URI resets the load status without a reconciling effect.
  return (
    <ResolvedWorkspaceFileGlbPreview
      key={state.uri}
      accessibilityLabel={props.accessibilityLabel}
      onRetry={props.onRetry}
      uri={state.uri}
    />
  );
}
