import { ArtifactStore } from "alchemy/Artifacts";
import { Stack } from "alchemy/Stack";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export interface EchoClient {
  echo: (msg: string) => Effect.Effect<string>;
  processId: () => Effect.Effect<number>;
  env: (key: string) => Effect.Effect<string | undefined>;
  boom: () => Effect.Effect<never, { _tag: "Boom"; msg: string }>;
  identity: () => Effect.Effect<{ name: string; stage: string }>;
  stats: () => Effect.Effect<{
    active: number;
    built: number;
    finalized: number;
  }>;
  retainArtifact: () => Effect.Effect<void>;
  artifactCount: () => Effect.Effect<number>;
  blockedCall: (label: string) => Effect.Effect<void>;
  tail: (label: string) => Stream.Stream<void>;
  callSnapshot: (label: string) => Effect.Effect<CallSnapshot | undefined>;
  unblockCall: (label: string) => Effect.Effect<void>;
}

export interface CallSnapshot {
  readonly events: string[];
  readonly mutations: number;
  readonly artifacts: number;
}

interface TrackedCall {
  readonly events: string[];
  readonly gate: Deferred.Deferred<void>;
  readonly bag: Map<string, unknown>;
  mutations: number;
}

const calls = new Map<string, TrackedCall>();

export class TestEcho extends Context.Service<TestEcho, EchoClient>()("Test.Echo") {}

let active = 0;
let built = 0;
let finalized = 0;

export const makeEcho = (blocked = false) =>
  Layer.effect(
    TestEcho,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const artifacts = yield* ArtifactStore;
      const bag = new Map<string, unknown>();
      const labels = new Set<string>();
      let alive = true;
      const blockedCall = Effect.fn(function* (label: string) {
        const gate = yield* Deferred.make<void>();
        const call: TrackedCall = { events: [], gate, bag, mutations: 0 };
        yield* Effect.scoped(
          Effect.acquireRelease(
            Effect.sync(() => {
              calls.set(label, call);
              labels.add(label);
              call.events.push("started");
            }),
            () =>
              Effect.sleep("50 millis").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    call.events.push(`call-finalized:${alive ? "live" : "closed"}`);
                    bag.set(label, "finalizer-artifact");
                    artifacts.set("fixture", bag);
                  }),
                ),
              ),
          ).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(
              Effect.sync(() => {
                call.mutations++;
                bag.set(label, "late-mutation");
                artifacts.set("fixture", bag);
              }),
            ),
          ),
        );
      });
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          active++;
          built++;
        }),
        () =>
          Effect.sync(() => {
            alive = false;
            active--;
            finalized++;
            for (const label of labels) calls.get(label)?.events.push("provider-finalized");
          }),
      );
      if (blocked) yield* Effect.never;
      return TestEcho.of({
        echo: (msg) => Effect.succeed(`echo:${msg}`),
        processId: () => Effect.sync(() => process.pid),
        env: (key) => Effect.sync(() => process.env[key]),
        boom: () => Effect.fail({ _tag: "Boom" as const, msg: "kaboom" }),
        identity: () => Effect.succeed({ name: stack.name, stage: stack.stage }),
        stats: () => Effect.sync(() => ({ active, built, finalized })),
        retainArtifact: () =>
          Effect.sync(() => {
            bag.set("payload", new Uint8Array(1024));
            artifacts.set("fixture", bag);
          }),
        artifactCount: () => Effect.sync(() => bag.size),
        blockedCall,
        tail: (label) => Stream.fromEffect(blockedCall(label)),
        callSnapshot: (label) =>
          Effect.sync(() => {
            const call = calls.get(label);
            return call === undefined
              ? undefined
              : {
                  events: [...call.events],
                  mutations: call.mutations,
                  artifacts: call.bag.size,
                };
          }),
        unblockCall: (label) =>
          Effect.suspend(() => {
            const call = calls.get(label);
            return call === undefined
              ? Effect.void
              : Deferred.succeed(call.gate, undefined).pipe(Effect.asVoid);
          }),
      });
    }),
  );
