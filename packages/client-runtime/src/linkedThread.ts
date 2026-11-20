import type {
  EnvironmentId,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  PeerLinkClientPairingResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  deriveRunlessWorkStartedAt,
  deriveThreadStructureRuntime,
} from "./state/threadExecution.ts";
import {
  applyThreadHistoryPage,
  applyThreadStreamItem,
  initialThreadStreamState,
  type ThreadStreamState,
} from "./state/threadStream.ts";

/** A thread on a linked environment, read through the environment that holds the link. */
export interface LinkedThreadTarget {
  /** The environment this client is connected to, which reads the thread over its link. */
  readonly viaEnvironmentId: EnvironmentId;
  /** The linked environment the thread lives in. */
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** What to call the linked environment and the thread until the first page names them. */
  readonly label: string;
  readonly title: string | null;
}

export type LinkedThreadOpen = "direct" | "linked" | "unavailable";

/**
 * How a client opens a thread on `environmentId` that a thread or link in `viaEnvironmentId`
 * points at. A connection of the client's own always wins, since it can do more than read. Without
 * one, the environment holding the link reads it. A saved environment that neither answers nor is
 * linked still opens directly, where the client says it is offline.
 */
export function resolveLinkedThreadOpen(input: {
  readonly environmentId: EnvironmentId;
  readonly viaEnvironmentId: EnvironmentId;
  /** The client's own saved connection to `environmentId`, when it has one. */
  readonly own: { readonly connected: boolean } | undefined;
  /** Whether `viaEnvironmentId` holds a link to `environmentId`. */
  readonly linked: boolean;
}): LinkedThreadOpen {
  if (input.environmentId === input.viaEnvironmentId) return "direct";
  if (input.own?.connected === true) return "direct";
  if (input.linked) return "linked";
  return input.own === undefined ? "unavailable" : "direct";
}

export type LinkedEnvironmentConnection =
  /** This client paired with the linked environment and saved it. */
  | { readonly type: "connected" }
  /** No address the linking environment knows answers from this device. */
  | { readonly type: "unreachable"; readonly label: string }
  /** The user pairs with a code of their own, in the add-environment flow, with this filled in. */
  | { readonly type: "manual"; readonly label: string; readonly host: string | null };

/**
 * Connects this client to a linked environment. The linking environment asks it for a one-time
 * pairing over a full-access link, and the client redeems that at an address it can reach itself.
 * Anything short of that leaves the user to pair by hand.
 */
export async function connectLinkedEnvironment(options: {
  readonly label: string;
  /** Asks the linking environment for a pairing; null when it could not answer. */
  readonly requestPairing: () => Promise<PeerLinkClientPairingResult | null>;
  /** Whether an address answers this device as the linked environment. */
  readonly reaches: (host: string) => Promise<boolean>;
  /** Pairs at `host` with the one-time credential and saves the environment. */
  readonly pair: (input: {
    readonly host: string;
    readonly pairingCode: string;
  }) => Promise<boolean>;
}): Promise<LinkedEnvironmentConnection> {
  const pairing = await options.requestPairing();
  if (pairing === null) return { type: "manual", label: options.label, host: null };
  const { label, urls } = pairing;
  // Asked together, taken in the linking environment's order of preference.
  const answers = await Promise.all(urls.map((url) => options.reaches(url)));
  const host = urls.find((_, index) => answers[index]) ?? null;
  if (pairing.type === "unsupported") {
    return { type: "manual", label, host: host ?? urls[0] ?? null };
  }
  if (host === null) return { type: "unreachable", label };
  return (await options.pair({ host, pairingCode: pairing.credential }))
    ? { type: "connected" }
    : { type: "manual", label, host };
}

const hasStringField = <K extends string>(value: unknown, key: K): value is Record<K, string> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>)[key] === "string";

/** Whether a failed read can succeed later with nothing changed: the linked environment was only out of reach. */
const isLinkedThreadUnreachable = (error: unknown): boolean =>
  hasStringField(error, "_tag") &&
  error._tag === "PeerLinkThreadReadError" &&
  hasStringField(error, "reason") &&
  error.reason === "unreachable";

export interface LinkedThreadFailure {
  readonly title: string;
  readonly detail: string;
  /** Whether reading again can succeed without the user changing something first. */
  readonly retryable: boolean;
}

/**
 * A failed read in the user's words. `via` and `label` name the two environments as the client
 * knows them; the server's own label wins once it has answered with one.
 */
