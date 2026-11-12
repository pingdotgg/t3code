import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

// A hold that expires an hour after it is placed, unless it is released first.
class HoldPlaced extends Domain.Event("HoldPlaced") {}
class HoldReleased extends Domain.Event("HoldReleased") {}
class HoldExpired extends Domain.Event("HoldExpired") {}

class PlaceHold extends Domain.Command("PlaceHold", {
  target: Schema.String,
  events: [HoldPlaced],
}) {}
class ReleaseHold extends Domain.Command("ReleaseHold", {
  target: Schema.String,
  events: [HoldReleased],
}) {}
/**
 * Records the expiry with no guard on state: only cancelling the schedule
 * keeps a released hold from expiring.
 */
class ExpireHold extends Domain.Command("ExpireHold", {
  target: Schema.String,
  events: [HoldExpired],
}) {}

class Hold extends Domain.Aggregate("Hold", {
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

/** The schedule key of a hold's expiry. */
const expiryOf = (id: string) => `expire:${id}`;

class HoldDeadline extends Domain.Policy("HoldDeadline", {
  from: Hold,
  on: [HoldPlaced, HoldReleased],
}) {}
const HoldDeadlineLive = HoldDeadline.toLayer(
  Effect.gen(function* () {
    const holds = yield* Hold;
    return Effect.fn(function* ({ source, event }) {
      if (event._tag === "HoldPlaced") {
        yield* holds
          .schedule(source, new ExpireHold(), { after: "1 hour", commandId: expiryOf(source.id) })
          // a redelivery after the expiry ran: nothing to arm
          .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
      } else {
        yield* holds.unschedule(source, expiryOf(source.id)).pipe(
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

class Holds extends Domain.Model("Holds", {
  aggregates: [Hold],
  policies: [HoldDeadline],
}) {}

const story = Story.make(Holds, { layer: HoldDeadlineLive });
const HoldsLive = Holds.layer(HoldDeadlineLive).pipe(Layer.provide(InMemory));
const h1 = Hold.ref("h-1");
const h2 = Hold.ref("h-2");

describe("Domain schedule", { tags: ["unit", "local"] }, () => {
  it.effect("a scheduled command fires when it is due", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(h1, new PlaceHold()),
      Story.then(h1, new HoldPlaced()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(h1, new HoldExpired()),
    ),
  );

  it.effect("an unscheduled command never fires", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(h1, new PlaceHold()),
      Story.when(h1, new ReleaseHold()),
      Story.then(h1, new HoldPlaced(), new HoldReleased()),
      Story.clock("2026-01-01T02:00:00Z"),
      Story.then(h1),
      Story.state(h1, (s) => expect(s.status).toBe("released")),
    ),
  );

  it.effect("unscheduling cancels only that instance's command", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(h1, new PlaceHold()),
      Story.when(h2, new PlaceHold()),
      Story.when(h1, new ReleaseHold()),
      Story.then(h1, new HoldPlaced(), new HoldReleased()),
      Story.then(h2, new HoldPlaced()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(h1),
      Story.then(h2, new HoldExpired()),
    ),
  );

  it.effect("a release after the command fired is still recorded", () =>
    story(
      Story.clock("2026-01-01T00:00:00Z"),
      Story.when(h1, new PlaceHold()),
      Story.clock("2026-01-01T01:00:00Z"),
      Story.then(h1, new HoldPlaced(), new HoldExpired()),
      Story.when(h1, new ReleaseHold()),
      Story.then(h1, new HoldReleased()),
    ),
  );

  it.live("an unscheduled command never fires on the real clock", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      yield* holds.schedule("h-3", new ExpireHold(), { after: "20 millis", commandId: "x" });
      yield* holds.schedule("h-4", new ExpireHold(), { after: "20 millis", commandId: "x" });
      yield* holds.unschedule("h-3", "x");
      yield* Effect.sleep("100 millis");
      expect((yield* holds.state("h-3")).status).toBe("none");
      expect((yield* holds.state("h-4")).status).toBe("expired");
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("schedule returns the command id and when it is due, to cancel it by", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      const before = yield* Effect.sync(() => Date.now());
      const receipt = yield* holds.schedule("h-9", new ExpireHold(), { after: "1 hour" });
      const at = DateTime.toEpochMillis(receipt.at);
      expect(at).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(at).toBeLessThan(before + 3_600_000 + 1_000);
      yield* holds.unschedule("h-9", receipt.commandId);
      const fixed = yield* holds.schedule("h-9", new ExpireHold(), {
        at: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
        commandId: "x",
      });
      expect(fixed).toEqual({ commandId: "x", at: DateTime.makeUnsafe("2030-01-01T00:00:00Z") });
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("unscheduling a command that ran fails with AlreadyExecuted", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      yield* holds.schedule("h-5", new ExpireHold(), { after: "20 millis", commandId: "x" });
      yield* Effect.sleep("100 millis");
      const error = yield* Effect.flip(holds.unschedule("h-5", "x"));
      expect(error).toEqual(
        new Domain.AlreadyExecuted({ aggregate: "Hold", id: "h-5", commandId: "x" }),
      );
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("scheduling a command id that was already sent fails with AlreadyExecuted", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      yield* holds.send("h-6", new PlaceHold(), { commandId: "x" });
      const error = yield* Effect.flip(
        holds.schedule("h-6", new ExpireHold(), { after: "1 hour", commandId: "x" }),
      );
      expect(error._tag).toBe("AlreadyExecuted");
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("unscheduling again fails with AlreadyCancelled, until it is scheduled again", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      yield* holds.schedule("h-7", new ExpireHold(), { after: "1 hour", commandId: "x" });
      yield* holds.unschedule("h-7", "x");
      expect((yield* Effect.flip(holds.unschedule("h-7", "x")))._tag).toBe("AlreadyCancelled");
      yield* holds.schedule("h-7", new ExpireHold(), { after: "1 hour", commandId: "x" });
      yield* holds.unschedule("h-7", "x");
    }).pipe(Effect.provide(HoldsLive)),
  );

  it.live("unscheduling an id that was never scheduled fails with NotScheduled", () =>
    Effect.gen(function* () {
      const holds = yield* Hold;
      const error = yield* Effect.flip(holds.unschedule("h-8", "never"));
      expect(error).toEqual(
        new Domain.NotScheduled({ aggregate: "Hold", id: "h-8", commandId: "never" }),
      );
    }).pipe(Effect.provide(HoldsLive)),
  );
});
