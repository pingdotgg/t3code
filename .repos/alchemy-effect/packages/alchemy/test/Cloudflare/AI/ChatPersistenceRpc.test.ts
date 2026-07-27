import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import ChatPersistenceRpcWorker from "./fixtures/ChatPersistenceRpcWorker.ts";
import { ChatRpcs } from "./fixtures/ChatRpcs.ts";
import { Gateway } from "./fixtures/Gateway.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

// `Test.rpcClientLayer` speaks `RpcSerialization.ndjson` (streaming
// procedures require newline framing on the wire, matching the worker) and
// guards the transport against edge-generated HTML bodies (workers.dev
// placeholder, error pages) that the RPC protocol would otherwise surface as
// an opaque `RpcClientDefect`; see Test/Http.ts.
const clientLayer = Test.rpcClientLayer;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "AiGatewayChatPersistenceRpcStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* ChatPersistenceRpcWorker;
    const gateway = yield* Gateway;
    return {
      gatewayId: gateway.gatewayId,
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Cap exponential backoff at 3s so retries stay bounded when the CF edge is
// slow (otherwise the geometric blow-up dominates wall time).
const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// A freshly deployed worker isn't live on every Cloudflare edge yet, so the
// first RPC calls fail with `Handler does not export a fetch() function.` —
// which arrives at the client as a DEFECT, and `Effect.retry` does not retry
// defects. Promote defects to failures so the readiness retry absorbs the
// transient cold-start error (a genuine bug just keeps failing until the
// retry budget is exhausted).
const retryReady = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry({ schedule: readinessSchedule, times: 15 }),
  );

test(
  "send round-trips text and turns through the RpcWorker → DO",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const id = `rpc-send-${Date.now()}`;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(ChatRpcs);
      const result = yield* client
        .send({ id, prompt: "Say the single word 'pong'." })
        .pipe(retryReady);

      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);
      // One turn appends the user prompt and the assistant reply.
      expect(result.turns).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "streamMessage yields effect/ai Response parts that decode to real classes",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const id = `rpc-stream-${Date.now()}`;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(ChatRpcs);

      const parts = yield* client
        .streamMessage({
          id,
          prompt: "Write a short sentence about Effect TS.",
        })
        .pipe(Stream.runCollect, retryReady);

      // The stream parts arrived as decoded `effect/ai` instances (a
      // discriminated union by `type`), not opaque JSON.
      expect(parts.length).toBeGreaterThan(0);

      const text = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(text.length).toBeGreaterThan(0);

      const finish = parts.find((p) => p.type === "finish");
      expect(finish).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "streamed turn is persisted: a follow-up send recalls it",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const id = `rpc-memory-${Date.now()}`;

    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(ChatRpcs);

      // First turn over the streaming procedure — persistence saves the
      // appended turn when the stream finalizes.
      yield* client
        .streamMessage({ id, prompt: "My name is Sam. Remember it." })
        .pipe(Stream.runDrain, retryReady);

      // Second turn hits the same DO instance; history is reloaded from
      // `state.storage`, so the model can recall the name and the turn
      // count reflects the restored history (2 from the stream + 2).
      const result = yield* client
        .send({ id, prompt: "What is my name? Answer with just the name." })
        .pipe(retryReady);

      expect(result.text.toLowerCase()).toContain("sam");
      expect(result.turns).toBe(4);
    }).pipe(Effect.scoped, Effect.provide(clientLayer(url)));
  }).pipe(logLevel),
  { timeout: 240_000 },
);
