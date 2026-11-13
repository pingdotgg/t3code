import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// Tours belong to an org. The org-wide views are keyed by the org id itself:
// there is no Org aggregate.
const OrgId = Schema.String.pipe(Schema.brand("OrgId"));
type OrgId = typeof OrgId.Type;

class TourBooked extends Domain.Event("TourBooked", { orgId: OrgId, unit: Schema.String }) {}
class TourCancelled extends Domain.Event("TourCancelled", { orgId: OrgId }) {}

class BookTour extends Domain.Command("BookTour", {
  target: Schema.String,
  input: { orgId: OrgId, unit: Schema.String },
  events: [TourBooked],
}) {}
class CancelTour extends Domain.Command("CancelTour", {
  target: Schema.String,
  input: { orgId: OrgId },
  events: [TourCancelled],
}) {}

class Tour extends Domain.Aggregate("Tour", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [BookTour, CancelTour],
  decide: {
    BookTour: (_, { orgId, unit }) => [new TourBooked({ orgId, unit })],
    CancelTour: (_, { orgId }) => [new TourCancelled({ orgId })],
  },
  evolve: { TourBooked: (s) => s, TourCancelled: (s) => s },
}) {}

class ScheduleChanged extends Domain.Event("ScheduleChanged", { open: Schema.Number }) {}

/** One instance per org: the open tours, by tour id. */
class OrgSchedule extends Domain.View("OrgSchedule", {
  from: [Tour],
  key: OrgId,
  keyOf: { Tour: ({ event }) => event.orgId },
  state: Schema.Struct({ org: Schema.String, tours: Schema.Record(Schema.String, Schema.String) }),
  initial: { org: "", tours: {} },
  evolve: {
    // `key` is the org id itself, not a ref.
    TourBooked: (s, e, { key, source }) => ({
      org: key,
      tours: { ...s.tours, [source.id]: e.unit },
    }),
    TourCancelled: (s, _, { source }) => {
      const { [source.id]: _cancelled, ...tours } = s.tours;
      return { ...s, tours };
    },
  },
  events: [ScheduleChanged],
  emit: {
    Tour: (_, { after }) => new ScheduleChanged({ open: Object.keys(after?.tours ?? {}).length }),
  },
}) {}

/** Keyed by the same schema as its source, so it needs no `keyOf`. */
class OrgBusy extends Domain.View("OrgBusy", {
  from: [OrgSchedule],
  key: OrgId,
  state: Schema.Struct({ org: Schema.String, busy: Schema.Boolean }),
  initial: { org: "", busy: false },
  evolve: {
    ScheduleChanged: (_, e, { source }) => ({ org: source, busy: e.open >= 2 }),
  },
}) {}

class FeedItem extends Domain.Event("FeedItem", { tour: Schema.String, unit: Schema.String }) {}

/** One ordered log per org. */
class OrgFeed extends Domain.Stream("OrgFeed", { key: OrgId, entries: [FeedItem] }) {}

/** Writes each org's feed, one org at a time. */
class OrgFeedWriter extends Domain.Projection("OrgFeedWriter", {
  from: [Tour],
  key: OrgId,
  keyOf: { Tour: ({ event }) => event.orgId },
  on: [TourBooked],
  writes: [OrgFeed],
}) {}
const OrgFeedWriterLive = OrgFeedWriter.toLayer(
  Effect.gen(function* () {
    const feed = yield* OrgFeed;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        // `key` is the org id itself, not a ref.
        const org: OrgId = input.key;
        yield* feed.append(
          input,
          new FeedItem({ tour: input.source.id, unit: `${org}:${input.event.unit}` }),
        );
      }
    });
  }),
);

class Noted extends Domain.Event("Noted", { tour: Schema.String }) {}
class Note extends Domain.Command("Note", {
  target: Schema.String,
  input: { tour: Schema.String },
  events: [Noted],
}) {}
/** An org's bookings, as notes. Its ids are org ids. */
class Board extends Domain.Aggregate("Board", {
  id: Schema.String,
  state: Schema.Struct({ notes: Schema.Array(Schema.String) }),
  initial: { notes: [] },
  commands: [Note],
  decide: { Note: (_, { tour }) => [new Noted({ tour })] },
  evolve: { Noted: (s, e) => ({ notes: [...s.notes, e.tour] }) },
}) {}

