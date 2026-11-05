import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** How long a batch waits for more inputs before it runs short. */
export const BATCH_WAIT = "5 seconds";

/** How long the projection takes over a slow ping. */
export const SLOW = "12 seconds";

/** A group of pings, projected together. */
export const GroupId = Schema.String.pipe(Schema.brand("GroupId"));

export class Pinged extends Domain.Event("Pinged", { group: GroupId, slow: Schema.Boolean }) {}

export class Ping extends Domain.Command("Ping", {
  target: Schema.String,
  input: { group: GroupId, slow: Schema.Boolean },
  events: [Pinged],
}) {}

export class Pinger extends Domain.Aggregate("Pinger", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Ping],
  decide: { Ping: (_, { group, slow }) => [new Pinged({ group, slow })] },
  evolve: { Pinged: (s) => s },
}) {}

export class Pong extends Domain.Event("Pong", { ping: Schema.String }) {}

/** One ordered log per group: a pong for each ping the projection has run. */
export class Pongs extends Domain.Stream("Pongs", { key: GroupId, entries: [Pong] }) {}

/** Answers each group's pings in batches. */
export class PongWriter extends Domain.Projection("PongWriter", {
  from: [Pinger],
  key: GroupId,
  keyOf: { Pinger: ({ event }) => event.group },
  on: [Pinged],
  writes: [Pongs],
}) {}

export const PongWriterLive = PongWriter.toLayer(
  Effect.gen(function* () {
    const pongs = yield* Pongs;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        if (input.event.slow) yield* Effect.sleep(SLOW);
        yield* pongs.append(input, new Pong({ ping: input.source.id }));
      }
    });
  }),
  { batch: { size: 10, wait: BATCH_WAIT } },
);

export class Batches extends Domain.Model("Batches", {
  aggregates: [Pinger],
  projections: [PongWriter],
  streams: [Pongs],
}) {}
