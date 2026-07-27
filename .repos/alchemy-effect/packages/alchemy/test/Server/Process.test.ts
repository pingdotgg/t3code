import { isResolved } from "@/Diff.ts";
import * as Plan from "@/Plan";
import { Platform, type Main, type PlatformProps } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import { Resource } from "@/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  ServerHost,
} from "@/Server/Process.ts";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// A minimal hosted Platform (like AWS.ECS.Task / AWS.EC2.Instance) whose
// runtime context is built by the shared `createHostRuntimeContext`. Its
// provider is a no-op so the plan never touches the cloud.
interface HostProps extends PlatformProps {
  main?: string;
}

interface Host extends Resource<"Test.Host", HostProps, { ok: boolean }> {}

type HostServices = ServerHost;
type HostShape = Main<HostServices>;

const Host: Platform<Host, HostServices, HostShape, HostRuntimeContext> =
  Platform("Test.Host", {
    createRuntimeContext: createHostRuntimeContext("Test.Host"),
  });

const hostProvider = () =>
  Provider.succeed(Host, {
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ output }) {
      return output ?? { ok: true };
    }),
    delete: Effect.fn(function* () {}),
  });

const { test } = Test.make({
  providers: hostProvider(),
  state: inMemoryState(),
});

const makePlan = <A, Err, Req>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<Plan.Plan<A>, Err, State> =>
  effect.pipe(
    // @ts-expect-error - Stack.make's typing erases R unsoundly here
    Stack.make({
      name: "test",
      providers: Layer.empty,
      state: inMemoryState(),
    }),
    Effect.provideService(Stage, "test"),
    Effect.flatMap((stackSpec: any) => Plan.make(stackSpec)),
    Effect.provide(hostProvider()),
  );

// Unit-level: the shared host context exposes run / serve / exports and folds
// both run-registered loops and serve-registered handlers into a single
// `exports.program` that the generated container/instance entry runs.
test(
  "createHostRuntimeContext collects run + serve into exports.program",
  Effect.gen(function* () {
    const ctx = createHostRuntimeContext("Test.Host")("my-host");

    expect(ctx.Type).toBe("Test.Host");
    expect(typeof ctx.run).toBe("function");
    expect(typeof ctx.serve).toBe("function");
    expect(typeof ctx.get).toBe("function");
    expect(typeof ctx.set).toBe("function");

    const ran = yield* Ref.make<string[]>([]);
    yield* ctx.run(Ref.update(ran, (xs) => [...xs, "loop"]));
    // serve registers an HTTP handler runner; with no HttpServer bound it is a
    // harmless no-op, so the program completes without crashing.
    yield* ctx.serve(Effect.succeed(HttpServerResponse.text("ok")));

    const { program } = yield* ctx.exports;
    yield* program;

    expect(yield* Ref.get(ran)).toEqual(["loop"]);
  }),
);

// Regression for #706: the generated container/instance entrypoint resolves the
// long-running program via `RuntimeContext.exports` (an Effect) and then runs
// `.program`. `exports` is an Effect, so the entry MUST flat-map it before
// touching `.program` — reaching for `exports.program` directly yields
// `undefined`. This asserts both the (wrong) direct access and the (correct)
// resolved access, mirroring the entry's `flatMap(exports) → flatMap(.program)`.
test(
  "exports must be resolved before reading .program (generated-entry contract)",
  Effect.gen(function* () {
    const ran = yield* Ref.make(false);
    const ctx = createHostRuntimeContext("Test.Host")("entry");
    yield* ctx.run(Ref.set(ran, true));

    // Direct access — what the broken entry did — is undefined.
    expect((ctx.exports as { program?: unknown }).program).toBeUndefined();

    // Correct access: resolve the Effect, then run the program.
    const { program } = yield* ctx.exports;
    yield* program;
    expect(yield* Ref.get(ran)).toBe(true);
  }),
);

// Regression for #706: a hosted Platform program can `yield* ServerHost` and
// call `host.run(...)` during plan. Before the fix this died with
// "Service not found: Alchemy::ServerHost". Returning `{ fetch }` additionally
// exercises the host `serve` path (previously "No serve handler").
test(
  "Platform provides ServerHost to a hosted program during plan",
  Effect.gen(function* () {
    const plan = yield* Host(
      "MyHost",
      { main: "index.ts" },
      Effect.gen(function* () {
        const host = yield* ServerHost;
        // The long-running loop — only registered during plan, never run.
        yield* host.run(Effect.void);
        return {
          fetch: Effect.succeed(HttpServerResponse.text("ok")),
        };
      }),
    ).pipe(makePlan);

    expect(plan.resources["MyHost"]?.action).toBe("create");
  }),
);
