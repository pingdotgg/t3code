import { useSyncExternalStore } from "react";
import { Appearance, Keyboard, View } from "react-native";
import {
  CommonActions,
  StackActions,
  type NavigationAction,
  type NavigationState,
} from "@react-navigation/native";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";

import { connectPairingUrl } from "../../connection/onboarding";
import {
  createMobileThemePairPatch,
  resolveMobileThemeIds,
  type MobileThemeId,
} from "../../lib/mobileTheme";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentProjects } from "../../state/projects";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { environmentThreadShells } from "../../state/threads";
import { holdEditingQueuedMessage } from "../../state/use-thread-outbox";
import { workspaceConnections } from "../../state/workspace";
import { resolveThemeAppearance } from "../settings/appearance/AppearancePreferencesProvider";
import {
  applyNativeShowcaseOrientation,
  getNativeShowcaseOrientation,
  getNativeShowcasePairingUrls,
  getNativeShowcaseScene,
  getNativeShowcaseTheme,
  markNativeShowcaseReady,
  type ShowcaseScene,
} from "./nativeShowcaseScene";
import { buildShowcaseAgentActivity } from "./showcaseAgentActivity";
import {
  isShowcaseThemeApplied,
  SHOWCASE_THREAD_ID,
  showcaseReadinessKey,
  showcaseSceneOnScreen,
  shouldNavigateToShowcaseScene,
  type ShowcaseNavigationTarget,
} from "./showcaseCaptureModel";
import {
  buildShowcasePendingTasks,
  SHOWCASE_PENDING_TASK_DEFINITIONS,
} from "./showcasePendingTasks";
import {
  clearShowcaseRenderSignal,
  getShowcaseRenderSnapshot,
  subscribeToShowcaseRenderSignal,
} from "./showcaseRenderSignal";
import { retryShowcaseOperation } from "./showcaseRetry";
import { stageShowcaseAgentActivity } from "./stageShowcaseAgentActivity";
import { settingsNavigationState } from "../settings/settings-navigation";
import { selectWorkspaceDetail } from "../workspace/workspace-detail-selection";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";
// Native launch requests (pairing links, scene switches) have no change event.
const NATIVE_POLL_MS = 250;
const READY_SETTLE_MS = 500;

const readySceneListeners = new Set<() => void>();
let readyScene: ShowcaseScene | null = null;

function setReadyScene(scene: ShowcaseScene | null): void {
  if (readyScene === scene) return;
  readyScene = scene;
  for (const listener of readySceneListeners) listener();
}

function subscribeToReadyScene(listener: () => void): () => void {
  readySceneListeners.add(listener);
  return () => readySceneListeners.delete(listener);
}

function getReadyScene(): ShowcaseScene | null {
  return readyScene;
}

interface Run {
  cancelled: boolean;
  done: boolean;
}

function cancelRun(run: Run | null): null {
  if (run) run.cancelled = true;
  return null;
}

function showcaseNavigationAction(
  scene: ShowcaseScene,
  environmentId: string,
  rootState: NavigationState,
): NavigationAction {
  const params = { environmentId, threadId: SHOWCASE_THREAD_ID };
  switch (scene) {
    case "threads":
      return StackActions.popToTop();
    case "agent-activity":
      return CommonActions.reset({ index: 0, routes: [{ name: "Home" }] });
    case "environments":
      return CommonActions.reset(settingsNavigationState(rootState, "SettingsEnvironments"));
    case "terminal":
      return CommonActions.navigate("ThreadTerminal", { ...params, terminalId: "term-1" });
    case "review":
      return CommonActions.navigate("ThreadReview", params);
    case "thread":
      return selectWorkspaceDetail({ name: "Thread", params });
  }
}

/**
 * Drives a showcase capture: pairs servers, seeds the fixture, applies theme and
 * orientation, and navigates to each scene the native harness requests. Inputs
 * are read from their stores on each step, so nothing depends on render timing.
 */
