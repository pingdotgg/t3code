/**
 * Capture to chat. The header's capture buttons screenshot the held session
 * (`page`) or run the in-page element picker (`element`) through the host's
 * `t3.browser/capture` capability, then insert the native annotation and crop
 * through `t3.composer/context` `insertPreviewAnnotation` on current hosts.
 * Page captures and older hosts use `insertImage`. Only opaque references
 * move between them; the image bytes and native pick stay on the client.
 */
import {
  composerContextApi,
  BROWSER_ANNOTATION_MIN_VERSION,
  uiNotificationsApi,
  type BrowserCaptureArtifact,
  type BrowserCaptureArtifactActionFailureReason,
  type BrowserCaptureArtifactActionRequest,
  type BrowserCaptureFailureReason,
  type BrowserCaptureHost,
  type BrowserCaptureResult,
  type BrowserCaptureTarget,
  type BrowserSurfaceLeaseState,
} from "@t3tools/extension-sdk/catalogue";
import {
  bindApi,
  grantDenialMessage,
  type ApiClient,
  type ApiDiscovery,
} from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import { useRef, useState } from "react";

import type { BoundApi } from "./uiContracts.ts";

export interface CaptureSessionRef {
  readonly tabId: string;
  readonly serverEpoch: string;
}

/** Whether this panel shows the held page, as native gates its capture buttons. */
export type CapturePageView = "shown" | "hidden" | "failed";

/**
 * Whether the page is on screen here. Only a lease the host composites and
 * whose slot last presented visible counts — an active lease stays active
 * while its slot is clipped away or occluded.
 */
export function capturePageView(
  lease: { readonly state: BrowserSurfaceLeaseState } | null,
  presentedVisible: boolean,
  navigation: string | undefined,
): CapturePageView {
  if (lease?.state.kind !== "active" || !lease.state.presentation.supported || !presentedVisible)
    return "hidden";
  return navigation === "failed" ? "failed" : "shown";
}

/** Why capture cannot run, or null when it can. */
export function captureUnavailableReason(
  host: Pick<ClientHost, "browserCapture">,
  held: CaptureSessionRef | null,
  threadId: string | undefined,
  page: CapturePageView = "shown",
): string | null {
  if (threadId === undefined) return "This panel has no thread, so there is no chat to add to.";
  if (!host.browserCapture) return "This host cannot capture browser sessions.";
  if (!host.browserCapture.support.supported)
    return "Capturing needs the T3 Code desktop app, where the page renders.";
  if (held === null) return "Open a page to capture it.";
  if (page === "hidden") return "The page is not shown here yet — capture once it renders.";
  if (page === "failed") return "Page didn't load — pick unavailable until the page renders";
  return null;
}

/**
 * Where a failed run stopped: `request` before any image existed (the host
 * refused, or the picker or engine threw), `image` when the pixels were lost
 * (the engine or picker kept no image, or the store refused it), `insert`
 * when the stored image could not be added to the draft.
 */
export type CaptureFailureStage = "request" | "image" | "insert";

/**
 * The annotate button, worded as native's PreviewChromeRow. While picking it
 * is Cancel annotation, so it stays enabled. A failed page blocks capture
 * (`blockReason`), and its tooltip then gives that reason — the one disabled
 * control that stays hoverable.
 */
export function annotationControl(input: {
  readonly blockReason: string | null;
  readonly capturing: BrowserCaptureTarget | null;
  readonly pageFailed: boolean;
}): {
  readonly disabled: boolean;
  readonly picking: boolean;
  readonly ariaLabel: string;
  readonly tooltip: string;
  readonly hoverWhileDisabled: boolean;
} {
  const picking = input.capturing === "element";
  const disabled = !picking && (input.blockReason !== null || input.capturing !== null);
  return {
    disabled,
    picking,
    ariaLabel: picking ? "Cancel annotation" : "Annotate preview",
    tooltip:
      disabled && input.pageFailed && input.blockReason !== null
        ? input.blockReason
        : picking
          ? "Cancel annotation (Esc)"
          : "Annotate elements, regions, and drawings",
    hoverWhileDisabled: input.pageFailed,
  };
}

