import { Services } from "@distilled.cloud/hetzner";
import type { GetActionResponseAction } from "@distilled.cloud/hetzner/actions";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class ActionPending extends Data.TaggedError("ActionPending")<{
  actionId: number;
  status: string;
}> {}

export class ActionFailed extends Data.TaggedError("ActionFailed")<{
  actionId: number;
  command: string;
  code?: string;
  message: string;
}> {}

export class ActionTimeout extends Data.TaggedError("ActionTimeout")<{
  actionId: number;
  status: string;
}> {}

export type ActionRef =
  | number
  | Pick<GetActionResponseAction, "id">
  | GetActionResponseAction;

const actionIdOf = (ref: ActionRef): number =>
  typeof ref === "number" ? ref : ref.id;

const isErrorStatus = (status: string): boolean => status === "error";
const isSuccessStatus = (status: string): boolean => status === "success";

const failIfError = (action: GetActionResponseAction) => {
  if (isErrorStatus(action.status)) {
    return Effect.fail(
      new ActionFailed({
        actionId: action.id,
        command: action.command,
        code: action.error?.code,
        message: action.error?.message ?? "Hetzner Action failed",
      }),
    );
  }
  return Effect.void;
};

const retryable = (e: { readonly _tag: string }): boolean =>
  e._tag === "ActionPending" ||
  e._tag === "TooManyRequests" ||
  e._tag === "ServiceUnavailable" ||
  e._tag === "InternalServerError" ||
  e._tag === "BadGateway" ||
  e._tag === "GatewayTimeout";

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

/**
 * Poll a Hetzner Action until it reaches `success` or `error`.
 *
 * Bounded: at most 24 polls, exponential backoff starting at 500ms and
 * capped at 5s. Already-finished actions return immediately.
 */
export const waitForAction = (
  ref: ActionRef,
): Effect.Effect<
  GetActionResponseAction,
  ActionFailed | ActionTimeout | Services.actions.GetActionError,
  Services.actions.HetznerOpContext
> =>
  Effect.gen(function* () {
    if (typeof ref !== "number" && "status" in ref) {
      yield* failIfError(ref);
      if (isSuccessStatus(ref.status)) {
        return ref;
      }
    }

    const id = actionIdOf(ref);
    return yield* Services.actions.getAction({ id }).pipe(
      Effect.flatMap(({ action }) =>
        Effect.gen(function* () {
          yield* failIfError(action);
          if (!isSuccessStatus(action.status)) {
            return yield* new ActionPending({
              actionId: action.id,
              status: action.status,
            });
          }
          return action;
        }),
      ),
      Effect.retry({
        while: retryable,
        times: 24,
        schedule: backoff,
      }),
      Effect.catchTag(
        "ActionPending",
        (e) =>
          new ActionTimeout({
            actionId: e.actionId,
            status: e.status,
          }),
      ),
    );
  });

/**
 * Wait for every Action in `refs` (in order). Empty input is a no-op.
 */
export const waitForActions = (
  refs: ReadonlyArray<ActionRef>,
): Effect.Effect<
  GetActionResponseAction[],
  ActionFailed | ActionTimeout | Services.actions.GetActionError,
  Services.actions.HetznerOpContext
> => Effect.forEach(refs, waitForAction, { concurrency: 1 });

/**
 * Poll a Hetzner Cloud DNS Zone Action (`GET /zones/actions/{id}`) until it
 * reaches `success` or `error`. Zone actions live in a separate namespace
 * from compute `/actions/{id}` — do not use {@link waitForAction} for them.
 *
 * Bounded: at most 10 polls, exponential backoff starting at 500ms and
 * capped at 5s (under 60s total). Already-finished actions return
 * immediately.
 */
export const waitForZoneAction = (
  ref: ActionRef,
): Effect.Effect<
  GetActionResponseAction,
  ActionFailed | ActionTimeout | Services.zoneActions.GetZonesActionError,
  Services.zoneActions.HetznerOpContext
> =>
  Effect.gen(function* () {
    if (typeof ref !== "number" && "status" in ref) {
      yield* failIfError(ref as GetActionResponseAction);
      if (isSuccessStatus(ref.status)) {
        return ref as GetActionResponseAction;
      }
    }

    const id = actionIdOf(ref);
    return yield* Services.zoneActions.getZonesAction({ id }).pipe(
      Effect.flatMap(({ action }) =>
        Effect.gen(function* () {
          yield* failIfError(action as GetActionResponseAction);
          if (!isSuccessStatus(action.status)) {
            return yield* new ActionPending({
              actionId: action.id,
              status: action.status,
            });
          }
          return action as GetActionResponseAction;
        }),
      ),
      Effect.retry({
        while: retryable,
        times: 24,
        schedule: backoff,
      }),
      Effect.catchTag(
        "ActionPending",
        (e) =>
          new ActionTimeout({
            actionId: e.actionId,
            status: e.status,
          }),
      ),
    );
  });
