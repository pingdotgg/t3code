import { type ThreadId as ThreadIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import {
  applyHistoryPageMeta,
  clearActiveHistoryLoading,
  EMPTY_THREAD_HISTORY_META,
  isActiveHistoryRequestCursor,
  mergeOlderHistoryIntoProjection,
  type ThreadHistoryMeta,
} from "./threadHistoryMerge.ts";
import { formatHistoryError } from "./threadHistoryErrors.ts";
import { type EnvironmentThreadState } from "./threadState.ts";

export function makeThreadHistoryLoadEarlier(input: {
  readonly state: SubscriptionRef.SubscriptionRef<EnvironmentThreadState>;
  readonly threadId: ThreadIdType;
  readonly supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  readonly httpClient: Option.Option<HttpClient.HttpClient>;
  readonly dpopSigner: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly patchHistoryMeta: (
    patch: (history: ThreadHistoryMeta) => ThreadHistoryMeta,
  ) => Effect.Effect<void>;
  readonly remember: Effect.Effect<void>;
  readonly applyLock: Semaphore.Semaphore;
  readonly awaitingCompletion: Ref.Ref<boolean>;
}) {
  const {
    state,
    threadId,
    supervisor,
    httpClient,
    dpopSigner,
    remoteAuthorization,
    patchHistoryMeta,
    remember,
    applyLock,
    awaitingCompletion,
  } = input;
  return Effect.fn("EnvironmentThreadState.loadEarlier")(function* (
    throughEntryId?: string,
    workAnchorId?: string,
  ): Effect.fn.Return<ThreadHistoryController.ThreadHistoryLoadEarlierResult> {
    const workCursor = (latest: EnvironmentThreadState) =>
      Option.getOrNull(latest.data)?.visibleTurnItems.find(
        (row) => row.sourceItemId === workAnchorId,
      )?.item.deferredWork?.cursor ?? null;
    const current = yield* SubscriptionRef.get(state);
    const initialCursor =
      workAnchorId === undefined ? current.history.historyCursor : workCursor(current);
    if (
      current.status === "deleted" ||
      Option.isNone(current.data) ||
      initialCursor === null ||
      (workAnchorId === undefined && !current.history.hasMoreHistory)
    )
      return { _tag: "noop" };
    if (workAnchorId === undefined && current.history.loading) return { _tag: "busy" };
    let requestCursor = initialCursor;
    const isCurrent = (latest: EnvironmentThreadState) =>
      workAnchorId === undefined
        ? isActiveHistoryRequestCursor(requestCursor, latest.history)
        : workCursor(latest) === requestCursor;
    const staleResult = (
      latest: EnvironmentThreadState,
    ): ThreadHistoryController.ThreadHistoryLoadEarlierResult =>
      workAnchorId !== undefined && workCursor(latest) !== null
        ? { _tag: "error", message: "Work history changed. Retry loading it." }
        : { _tag: "noop" };
    if (workAnchorId === undefined)
      yield* patchHistoryMeta((history) =>
        isActiveHistoryRequestCursor(requestCursor, history)
          ? { ...history, loading: true, error: null }
          : history,
      );
    const failLoad = (message: string) =>
      SubscriptionRef.modify(
        state,
        (
          latest,
        ): readonly [
          ThreadHistoryController.ThreadHistoryLoadEarlierResult,
          EnvironmentThreadState,
        ] =>
          isCurrent(latest)
            ? [
                { _tag: "error", message },
                {
                  ...latest,
                  history:
                    workAnchorId === undefined
                      ? { ...latest.history, loading: false, error: message }
                      : latest.history,
                },
              ]
            : [staleResult(latest), latest],
      );

    const runLoad = Effect.gen(function* () {
      while (true) {
        const preparedOption = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(preparedOption) || Option.isNone(httpClient))
          return yield* failLoad("Environment is not connected.");
        const views =
          workAnchorId !== undefined
            ? ["work" as const]
            : throughEntryId === undefined
              ? [undefined]
              : ["conversation" as const, undefined];
        let nextCursor: string | null = null;
        for (const view of views) {
          const pageResult = yield* fetchEnvironmentThreadHistoryPage({
            prepared: preparedOption.value,
            threadId,
            cursor: requestCursor,
            throughEntryId: workAnchorId ?? throughEntryId,
            view,
            signer: dpopSigner,
            remoteAuthorization,
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient.value), Effect.result);
          if (Result.isFailure(pageResult))
            return yield* failLoad(formatHistoryError(pageResult.failure));
          const page = pageResult.success;
          const complete = view !== "conversation";
          const keepPaging =
            complete &&
            (workAnchorId !== undefined
              ? page.nextCursor !== null
              : throughEntryId === undefined &&
                page.hasMoreHistory &&
                !page.items.some(
                  ({ item }) => item.type === "user_message" && item.createdBy === "user",
                ));
          if (keepPaging && (page.nextCursor === null || page.nextCursor === requestCursor))
            return yield* failLoad(
              workAnchorId === undefined
                ? "History did not advance."
                : "Work history did not advance.",
            );
          const waiting = yield* Ref.get(awaitingCompletion);
          const result = yield* applyLock.withPermits(1)(
            SubscriptionRef.modify(
              state,
              (
                latest,
              ): readonly [
                ThreadHistoryController.ThreadHistoryLoadEarlierResult,
                EnvironmentThreadState,
              ] => {
                if (!isCurrent(latest)) return [staleResult(latest), latest];
                if (Option.isNone(latest.data) || latest.status === "deleted")
                  return [{ _tag: "noop" }, { ...latest, history: EMPTY_THREAD_HISTORY_META }];
                return [
                  { _tag: "loaded" },
                  {
                    ...latest,
                    data: Option.some(
                      mergeOlderHistoryIntoProjection(
                        latest.data.value,
                        page.items,
                        workAnchorId === undefined
                          ? undefined
                          : { anchorId: workAnchorId, nextCursor: page.nextCursor },
                      ),
                    ),
                    status:
                      workAnchorId === undefined && complete && waiting
                        ? "synchronizing"
                        : latest.status,
                    history:
                      workAnchorId === undefined && complete
                        ? { ...applyHistoryPageMeta(latest.history, page), loading: keepPaging }
                        : { ...latest.history, expanded: true },
                  },
                ];
              },
            ),
          );
          if (result._tag !== "loaded") return result;
          if (complete) yield* applyLock.withPermits(1)(remember);
          nextCursor = keepPaging ? page.nextCursor : null;
        }
        if (nextCursor === null) return { _tag: "loaded" } as const;
        requestCursor = nextCursor;
      }
    });
    return yield* runLoad.pipe(
      Effect.onInterrupt(() =>
        SubscriptionRef.update(state, (latest) => ({
          ...latest,
          history: clearActiveHistoryLoading(requestCursor, latest.history),
        })),
      ),
    );
  });
}