/** Runs in each org's order: a policy keyed by the org id. */
class NoteBookings extends Domain.Policy("NoteBookings", {
  from: Tour,
  key: OrgId,
  keyOf: { TourBooked: ({ event }) => event.orgId },
  on: [TourBooked],
}) {}
const NoteBookingsLive = NoteBookings.toLayer(
  Effect.gen(function* () {
    const boards = yield* Board;
    return Effect.fn(function* ({ key, source }) {
      const org: OrgId = key;
      yield* boards.send(org, new Note({ tour: source.id }));
    });
  }),
);

class Tours extends Domain.Model("Tours", {
  aggregates: [Tour, Board],
  views: [OrgSchedule, OrgBusy],
  projections: [OrgFeedWriter],
  streams: [OrgFeed],
  policies: [NoteBookings],
}) {}

const handlers = Layer.mergeAll(OrgFeedWriterLive, NoteBookingsLive);
const story = Story.make(Tours, { layer: handlers });

// A Schema-keyed view is addressed by its value, not by a ref.
// @ts-expect-error a ref is not an OrgId
export const byRef = Story.view(OrgSchedule, Tour.ref("t-1"), Story.none);
// @ts-expect-error a ref is not an OrgId
export const streamedByRef = Story.streamed(OrgFeed, Tour.ref("t-1"));
const acme = OrgId.make("acme");
const globex = OrgId.make("globex");