export type CaptureToChatOutcome =
  | {
      readonly kind: "annotated";
      readonly imageInserted: boolean;
      readonly screenshotFailed: boolean;
    }
  | {
      readonly kind: "added";
      readonly artifact: BrowserCaptureArtifact;
      readonly inserted: boolean;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly stage: CaptureFailureStage; readonly message: string };

const IMAGE_LOST_REASONS: ReadonlySet<BrowserCaptureFailureReason> = new Set([
  "capture-failed",
  "too-large",
  "upload-failed",
]);

const annotationSupport = new WeakMap<
  ClientHost["discoverApis"],
  WeakMap<ViewContext, Promise<boolean>>
>();

function supportsAnnotationComposer(
  host: Partial<Pick<ClientHost, "discoverApis">>,
  context: ViewContext,
  signal: AbortSignal,
) {
  const discover = host.discoverApis;
  if (!discover) return Promise.resolve(false);
  let scopes = annotationSupport.get(discover);
  if (!scopes) {
    scopes = new WeakMap();
    annotationSupport.set(discover, scopes);
  }
  const cached = scopes.get(context);
  if (cached) return cached;
  const support = discover(context, signal).then((apis) =>
    apis.some(
      (api) =>
        api.id === composerContextApi.definition.id && satisfiesSemverRange(api.version, "^1.3.0"),
    ),
  );
  scopes.set(context, support);
  void support.catch(() => scopes.delete(context));
  return support;
}

/**
 * One capture-then-insert run. Every failure comes back as a named message;
 * an abort of `signal` at any stage, even after the image is stored, is a
 * silent cancel.
 */
export async function captureToChat(
  host: Pick<ClientHost, "browserCapture" | "invokeApi"> &
    Partial<Pick<ClientHost, "discoverApis">>,
  context: ViewContext,
  held: CaptureSessionRef,
  target: BrowserCaptureTarget,
  signal: AbortSignal,
): Promise<CaptureToChatOutcome> {
  const threadId = context.resource.threadId;
  if (!host.browserCapture || threadId === undefined)
    return {
      kind: "failed",
      stage: "request",
      message: "This host cannot capture browser sessions.",
    };
  let captured: BrowserCaptureResult;
  let composerSupported = false;
  try {
    composerSupported =
      target === "element" && (await supportsAnnotationComposer(host, context, signal));
    signal.throwIfAborted();
    captured = await host.browserCapture.capture({
      context,
      session: held,
      target,
      signal,
      ...(composerSupported &&
      satisfiesSemverRange(host.browserCapture.version, `^${BROWSER_ANNOTATION_MIN_VERSION}`)
        ? { annotation: true }
        : {}),
    });
  } catch (error) {
    if (signal.aborted) return { kind: "cancelled" };
    return {
      kind: "failed",
      stage: "request",
      message: `Capture failed: ${error instanceof Error ? error.message : "the host threw"}`,
    };
  }
  // Cancel wins over whatever the host settled with: an upload that fails or
  // succeeds after Cancel annotation is still a silent cancel.
  if (signal.aborted) return { kind: "cancelled" };
  if (target === "element" && captured.annotationRef && composerSupported) {
    try {
      const inserted = await bindApi(composerContextApi, host, context, "^1.3.0").invoke(
        "insertPreviewAnnotation",
        { threadId, annotationRef: captured.annotationRef },
        signal,
      );
      if (signal.aborted) return { kind: "cancelled" };
      return {
        kind: "annotated",
        imageInserted: inserted.imageInserted,
        screenshotFailed: inserted.screenshotFailed,
      };
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      return {
        kind: "failed",
        stage: "insert",
        message: `The annotation could not be added to chat: ${error instanceof Error ? error.message : "the composer refused it"}`,
      };
    }
  }
  if (!captured.ok) {
    if (captured.failure.reason === "cancelled") return { kind: "cancelled" };
    return {
      kind: "failed",
      stage: IMAGE_LOST_REASONS.has(captured.failure.reason) ? "image" : "request",
      message: captured.failure.grant
        ? `Capture failed — ${grantDenialMessage(captured.failure.grant)}`
        : `Capture failed — ${captured.failure.reason}: ${captured.failure.detail}`,
    };
  }
  if (!captured.artifact)
    return {
      kind: "failed",
      stage: "insert",
      message: "The annotation could not be added to chat.",
    };
  try {
    const result = await bindApi(composerContextApi, host, context).invoke(
      "insertImage",
      { threadId, artifactRef: captured.artifact.artifactRef },
      signal,
    );
    return { kind: "added", artifact: captured.artifact, inserted: result.inserted };
  } catch (error) {
    if (signal.aborted) return { kind: "cancelled" };
    return {
      kind: "failed",
      stage: "insert",
      message: `Captured, but it could not be added to chat: ${
        error instanceof Error ? error.message : "the composer refused it"
      }`,
    };
  }
}

