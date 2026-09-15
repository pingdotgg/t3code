/**
 * Voice-session navigation: approximate discovery opens the correct thread in
 * the attached UI and acknowledges the landing by reading the resulting route.
 *
 * Acknowledgment never trusts the navigation call alone. The thread route's
 * missing-thread guard (`_chat.$environmentId.$threadId.tsx`) redirects to `/`
 * asynchronously once route data proves the thread is gone, so the navigator
 * (1) reads the path back after `navigate` resolves, and (2) stays armed for
 * the guard's authoritative missing-thread redirect: a redirect carrying the
 * acknowledged destination's provenance is reported as a navigation failure
 * instead of silent success, however late it lands. User-initiated navigation
 * carries no provenance and is never reported.
 *
 * The plan's suppression rule lives here too: one pending navigation at a
 * time; a newer request supersedes the older one, which resolves as
 * "superseded" without emitting marks or reporting success.
 */
import type { EnvironmentId, ThreadId, VoiceTimingMark, VoiceToolError } from "@t3tools/contracts";

import type { MissingThreadRedirect } from "../missingThreadRedirects";

export interface VoiceNavigationDestination {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** A guard redirect is provenance for exactly one destination. */
export type VoiceMissingThreadRedirect = MissingThreadRedirect;

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
  /** Authoritative missing-thread redirect provenance, fired only by the
      thread route's guard when route data proves a thread gone. */
  subscribeMissingThreadRedirect(
    listener: (redirect: VoiceMissingThreadRedirect) => void,
  ): () => void;
  /** Provenance high-water mark and since-query over the guard's retained
      recent redirects. Optional so test drivers without the seam stay valid;
      the navigator uses them to catch a provenance event recorded while a
      navigation was still pending (before the post-acknowledgment watch
      armed) whose route transition commits after a successful-looking path
      read-back. */
  currentMissingThreadRedirectSeq?(): number;
  hasMissingThreadRedirectSince?(
    destination: VoiceNavigationDestination,
    sinceSeq: number,
  ): boolean;
}

export type VoiceEnvironmentReachability = "unknown" | "disconnected" | "connected";

export interface VoiceNavigatorDeps {
  readonly driver: VoiceRouteDriver;
  /** Catalog-backed reachability: "unknown" = not in the client catalog,
      "disconnected" = known but not connected. */
  readonly reachabilityOf: (environmentId: EnvironmentId) => VoiceEnvironmentReachability;
  /** Mark bus (the live client's emitMark). */
  readonly emitMark: (mark: VoiceTimingMark, detail?: string) => void;
  /** Fired when a route acknowledged as the destination is later proven
      missing by the guard's redirect. The `navigation_acknowledged` mark has
      already been emitted at that point and is never un-emitted; the UI
      surfaces the failure instead. */
  readonly onRedirectAfterAcknowledgment?: (error: VoiceToolError) => void;
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

const threadNotFoundError = (destination: VoiceNavigationDestination): VoiceToolError => ({
  code: "thread_not_found",
  message: `Thread "${destination.threadId}" is not reachable in the attached UI; the route redirected away.`,
  environmentId: destination.environmentId,
  threadId: destination.threadId,
});

export function createVoiceNavigator(deps: VoiceNavigatorDeps): VoiceNavigator {
  let token = 0;
  let awaitingFirstSpeech = false;
  let acknowledgedDestination: VoiceNavigationDestination | undefined;
  let redirectUnsubscribe: (() => void) | undefined;

  const clearRedirectWatch = () => {
    redirectUnsubscribe?.();
    redirectUnsubscribe = undefined;
  };

  /** Armed from acknowledgment until it fires, a newer navigation replaces
      it, or dispose. There is no timer: the guard's provenance-matched
      redirect is the only trigger, so neither user navigation nor elapsed
      time can produce a false or missed report. */
  const armRedirectWatch = () => {
    clearRedirectWatch();
    redirectUnsubscribe = deps.driver.subscribeMissingThreadRedirect((redirect) => {
      if (acknowledgedDestination === undefined) {
        return;
      }
      if (
        redirect.environmentId !== acknowledgedDestination.environmentId ||
        redirect.threadId !== acknowledgedDestination.threadId
      ) {
        return;
      }
      clearRedirectWatch();
      deps.onRedirectAfterAcknowledgment?.(threadNotFoundError(acknowledgedDestination));
    });
  };

  const navigateToThread = async (
    destination: VoiceNavigationDestination,
  ): Promise<VoiceNavigationResult> => {
    token += 1;
    const myToken = token;
    clearRedirectWatch();
    acknowledgedDestination = undefined;
    // Provenance recorded between this mark and the acknowledgment is
    // checked below: the live subscription only arms at acknowledgment, so
    // an event fired while this navigation was pending would otherwise be
    // lost if its route transition commits after the path read-back.
    const provenanceSeq = deps.driver.currentMissingThreadRedirectSeq?.() ?? 0;

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
    // The path read-back can still show the thread route while the guard has
    // already proven it missing (record + redirect mid-transition). The
    // guard's verdict outranks the transient read-back.
    if (deps.driver.hasMissingThreadRedirectSince?.(destination, provenanceSeq) === true) {
      return { status: "failed", error: threadNotFoundError(destination) };
    }

    acknowledgedDestination = destination;
    deps.emitMark(
      "navigation_acknowledged",
      `${destination.environmentId}/${destination.threadId}`,
    );
    awaitingFirstSpeech = true;
    armRedirectWatch();
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
    dispose: clearRedirectWatch,
  };
}
