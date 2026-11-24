import { StackActions, useNavigation } from "@react-navigation/native";
import { createContext, use } from "react";
import { Platform } from "react-native";

import { resolveMobileSideThreadPresentation } from "@t3tools/client-runtime/side-thread";

import { useWorkspacePaneState } from "../layout/AdaptiveWorkspaceLayout";

export type ThreadInspectorMode = "route" | "git" | "files" | "preview";

export type ThreadInspectorTarget = {
  /** "linkedThread" is a thread on a linked environment, read through `linked.viaEnvironmentId`. */
  readonly type: "thread" | "linkedThread" | "device" | "localPreview";
  readonly environmentId: string;
  readonly threadId: string;
  readonly linked?: {
    readonly viaEnvironmentId: string;
    readonly label: string;
    readonly title?: string;
  };
  readonly deviceKey?: string;
  /** The environment's localhost page a "localPreview" shows. */
  readonly url?: string;
};

export const ThreadInspectorNavigationContext = createContext<
  ((target: ThreadInspectorTarget) => void) | null
>(null);

export function useOpenThreadInspector() {
  const navigation = useNavigation();
  const { fileInspector } = useWorkspacePaneState();
  const openInInspector = use(ThreadInspectorNavigationContext);
  return (
    source: { readonly environmentId: string; readonly threadId: string },
    target: ThreadInspectorTarget,
  ) => {
    const presentation = resolveMobileSideThreadPresentation({
      inspectorAvailable: Platform.OS === "ios" && fileInspector.supported,
    });
    if (presentation === "full-screen") return false;
    if (openInInspector) openInInspector(target);
    else {
      if (!isNearestThreadRoute(navigation.getState(), source)) return false;
      navigation.dispatch(
        StackActions.popTo("Thread", { ...source, inspector: target }, { merge: true }),
      );
    }
    return true;
  };
}

/** Closes the screens above `thread`, or opens it when the nearest thread route is another one. */
export function useReturnToThread() {
  const navigation = useNavigation();
  return (thread: { readonly environmentId: string; readonly threadId: string }) =>
    navigation.dispatch(
      isNearestThreadRoute(navigation.getState(), thread)
        ? StackActions.popTo("Thread", thread, { merge: true })
        : StackActions.replace("Thread", thread),
    );
}

// `Thread` has no `getId`, so `popTo("Thread")` lands on the nearest one whatever thread it shows.
function isNearestThreadRoute(
  state:
    | { readonly routes: ReadonlyArray<{ readonly name: string; readonly params?: object }> }
    | undefined,
  thread: { readonly environmentId: string; readonly threadId: string },
) {
  const params = state?.routes.findLast((route) => route.name === "Thread")?.params;
  return (
    params !== undefined &&
    "environmentId" in params &&
    params.environmentId === thread.environmentId &&
    "threadId" in params &&
    params.threadId === thread.threadId
  );
}
