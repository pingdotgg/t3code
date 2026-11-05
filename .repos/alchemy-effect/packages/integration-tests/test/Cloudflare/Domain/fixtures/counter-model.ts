import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";

const CounterId = Schema.String.pipe(Schema.brand("CounterId"));

class Incremented extends Domain.Event("Incremented", { by: Schema.Int }) {}

class Increment extends Domain.Command("Increment", {
  target: CounterId,
  input: { by: Schema.Int },
  events: [Incremented],
}) {}

class Counter extends Domain.Aggregate("Counter", {
  id: CounterId,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Increment],
  decide: {
    Increment: (_, command) => [new Incremented({ by: command.by })],
  },
  evolve: {
    Incremented: (state, event) => ({ total: state.total + event.by }),
  },
}) {}

class Mirrored extends Domain.Event("Mirrored", { by: Schema.Int }) {}

class Mirror extends Domain.Command("Mirror", {
  target: CounterId,
  input: { by: Schema.Int },
  events: [Mirrored],
}) {}

/** What the saga writes, so a test can see that it ran. */
class Echo extends Domain.Aggregate("Echo", {
  id: CounterId,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Mirror],
  decide: {
    Mirror: (_, command) => [new Mirrored({ by: command.by })],
  },
  evolve: {
    Mirrored: (state, event) => ({ total: state.total + event.by }),
  },
}) {}

class CounterTotal extends Domain.View("CounterTotal", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  evolve: {
    Incremented: (view, event) => ({ total: view.total + event.by }),
  },
}) {}

/** Mirrors a counter's first increment onto its Echo; one run per counter. */
class MirrorFirst extends Domain.Saga("MirrorFirst", {
  key: CounterId,
  input: { by: Schema.Int },
}) {}

const MirrorFirstLive = MirrorFirst.toLayer(
  Effect.gen(function* () {
    const echoes = yield* Echo;
    return Effect.fn(function* ({ key, by }) {
      yield* Activity.make({
        name: "mirror",
        execute: echoes.send(key, new Mirror({ by })).pipe(Effect.orDie),
      });
    });
  }),
);

class StartMirror extends Domain.Policy("StartMirror", {
  from: Counter,
  on: [Incremented],
}) {}

const StartMirrorLive = StartMirror.toLayer(
  Effect.gen(function* () {
    const mirrors = yield* MirrorFirst;
    return Effect.fn(function* ({ source, event }) {
      yield* mirrors.start(source, { by: event.by });
    });
  }),
);

/**
 * An aggregate, a view, a policy and a saga, so the model declares every
 * kind of Durable Object the platform hosts, and runs the workflow engine.
 */
export class Counters extends Domain.Model("Counters", {
  aggregates: [Counter, Echo],
  views: [CounterTotal],
  policies: [StartMirror],
  sagas: [MirrorFirst],
}) {}

export const CountersLive = Counters.layer(Layer.mergeAll(StartMirrorLive, MirrorFirstLive));

/**
 * Serves `/increment/:id` and `/state/:id` for a counter, `/total/:id` for
 * its view, `/echo/:id` for what the saga wrote, and `/platform` for which
 * platform the deployed version runs on.
 */
export const serve = (platform: "eu" | "unrestricted") =>
  Effect.gen(function* () {
    const counters = yield* Counter;
    const echoes = yield* Echo;
    const totals = yield* CounterTotal;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, action, id] = new URL(request.url, "http://localhost").pathname.split("/");
        const counter = CounterId.make(id ?? "c-1");
        switch (action) {
          case "platform":
            return yield* HttpServerResponse.json({ platform });
          case "increment":
            yield* counters.send(counter, new Increment({ by: 2 })).pipe(Effect.orDie);
            return yield* HttpServerResponse.json(yield* counters.state(counter));
          case "total": {
            const total = yield* totals.query(Counter.ref(counter)).pipe(Effect.orDie);
            return yield* HttpServerResponse.json(Option.getOrElse(total, () => ({ total: 0 })));
          }
          case "echo":
            return yield* HttpServerResponse.json(yield* echoes.state(counter));
          default:
            return yield* HttpServerResponse.json(yield* counters.state(counter));
        }
      }),
    };
  });
