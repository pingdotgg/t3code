import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { createContext, use, useMemo, type ReactNode } from "react";
import { useWindowDimensions, View } from "react-native";

import { deriveLayout, type Layout } from "../../lib/layout";
import { buildThreadRoutePath } from "../../lib/routes";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";

interface AdaptiveWorkspaceContextValue {
  readonly layout: Layout;
}

const compactLayout = deriveLayout({ width: 0, height: 0 });
const AdaptiveWorkspaceContext = createContext<AdaptiveWorkspaceContextValue>({
  layout: compactLayout,
});

function firstRouteParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export function useAdaptiveWorkspaceLayout(): AdaptiveWorkspaceContextValue {
  return use(AdaptiveWorkspaceContext);
}

export function AdaptiveWorkspaceLayout(props: { readonly children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const router = useRouter();
  const params = useGlobalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
  }>();
  const layout = useMemo(() => deriveLayout({ width, height }), [height, width]);
  const environmentId = firstRouteParam(params.environmentId);
  const threadId = firstRouteParam(params.threadId);
  const selectedThreadKey =
    environmentId !== null && threadId !== null
      ? scopedThreadKey(EnvironmentId.make(environmentId), ThreadId.make(threadId))
      : null;
  const contextValue = useMemo(() => ({ layout }), [layout]);

  const handleSelectThread = (thread: EnvironmentThreadShell) => {
    router.replace(buildThreadRoutePath(thread));
  };

  return (
    <AdaptiveWorkspaceContext.Provider value={contextValue}>
      <View testID="adaptive-workspace-layout" style={{ flex: 1, flexDirection: "row" }}>
        {layout.usesSplitView && layout.listPaneWidth !== null ? (
          <ThreadNavigationSidebar
            width={layout.listPaneWidth}
            selectedThreadKey={selectedThreadKey}
            onOpenSettings={() => router.push("/settings")}
            onSelectThread={handleSelectThread}
            onStartNewTask={() => router.push("/new")}
          />
        ) : null}
        <View style={{ flex: 1 }}>{props.children}</View>
      </View>
    </AdaptiveWorkspaceContext.Provider>
  );
}