export function linkedThreadFailure(
  error: unknown,
  names: { readonly via: string; readonly label: string },
  resolve: MFunctionType = mFallback,
): LinkedThreadFailure {
  const via = names.via;
  const serverMessage = hasStringField(error, "message") ? error.message : "";
  if (!hasStringField(error, "_tag") || error._tag !== "PeerLinkThreadReadError") {
    // An environment from before this read answers with an unknown method.
    return {
      title: resolve(msg("Could not read this thread through {via}", { via })),
      detail:
        serverMessage ||
        resolve(msg("{via} may need an update before it can read linked threads.", { via })),
      retryable: true,
    };
  }
  const retryable = isLinkedThreadUnreachable(error);
  const label = hasStringField(error, "label") ? error.label : names.label;
  const reason = hasStringField(error, "reason") ? error.reason : "";
  switch (reason) {
    case "disabled":
      return {
        title: resolve(msg("Linked environments is off on {via}", { via })),
        detail: resolve(
          msg(
            "Turn it on in {via}'s Settings → Labs to read threads on the machines it links to.",
            {
              via,
            },
          ),
        ),
        retryable,
      };
    case "unknown_link":
      return {
        title: resolve(msg("{via} is no longer linked to {label}", { via, label })),
        detail: resolve(
          msg("Link it again in {via}'s Settings → Connections to read its threads from here.", {
            via,
          }),
        ),
        retryable,
      };
    case "expired":
      return {
        title: resolve(msg("The link from {via} to {label} expired", { via, label })),
        detail: resolve(
          msg("Link it again in {via}'s Settings → Connections with a new pairing code.", { via }),
        ),
        retryable,
      };
    case "rejected":
      return {
        title: resolve(msg("{label} refused the read", { label })),
        detail: serverMessage,
        retryable,
      };
    case "thread_not_found":
      return {
        title: resolve(msg("This thread is no longer on {label}", { label })),
        detail: resolve(msg("It may have been deleted there.")),
        retryable,
      };
    case "incompatible":
      return {
        title: resolve(msg("{label} needs an update", { label })),
        detail: serverMessage,
        retryable,
      };
    default:
      return {
        title: resolve(msg("{label} is not answering {via}", { label, via })),
        detail: serverMessage,
        retryable,
      };
  }
}

const WORKING_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** Whether the thread has work under way, for the note that stands where its composer would. */
export function isLinkedThreadWorking(projection: OrchestrationV2ThreadProjection): boolean {
  return (
    WORKING_STATUSES.has(deriveThreadStructureRuntime(projection)?.status ?? "") ||
    deriveRunlessWorkStartedAt(projection) !== null
  );
}

/** How long a view waits before asking again for a thread whose environment did not answer. */
export const LINKED_THREAD_RETRY_MS = 15_000;

/** A linked thread as its view holds it: the thread's own stream, reduced as any thread's is. */
export interface LinkedThreadView {
  readonly thread: ThreadStreamState;
  /** Why the stream stopped, while the view waits to ask again; the next item clears it. */
  readonly error: unknown;
  readonly history: { readonly loading: boolean; readonly failed: boolean };
  /** Loads the turns before the ones shown. Does nothing while a page loads or none is left. */
  readonly loadEarlier: () => void;
}

/**
 * What a view keeps once its stream shows `next`. A stream that was opened again has read nothing
 * until its snapshot arrives, so the thread read before stays, with the new stream's state beside
 * it. Its earlier turns load again only once that stream has a thread of its own to add them to.
 */
export const keepLinkedThreadView = (
  kept: LinkedThreadView | null,
  next: LinkedThreadView,
): LinkedThreadView =>
  next.thread.projection !== null || kept === null || kept.thread.projection === null
    ? next
    : { ...next, thread: { ...kept.thread, historyCursor: null } };

/**
 * Follows a linked environment's thread for as long as something consumes the result. The thread
 * is built from the same stream items and with the same reducer as a guest page's, and older
 * turns load through the same cursor. A linked environment that stops answering is asked again
 * after a wait, with what was read kept; any other failure ends the stream.
 */
export const followLinkedThread = <E, R, E2, R2>(source: {
  readonly items: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>;
  readonly historyPage: (cursor: string) => Effect.Effect<OrchestrationV2ThreadHistoryPage, E2, R2>;
}): Stream.Stream<LinkedThreadView, E, R | R2> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<void>();
      let requested = false;
      // Both halves below run one step at a time, so each reads the view the other left.
      let view: LinkedThreadView = {
        thread: initialThreadStreamState,
        error: null,
        history: { loading: false, failed: false },
        loadEarlier: () => {
          if (requested || view.thread.historyCursor === null) return;
          requested = true;
          Queue.offerUnsafe(requests, undefined);
        },
      };
      const show = (patch: Partial<LinkedThreadView>) => {
        view = { ...view, ...patch };
        return view;
      };
      const attempt = (): Stream.Stream<LinkedThreadView, E, R> =>
        source.items.pipe(
          Stream.map((item) =>
            show({ thread: applyThreadStreamItem(view.thread, item), error: null }),
          ),
          Stream.catch((error) =>
            isLinkedThreadUnreachable(error)
              ? Stream.make(show({ error })).pipe(
                  Stream.concat(
                    Stream.unwrap(Effect.sleep(LINKED_THREAD_RETRY_MS).pipe(Effect.map(attempt))),
                  ),
                )
              : Stream.fail(error),
          ),
        );
      const earlier = Stream.fromQueue(requests).pipe(
        Stream.flatMap(() =>
          Stream.suspend(() => {
            const cursor = view.thread.historyCursor;
            if (cursor === null) {
              requested = false;
              return Stream.empty;
            }
            return Stream.make(show({ history: { loading: true, failed: false } })).pipe(
              Stream.concat(
                Stream.fromEffect(
                  source.historyPage(cursor).pipe(
                    Effect.match({
                      onSuccess: (page) =>
                        show({
                          thread: applyThreadHistoryPage(view.thread, cursor, page),
                          history: { loading: false, failed: false },
                        }),
                      onFailure: () => show({ history: { loading: false, failed: true } }),
                    }),
                    Effect.ensuring(
                      Effect.sync(() => {
                        requested = false;
                      }),
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
      );
      return Stream.merge(attempt(), earlier, { haltStrategy: "left" });
    }),
  );