describe("Domain keyed by a schema", { tags: ["unit", "local"] }, () => {
  it.effect("folds every aggregate's events into the org they name", () =>
    story(
      Story.when(Tour.ref("t-1"), new BookTour({ orgId: acme, unit: "1A" })),
      Story.then(Tour.ref("t-1"), new TourBooked({ orgId: acme, unit: "1A" })),
      Story.when(Tour.ref("t-2"), new BookTour({ orgId: acme, unit: "2B" })),
      Story.then(Tour.ref("t-2"), new TourBooked({ orgId: acme, unit: "2B" })),
      Story.when(Tour.ref("t-3"), new BookTour({ orgId: globex, unit: "9Z" })),
      Story.then(Tour.ref("t-3"), new TourBooked({ orgId: globex, unit: "9Z" })),
      Story.when(Tour.ref("t-1"), new CancelTour({ orgId: acme })),
      Story.then(Tour.ref("t-1"), new TourCancelled({ orgId: acme })),
      Story.view(OrgSchedule, acme, { org: "acme", tours: { "t-2": "2B" } }),
      Story.view(OrgSchedule, globex, { org: "globex", tours: { "t-3": "9Z" } }),
      Story.view(OrgSchedule, OrgId.make("initech"), Story.none),
      Story.emitted(OrgSchedule, acme, [{ open: 1 }, { open: 2 }, { open: 1 }]),
      Story.then(Board.ref("acme"), new Noted({ tour: "t-1" }), new Noted({ tour: "t-2" })),
      Story.then(Board.ref("globex"), new Noted({ tour: "t-3" })),
    ),
  );

  it.effect("a view keyed by the same schema follows it without keyOf", () =>
    story(
      Story.when(Tour.ref("t-1"), new BookTour({ orgId: acme, unit: "1A" })),
      Story.then(Tour.ref("t-1"), new TourBooked({ orgId: acme, unit: "1A" })),
      Story.view(OrgBusy, acme, { org: "acme", busy: false }),
      Story.when(Tour.ref("t-2"), new BookTour({ orgId: acme, unit: "2B" })),
      Story.then(Tour.ref("t-2"), new TourBooked({ orgId: acme, unit: "2B" })),
      Story.view(OrgBusy, acme, { org: "acme", busy: true }),
      Story.view(OrgBusy, globex, Story.none),
      Story.then(Board.ref("acme"), new Noted({ tour: "t-1" }), new Noted({ tour: "t-2" })),
    ),
  );

  it.effect("a projection keyed by the schema writes a stream keyed by it", () =>
    story(
      Story.when(Tour.ref("t-1"), new BookTour({ orgId: acme, unit: "1A" })),
      Story.then(Tour.ref("t-1"), new TourBooked({ orgId: acme, unit: "1A" })),
      Story.when(Tour.ref("t-3"), new BookTour({ orgId: globex, unit: "9Z" })),
      Story.then(Tour.ref("t-3"), new TourBooked({ orgId: globex, unit: "9Z" })),
      Story.when(Tour.ref("t-2"), new BookTour({ orgId: acme, unit: "2B" })),
      Story.then(Tour.ref("t-2"), new TourBooked({ orgId: acme, unit: "2B" })),
      Story.streamed(
        OrgFeed,
        acme,
        new FeedItem({ tour: "t-1", unit: "acme:1A" }),
        new FeedItem({ tour: "t-2", unit: "acme:2B" }),
      ),
      Story.streamed(OrgFeed, globex, new FeedItem({ tour: "t-3", unit: "globex:9Z" })),
      Story.then(Board.ref("acme"), new Noted({ tour: "t-1" }), new Noted({ tour: "t-2" })),
      Story.then(Board.ref("globex"), new Noted({ tour: "t-3" })),
    ),
  );

  it.effect("a policy keyed by the schema gets the value as its key", () =>
    story(
      Story.when(Tour.ref("t-1"), new BookTour({ orgId: acme, unit: "1A" })),
      Story.then(Tour.ref("t-1"), new TourBooked({ orgId: acme, unit: "1A" })),
      Story.when(Tour.ref("t-2"), new BookTour({ orgId: acme, unit: "2B" })),
      Story.then(Tour.ref("t-2"), new TourBooked({ orgId: acme, unit: "2B" })),
      Story.then(Board.ref("acme"), new Noted({ tour: "t-1" }), new Noted({ tour: "t-2" })),
      Story.state(Board.ref("acme"), { notes: ["t-1", "t-2"] }),
    ),
  );

  it.live("is read, watched and listed by its key", () =>
    Effect.gen(function* () {
      const tours = yield* Tour;
      const schedules = yield* OrgSchedule;
      const watched = yield* schedules.watch(acme).pipe(
        Stream.filter(Option.isSome),
        Stream.map((state) => Object.keys(state.value.tours).length),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.sleep("10 millis");
      const first = yield* tours.send("t-1", new BookTour({ orgId: acme, unit: "1A" }));
      const second = yield* tours.send("t-2", new BookTour({ orgId: acme, unit: "2B" }));
      expect(yield* Fiber.join(watched)).toEqual([1, 2]);
      const state = yield* schedules.query(acme, {
        atLeast: { stream: second.stream, version: second.version },
      });
      expect(Option.getOrNull(state)).toEqual({ org: "acme", tours: { "t-1": "1A", "t-2": "2B" } });
      const page = yield* schedules.list(acme, { take: 1 });
      expect(page.entries.map((entry) => entry.envelope.id)).toEqual(["acme"]);
      expect(page.entries.map((entry) => entry.event.open)).toEqual([1]);
      expect(first.stream).toBe("Tour/t-1");
    }).pipe(Effect.scoped, Effect.provide(Tours.layer(handlers).pipe(Layer.provide(InMemory)))),
  );

  it.live("is served through an Api by its key", () =>
    Effect.gen(function* () {
      class TourApi extends Domain.Api("TourApi", {
        model: Tours,
        views: ["OrgSchedule"],
        streams: ["OrgFeed"],
      }) {}
      const client = yield* TourApi.clientInProcess;
      const tours = yield* Tour;
      const receipt = yield* tours.send("t-1", new BookTour({ orgId: acme, unit: "1A" }));
      const atLeast = { stream: receipt.stream, version: receipt.version };
      expect(yield* client.OrgSchedule.get(acme, { atLeast })).toEqual({
        org: "acme",
        tours: { "t-1": "1A" },
      });
      expect(yield* client.OrgSchedule.get(globex)).toBeNull();
      const { entries } = yield* client.OrgSchedule.list(acme);
      expect(entries.map((entry) => entry.event.open)).toEqual([1]);
      const latest = yield* client.OrgFeed.peek(acme, { atLeast });
      expect(latest?.envelope.id).toBe("acme");
      expect(latest?.event).toMatchObject({ tour: "t-1", unit: "acme:1A" });
    }).pipe(Effect.scoped, Effect.provide(Tours.layer(handlers).pipe(Layer.provide(InMemory)))),
  );
});
