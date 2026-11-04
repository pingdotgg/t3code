import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Tours belong to an org; there is no Org aggregate, the org views are keyed by its id. */
export const OrgId = Schema.String.pipe(Schema.brand("OrgId"));

export class TourBooked extends Domain.Event("TourBooked", {
  orgId: OrgId,
  unit: Schema.String,
}) {}
export class TourCancelled extends Domain.Event("TourCancelled", { orgId: OrgId }) {}

export class BookTour extends Domain.Command("BookTour", {
  target: Schema.String,
  input: { orgId: OrgId, unit: Schema.String },
  events: [TourBooked],
}) {}
export class CancelTour extends Domain.Command("CancelTour", {
  target: Schema.String,
  input: { orgId: OrgId },
  events: [TourCancelled],
}) {}

export class Tour extends Domain.Aggregate("Tour", {
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

export class ScheduleChanged extends Domain.Event("ScheduleChanged", { open: Schema.Number }) {}

/** One instance per org: its open tours, by tour id. */
export class OrgSchedule extends Domain.View("OrgSchedule", {
  from: [Tour],
  key: OrgId,
  keyOf: { Tour: ({ event }) => event.orgId },
  state: Schema.Struct({ org: Schema.String, tours: Schema.Record(Schema.String, Schema.String) }),
  initial: { org: "", tours: {} },
  evolve: {
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

/** Keyed by the same schema as OrgSchedule, so it follows it without `keyOf`. */
export class OrgBusy extends Domain.View("OrgBusy", {
  from: [OrgSchedule],
  key: OrgId,
  state: Schema.Struct({ org: Schema.String, busy: Schema.Boolean }),
  initial: { org: "", busy: false },
  evolve: {
    ScheduleChanged: (_, e, { source }) => ({ org: source, busy: e.open >= 2 }),
  },
}) {}

export class FeedItem extends Domain.Event("FeedItem", {
  tour: Schema.String,
  unit: Schema.String,
}) {}

/** One ordered log per org. */
export class OrgFeed extends Domain.Stream("OrgFeed", { key: OrgId, entries: [FeedItem] }) {}

/** Writes each org's feed; `key` is the org id. */
export class OrgFeedWriter extends Domain.Projection("OrgFeedWriter", {
  from: [Tour],
  key: OrgId,
  keyOf: { Tour: ({ event }) => event.orgId },
  on: [TourBooked],
  writes: [OrgFeed],
}) {}
export const OrgFeedWriterLive = OrgFeedWriter.toLayer(
  Effect.gen(function* () {
    const feed = yield* OrgFeed;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        yield* feed.append(input, new FeedItem({ tour: input.source.id, unit: input.event.unit }));
      }
    });
  }),
);

export class Noted extends Domain.Event("Noted", { tour: Schema.String }) {}
export class Note extends Domain.Command("Note", {
  target: Schema.String,
  input: { tour: Schema.String },
  events: [Noted],
}) {}
/** An org's bookings, as notes. Its ids are org ids. */
export class Board extends Domain.Aggregate("Board", {
  id: Schema.String,
  state: Schema.Struct({ notes: Schema.Array(Schema.String) }),
  initial: { notes: [] },
  commands: [Note],
  decide: { Note: (_, { tour }) => [new Noted({ tour })] },
  evolve: { Noted: (s, e) => ({ notes: [...s.notes, e.tour] }) },
}) {}

/** A policy keyed by the org id: bookings of one org run in order. */
export class NoteBookings extends Domain.Policy("NoteBookings", {
  from: Tour,
  key: OrgId,
  keyOf: { TourBooked: ({ event }) => event.orgId },
  on: [TourBooked],
}) {}
export const NoteBookingsLive = NoteBookings.toLayer(
  Effect.gen(function* () {
    const boards = yield* Board;
    return Effect.fn(function* ({ key, source }) {
      yield* boards.send(key, new Note({ tour: source.id }));
    });
  }),
);

export class Tours extends Domain.Model("Tours", {
  aggregates: [Tour, Board],
  views: [OrgSchedule, OrgBusy],
  projections: [OrgFeedWriter],
  streams: [OrgFeed],
  policies: [NoteBookings],
}) {}
