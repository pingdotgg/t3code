import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, View } from "react-native";
import {
  CommonActions,
  type NavigationState,
  type PartialState,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";

import { useConnectionController } from "../connection/useConnectionController";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { MobileThemeId } from "../../lib/mobileTheme";
import { useProjects, useThreadShells } from "../../state/entities";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { holdEditingQueuedMessage } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import {
  applyNativeShowcaseOrientation,
  getNativeShowcaseOrientation,
  getNativeShowcasePairingUrls,
  getNativeShowcaseScene,
  getNativeShowcaseTheme,
  markNativeShowcaseReady,
  type ShowcaseScene,
} from "./nativeShowcaseScene";
import {
  buildShowcasePendingTasks,
  SHOWCASE_PENDING_TASK_DEFINITIONS,
} from "./showcasePendingTasks";
import { retryShowcaseOperation } from "./showcaseRetry";
import {
  clearShowcaseRenderSignal,
  getShowcaseRenderSignal,
  isShowcaseNativeContentReady,
  subscribeToShowcaseRenderSignal,
} from "./showcaseRenderSignal";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";
const SHOWCASE_THREAD_ID = "remote-command-center";

type ShowcaseResetRoute = PartialState<NavigationState>["routes"][number];

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
  const {
    isReady: appearancePreferencesReady,
    themeId,
    themeIds,
    setThemeIdForBothAppearances,
  } = useAppearancePreferences();
  const workspace = useWorkspaceState();
  const projects = useProjects();
  const threads = useThreadShells();
  const attemptedPairingRef = useRef(new Set<string>());
  const seededPendingTaskIdsRef = useRef(new Set<string>());
  const [pairingUrls, setPairingUrls] = useState<ReadonlyArray<string>>([]);
  const [pendingTasksReady, setPendingTasksReady] = useState(false);
  const [requestedScene, setRequestedScene] = useState<ShowcaseScene | null>(null);
  const [requestedTheme, setRequestedTheme] = useState<MobileThemeId | null>(null);
  const [themeRequestSettled, setThemeRequestSettled] = useState(false);
  const [readyScene, setReadyScene] = useState<ShowcaseScene | null>(null);
  const [orientationSettled, setOrientationSettled] = useState(false);
  const requestedSceneRef = useRef<ShowcaseScene | null>(null);
  const renderSignal = useSyncExternalStore(
    subscribeToShowcaseRenderSignal,
    getShowcaseRenderSignal,
    getShowcaseRenderSignal,
  );

  useEffect(() => {
    if (!SHOWCASE_ENABLED || pairingUrls.length > 0) return;

    const readLaunchRequest = () => {
      const values = getNativeShowcasePairingUrls();
      if (values.length === 0) return;
      // The palette rides the same launch request as the pairing URLs, so
      // reading it here settles it without a timeout that could expire while
      // the request is still on its way.
      setRequestedTheme(getNativeShowcaseTheme());
      setThemeRequestSettled(true);
      setPairingUrls(values);
    };
    readLaunchRequest();
    const interval = setInterval(readLaunchRequest, 250);
    return () => clearInterval(interval);
  }, [pairingUrls.length]);

  useEffect(() => {
    if (!SHOWCASE_ENABLED || orientationSettled) return;
    const orientation = getNativeShowcaseOrientation();
    if (orientation === null) {
      setOrientationSettled(true);
      return;
    }

    let cancelled = false;
    void retryShowcaseOperation(async () => applyNativeShowcaseOrientation(orientation), {
      isCancelled: () => cancelled,
    }).then((applied) => {
      if (!cancelled && applied) setOrientationSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [orientationSettled]);

  useEffect(() => {
    if (!SHOWCASE_ENABLED) return;

    const readRequestedScene = () => {
      const value = getNativeShowcaseScene();
      if (!value || requestedSceneRef.current === value) return;
      requestedSceneRef.current = value;
      // A native draw belongs only to the scene request that produced it. In
      // particular, revisiting review must wait for its newly mounted surface.
      clearShowcaseRenderSignal();
      setRequestedScene(value);
    };
    readRequestedScene();
    const interval = setInterval(readRequestedScene, 250);
    return () => clearInterval(interval);
  }, []);

  // Captures pick a palette for both color schemes so the requested theme is
  // used whichever system appearance the runner set on the device.
  const themeApplied =
    requestedTheme === null
      ? themeRequestSettled
      : themeIds.light === requestedTheme && themeIds.dark === requestedTheme;

  useEffect(() => {
    if (
      !SHOWCASE_ENABLED ||
      requestedTheme === null ||
      themeApplied ||
      // Writing before stored preferences load would be overwritten by them.
      !appearancePreferencesReady
    ) {
      return;
    }
    setThemeIdForBothAppearances(requestedTheme);
  }, [appearancePreferencesReady, requestedTheme, setThemeIdForBothAppearances, themeApplied]);

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
    const routes: ShowcaseResetRoute[] = [{ name: "Home" }];
    if (requestedScene === "environments") {
      routes.push({
        name: "SettingsSheet",
        state: {
          index: 0,
          routes: [
            {
              name: "SettingsContent",
              state: {
                index: 1,
                routes: [{ name: "Settings" }, { name: "SettingsEnvironments" }],
              },
            },
          ],
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
      !hasFixture ||
      // Never report a scene ready while the capture orientation is still
      // being applied — a screenshot taken early has the wrong dimensions.
      !orientationSettled ||
      // Likewise for the palette: an early screenshot shows the default theme.
      !themeApplied ||
      !isShowcaseNativeContentReady({ scene, themeId, renderSignal })
    ) {
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
  }, [hasFixture, orientationSettled, renderSignal, requestedScene, scene, themeApplied, themeId]);

  if (!SHOWCASE_ENABLED || readyScene === null) return null;

  return (
    <View
      pointerEvents="none"
      testID={`showcase-ready-${readyScene}`}
      style={{ position: "absolute", width: 1, height: 1, opacity: 0.01 }}
    />
  );
}
