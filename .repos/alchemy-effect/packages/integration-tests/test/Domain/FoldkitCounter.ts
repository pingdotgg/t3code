import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

export const CounterId = Schema.String.pipe(Schema.brand("CounterId"));
export class Limit extends Domain.Rejection("Limit", { amount: Schema.Number }) {}
export class Unauthenticated extends Schema.TaggedError<
  Unauthenticated,
  { readonly brand: unique symbol }
>()("Unauthenticated", {}) {}
export class Session extends RpcMiddleware.Service<Session>()("FoldkitTest/Session", {
  error: Unauthenticated,
}) {}
export class Incremented extends Domain.Event("Incremented", { amount: Schema.Number }) {}
export class Increment extends Domain.Command("Increment", {
  target: CounterId,
  input: { amount: Schema.NumberFromString },
  events: [Incremented],
  rejects: [Limit],
  reply: { total: Schema.Number },
}) {}
export class Reset extends Domain.Command("Reset", {
  target: CounterId,
  events: [Incremented],
  middleware: [Session],
}) {}
export class Counter extends Domain.Aggregate("Counter", {
  id: CounterId,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  commands: [Increment, Reset],
  read: {},
  decide: {
    Increment: (_, { amount }) =>
      amount > 10 ? new Limit({ amount }) : [Incremented.make({ amount })],
    Reset: (state) => [Incremented.make({ amount: -state.total })],
  },
  evolve: { Incremented: (state, { amount }) => ({ total: state.total + amount }) },
  reply: { Increment: (state) => ({ total: state.total }) },
}) {}
export class Total extends Domain.View("Total", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Incremented: (state, { amount }) => ({ total: state.total + amount }) },
  events: [Incremented],
  rejects: [Limit],
  validate: (_, state) =>
    state && state.total > 5 ? Effect.fail(new Limit({ amount: state.total })) : Effect.void,
}) {}
export class Outputs extends Domain.Stream("Outputs", { key: Counter, entries: [Incremented] }) {}
export class Counters extends Domain.Model("Counters", {
  aggregates: [Counter],
  views: [Total],
  streams: [Outputs],
}) {}
export class CounterApi extends Domain.Api("CounterApi", {
  model: Counters,
  commands: ["Increment", "Reset"],
  views: ["Total"],
  streams: ["Outputs"],
  aggregates: ["Counter"],
}) {}
export const Hosted = Counters.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory));
export const Client = CounterApi.layerClientInProcess.pipe(
  Layer.provide(
    Layer.merge(
      Hosted,
      Layer.succeed(Session, () => Effect.fail(Unauthenticated.make({}))),
    ),
  ),
);