/**
 * Native toasts a pick only when it loses its image. A pick the host refused
 * (grant-denied, busy, not-presented) has no native toast, so it stays on the
 * status line; a dismissed or throwing picker arrives as `cancelled`.
 */
function isInlineOnlyFailure(target: BrowserCaptureTarget, stage: CaptureFailureStage): boolean {
  return target === "element" && stage === "request";
}

/** Status line text for an outcome; null clears the line. */
export function captureOutcomeMessage(
  target: BrowserCaptureTarget,
  outcome: CaptureToChatOutcome,
): string | null {
  switch (outcome.kind) {
    case "annotated":
      return outcome.screenshotFailed
        ? "The annotation was kept without the screenshot."
        : "Annotation added to chat.";
    case "cancelled":
      return null;
    case "failed":
      return outcome.message;
    case "added": {
      const what = outcome.artifact.target === "page" ? "Page screenshot" : "Element capture";
      return outcome.inserted ? `${what} added to chat.` : `${what} is already in chat.`;
    }
  }
}

/** Native toasts use the toast manager's default lifetime. */
export const CAPTURE_TOAST_DURATION_MS = 5_000;
/** How long a copy action reads "Copied!", like native. */
export const CAPTURE_COPIED_FLASH_MS = 2_000;

export type CaptureToastActionId = "copy-image" | "copy-path" | "reveal";

export interface CaptureToastAction {
  readonly id: CaptureToastActionId;
  readonly label: string;
  readonly variant?: "primary";
  readonly keepOpen: true;
}

export interface CaptureToast {
  readonly severity: "success" | "error";
  readonly title: string;
  readonly body?: string;
  readonly durationMs: number;
  readonly actions?: readonly CaptureToastAction[];
}

/**
 * Native's "Screenshot saved" actions this host can run, in native's order:
 * outline Copy path and Reveal, then the primary Copy image. Every click keeps
 * the toast open. Empty on a 1.0.0 host or a client without saved captures.
 */
export function captureToastActions(
  capture: Pick<
    BrowserCaptureHost,
    "artifactActions" | "copyArtifactToClipboard" | "copyArtifactPath" | "revealArtifact"
  > | null,
): readonly CaptureToastAction[] {
  const support = capture?.artifactActions;
  if (!capture || !support) return [];
  const actions: CaptureToastAction[] = [];
  if (support.copyPath.supported && capture.copyArtifactPath)
    actions.push({ id: "copy-path", label: "Copy path", keepOpen: true });
  if (support.reveal.supported && capture.revealArtifact)
    actions.push({ id: "reveal", label: support.revealLabel, keepOpen: true });
  if (support.copyImage.supported && capture.copyArtifactToClipboard)
    actions.push({ id: "copy-image", label: "Copy image", variant: "primary", keepOpen: true });
  return actions;
}

/**
 * The toast native `PreviewView` raises for the same outcome, or null where
 * native stays silent. Titles are native's verbatim: a page capture toasts
 * "Screenshot saved" / "Unable to capture screenshot"; a pick toasts only when
 * it loses its image ("Could not capture the picked element"). `actions`
 * ride only on "Screenshot saved", as in native.
 */
