import { StackActions, useNavigation, useRoute, type Route } from "@react-navigation/native";
import { use } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { linkedThreadStep } from "../../lib/android-workspace-navigation";
import { linkedThreadRouteParams } from "./linkedThreadRoute";
import {
  ThreadInspectorNavigationContext,
  type ThreadInspectorTarget,
  useOpenThreadInspector,
} from "./thread-inspector-navigation";

export function useOpenLinkedThread() {
  const navigation = useNavigation();
  const route = useRoute<Route<string, { environmentId?: string; threadId?: string }>>();
  const openInspector = useOpenThreadInspector();
  const openInInspector = use(ThreadInspectorNavigationContext);
  return (target: { readonly environmentId: string; readonly threadId: string }) => {
    if (openInInspector) {
      openInInspector({ type: "thread", ...target });
      return;
    }
    const state = navigation.getState();
    const step = state ? linkedThreadStep(state, target) : "push";
    if (
      step === "push" &&
      route.name === "Thread" &&
      route.params?.environmentId &&
      route.params.threadId &&
      openInspector(
        { environmentId: route.params.environmentId, threadId: route.params.threadId },
        { type: "thread", ...target },
      )
    )
      return;
    if (step === "pop") navigation.dispatch(StackActions.pop());
    else if (step === "push") navigation.dispatch(StackActions.push("Thread", target));
  };
}

/**
 * Opens a linked environment's thread read-only, read through `linked.viaEnvironmentId`: in the
 * inspector where the layout has one, as subagents and side chats do, else as its own screen.
 * `source` is the thread it opens from when the caller is not that thread's own screen.
 */
export function useOpenLinkedThreadRead() {
  const navigation = useNavigation();
  const route = useRoute<Route<string, { environmentId?: string; threadId?: string }>>();
  const openInspector = useOpenThreadInspector();
  const openInInspector = use(ThreadInspectorNavigationContext);
  return (
    thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
    linked: { readonly viaEnvironmentId: EnvironmentId; readonly label: string },
    title: string | null,
    options?: {
      readonly source?: { readonly environmentId: string; readonly threadId: string };
      /** Replaces the calling sheet instead of stacking on it. */
      readonly replace?: boolean;
    },
  ) => {
    const params = linkedThreadRouteParams(thread, linked, title);
    const target: ThreadInspectorTarget = {
      type: "linkedThread",
      environmentId: params.environmentId,
      threadId: params.threadId,
      linked: {
        viaEnvironmentId: params.viaEnvironmentId,
        label: params.label,
        ...(params.title === undefined ? {} : { title: params.title }),
      },
    };
    if (openInInspector) {
      openInInspector(target);
      return;
    }
    const source =
      options?.source ??
      (route.name === "Thread" && route.params?.environmentId && route.params.threadId
        ? { environmentId: route.params.environmentId, threadId: route.params.threadId }
        : null);
    if (source !== null && openInspector(source, target)) return;
    navigation.dispatch(
      options?.replace
        ? StackActions.replace("LinkedThread", params)
        : StackActions.push("LinkedThread", params),
    );
  };
}
