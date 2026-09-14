/**
 * Voice-session navigation: approximate discovery opens the correct thread in
 * the attached UI and acknowledges the landing by reading the resulting route.
 *
 * Acknowledgment never trusts the navigation call alone. The TanStack router's
 * missing-thread guard (`_chat.$environmentId.$threadId.tsx`) redirects to `/`
 * asynchronously once route data proves the thread is gone, so the navigator
 * (1) reads the path back after `navigate` resolves, and (2) keeps a bounded
 * watch on subsequent path changes: a late redirect is reported as a
 * navigation failure instead of silent success.
 *
 * The plan's suppression rule lives here too: one pending navigation at a
 * time; a newer request supersedes the older one, which resolves as
 * "superseded" without emitting marks or reporting success.
 */
import type { EnvironmentId, ThreadId, VoiceTimingMark, VoiceToolError } from "@t3tools/contracts";

export interface VoiceNavigationDestination {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Route id of the thread route (`_chat` is a pathless layout, so the URL is
    `/$environmentId/$threadId`; see `__root.tsx`'s programmatic navigate). */
export const THREAD_ROUTE_TO = "/$environmentId/$threadId" as const;

export function expectedThreadRoutePath(destination: VoiceNavigationDestination): string {
  return `/${destination.environmentId}/${destination.threadId}`;
}

/** The slice of the TanStack router the navigator needs. The production
    driver is built from `useNavigate`/`useRouter` inside the voice panel;
    tests inject fakes. */
export interface VoiceRouteDriver {
  navigate(input: {
    readonly to: typeof THREAD_ROUTE_TO;
    readonly params: VoiceNavigationDestination;
    readonly replace?: boolean;
  }): Promise<void>;
  /** The current location pathname, read at call time (never assumed). */
  readCurrentPath(): string;
  /** Location-change subscription used for the bounded late-redirect watch. */
  subscribePathChange(listener: (path: string) => void): () => void;
}

export type VoiceEnvironmentReachability = "unknown" | "disconnected" | "connected";

export interface VoiceNavigatorDeps {
  readonly driver: VoiceRouteDriver;
  /** Catalog-backed reachability: "unknown" = not in the client catalog,
      "disconnected" = known but not connected. */
  readonly reachabilityOf: (environmentId: EnvironmentId) => VoiceEnvironmentReachability;
  /** Mark bus (the live client's emitMark). */
  readonly emitMark: (mark: VoiceTimingMark, detail?: string) => void;
  /** Fired when a route acknowledged as the destination later redirects to
      `/` (thread disappeared between validation and navigation). The
      `navigation_acknowledged` mark has already been emitted at that point
      and is never un-emitted; the UI surfaces the failure instead. */
  readonly onRedirectAfterAcknowledgment?: (error: VoiceToolError) => void;
  /** How long the late-redirect watch stays armed after acknowledgment. */
  readonly redirectWatchMs?: number;
}

export type VoiceNavigationResult =
  | { readonly status: "acknowledged"; readonly destination: VoiceNavigationDestination }
  | { readonly status: "failed"; readonly error: VoiceToolError }
  | { readonly status: "superseded" };

export interface VoiceNavigator {
  navigateToThread(destination: VoiceNavigationDestination): Promise<VoiceNavigationResult>;
  /** Arms-then-fires `first_useful_speech`: the first call after an
      acknowledgment emits the mark once; calls before any acknowledgment and
      repeat calls emit nothing. */
  onOutputTranscriptDelta(): void;
  dispose(): void;
}

const DEFAULT_REDIRECT_WATCH_MS = 2_000;

const threadNotFoundError = (destination: VoiceNavigationDestination): VoiceToolError => ({
  code: "thread_not_found",
  message: `Thread "${destination.threadId}" is not reachable in the attached UI; the route redirected away.`,
  environmentId: destination.environmentId,
  threadId: destination.threadId,
});

export function createVoiceNavigator(deps: VoiceNavigatorDeps): VoiceNavigator {
  const redirectWatchMs = deps.redirectWatchMs ?? DEFAULT_REDIRECT_WATCH_MS;
  let token = 0;
  let awaitingFirstSpeech = false;
  let acknowledgedDestination: VoiceNavigationDestination | undefined;
  let pathWatchUnsubscribe: (() => void) | undefined;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;

  const clearWatch = () => {
    pathWatchUnsubscribe?.();
    pathWatchUnsubscribe = undefined;
    if (watchTimer !== undefined) {
      clearTimeout(watchTimer);
      watchTimer = undefined;
    }
  };

  /** The late redirect always lands on `/` (the route's missing-thread
      effect), so the failure shape is fixed; the acknowledged destination is
      carried by the closure for its identity fields. */
  const armRedirectWatch = (myToken: number) => {
    clearWatch();
    pathWatchUnsubscribe = deps.driver.subscribePathChange((path) => {
      if (myToken !== token) {
        clearWatch();
        return;
      }
      if (path === "/" && acknowledgedDestination !== undefined) {
        clearWatch();
        deps.onRedirectAfterAcknowledgment?.(threadNotFoundError(acknowledgedDestination));
      }
    });
    watchTimer = setTimeout(() => {
      clearWatch();
    }, redirectWatchMs);
  };

  const navigateToThread = async (
    destination: VoiceNavigationDestination,
  ): Promise<VoiceNavigationResult> => {
    token += 1;
    const myToken = token;
    clearWatch();
    acknowledgedDestination = undefined;

    const reachability = deps.reachabilityOf(destination.environmentId);
    if (reachability === "unknown") {
      return {
        status: "failed",
        error: {
          code: "environment_not_in_catalog",
          message: `Environment "${destination.environmentId}" is not in this client's connection catalog.`,
          environmentId: destination.environmentId,
        },
      };
    }
    if (reachability === "disconnected") {
      return {
        status: "failed",
        error: {
          code: "environment_unreachable",
          message: `Environment "${destination.environmentId}" is not connected, so its thread cannot be opened here.`,
          environmentId: destination.environmentId,
        },
      };
    }

    await deps.driver.navigate({
      to: THREAD_ROUTE_TO,
      params: destination,
      replace: true,
    });
    if (myToken !== token) {
      return { status: "superseded" };
    }

    // Read the resulting route back; never assume the navigation landed.
    const path = deps.driver.readCurrentPath();
    if (path === "/") {
      return { status: "failed", error: threadNotFoundError(destination) };
    }
    if (path !== expectedThreadRoutePath(destination)) {
      return {
        status: "failed",
        error: {
          code: "invalid_request",
          message: `Navigation landed on "${path}" instead of the requested thread route.`,
        },
      };
    }

    acknowledgedDestination = destination;
    deps.emitMark(
      "navigation_acknowledged",
      `${destination.environmentId}/${destination.threadId}`,
    );
    awaitingFirstSpeech = true;
    armRedirectWatch(myToken);
    return { status: "acknowledged", destination };
  };

  return {
    navigateToThread,
    onOutputTranscriptDelta: () => {
      if (!awaitingFirstSpeech) {
        return;
      }
      awaitingFirstSpeech = false;
      deps.emitMark("first_useful_speech");
    },
    dispose: clearWatch,
  };
}
