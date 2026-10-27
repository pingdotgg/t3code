import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, View } from "react-native";
import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";

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
import { buildShowcaseAgentActivity } from "./showcaseAgentActivity";
import {
  isShowcaseThemeApplied,
  SHOWCASE_THREAD_ID,
  showcaseReadinessKey,
  showcaseSceneOnScreen,
} from "./showcaseCaptureModel";
import { retryShowcaseOperation } from "./showcaseRetry";
import {
  clearShowcaseRenderSignal,
  getShowcaseRenderSnapshot,
  subscribeToShowcaseRenderSignal,
} from "./showcaseRenderSignal";
import { stageShowcaseAgentActivity } from "./stageShowcaseAgentActivity";
import { openSettings } from "../settings/settings-navigation";
import { selectWorkspaceDetail } from "../workspace/workspace-detail-selection";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

export function ShowcaseCaptureCoordinator(props: { readonly pathname: string }) {
  if (!SHOWCASE_ENABLED) return null;
  return <EnabledShowcaseCaptureCoordinator pathname={props.pathname} />;
}

function EnabledShowcaseCaptureCoordinator(props: { readonly pathname: string }) {
  const navigation = useNavigation();
  useEffect(() => {
    const menu = requireOptionalNativeModule<{
      closeMenu(): void;
      setToolsButtonVisible(visible: boolean): void;
    }>("ExpoDevMenu");
    // The dev menu can open after bundle loading and block orientation requests.
    const timer = setInterval(() => {
      menu?.closeMenu();
      menu?.setToolsButtonVisible(false);
    }, 1_000);
    return () => clearInterval(timer);
  }, []);
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
  const [agentActivityStaged, setAgentActivityStaged] = useState(false);
  const requestedSceneRef = useRef<ShowcaseScene | null>(null);
  // Read current entities without restarting on shell updates and re-entering open permission prompts.
  const readFixtureEntities = useEffectEvent(() => ({ threads, projects }));
  const { signal: renderSignal, reports: renderReports } = useSyncExternalStore(
    subscribeToShowcaseRenderSignal,
    getShowcaseRenderSnapshot,
    getShowcaseRenderSnapshot,
  );

  useEffect(() => {
    if (pairingUrls.length > 0) return;

    const readLaunchRequest = () => {
      const values = getNativeShowcasePairingUrls();
      if (values.length === 0) return;
      setRequestedTheme(getNativeShowcaseTheme());
      setThemeRequestSettled(true);
      setPairingUrls(values);
    };
    readLaunchRequest();
    const interval = setInterval(readLaunchRequest, 250);
    return () => clearInterval(interval);
  }, [pairingUrls.length]);

  useEffect(() => {
    if (orientationSettled) return;
    const orientation = getNativeShowcaseOrientation();
    if (orientation === null) {
      // oxlint-disable-next-line react/set-state-in-effect -- Capture readiness follows the native orientation change.
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
    const readRequestedScene = () => {
      const value = getNativeShowcaseScene();
      if (!value || requestedSceneRef.current === value) return;
      requestedSceneRef.current = value;
      // Draws belong to their scene request; revisiting review must wait for its new surface.
      clearShowcaseRenderSignal();
      setAgentActivityStaged(false);
      setRequestedScene(value);
    };
    readRequestedScene();
    const interval = setInterval(readRequestedScene, 250);
    return () => clearInterval(interval);
  }, []);

  const themeApplied = isShowcaseThemeApplied({
    launchRequestRead: themeRequestSettled,
    requestedTheme,
    themeIds,
  });

  useEffect(() => {
    if (requestedTheme === null || themeApplied || !appearancePreferencesReady) {
      return;
    }
    setThemeIdForBothAppearances(requestedTheme);
  }, [appearancePreferencesReady, requestedTheme, setThemeIdForBothAppearances, themeApplied]);

  useEffect(() => {
    if (pairingUrls.length === 0) return;
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

  const scene = showcaseSceneOnScreen(requestedScene, props.pathname);
  const hasServerFixture =
    workspace.state.hasReadyEnvironment &&
    workspace.environments.length >= 3 &&
    projects.length >= 3 &&
    threads.some((thread) => String(thread.id) === SHOWCASE_THREAD_ID);
  const hasFixture = hasServerFixture && pendingTasksReady;
  const showcaseThread = threads.find((thread) => String(thread.id) === SHOWCASE_THREAD_ID);

  useEffect(() => {
    if (!hasServerFixture || pendingTasksReady) return;

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
    if (requestedScene === null || !hasFixture || !showcaseThread) return;
    if (scene === requestedScene) return;

    const params = {
      environmentId: String(showcaseThread.environmentId),
      threadId: SHOWCASE_THREAD_ID,
    };
    if (requestedScene === "threads") {
      navigation.dispatch(StackActions.popToTop());
      return;
    }
    if (requestedScene === "agent-activity") {
      navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name: "Home" }] }));
      return;
    }
    if (requestedScene === "environments") {
      openSettings(navigation, "SettingsEnvironments");
    } else if (requestedScene === "terminal") {
      navigation.dispatch(
        CommonActions.navigate("ThreadTerminal", { ...params, terminalId: "term-1" }),
      );
    } else if (requestedScene === "review") {
      navigation.dispatch(CommonActions.navigate("ThreadReview", params));
    } else {
      navigation.dispatch(selectWorkspaceDetail({ name: "Thread", params }));
    }
  }, [hasFixture, navigation, requestedScene, scene, showcaseThread]);

  useEffect(() => {
    if (scene !== "agent-activity" || !hasFixture || agentActivityStaged) {
      return;
    }
    let cancelled = false;
    let lastOutcome: string | null = null;
    void retryShowcaseOperation(
      async () => {
        const now = Date.now();
        const { threads: latestThreads, projects: latestProjects } = readFixtureEntities();
        const activity = buildShowcaseAgentActivity(latestThreads, latestProjects, now);
        const outcome =
          activity === null
            ? "fixture threads not loaded"
            : await stageShowcaseAgentActivity(activity, now);
        if (outcome === true) return true;
        if (outcome !== lastOutcome)
          console.warn(`[showcase] agent activity not staged: ${outcome}`);
        lastOutcome = outcome;
        return false;
      },
      { isCancelled: () => cancelled, attemptTimeoutMs: 60_000 },
    ).then((staged) => {
      if (!cancelled && staged) setAgentActivityStaged(true);
    });
    return () => {
      cancelled = true;
    };
  }, [agentActivityStaged, hasFixture, scene]);

  const readinessKey = showcaseReadinessKey({
    scene,
    requestedScene,
    hasFixture,
    orientationSettled,
    themeApplied,
    agentActivityStaged,
    themeId,
    renderSignal,
    renderReports,
  });
  // Losing readiness hides the marker. A redraw or theme change while ready keeps it and re-settles.
  if (readinessKey === null && readyScene !== null) setReadyScene(null);

  useEffect(() => {
    if (readinessKey === null || scene === null) return;
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
  }, [readinessKey, scene]);

  if (readyScene === null) return null;
  return (
    <View
      pointerEvents="none"
      testID={`showcase-ready-${readyScene}`}
      style={{ position: "absolute", width: 1, height: 1, opacity: 0.01 }}
    />
  );
}