export function captureOutcomeToast(
  target: BrowserCaptureTarget,
  outcome: CaptureToChatOutcome,
  actions: readonly CaptureToastAction[] = [],
): CaptureToast | null {
  switch (outcome.kind) {
    case "annotated":
      return outcome.screenshotFailed
        ? {
            severity: "error",
            title: "Could not capture the picked element",
            body: "The annotation was kept without the screenshot.",
            durationMs: CAPTURE_TOAST_DURATION_MS,
          }
        : null;
    case "cancelled":
      return null;
    case "failed":
      if (isInlineOnlyFailure(target, outcome.stage)) return null;
      return {
        severity: "error",
        title:
          target === "page"
            ? "Unable to capture screenshot"
            : "Could not capture the picked element",
        body: outcome.message,
        durationMs: CAPTURE_TOAST_DURATION_MS,
      };
    case "added":
      if (target !== "page") return null;
      return {
        severity: "success",
        title: "Screenshot saved",
        durationMs: CAPTURE_TOAST_DURATION_MS,
        ...(actions.length > 0 ? { actions } : {}),
      };
  }
}

type Notifications = BoundApi<typeof uiNotificationsApi>;

/**
 * The toast body for a copy the host refused. Host details can name the
 * saved file's absolute path, so the pack words every reason itself.
 */
function copyFailureBody(
  reason: BrowserCaptureArtifactActionFailureReason,
  kind: "screenshot" | "recording",
): string {
  switch (reason) {
    case "artifact-not-found":
      return kind === "recording"
        ? "This recording is no longer available to copy."
        : "This screenshot is no longer available to copy.";
    case "desktop-required":
      return kind === "recording"
        ? "Saved recordings live in the T3 Code desktop app."
        : "Saved screenshots live in the T3 Code desktop app.";
    case "grant-denied":
    case "scope-invalid":
    case "host-unavailable":
      return kind === "recording"
        ? "This panel can no longer reach the saved recording."
        : "This panel can no longer reach the saved screenshot.";
    case "action-failed":
      return kind === "recording"
        ? "The saved recording could not be copied."
        : "The saved screenshot could not be copied.";
  }
}

/**
 * Runs one clicked action the way native's toast does: a copy that lands
 * reads "Copied!" for 2 s on a restored "Screenshot saved"; a copy that fails
 * turns the toast into the error native shows; reveal reports nothing.
 */
export async function runCaptureToastAction(
  notifications: Notifications,
  capture: Pick<
    BrowserCaptureHost,
    "copyArtifactToClipboard" | "copyArtifactPath" | "revealArtifact"
  >,
  request: BrowserCaptureArtifactActionRequest,
  notificationId: string,
  actionId: string,
  signal: AbortSignal,
  kind: "screenshot" | "recording" = "screenshot",
): Promise<void> {
  if (actionId === "reveal") {
    await capture.revealArtifact?.(request);
    return;
  }
  const copy =
    actionId === "copy-image"
      ? { run: capture.copyArtifactToClipboard, failTitle: "Unable to copy screenshot" }
      : actionId === "copy-path"
        ? {
            run: capture.copyArtifactPath,
            failTitle:
              kind === "recording"
                ? "Unable to copy recording path"
                : "Unable to copy screenshot path",
          }
        : null;
  if (!copy?.run) return;
  const result = await copy.run(request);
  if (signal.aborted) return;
  await notifications.invoke(
    "update",
    result.ok
      ? {
          notificationId,
          severity: "success",
          title: kind === "recording" ? "Recording saved" : "Screenshot saved",
          body: "",
          flashAction: { actionId, label: "Copied!", durationMs: CAPTURE_COPIED_FLASH_MS },
        }
      : {
          notificationId,
          severity: "error",
          title: copy.failTitle,
          body: copyFailureBody(result.failure.reason, kind),
        },
    signal,
  );
}

/**
 * Serves a "Screenshot saved" toast's clicks until it closes. Each click runs
 * on its own, so a slow copy never swallows the next one.
 */
export async function serveCaptureToastActions(
  notifications: Notifications,
  capture: Pick<
    BrowserCaptureHost,
    "copyArtifactToClipboard" | "copyArtifactPath" | "revealArtifact"
  >,
  request: BrowserCaptureArtifactActionRequest,
  notificationId: string,
  signal: AbortSignal,
  kind: "screenshot" | "recording" = "screenshot",
): Promise<void> {
  while (!signal.aborted) {
    let outcome;
    try {
      outcome = await notifications.invoke("awaitAction", { notificationId }, signal);
    } catch {
      return;
    }
    if (!("actionId" in outcome)) return;
    void runCaptureToastAction(
      notifications,
      capture,
      request,
      notificationId,
      outcome.actionId,
      signal,
      kind,
    ).catch(() => {});
  }
}

