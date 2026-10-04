import type { BusyBarSettings, ThreadId } from "@t3tools/contracts";
import { type AgentAwarenessPhase, projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  makeAgentAwarenessPublishWorker,
  shouldPublishAgentAwarenessEvent,
} from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import {
  BUSY_BAR_TRANSIENT_IDS,
  type BusyBarCard,
  busyBarCardElements,
  busyBarIntroFrames,
  LOGO_PATH,
} from "./BusyBarMotion.ts";
import * as ServerSettings from "../serverSettings.ts";

export type BusyBarAlert = "completed" | "failed" | "waiting_for_approval" | "waiting_for_input";

export interface BusyBarThreadTracking {
  readonly phase: AgentAwarenessPhase | null;
  /** Saw the thread working, so its next terminal phase is news. */
  readonly armed: boolean;
}

const isAttention = (phase: AgentAwarenessPhase | null | undefined) =>
  phase === "waiting_for_approval" || phase === "waiting_for_input";

/**
 * Decides whether a thread's new awareness phase is worth showing. Terminal
 * phases alert only after the thread was seen working in this process, so
 * restarts and the instant "completed" a fresh session reports stay quiet.
 */
export function nextBusyBarAlert(
  previous: BusyBarThreadTracking | undefined,
  phase: AgentAwarenessPhase | null,
): { readonly tracking: BusyBarThreadTracking; readonly alert: BusyBarAlert | null } {
  const working = phase === "starting" || phase === "running" || isAttention(phase);
  const armed = working || (phase === null && (previous?.armed ?? false));
  const tracking = { phase, armed };
  if (isAttention(phase) && previous?.phase !== phase) {
    return { tracking, alert: phase as BusyBarAlert };
  }
  if ((phase === "completed" || phase === "failed") && previous?.armed) {
    return { tracking, alert: phase };
  }
  return { tracking, alert: null };
}

const ALERTS: Record<
  BusyBarAlert,
  {
    readonly label: string;
    readonly color: string;
    readonly timeoutSeconds: number;
  }
> = {
  completed: { label: "DONE", color: "#00C853FF", timeoutSeconds: 60 },
  failed: { label: "FAILED", color: "#FF1744FF", timeoutSeconds: 120 },
  // Attention stays up until the thread moves on.
  waiting_for_approval: {
    label: "APPROVE",
    color: "#FFAB00FF",
    timeoutSeconds: 0,
  },
  waiting_for_input: { label: "QUESTION", color: "#2979FFFF", timeoutSeconds: 0 },
};

const APPLICATION_NAME = "t3code";
const PROXY_HOST = "api.busy.app";

/** The device serves `/api`; the cloud proxy serves the same API under `/busybar`. */
export function resolveBusyBarEndpoint(settings: Pick<BusyBarSettings, "address" | "token">) {
  const raw = settings.address.trim();
  const hasProtocol = /^https?:\/\//i.test(raw);
  const isProxy = new URL(hasProtocol ? raw : `http://${raw}`).hostname === PROXY_HOST;
  const origin = new URL(hasProtocol ? raw : `${isProxy ? "https" : "http"}://${raw}`).origin;
  const headers: Record<string, string> =
    settings.token.length === 0
      ? {}
      : isProxy
        ? { authorization: `Bearer ${settings.token}` }
        : { "x-api-token": settings.token };
  return { baseUrl: `${origin}${isProxy ? "/busybar" : "/api"}`, headers };
}

/** The device fonts are bitmap ASCII. */
const toDeviceText = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// 16x16 white-on-black T3 mark, uploaded to the app's assets before each intro.
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVR4nGNgYGD4TyEeNgbgAoTkqGcAukG4nIxFnngDcMgRZwAO55PuBSxq6GAAnhggz4BBmpTJxQCvpq9f5bqLtAAAAABJRU5ErkJggg==",
  "base64",
);

export const busyBarAlertCard = (alert: BusyBarAlert, threadTitle: string): BusyBarCard => {
  const { label, color, timeoutSeconds } = ALERTS[alert];
  return { label, color, title: toDeviceText(threadTitle), timeoutSeconds };
};

// One failed request ends a sequence, so an unreachable device costs one timeout.
const reportFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning("BUSY Bar request failed", { cause })),
  );

