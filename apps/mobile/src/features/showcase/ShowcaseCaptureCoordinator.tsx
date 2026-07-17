import { useEffect, useRef, useState } from "react";
import { Keyboard, View } from "react-native";
import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";

import { useConnectionController } from "../connection/useConnectionController";
import { useProjects, useThreadShells } from "../../state/entities";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { holdEditingQueuedMessage } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import {
  getNativeShowcasePairingUrls,
  getNativeShowcaseScene,
  markNativeShowcaseReady,
  type ShowcaseScene,
} from "./nativeShowcaseScene";
import {
  buildShowcasePendingTasks,
  SHOWCASE_PENDING_TASK_DEFINITIONS,
} from "./showcasePendingTasks";
import { retryShowcaseOperation } from "./showcaseRetry";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";
const SHOWCASE_THREAD_ID = "remote-command-center";

function sceneFromPathname(pathname: string): ShowcaseScene | null {
  const routePath = pathname.split(/[?#]/u, 1)[0] ?? pathname;
  if (routePath === "/settings" || routePath.endsWith("/settings/environments")) {
    return "environments";
  }
  if (routePath.endsWith("/terminal")) return "terminal";
  if (routePath.endsWith("/review")) return "review";
  if (routePath.startsWith("/threads/")) return "thread";
  if (routePath === "/") return "threads";
  return null;
}

export function ShowcaseCaptureCoordinator(props: { readonly pathname: string }) {
  const navigation = useNavigation();
  const { connectPairingUrl } = useConnectionController();
  const workspace = useWorkspaceState();
  const projects = useProjects();
  const threads = useThreadShells();
  const attemptedPairingRef = useRef(new Set<string>());
  const seededPendingTaskIdsRef = useRef(new Set<string>());
  const [pairingUrls, setPairingUrls] = useState<ReadonlyArray<string>>([]);
  const [pendingTasksReady, setPendingTasksReady] = useState(false);
  const [requestedScene, setRequestedScene] = useState<ShowcaseScene | null>(null);
  const [readyScene, setReadyScene] = useState<ShowcaseScene | null>(null);

  useEffect(() => {
    if (!SHOWCASE_ENABLED || pairingUrls.length > 0) return;

    const readPairingUrls = () => {
      const values = getNativeShowcasePairingUrls();
      if (values.length > 0) setPairingUrls(values);
    };
    readPairingUrls();
    const interval = setInterval(readPairingUrls, 250);
    return () => clearInterval(interval);
  }, [pairingUrls.length]);

  useEffect(() => {
    if (!SHOWCASE_ENABLED) return;

    const readRequestedScene = () => {
      const value = getNativeShowcaseScene();
      if (value) setRequestedScene(value);
    };
    readRequestedScene();
    const interval = setInterval(readRequestedScene, 250);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!SHOWCASE_ENABLED || pairingUrls.length === 0) return;
    let cancelled = false;
    void (async () => {
      await Promise.all(
        pairingUrls.map(async (pairingUrl) => {
          if (cancelled || attemptedPairingRef.current.has(pairingUrl)) return;
          const paired = await retryShowcaseOperation(
            async () => AsyncResult.isSuccess(await connectPairingUrl(pairingUrl)),
            { isCancelled: () => cancelled },
          );
          if (paired) attemptedPairingRef.current.add(pairingUrl);
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [connectPairingUrl, pairingUrls]);

  const scene = sceneFromPathname(props.pathname);
  const hasServerFixture =
    workspace.state.hasReadyEnvironment &&
    workspace.environments.length >= 3 &&
    projects.length >= 3 &&
    threads.some((thread) => String(thread.id) === SHOWCASE_THREAD_ID);
  const hasFixture = hasServerFixture && pendingTasksReady;
  const showcaseThread = threads.find((thread) => String(thread.id) === SHOWCASE_THREAD_ID);

  useEffect(() => {
    if (!SHOWCASE_ENABLED || !hasServerFixture || pendingTasksReady) return;

    const pendingTasks = buildShowcasePendingTasks(projects, Date.now());
    if (pendingTasks.length !== SHOWCASE_PENDING_TASK_DEFINITIONS.length) return;

    let cancelled = false;
    for (const task of pendingTasks) holdEditingQueuedMessage(task.messageId);
    void (async () => {
      const results = await Promise.all(
        pendingTasks.map(async (task) => {
          const messageId = String(task.messageId);
          if (seededPendingTaskIdsRef.current.has(messageId)) return true;
          const seeded = await retryShowcaseOperation(
            async () => {
              await enqueueThreadOutboxMessage(task);
              return true;
            },
            { isCancelled: () => cancelled },
          );
          if (seeded) seededPendingTaskIdsRef.current.add(messageId);
          return seeded;
        }),
      );
      if (!cancelled && results.every(Boolean)) setPendingTasksReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [hasServerFixture, pendingTasksReady, projects]);

  useEffect(() => {
    if (!SHOWCASE_ENABLED || requestedScene === null || !hasFixture || !showcaseThread) return;
    if (scene === requestedScene) return;

    const params = {
      environmentId: String(showcaseThread.environmentId),
      threadId: SHOWCASE_THREAD_ID,
    };
    if (requestedScene === "threads") {
      navigation.dispatch(StackActions.popToTop());
      return;
    }
    const routes: Array<{
      name: string;
      params?: Record<string, unknown>;
      state?: { index: number; routes: Array<{ name: string }> };
    }> = [{ name: "Home" }];
    if (requestedScene === "environments") {
      routes.push({
        name: "SettingsSheet",
        state: {
          index: 1,
          routes: [{ name: "Settings" }, { name: "SettingsEnvironments" }],
        },
      });
    } else {
      routes.push({ name: "Thread", params });
      if (requestedScene === "terminal") {
        routes.push({
          name: "ThreadTerminal",
          params: { ...params, terminalId: "term-1" },
        });
      } else if (requestedScene === "review") {
        routes.push({ name: "ThreadReview", params });
      }
    }
    navigation.dispatch(
      CommonActions.reset({
        index: routes.length - 1,
        routes,
      }),
    );
  }, [hasFixture, navigation, requestedScene, scene, showcaseThread]);

  useEffect(() => {
    if (
      !SHOWCASE_ENABLED ||
      scene === null ||
      requestedScene === null ||
      scene !== requestedScene ||
      !hasFixture
    ) {
      setReadyScene(null);
      return;
    }
    // Review owns its readiness marker because route activation happens before
    // the VCS request is parsed and the native diff surface is mounted.
    if (scene === "review") {
      setReadyScene(null);
      return;
    }
    if (scene === "terminal") Keyboard.dismiss();

    let renderFrame: number | null = null;
    let readyFrame: number | null = null;
    const settleTimer = setTimeout(() => {
      renderFrame = requestAnimationFrame(() => {
        readyFrame = requestAnimationFrame(() => {
          markNativeShowcaseReady(scene);
          setReadyScene(scene);
        });
      });
    }, 500);
    return () => {
      clearTimeout(settleTimer);
      if (renderFrame !== null) cancelAnimationFrame(renderFrame);
      if (readyFrame !== null) cancelAnimationFrame(readyFrame);
    };
  }, [hasFixture, requestedScene, scene]);

  if (!SHOWCASE_ENABLED || readyScene === null) return null;

  return (
    <View
      pointerEvents="none"
      testID={`showcase-ready-${readyScene}`}
      style={{ position: "absolute", width: 1, height: 1, opacity: 0.01 }}
    />
  );
}
