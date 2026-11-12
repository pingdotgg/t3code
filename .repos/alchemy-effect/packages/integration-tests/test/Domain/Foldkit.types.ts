import * as Domain from "@alchemy.run/domain";
import * as Foldkit from "@alchemy.run/domain/Foldkit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CounterApi, CounterId, Limit, Unauthenticated } from "./FoldkitCounter.ts";

const Counter = Foldkit.make(CounterApi);
const target = CounterId.make("one");
Counter.Reset({ target, input: {}, commandId: "page:0" });
Counter.Increment({ target, input: { amount: 1 }, commandId: "page:1" });
// @ts-expect-error the target is branded
Counter.Increment({ target: "one", input: { amount: 1 }, commandId: "page:1" });
// @ts-expect-error input uses the decoded side of the transform
Counter.Increment({ target, input: { amount: "1" }, commandId: "page:1" });
// @ts-expect-error required command input cannot be omitted
Counter.Increment({ target, commandId: "page:1" });

const check = (message: typeof Counter.Message.Type) =>
  Counter.Message.match<void>(message, {
    SucceededIncrement: ({ reply }) => {
      const total: number = reply.total;
      void total;
    },
    FailedIncrement: ({ failure }) => {
      if (failure._tag === "Rejected") {
        const rejection: typeof Limit.Type = failure.rejection;
        void rejection;
      }
    },
    SucceededReset: ({ reply }) => {
      const empty: void = reply;
      void empty;
    },
    FailedReset: ({ failure }) => {
      if (failure._tag === "Denied") {
        const denied: Unauthenticated = failure.error;
        void denied;
      }
    },
  });
const schema: Schema.Top = Counter.Message;
const requirements: Effect.Effect<
  typeof Counter.Message.Type,
  never,
  typeof CounterApi.Client.Identifier
> = Counter.Increment({ target, input: { amount: 1 }, commandId: "page:1" }).effect;
void check;
void schema;
void requirements;

// @ts-expect-error only Api read names are exposed
Counter.UnknownView.watch({});
const watchOptions = {
  key: (_model: { id: typeof CounterId.Type }) => target,
  toMessage: (snapshot: Foldkit.Snapshot<{ readonly total: number }>) => snapshot.cursor,
  onFailure: (
    _error: Domain.Api.ReadError<typeof import("./FoldkitCounter.ts").Total.definition>,
  ) => 0,
  onDefect: () => 0,
};
Counter.Total.watch(watchOptions);
// @ts-expect-error read keys preserve their brand
Counter.Total.watch({ ...watchOptions, key: () => "one" });
Counter.Total.watch({
  ...watchOptions,
  // @ts-expect-error snapshot state has the View state type
  toMessage: (snapshot: Foldkit.Snapshot<string>) => snapshot.cursor,
});
Counter.Total.watch<{ id: typeof CounterId.Type }, number>({
  ...watchOptions,
  // @ts-expect-error all callbacks produce the selected Message type
  onDefect: () => "failed",
});
Counter.Counter.watch(watchOptions);
Counter.Counter.events({
  key: () => target,
  cursor: () => Option.none(),
  onEntry: (entry) => {
    const amount: number = entry.event.amount;
    return amount;
  },
  onCaughtUp: (cursor) => cursor,
  onFailure: () => 0,
  onDefect: () => 0,
});
Counter.Outputs.watch({
  key: () => target,
  toMessage: (snapshot) =>
    Option.match(snapshot.state, { onNone: () => 0, onSome: (entry) => entry.event.amount }),
  onFailure: () => 0,
  onDefect: () => 0,
});
Counter.Outputs.events({
  key: () => target,
  cursor: () => Option.none(),
  onEntry: (entry) => entry.event.amount,
  onCaughtUp: (cursor) => cursor,
  onFailure: () => 0,
  onDefect: () => 0,
});
const flags: Option.Option<{
  readonly state: Option.Option<{ readonly total: number }>;
  readonly cursor: number;
}> = Counter.Total.decodeSnapshotFlags({});
void flags;
class MessageView extends Domain.View("Message", {
  key: CounterId,
  state: Schema.Number,
  initial: 0,
  from: [],
}) {}
class Collision extends Domain.Model("Collision", { aggregates: [], views: [MessageView] }) {}
class CollisionApi extends Domain.Api("CollisionApi", {
  model: Collision,
  views: ["Message"],
}) {}
// @ts-expect-error Message is reserved for command results
Foldkit.make(CollisionApi);

const decodedFlags = Schema.decodeUnknownOption(Counter.Total.SnapshotFlags)({});
void decodedFlags;
Counter.Total.events({
  key: () => target,
  // @ts-expect-error cursors use Option<number>
  cursor: () => 1,
  onEntry: (entry) => entry.envelope.seq,
  onCaughtUp: (cursor) => cursor,
  onFailure: () => 0,
  onDefect: () => 0,
});