/** How long notify may take to acknowledge before delivery counts as unknown. */
export const NOTIFY_ACK_TIMEOUT_MS = 5_000;

export interface CaptureReport {
  /** Status line text owed now: the message when no toast carries it. */
  readonly inline: string | null;
  /**
   * Resolves the status line text owed once notify settles: the message only
   * when the toast definitely did not land (notify rejected before its ack
   * deadline — provider unavailable, grant denied). An ack timeout may follow
   * a toast already on screen, so it resolves null rather than report twice.
   */
  readonly fallback: Promise<string | null>;
}

/** Where the "Screenshot saved" actions run, when the host offers any. */
export interface CaptureToastActionHost {
  readonly capture: Pick<
    BrowserCaptureHost,
    "artifactActions" | "copyArtifactToClipboard" | "copyArtifactPath" | "revealArtifact"
  >;
  readonly context: ViewContext;
  /** Probes the host's t3.ui/notifications version before asking for keepOpen. */
  readonly discoverApis: (
    context: ViewContext,
    signal: AbortSignal,
  ) => Promise<readonly ApiDiscovery[]>;
  /** Carries the keepOpen toast and its updates once the probe passes. */
  readonly invokeApi: ApiClient["invokeApi"];
}

/** `keepOpen` actions and `flashAction` arrived in t3.ui/notifications 1.1.0. */
const NOTIFICATIONS_KEEP_OPEN_RANGE = "^1.1.0";

/** Whether the host's selected t3.ui/notifications takes keepOpen actions. */
async function hostTakesKeepOpen(
  actionHost: CaptureToastActionHost,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const selected = (await actionHost.discoverApis(actionHost.context, signal)).find(
      (api) => api.id === uiNotificationsApi.definition.id && api.selected,
    );
    return (
      selected !== undefined &&
      satisfiesSemverRange(selected.version, NOTIFICATIONS_KEEP_OPEN_RANGE)
    );
  } catch {
    return false;
  }
}

/**
 * Reports an outcome without waiting on notify; see `CaptureReport`. With
 * `actionHost`, a "Screenshot saved" toast for a capture the desktop saved
 * carries native's actions and is served until it closes. A host that does
 * not advertise notifications 1.1.0, or whose client still rejects the
 * actions, gets the plain toast.
 */
export function reportCaptureOutcome(
  notifications: Notifications,
  threadId: string,
  target: BrowserCaptureTarget,
  outcome: CaptureToChatOutcome,
  signal: AbortSignal,
  ackTimeoutMs = NOTIFY_ACK_TIMEOUT_MS,
  actionHost: CaptureToastActionHost | null = null,
): CaptureReport {
  const message = captureOutcomeMessage(target, outcome);
  const saved = outcome.kind === "added" && outcome.artifact.saved === true;
  const toast = captureOutcomeToast(
    target,
    outcome,
    saved ? captureToastActions(actionHost?.capture ?? null) : [],
  );
  if (toast === null) return { inline: message, fallback: Promise.resolve(null) };
  const ack = AbortSignal.timeout(ackTimeoutMs);
  const delivery = AbortSignal.any([signal, ack]);
  const notify = (input: CaptureToast, via = notifications) =>
    via.invoke("notify", { ...input, threadId, anchor: "thread" }, delivery);
  const { actions, ...plain } = toast;
  const fallback = Promise.resolve()
    .then(async () => {
      if (
        actions === undefined ||
        actionHost === null ||
        !(await hostTakesKeepOpen(actionHost, delivery))
      )
        return notify(plain);
      // The SDK refuses keepOpen and flashAction below the range just probed.
      const probed = bindApi(
        uiNotificationsApi,
        actionHost,
        actionHost.context,
        NOTIFICATIONS_KEEP_OPEN_RANGE,
      );
      return notify(toast, probed).then(
        ({ notificationId }) => {
          if (outcome.kind === "added")
            void serveCaptureToastActions(
              probed,
              actionHost.capture,
              { context: actionHost.context, artifactRef: outcome.artifact.artifactRef },
              notificationId,
              signal,
            );
        },
        // A 1.1.0 host with a 1.0.0 client rejects keepOpen actions;
        // native's toast without them still beats a status line.
        (error: unknown) => {
          if (signal.aborted || ack.aborted) throw error;
          return notify(plain);
        },
      );
    })
    .then(
      () => null,
      () => (signal.aborted || ack.aborted ? null : message),
    );
  return { inline: null, fallback };
}

