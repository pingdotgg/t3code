import {
  type DesktopUpdateCommandRequest,
  type DesktopUpdateCommandResponse,
  type T3UpdateCheck,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Duration from "effect/Duration";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { UPDATE_COMMAND_REQUEST_CHANNEL } from "../ipc/channels.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

export class DesktopUpdateCommand extends Context.Service<
  DesktopUpdateCommand,
  {
    readonly inspect: Effect.Effect<T3UpdateCheck>;
    readonly request: (
      request: DesktopUpdateCommandRequest,
    ) => Effect.Effect<DesktopUpdateCommandResponse>;
    readonly setReady: (ready: boolean, rendererId: string) => Effect.Effect<void>;
    readonly cancel: (callerId: string) => Effect.Effect<void>;
    readonly complete: (response: DesktopUpdateCommandResponse) => Effect.Effect<boolean>;
    readonly reserve: Effect.Effect<string | null>;
    readonly reserveForRemoteUpdate: Effect.Effect<string | null>;
    readonly reserveForRenderer: Effect.Effect<string | null>;
    readonly finish: (reservation: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/updates/DesktopUpdateCommand") {}

interface PendingCommand {
  readonly requestId: string;
  readonly callerId: string;
  readonly reply: Deferred.Deferred<DesktopUpdateCommandResponse>;
}

interface UpdateReservation {
  readonly owner: string | null;
  readonly rendererId: string | null;
  readonly next: number;
  readonly phase: "confirming" | "running" | null;
}

const make = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const windows = yield* ElectronWindow.ElectronWindow;
  const ready = yield* Ref.make<string | null>(null);
  const lock = yield* Ref.make<UpdateReservation>({
    owner: null,
    rendererId: null,
    next: 0,
    phase: null,
  });
  const isAbandoned = (reservation: UpdateReservation, rendererId: string | null) =>
    reservation.rendererId !== null && rendererId !== null && reservation.rendererId !== rendererId;
  const pending = yield* Ref.make<Option.Option<PendingCommand>>(Option.none());
  const finish = (reservation: string) =>
    Ref.update(lock, (current) =>
      current.owner === reservation ? { ...current, owner: null, phase: null } : current,
    );
  const finishConfirmation = (reservation: string) =>
    Ref.update(lock, (current) =>
      current.owner === reservation && current.phase === "confirming"
        ? { ...current, owner: null, phase: null }
        : current,
    );
  const clearPending = (reservation: string) =>
    Ref.update(pending, (current) =>
      Option.isSome(current) && current.value.requestId === reservation ? Option.none() : current,
    );
  const failure = (requestId: string, message: string): DesktopUpdateCommandResponse => ({
    version: 1,
    requestId,
    ok: false,
    code: "renderer-unavailable",
    message,
  });
  const complete = Effect.fn("DesktopUpdateCommand.complete")(function* (
    response: DesktopUpdateCommandResponse,
  ) {
    const current = yield* Ref.modify(
      pending,
      (value): readonly [Option.Option<PendingCommand>, Option.Option<PendingCommand>] =>
        Option.isSome(value) && value.value.requestId === response.requestId
          ? ([value, Option.none()] as const)
          : ([Option.none(), value] as const),
    );
    if (Option.isNone(current)) return false;
    if (response.ok && "status" in response && response.status === "started") {
      const accepted = yield* Ref.modify(lock, (reservation) =>
        reservation.owner === response.requestId && reservation.phase === "confirming"
          ? ([true, { ...reservation, phase: "running" as const }] as const)
          : ([false, reservation] as const),
      );
      if (!accepted) return false;
    } else yield* finishConfirmation(current.value.requestId);
    yield* Deferred.succeed(current.value.reply, {
      ...response,
      requestId: current.value.callerId,
    });
    return true;
  });
  const reserveOwned = Effect.fn("DesktopUpdateCommand.reserve")(function* (
    rendererId: string | null,
    phase: "confirming" | "running" = "running",
    allowCheck = false,
  ) {
    if ((yield* updates.isActionActive) && !(allowCheck && (yield* updates.isCheckActive)))
      return null;
    return yield* Ref.modify(lock, (current) => {
      if (current.owner !== null) return [null, current] as const;
      const owner = `desktop-update-${current.next}`;
      return [owner, { owner, rendererId, phase, next: current.next + 1 }] as const;
    });
  });
  const reserve = reserveOwned(null);
  const reserveForRemoteUpdate = reserveOwned(null, "running", true);
  const reserveForRenderer = Effect.gen(function* () {
    const rendererId = yield* Ref.get(ready);
    return rendererId === null ? null : yield* reserveOwned(rendererId);
  });
  const inspect = Effect.gen(function* () {
    const state = yield* updates.getState;
    const main = yield* windows.main;
    const registeredRenderer = yield* Ref.get(ready);
    const available =
      registeredRenderer !== null && Option.isSome(main) && !main.value.webContents.isDestroyed();
    const reservation = yield* Ref.get(lock);
    const occupied = reservation.owner !== null || (yield* updates.isActionActive);
    const targetVersion = state.downloadedVersion ?? state.availableVersion;
    return {
      schema: "t3.update-check.v1",
      owner: "desktop",
      pathway: "desktop-coordinated",
      coordinated: available,
      currentVersion: state.currentVersion,
      targetVersion,
      state: !available
        ? "unavailable"
        : occupied
          ? "busy"
          : !state.enabled
            ? "blocked"
            : state.status === "error"
              ? "error"
              : "ready",
      reason: !available
        ? "Open or update T3 Code so its coordinated updater is available."
        : occupied
          ? reservation.phase === "running" && isAbandoned(reservation, registeredRenderer)
            ? "A coordinated update outlived its interface. Check affected machines before restarting T3 Code and trying again."
            : "A T3 Code update or confirmation is already in progress."
          : !state.enabled
            ? (state.message ?? "Desktop updates are disabled.")
            : state.status === "error"
              ? (state.message ?? "The desktop update check failed.")
              : "Cached desktop update state only; connected machines and providers have not been checked.",
    } satisfies T3UpdateCheck;
  });
  return DesktopUpdateCommand.of({
    inspect,
    reserve,
    reserveForRemoteUpdate,
    reserveForRenderer,
    finish,
    complete,
    cancel: Effect.fn("DesktopUpdateCommand.cancel")(function* (callerId) {
      const current = yield* Ref.get(pending);
      if (Option.isSome(current) && current.value.callerId === callerId) {
        yield* complete(failure(current.value.requestId, "The update command disconnected."));
      }
    }),
    setReady: Effect.fn("DesktopUpdateCommand.setReady")(function* (value, rendererId) {
      if (value) {
        const reservation = yield* Ref.get(lock);
        yield* Ref.set(ready, rendererId);
        const current = yield* Ref.get(pending);
        if (
          isAbandoned(reservation, rendererId) &&
          Option.isSome(current) &&
          current.value.requestId === reservation.owner
        )
          yield* complete(
            failure(current.value.requestId, "The desktop update coordinator was replaced."),
          );
        return;
      }
      if ((yield* Ref.get(ready)) !== rendererId) return;
      yield* Ref.set(ready, null);
      const current = yield* Ref.get(pending);
      if (Option.isSome(current))
        yield* complete(failure(current.value.requestId, "The desktop update coordinator closed."));
    }),
    request: Effect.fn("DesktopUpdateCommand.request")(function* (request) {
      if (request.type === "update-check")
        return { version: 1, requestId: request.requestId, ok: true, check: yield* inspect };
      if ((yield* Ref.get(ready)) === null)
        return failure(
          request.requestId,
          "Open or update T3 Code, then run t3 update again. No standalone update was attempted.",
        );
      const rendererId = yield* Ref.get(ready);
      const reservation = yield* reserveOwned(rendererId, "confirming");
      if (reservation === null) {
        const status = yield* inspect;
        return failure(
          request.requestId,
          status.state === "busy" && status.reason
            ? status.reason
            : "A T3 Code update or confirmation is already in progress.",
        );
      }
      const main = yield* windows.main;
      if (Option.isNone(main) || main.value.webContents.isDestroyed()) {
        yield* finish(reservation);
        return failure(request.requestId, "The desktop update coordinator is unavailable.");
      }
      const reply = yield* Deferred.make<DesktopUpdateCommandResponse>();
      yield* Ref.set(
        pending,
        Option.some({ requestId: reservation, callerId: request.requestId, reply }),
      );
      const delivered = yield* Effect.sync(() => {
        main.value.webContents.send(UPDATE_COMMAND_REQUEST_CHANNEL, {
          ...request,
          requestId: reservation,
        });
        return true;
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!delivered) {
        yield* clearPending(reservation);
        yield* finish(reservation);
        return failure(request.requestId, "The desktop update coordinator became unavailable.");
      }
      return yield* Deferred.await(reply).pipe(
        Effect.timeoutOption(Duration.minutes(5)),
        Effect.map(
          Option.getOrElse(() =>
            failure(request.requestId, "The desktop update request timed out."),
          ),
        ),
        Effect.tap((response) =>
          response.ok && "status" in response && response.status === "started"
            ? Effect.void
            : finishConfirmation(reservation),
        ),
        Effect.ensuring(clearPending(reservation)),
        Effect.onInterrupt(() => finishConfirmation(reservation)),
      );
    }),
  });
});
export const layer = Layer.effect(DesktopUpdateCommand, make);
