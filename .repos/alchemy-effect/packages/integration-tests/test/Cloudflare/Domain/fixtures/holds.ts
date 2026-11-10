import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** How long a hold lasts before it expires, unless it is released first. */
export const HOLD_WINDOW = "15 seconds";

/** The command id a hold's expiry is scheduled under. */
export const EXPIRY = "expire";

export class HoldPlaced extends Domain.Event("HoldPlaced") {}
export class HoldReleased extends Domain.Event("HoldReleased") {}
export class HoldExpired extends Domain.Event("HoldExpired") {}

export class PlaceHold extends Domain.Command("PlaceHold", {
  target: Schema.String,
  events: [HoldPlaced],
}) {}
export class ReleaseHold extends Domain.Command("ReleaseHold", {
  target: Schema.String,
  events: [HoldReleased],
}) {}
/**
 * Records the expiry with no guard on state: only cancelling the schedule
 * keeps a released hold from expiring.
 */
export class ExpireHold extends Domain.Command("ExpireHold", {
  target: Schema.String,
  events: [HoldExpired],
}) {}

export class Hold extends Domain.Aggregate("Hold", {
  id: Schema.String,
  state: Schema.Struct({ status: Schema.Literals(["none", "held", "released", "expired"]) }),
  initial: { status: "none" },
  commands: [PlaceHold, ReleaseHold, ExpireHold],
  decide: {
    PlaceHold: () => [new HoldPlaced()],
    ReleaseHold: () => [new HoldReleased()],
    ExpireHold: () => [new HoldExpired()],
  },
  evolve: {
    HoldPlaced: () => ({ status: "held" as const }),
    HoldReleased: () => ({ status: "released" as const }),
    HoldExpired: () => ({ status: "expired" as const }),
  },
}) {}

/** Schedules a hold's expiry when it is placed, and cancels it when it is released. */
export class HoldDeadline extends Domain.Policy("HoldDeadline", {
  from: Hold,
  on: [HoldPlaced, HoldReleased],
}) {}

export const HoldDeadlineLive = HoldDeadline.toLayer(
  Effect.gen(function* () {
    const holds = yield* Hold;
    return Effect.fn(function* ({ source, event }) {
      if (event._tag === "HoldPlaced") {
        yield* holds
          .schedule(source, new ExpireHold(), { after: HOLD_WINDOW, commandId: EXPIRY })
          // a redelivery after the expiry ran: nothing to arm
          .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
      } else {
        yield* holds.unschedule(source, EXPIRY).pipe(
          // the hold expired first, and the release is recorded after it; a
          // redelivery, so the expiry is already cancelled; or the hold was
          // never placed, so there's no expiry
          Effect.catchTag(
            ["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"],
            () => Effect.void,
          ),
        );
      }
    });
  }),
);

export class Holds extends Domain.Model("Holds", {
  aggregates: [Hold],
  policies: [HoldDeadline],
}) {}