export type BrowserCaptureState =
  | { readonly kind: "idle" }
  | { readonly kind: "capturing"; readonly target: BrowserCaptureTarget }
  | { readonly kind: "done"; readonly message: string | null };

/**
 * One button press end to end. The run announces itself (`onState`
 * capturing) before the host is asked, so the panel can drop stale faults.
 * Capture state releases as soon as the run
 * ends (`onState` done); the toast goes out after, and its fallback line
 * lands only while `isCurrent()` says no newer run has started. Aborting
 * `cancel` dismisses an open picker, which settles as a silent cancel.
 */
export async function runBrowserCapture(
  host: Pick<ClientHost, "browserCapture" | "invokeApi" | "discoverApis">,
  session: Pick<ViewSession, "context" | "signal">,
  held: CaptureSessionRef,
  target: BrowserCaptureTarget,
  isCurrent: () => boolean,
  onState: (state: BrowserCaptureState) => void,
  ackTimeoutMs = NOTIFY_ACK_TIMEOUT_MS,
  cancel?: AbortSignal,
): Promise<void> {
  const context = session.context;
  const signal = cancel ? AbortSignal.any([session.signal, cancel]) : session.signal;
  onState({ kind: "capturing", target });
  const outcome = await captureToChat(host, context, held, target, signal);
  if (session.signal.aborted) return;
  const report = reportCaptureOutcome(
    bindApi(uiNotificationsApi, host, context),
    context.resource.threadId ?? "",
    target,
    outcome,
    session.signal,
    ackTimeoutMs,
    host.browserCapture
      ? {
          capture: host.browserCapture,
          context,
          discoverApis: (probeContext, signal) => host.discoverApis(probeContext, signal),
          invokeApi: (request, signal) => host.invokeApi(request, signal),
        }
      : null,
  );
  onState({ kind: "done", message: report.inline });
  const message = await report.fallback;
  if (message !== null && isCurrent() && !session.signal.aborted)
    onState({ kind: "done", message });
}

/** Status line text for a capture state; null says the run has nothing to show. */
function captureStatusText(state: BrowserCaptureState): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "capturing":
      return state.target === "element"
        ? "Pick an element in the page — Esc cancels."
        : "Capturing the page…";
    case "done":
      return state.message;
  }
}

/**
 * The header buttons' state and action. Pressing pick again while its picker
 * is open cancels it, like native's "Cancel annotation"; any other click
 * while one runs is ignored. `onStatus` receives every state change's status
 * line, null included, so the panel's line always shows the latest event.
 */
export function useBrowserCapture(
  host: ClientHost,
  session: ViewSession,
  held: CaptureSessionRef | null,
  page: CapturePageView = "shown",
  onStatus?: (line: string | null) => void,
): {
  readonly blockReason: string | null;
  readonly state: BrowserCaptureState;
  readonly picking: boolean;
  readonly capture: (target: BrowserCaptureTarget) => void;
} {
  const [state, setState] = useState<BrowserCaptureState>({ kind: "idle" });
  const latestRun = useRef(0);
  const cancelRun = useRef<AbortController | null>(null);
  // threadId is read per render: a project-scoped surface can switch threads.
  const blockReason = captureUnavailableReason(host, held, session.context.resource.threadId, page);
  const picking = state.kind === "capturing" && state.target === "element";
  const capture = (target: BrowserCaptureTarget) => {
    if (picking && target === "element") {
      cancelRun.current?.abort();
      return;
    }
    if (blockReason !== null || held === null || state.kind === "capturing") return;
    const run = ++latestRun.current;
    const cancel = new AbortController();
    cancelRun.current = cancel;
    void runBrowserCapture(
      host,
      session,
      held,
      target,
      () => run === latestRun.current,
      (next) => {
        onStatus?.(captureStatusText(next));
        setState(next);
      },
      NOTIFY_ACK_TIMEOUT_MS,
      cancel.signal,
    );
  };
  return { blockReason, state, picking, capture };
}