export function installShowcaseCapture(
  pathnameFromState: (state: NavigationState) => string,
): () => void {
  if (!SHOWCASE_ENABLED) return () => {};

  let disposed = false;
  let launchRequestRead = false;
  let requestedTheme: MobileThemeId | null = null;
  let orientationSettled = false;
  let requestedScene: ShowcaseScene | null = null;
  let pendingTasks: Run | null = null;
  let agentActivity: Run | null = null;
  let lastNavigation: ShowcaseNavigationTarget | null = null;
  let readiness: { key: string; cancel: () => void } | null = null;
  const isCancelled = (run?: Run) => () => disposed || run?.cancelled === true;

  const devMenu = requireOptionalNativeModule<{
    closeMenu(): void;
    setToolsButtonVisible(visible: boolean): void;
  }>("ExpoDevMenu");
  // The dev menu can open after bundle loading and block orientation requests.
  const devMenuTimer = setInterval(() => {
    devMenu?.closeMenu();
    devMenu?.setToolsButtonVisible(false);
  }, 1_000);

  const orientation = getNativeShowcaseOrientation();
  if (orientation === null) {
    orientationSettled = true;
  } else {
    void retryShowcaseOperation(async () => applyNativeShowcaseOrientation(orientation), {
      isCancelled: isCancelled(),
    }).then((applied) => {
      if (!applied) return;
      orientationSettled = true;
      evaluate();
    });
  }

  const pair = (pairingUrls: ReadonlyArray<string>) => {
    for (const pairingUrl of pairingUrls) {
      void retryShowcaseOperation(
        async () =>
          AsyncResult.isSuccess(
            await runAtomCommand(
              appAtomRegistry,
              connectPairingUrl,
              { pairingUrl },
              { reportFailure: false },
            ),
          ),
        { isCancelled: isCancelled() },
      );
    }
  };

  const readNativeRequests = () => {
    if (!launchRequestRead) {
      const pairingUrls = getNativeShowcasePairingUrls();
      if (pairingUrls.length > 0) {
        launchRequestRead = true;
        requestedTheme = getNativeShowcaseTheme();
        pair(pairingUrls);
      }
    }
    const scene = getNativeShowcaseScene();
    if (scene && scene !== requestedScene) {
      requestedScene = scene;
      // Draws belong to their scene request; revisiting review must wait for its new surface.
      clearShowcaseRenderSignal();
      agentActivity = cancelRun(agentActivity);
    }
  };

  const seedPendingTasks = () => {
    const pendingTaskList = buildShowcasePendingTasks(
      appAtomRegistry.get(environmentProjects.projectsAtom),
      Date.now(),
    );
    if (pendingTaskList.length !== SHOWCASE_PENDING_TASK_DEFINITIONS.length) return;
    const run: Run = { cancelled: false, done: false };
    pendingTasks = run;
    for (const task of pendingTaskList) holdEditingQueuedMessage(task.messageId);
    void Promise.all(
      pendingTaskList.map((task) =>
        retryShowcaseOperation(
          async () => {
            await enqueueThreadOutboxMessage(task);
            return true;
          },
          { isCancelled: isCancelled(run) },
        ),
      ),
    ).then((results) => {
      if (run.cancelled || !results.every(Boolean)) return;
      run.done = true;
      evaluate();
    });
  };

  const stageAgentActivity = () => {
    const run: Run = { cancelled: false, done: false };
    agentActivity = run;
    let lastOutcome: string | null = null;
    void retryShowcaseOperation(
      async () => {
        const now = Date.now();
        const activity = buildShowcaseAgentActivity(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          appAtomRegistry.get(environmentProjects.projectsAtom),
          now,
        );
        const outcome =
          activity === null
            ? "fixture threads not loaded"
            : await stageShowcaseAgentActivity(activity, now);
        if (outcome === true) return true;
        if (outcome !== lastOutcome) {
          console.warn(`[showcase] agent activity not staged: ${outcome}`);
        }
        lastOutcome = outcome;
        return false;
      },
      { isCancelled: isCancelled(run), attemptTimeoutMs: 60_000 },
    ).then((staged) => {
      if (run.cancelled || !staged) return;
      run.done = true;
      evaluate();
    });
  };

  const updateReadiness = (key: string | null, scene: ShowcaseScene | null) => {
    if (readiness?.key === key) return;
    readiness?.cancel();
    readiness = null;
    if (key === null || scene === null) {
      setReadyScene(null);
      return;
    }
    if (scene === "terminal") Keyboard.dismiss();
    let frame: number | null = null;
    // Two frames after the settle delay so the scene has been drawn, not just committed.
    const settleTimer = setTimeout(() => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = null;
          markNativeShowcaseReady(scene);
          setReadyScene(scene);
        });
      });
    }, READY_SETTLE_MS);
    readiness = {
      key,
      cancel: () => {
        clearTimeout(settleTimer);
        if (frame !== null) cancelAnimationFrame(frame);
      },
    };
  };

  const step = () => {
    readNativeRequests();

    const preferences = appAtomRegistry.get(mobilePreferencesAtom);
    const storedPreferences = AsyncResult.isSuccess(preferences) ? preferences.value : null;
    const themeIds = resolveMobileThemeIds(storedPreferences ?? {});
    const themeApplied = isShowcaseThemeApplied({ launchRequestRead, requestedTheme, themeIds });
    // The write patches preferences optimistically, so the step it triggers
    // already sees the theme applied. A failed save rolls the patch back, and
    // the next step writes again.
    if (requestedTheme !== null && !themeApplied && storedPreferences) {
      appAtomRegistry.set(updateMobilePreferencesAtom, createMobileThemePairPatch(requestedTheme));
    }
    const themeId = themeIds[resolveThemeAppearance(storedPreferences)];

    const projects = appAtomRegistry.get(environmentProjects.projectsAtom);
    const threads = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
    const showcaseThread = threads.find((thread) => String(thread.id) === SHOWCASE_THREAD_ID);
    const hasServerFixture =
      appAtomRegistry.get(workspaceConnections.stateAtom).hasReadyEnvironment &&
      appAtomRegistry.get(workspaceConnections.environmentsAtom).length >= 3 &&
      projects.length >= 3 &&
      showcaseThread !== undefined;
    if (hasServerFixture && pendingTasks === null) seedPendingTasks();
    const hasFixture = hasServerFixture && pendingTasks?.done === true;

    const navigationReady = rootNavigationRef.isReady();
    const rootState = navigationReady ? rootNavigationRef.getRootState() : undefined;
    const scene = rootState
      ? showcaseSceneOnScreen(requestedScene, pathnameFromState(rootState))
      : null;

    if (requestedScene !== null && hasFixture && showcaseThread && rootState) {
      const navigation = { requestedScene, scene, thread: showcaseThread };
      // Arriving forgets the target, so leaving the scene again navigates back.
      if (scene === requestedScene) {
        lastNavigation = null;
      } else if (shouldNavigateToShowcaseScene(lastNavigation, navigation)) {
        lastNavigation = navigation;
        rootNavigationRef.dispatch({
          ...showcaseNavigationAction(
            requestedScene,
            String(showcaseThread.environmentId),
            rootState,
          ),
          target: rootState.key,
        });
      }
    }

    if (scene === "agent-activity" && hasFixture) {
      if (agentActivity === null) stageAgentActivity();
    } else if (agentActivity?.done === false) {
      agentActivity = cancelRun(agentActivity);
    }

    const render = getShowcaseRenderSnapshot();
    updateReadiness(
      showcaseReadinessKey({
        scene,
        requestedScene,
        hasFixture,
        orientationSettled,
        themeApplied,
        agentActivityStaged: agentActivity?.done === true,
        themeId,
        renderSignal: render.signal,
        renderReports: render.reports,
      }),
      scene,
    );
  };

  // Steps write atoms they also observe; a nested change reruns the step once
  // the current one finishes instead of interleaving with it.
  let stepping = false;
  let stepAgain = false;
  function evaluate() {
    if (disposed) return;
    if (stepping) {
      stepAgain = true;
      return;
    }
    stepping = true;
    try {
      do {
        stepAgain = false;
        step();
      } while (stepAgain);
    } finally {
      stepping = false;
    }
  }

  const unsubscribers = [
    appAtomRegistry.subscribe(mobilePreferencesAtom, evaluate),
    appAtomRegistry.subscribe(environmentProjects.projectsAtom, evaluate),
    appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, evaluate),
    appAtomRegistry.subscribe(workspaceConnections.stateAtom, evaluate),
    appAtomRegistry.subscribe(workspaceConnections.environmentsAtom, evaluate),
    subscribeToShowcaseRenderSignal(evaluate),
    rootNavigationRef.addListener("state", evaluate),
  ];
  const appearanceSubscription = Appearance.addChangeListener(evaluate);
  const pollTimer = setInterval(evaluate, NATIVE_POLL_MS);
  evaluate();

  return () => {
    disposed = true;
    clearInterval(devMenuTimer);
    clearInterval(pollTimer);
    appearanceSubscription.remove();
    for (const unsubscribe of unsubscribers) unsubscribe();
    pendingTasks = cancelRun(pendingTasks);
    agentActivity = cancelRun(agentActivity);
    readiness?.cancel();
    readiness = null;
    setReadyScene(null);
  };
}

/** The capture harness waits for this marker before taking a screenshot. */
export function ShowcaseReadyMarker() {
  const scene = useSyncExternalStore(subscribeToReadyScene, getReadyScene, getReadyScene);
  if (scene === null) return null;
  return (
    <View
      pointerEvents="none"
      testID={`showcase-ready-${scene}`}
      style={{ position: "absolute", width: 1, height: 1, opacity: 0.01 }}
    />
  );
}