/** Device calls for one HTTP client. Each fails on the first failed request. */
export function makeBusyBarDevice(httpClient: HttpClient.HttpClient) {
  const send = (settings: BusyBarSettings, request: HttpClientRequest.HttpClientRequest) => {
    const endpoint = resolveBusyBarEndpoint(settings);
    return httpClient
      .execute(
        request.pipe(
          HttpClientRequest.prependUrl(endpoint.baseUrl),
          HttpClientRequest.setHeaders(endpoint.headers),
        ),
      )
      .pipe(Effect.timeout("3 seconds"), Effect.asVoid);
  };
  const draw = (card: BusyBarCard, elements: ReadonlyArray<object>, extra?: object) =>
    HttpClientRequest.post("/display/draw").pipe(
      HttpClientRequest.bodyJsonUnsafe({
        application_name: APPLICATION_NAME,
        ...extra,
        elements: elements.map((element) => ({
          display: "front",
          timeout: card.timeoutSeconds,
          ...element,
        })),
      }),
    );

  const clear = (settings: BusyBarSettings, elementIds?: ReadonlyArray<string>) =>
    send(
      settings,
      HttpClientRequest.delete("/display/draw").pipe(
        HttpClientRequest.bodyJsonUnsafe({
          application_name: APPLICATION_NAME,
          ...(elementIds ? { element_ids: elementIds } : {}),
        }),
      ),
    );

  /** Plays the intro on its schedule, then leaves the settled card with its LED blink. */
  const play = (settings: BusyBarSettings, card: BusyBarCard) =>
    Effect.gen(function* () {
      // Draws add to what is on screen, so start from a clean slate.
      yield* clear(settings);
      yield* send(
        settings,
        HttpClientRequest.post("/assets/upload").pipe(
          HttpClientRequest.setUrlParams({ application_name: APPLICATION_NAME, file: LOGO_PATH }),
          HttpClientRequest.bodyUint8Array(LOGO_PNG, "application/octet-stream"),
        ),
      );
      const startedAt = yield* Clock.currentTimeMillis;
      for (const frame of busyBarIntroFrames(card)) {
        const wait = startedAt + frame.atMs - (yield* Clock.currentTimeMillis);
        if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
        if (frame.elements.length > 0) yield* send(settings, draw(card, frame.elements));
      }
      yield* clear(settings, BUSY_BAR_TRANSIENT_IDS);
      yield* send(
        settings,
        draw(card, busyBarCardElements(card), { led_notification_color: card.color }),
      );
    });

  return { clear, play };
}

/**
 * Mirrors agent turns onto a BUSY Bar: a finished or failed run shows briefly,
 * and a pending approval or question stays up until it is answered.
 */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const tracked = new Map<ThreadId, BusyBarThreadTracking>();
  // The thread whose attention alert is on the device, so moving on can clear it.
  let attentionThreadId: ThreadId | null = null;

  const device = makeBusyBarDevice(httpClient);

  const evaluate = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* threads.getThreadShell(threadId);
      const project =
        thread === null || thread.archivedAt !== null
          ? Option.none()
          : yield* projects.getById(thread.projectId);
      const state =
        thread !== null && Option.isSome(project)
          ? projectThreadAwarenessV2({
              environmentId: yield* serverEnvironment.getEnvironmentId,
              project: project.value,
              thread,
            })
          : null;
      const { tracking, alert } = nextBusyBarAlert(tracked.get(threadId), state?.phase ?? null);
      if (thread === null || thread.archivedAt !== null) tracked.delete(threadId);
      else tracked.set(threadId, tracking);

      const show = alert !== null && thread !== null;
      const dismiss = attentionThreadId === threadId && !isAttention(tracking.phase);
      if (!show && !dismiss) return;
      // Read last: settings materialize the token from the secret store.
      const settings = (yield* serverSettings.getSettings).busyBar;
      if (!settings.enabled) return;
      if (show) {
        attentionThreadId = isAttention(alert) ? threadId : null;
        yield* reportFailure(device.play(settings, busyBarAlertCard(alert, thread.title)));
      } else {
        attentionThreadId = null;
        yield* reportFailure(device.clear(settings));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("BUSY Bar thread evaluation failed", { threadId, cause }),
      ),
    );

  const worker = yield* makeAgentAwarenessPublishWorker(evaluate);

  // Saving an enabled device plays the intro, so setup gets visible confirmation.
  const greet = (settings: BusyBarSettings) =>
    reportFailure(
      device.play(settings, {
        label: "CONNECTED",
        color: "#FFFFFFFF",
        title: "T3 Code",
        timeoutSeconds: 5,
      }),
    );

  const settingsKey = (settings: BusyBarSettings) =>
    JSON.stringify([settings.enabled, settings.address, settings.token]);

  const start = (): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      let greetedKey = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settingsKey(settings.busyBar)),
        Effect.orElseSucceed(() => ""),
      );
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          shouldPublishAgentAwarenessEvent(event) ? worker.enqueue(event.threadId) : Effect.void,
        ),
      );
      yield* forkParked(
        Stream.runForEach(serverSettings.streamChanges, ({ busyBar }) => {
          const key = settingsKey(busyBar);
          if (key === greetedKey) return Effect.void;
          greetedKey = key;
          return busyBar.enabled ? greet(busyBar) : Effect.void;
        }),
      );
    });

  return { start, drain: worker.drain };
}).pipe(Effect.provide(FetchHttpClient.layer));
