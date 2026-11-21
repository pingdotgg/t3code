import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { View } from "react-native";

import { LocalPreviewScreen } from "../browser/LocalPreviewRouteScreen";
import { DevicePreviewScreen } from "../devices/DevicePreviewRouteScreen";
import {
  WorkspaceContentWidthContext,
  WorkspaceSettledContentWidthContext,
} from "../layout/workspace-content-width";
import {
  ThreadInspectorNavigationContext,
  type ThreadInspectorTarget,
} from "./thread-inspector-navigation";
import { linkedThreadRouteParams } from "./linkedThreadRoute";
import { LinkedThreadView } from "./LinkedThreadSheet";
import type { ThreadInspectorPresentation } from "./thread-inspector-header";
import { ThreadPreviewRoute } from "./thread-preview-route";

/** A thread shown beside or over the workspace does not take the workspace's content width. */
export function InspectorContentScope({ children }: { readonly children: ReactNode }) {
  return (
    <WorkspaceContentWidthContext value={null}>
      <WorkspaceSettledContentWidthContext value={null}>
        {children}
      </WorkspaceSettledContentWidthContext>
    </WorkspaceContentWidthContext>
  );
}

export function ThreadInspectorPreview(props: {
  readonly target: ThreadInspectorTarget;
  readonly onClose: () => void;
  readonly onOpen: (target: ThreadInspectorTarget) => void;
  readonly renderThread: (
    props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }> & {
      readonly inspectorPresentation: ThreadInspectorPresentation;
    },
  ) => ReactNode;
}) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const { target } = props;
  const maximizeDevice = (deviceKey: string | null) => {
    props.onOpen({ ...target, deviceKey: deviceKey ?? undefined });
    navigation.navigate("ThreadDevicePreview", {
      environmentId: target.environmentId,
      threadId: target.threadId,
      deviceKey: deviceKey ?? undefined,
    });
  };
  if (!focused) return null;
  return (
    <ThreadInspectorNavigationContext value={props.onOpen}>
      <InspectorContentScope>
        {target.type === "localPreview" && target.url ? (
          <LocalPreviewScreen
            key={`${target.environmentId}:${target.url}`}
            environmentId={EnvironmentId.make(target.environmentId)}
            url={target.url}
            onClose={props.onClose}
            onMaximize={(url) => {
              props.onOpen({ ...target, url });
              navigation.navigate("ThreadLocalPreview", {
                environmentId: target.environmentId,
                url,
              });
            }}
          />
        ) : target.type === "linkedThread" && target.linked ? (
          <LinkedThread
            key={`${target.linked.viaEnvironmentId}:${target.environmentId}:${target.threadId}`}
            thread={target}
            linked={target.linked}
          />
        ) : target.type === "device" ? (
          <DevicePreviewScreen
            key={`${target.environmentId}:${target.threadId}`}
            environmentId={EnvironmentId.make(target.environmentId)}
            threadId={ThreadId.make(target.threadId)}
            initialDeviceKey={target.deviceKey}
            onClose={props.onClose}
            onMaximize={maximizeDevice}
          />
        ) : (
          <View className="flex-1 bg-screen">
            <ThreadPreviewRoute environmentId={target.environmentId} threadId={target.threadId}>
              {(route) =>
                props.renderThread({
                  route,
                  inspectorPresentation: {
                    onMaximize: () =>
                      navigation.navigate("ThreadInspectorFullscreen", {
                        environmentId: route.params.environmentId,
                        threadId: route.params.threadId,
                      }),
                  },
                })
              }
            </ThreadPreviewRoute>
          </View>
        )}
      </InspectorContentScope>
    </ThreadInspectorNavigationContext>
  );
}

/** A linked environment's read-only thread in the inspector; Maximize gives it the whole screen. */
function LinkedThread(props: {
  readonly thread: Pick<ThreadInspectorTarget, "environmentId" | "threadId">;
  readonly linked: NonNullable<ThreadInspectorTarget["linked"]>;
}) {
  const navigation = useNavigation();
  const params = linkedThreadRouteParams(
    {
      environmentId: EnvironmentId.make(props.thread.environmentId),
      threadId: ThreadId.make(props.thread.threadId),
    },
    {
      viaEnvironmentId: EnvironmentId.make(props.linked.viaEnvironmentId),
      label: props.linked.label,
    },
    props.linked.title ?? null,
  );
  return (
    <LinkedThreadView
      target={{
        viaEnvironmentId: EnvironmentId.make(params.viaEnvironmentId),
        environmentId: EnvironmentId.make(params.environmentId),
        threadId: ThreadId.make(params.threadId),
        label: params.label,
        title: params.title ?? null,
      }}
      presentation={{ onMaximize: () => navigation.navigate("LinkedThreadFullscreen", params) }}
    />
  );
}
