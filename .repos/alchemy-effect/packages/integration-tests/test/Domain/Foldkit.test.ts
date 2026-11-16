import * as Domain from "@alchemy.run/domain";
import * as Foldkit from "@alchemy.run/domain/Foldkit";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  Client,
  Counter as CounterAggregate,
  CounterApi,
  CounterId,
  Increment,
} from "./FoldkitCounter.ts";

const Counter = Foldkit.make(CounterApi);
const target = CounterId.make("one");

describe("Domain Foldkit", { tags: ["unit", "local"] }, () => {
  it.live("keeps reply, receipt and the caller's id on success", () =>
    Effect.gen(function* () {
      const result = yield* Counter.Increment({ target, input: { amount: 2 }, commandId: "page:0" })
        .effect;
      expect(result).toEqual({
        _tag: "SucceededIncrement",
        commandId: "page:0",
        reply: { total: 2 },
        receipt: { stream: "Counter/one", version: 1 },
      });
      expect(Schema.is(Counter.Message)(result)).toBe(true);
      const replay = yield* Counter.Increment({ target, input: { amount: 2 }, commandId: "page:0" })
        .effect;
      expect(replay).toEqual(result);
    }).pipe(Effect.provide(Client)),
  );

  it.live("keeps declared rejection fields", () =>
    Effect.gen(function* () {
      const result = yield* Counter.Increment({
        target,
        input: { amount: 11 },
        commandId: "page:1",
      }).effect;
      expect(result).toMatchObject({
        _tag: "FailedIncrement",
        commandId: "page:1",
        failure: { _tag: "Rejected", rejection: { _tag: "Limit", amount: 11 } },
      });
    }).pipe(Effect.provide(Client)),
  );

  it.live("classifies a middleware refusal as Denied", () =>
    Effect.gen(function* () {
      const result = yield* Counter.Reset({ target, input: {}, commandId: "page:2" }).effect;
      expect(result).toMatchObject({
        _tag: "FailedReset",
        failure: { _tag: "Denied", error: { _tag: "Unauthenticated" } },
      });
    }).pipe(Effect.provide(Client)),
  );

  it.live("keeps transport uncertainty and reads headers only during execution", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      let calls = 0;
      const uncertain = Layer.succeed(CounterApi.Client, {
        ...client,
        // The server applies the command; its reply is lost on the way back.
        Increment: (...args: Parameters<typeof client.Increment>) =>
          client.Increment(...args).pipe(
            Effect.andThen(
              Effect.fail(
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    cause: "lost reply",
                    message: "lost reply",
                  }),
                }),
              ),
            ),
          ),
      });
      const command = Counter.Increment({ target, input: { amount: 1 }, commandId: "page:3" });
      expect(calls).toBe(0);
      const result = yield* command.effect.pipe(
        Effect.provide(uncertain),
        Effect.provideService(Foldkit.CommandHeaders, {
          get: () =>
            Effect.sync(() => {
              calls += 1;
              return { "x-mfa-code": "secret" };
            }),
        }),
      );
      expect(calls).toBe(1);
      expect(result).toMatchObject({ _tag: "FailedIncrement", failure: { _tag: "Unknown" } });
      expect(command.args).toEqual({ target, input: { amount: 1 }, commandId: "page:3" });
    }).pipe(Effect.provide(Client)),
  );

  it.live("turns a defect while reading headers into Unknown", () =>
    Effect.gen(function* () {
      const result = yield* Counter.Increment({
        target,
        input: { amount: 1 },
        commandId: "page:4",
      }).effect.pipe(
        Effect.provideService(Foldkit.CommandHeaders, {
          get: () => Effect.die("storage unavailable"),
        }),
      );
      expect(result).toMatchObject({ _tag: "FailedIncrement", failure: { _tag: "Unknown" } });
    }).pipe(Effect.provide(Client)),
  );

  it("allocates ids without changing the prior state", () => {
    const ids = Foldkit.CommandIds.make({ session: "page", sent: 0 });
    expect(Foldkit.next(ids)).toEqual({
      commandId: "page:0",
      commandIds: { session: "page", sent: 1 },
    });
    expect(ids.sent).toBe(0);
  });

  const watched = Counter.Total.watch({
    key: (model: { id: typeof CounterId.Type; cursor: number; online: boolean }) => model.id,
    isEnabled: (model) => model.online,
    toMessage: (snapshot) => ({ _tag: "ReceivedTotal", snapshot }),
    onFailure: () => ({ _tag: "ReceivedTotal", snapshot: { state: Option.none(), cursor: 0 } }),
    onDefect: () => ({ _tag: "ReceivedTotal", snapshot: { state: Option.none(), cursor: 0 } }),
  });

  it.live("watches absent state as None and preserves the cursor", () =>
    watched.dependenciesToStream({ key: target, isEnabled: true }).pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.tap((messages) =>
        Effect.sync(() =>
          expect(messages).toEqual([
            { _tag: "ReceivedTotal", snapshot: { state: Option.none(), cursor: 0 } },
          ]),
        ),
      ),
      Effect.asVoid,
      Effect.provide(Client),
    ),
  );

  it.live("watches a fresh state and cursor after a write", () =>
    Effect.gen(function* () {
      const reply = yield* Counter.Increment({ target, input: { amount: 2 }, commandId: "page:0" })
        .effect;
      if (reply._tag === "SucceededIncrement") {
        const client = yield* CounterApi.Client;
        yield* client.Total.snapshot(target, { atLeast: reply.receipt });
      }
      const messages = yield* watched
        .dependenciesToStream({ key: target, isEnabled: true })
        .pipe(Stream.take(1), Stream.runCollect);
      expect(messages).toEqual([
        { _tag: "ReceivedTotal", snapshot: { state: Option.some({ total: 2 }), cursor: 1 } },
      ]);
    }).pipe(Effect.provide(Client)),
  );

  it("restarts for key or enabled changes and ignores Model cursor changes", () => {
    const model = { id: target, cursor: 0, online: true };
    expect(watched.modelToDependencies(model)).toEqual(
      watched.modelToDependencies({ ...model, cursor: 4 }),
    );
    expect(watched.modelToDependencies(model)).not.toEqual(
      watched.modelToDependencies({ ...model, id: CounterId.make("two") }),
    );
  });

  it.live("does not open a disabled watch", () =>
    watched.dependenciesToStream({ key: target, isEnabled: false }).pipe(
      Stream.runCollect,
      Effect.tap((messages) => Effect.sync(() => expect(messages).toEqual([]))),
      Effect.asVoid,
      Effect.provide(Client),
    ),
  );

  type FeedModel = { id: typeof CounterId.Type; cursor: Option.Option<number>; online: boolean };
  const feed = Counter.Total.events({
    key: (model: FeedModel) => model.id,
    cursor: (model) => model.cursor,
    isEnabled: (model) => model.online,
    onEntry: (entry) => `entry:${entry.envelope.seq}:${entry.envelope.commandId}`,
    onCaughtUp: (cursor) => `caught:${cursor}`,
    onFailure: (error) => `failed:${error._tag}`,
    onDefect: () => "defect",
  });
  const dependencies = { key: target, cursor: Option.none<number>(), isEnabled: true };

  it.live("resumes from the latest Model cursor and preserves source command ids", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const receipt = yield* client.Increment(target, { amount: 2 }, { commandId: "page:0" });
      yield* client.Increment(target, { amount: 3 }, { commandId: "page:1" });
      yield* client.Total.snapshot(target, { atLeast: { stream: receipt.stream, version: 2 } });
      const messages = yield* feed
        .dependenciesToStream(dependencies, () => ({ ...dependencies, cursor: Option.some(1) }))
        .pipe(Stream.take(2), Stream.runCollect);
      expect(messages).toEqual(["entry:2:page:1", "caught:2"]);
    }).pipe(Effect.provide(Client)),
  );

  it.live("drops duplicate entries while allowing gaps in filtered feeds", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const receipt = yield* client.Increment(target, { amount: 2 }, { commandId: "page:0" });
      yield* client.Total.snapshot(target, { atLeast: receipt });
      const frames = yield* client.Total.events(target).pipe(Stream.take(2), Stream.runCollect);
      const entries = frames.filter(Domain.Read.isEvent);
      const replay = entries.flatMap((entry) => [
        entry,
        entry,
        { ...entry, envelope: { ...entry.envelope, seq: 5 } },
      ]);
      const source = Layer.succeed(CounterApi.Client, {
        ...client,
        Total: { ...client.Total, events: () => Stream.fromIterable(replay) },
      });
      const messages = yield* feed
        .dependenciesToStream(dependencies, () => dependencies)
        .pipe(Stream.runCollect, Effect.provide(source));
      expect(messages).toEqual(["entry:1:page:0", "entry:5:page:0"]);
    }).pipe(Effect.provide(Client)),
  );

  it("keeps the event stream alive across cursor changes", () => {
    expect(
      feed.keepAliveEquivalence(dependencies, { ...dependencies, cursor: Option.some(5) }),
    ).toBe(true);
    expect(
      feed.keepAliveEquivalence(dependencies, { ...dependencies, key: CounterId.make("two") }),
    ).toBe(false);
    expect(feed.keepAliveEquivalence(dependencies, { ...dependencies, isEnabled: false })).toBe(
      false,
    );
  });

  it("decodes snapshot Flags and falls back when their state Schema changed", () => {
    expect(Counter.Total.decodeSnapshotFlags({ state: { total: 4 }, cursor: 7 })).toEqual(
      Option.some({ state: Option.some({ total: 4 }), cursor: 7 }),
    );
    expect(Counter.Total.decodeSnapshotFlags({ state: null, cursor: 0 })).toEqual(
      Option.some({ state: Option.none(), cursor: 0 }),
    );
    expect(Counter.Total.decodeSnapshotFlags({ state: { oldTotal: 4 }, cursor: 7 })).toEqual(
      Option.none(),
    );
    expect(Counter.Total.decodeSnapshotFlags({ state: null, cursor: -1 })).toEqual(Option.none());
    expect(Counter.Total.decodeSnapshotFlags(undefined)).toEqual(Option.none());
  });

  it("can restart a failed Flags cursor without changing the View key", () => {
    expect(
      feed.keepAliveEquivalence(
        { ...dependencies, restartKey: 0 },
        { ...dependencies, cursor: Option.none(), restartKey: 1 },
      ),
    ).toBe(false);
  });

  it.live("turns a mid-stream validate refusal into an app Message", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const read = Counter.Total.watch({
        key: () => target,
        toMessage: (snapshot) => `snapshot:${snapshot.cursor}`,
        onFailure: (error) => `failed:${error._tag}`,
        onDefect: () => "defect",
      });
      const watch = yield* read.dependenciesToStream({ key: target, isEnabled: true }).pipe(
        Stream.tap(() => Deferred.succeed(started, undefined)),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Counter.Increment({ target, input: { amount: 6 }, commandId: "page:0" }).effect;
      expect(yield* Fiber.join(watch)).toEqual(["snapshot:0", "failed:Limit"]);
      const messages = yield* feed
        .dependenciesToStream(dependencies, () => dependencies)
        .pipe(Stream.runCollect);
      expect(messages).toEqual(["failed:Limit"]);
    }).pipe(Effect.scoped, Effect.provide(Client)),
  );

  it.live("maps command defects to Unknown and preserves interruption", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const command = Counter.Increment({ target, input: { amount: 1 }, commandId: "page:die" });
      const source = Layer.succeed(CounterApi.Client, {
        ...client,
        Increment: (...args: Parameters<typeof client.Increment>) =>
          client.Increment(...args).pipe(Effect.andThen(Effect.die("storage failed"))),
      });
      const result = yield* command.effect.pipe(Effect.provide(source));
      expect(result).toMatchObject({ _tag: "FailedIncrement", failure: { _tag: "Unknown" } });
      const interrupted = Layer.succeed(CounterApi.Client, {
        ...client,
        Increment: (...args: Parameters<typeof client.Increment>) =>
          client.Increment(...args).pipe(Effect.andThen(Effect.interrupt)),
      });
      const exit = yield* command.effect.pipe(Effect.provide(interrupted), Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      }
    }).pipe(Effect.provide(Client)),
  );

  it.live("turns watch and event defects into Messages", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const source = Layer.succeed(CounterApi.Client, {
        ...client,
        Total: {
          ...client.Total,
          watch: (...args: Parameters<typeof client.Total.watch>) =>
            client.Total.watch(...args).pipe(
              Stream.take(1),
              Stream.concat(Stream.die("watch failed")),
            ),
          events: (...args: Parameters<typeof client.Total.events>) =>
            client.Total.events(...args).pipe(
              Stream.take(1),
              Stream.concat(Stream.die("events failed")),
            ),
        },
      });
      const read = Counter.Total.watch({
        key: () => target,
        toMessage: () => "snapshot",
        onFailure: () => "failure",
        onDefect: (cause) => (Cause.pretty(cause).includes("watch failed") ? "defect" : "other"),
      });
      expect(
        yield* read
          .dependenciesToStream({ key: target, isEnabled: true })
          .pipe(Stream.runCollect, Effect.provide(source)),
      ).toEqual(["snapshot", "defect"]);
      expect(
        yield* feed
          .dependenciesToStream(dependencies, () => dependencies)
          .pipe(Stream.runCollect, Effect.provide(source)),
      ).toEqual(["caught:0", "defect"]);
    }).pipe(Effect.provide(Client)),
  );

  it.live("preserves interruption in watch and event streams", () =>
    Effect.gen(function* () {
      const client = yield* CounterApi.Client;
      const source = Layer.succeed(CounterApi.Client, {
        ...client,
        Total: {
          ...client.Total,
          watch: (...args: Parameters<typeof client.Total.watch>) =>
            client.Total.watch(...args).pipe(
              Stream.take(1),
              Stream.concat(Stream.fromEffect(Effect.interrupt)),
            ),
          events: (...args: Parameters<typeof client.Total.events>) =>
            client.Total.events(...args).pipe(
              Stream.take(1),
              Stream.concat(Stream.fromEffect(Effect.interrupt)),
            ),
        },
      });
      const reads = [
        watched.dependenciesToStream({ key: target, isEnabled: true }).pipe(Stream.runDrain),
        feed.dependenciesToStream(dependencies, () => dependencies).pipe(Stream.runDrain),
      ];
      for (const read of reads) {
        const exit = yield* read.pipe(Effect.provide(source), Effect.exit);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }
    }).pipe(Effect.provide(Client)),
  );

  it.live("watches Aggregate state and follows committed events", () =>
    Effect.gen(function* () {
      yield* Counter.Increment({ target, input: { amount: 3 }, commandId: "page:aggregate" })
        .effect;
      const watch = Counter.Counter.watch({
        key: () => target,
        toMessage: (snapshot) => snapshot,
        onFailure: () => ({ state: Option.none(), cursor: -1 }),
        onDefect: () => ({ state: Option.none(), cursor: -1 }),
      });
      const snapshots = yield* watch
        .dependenciesToStream({ key: target, isEnabled: true })
        .pipe(Stream.take(1), Stream.runCollect);
      expect(snapshots).toEqual([{ state: Option.some({ total: 3 }), cursor: 1 }]);
      const feed = Counter.Counter.events({
        key: () => target,
        cursor: () => Option.none(),
        onEntry: (entry) => entry.event.amount,
        onCaughtUp: (cursor) => cursor,
        onFailure: () => -1,
        onDefect: () => -1,
      });
      const dependencies = feed.modelToDependencies(undefined);
      const events = yield* feed
        .dependenciesToStream(dependencies, () => dependencies)
        .pipe(Stream.take(2), Stream.runCollect);
      expect(events).toEqual([3, 1]);
    }).pipe(Effect.provide(Client)),
  );

  it.live("watches Stream absence and reports CaughtUp", () =>
    Effect.gen(function* () {
      const watch = Counter.Outputs.watch({
        key: () => target,
        toMessage: (snapshot) => snapshot,
        onFailure: () => ({ state: Option.none(), cursor: -1 }),
        onDefect: () => ({ state: Option.none(), cursor: -1 }),
      });
      const snapshots = yield* watch
        .dependenciesToStream({ key: target, isEnabled: true })
        .pipe(Stream.take(1), Stream.runCollect);
      expect(snapshots).toEqual([{ state: Option.none(), cursor: 0 }]);
      const feed = Counter.Outputs.events({
        key: () => target,
        cursor: () => Option.none(),
        onEntry: (entry) => entry.event.amount,
        onCaughtUp: (cursor) => cursor,
        onFailure: () => -1,
        onDefect: () => -1,
      });
      const dependencies = feed.modelToDependencies(undefined);
      const events = yield* feed
        .dependenciesToStream(dependencies, () => dependencies)
        .pipe(Stream.take(1), Stream.runCollect);
      expect(events).toEqual([0]);
    }).pipe(Effect.provide(Client)),
  );

  it("reserves Message for command results", () => {
    class MessageView extends Domain.View("Message", {
      from: [],
      key: Schema.String,
      state: Schema.Number,
      initial: 0,
    }) {}
    class Collision extends Domain.Model("Collision", {
      aggregates: [CounterAggregate],
      views: [MessageView],
    }) {}
    class CollisionApi extends Domain.Api("CollisionApi", {
      model: Collision,
      commands: ["Increment"],
      views: ["Message"],
    }) {}
    // @ts-expect-error Message is reserved for command results
    const collision = Foldkit.make(CollisionApi);
    expect("watch" in collision.Message).toBe(false);
    expect(
      Schema.is(collision.Message)({
        _tag: "FailedIncrement",
        commandId: "page:0",
        failure: { _tag: "Unknown" },
      }),
    ).toBe(true);
  });
});
