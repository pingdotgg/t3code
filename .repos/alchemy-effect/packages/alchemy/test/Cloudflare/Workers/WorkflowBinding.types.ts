import * as Cloudflare from "@/Cloudflare";
import * as Output from "@/Output.ts";
import type { ResourceClass } from "@/Resource.ts";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { AsyncWorkflowWorker } from "./fixtures/workflow-async/stack.ts";

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

class ApplicationError extends Data.TaggedError("ApplicationError")<{
  reason: string;
}> {}

const fallibleTask = Cloudflare.Workflows.task(
  "fallible",
  Effect.fail(new ApplicationError({ reason: "retry" })),
  { rollback: () => Effect.fail(new ApplicationError({ reason: "rollback" })) },
);
type _TaskRetainsApplicationError = Assert<
  Equals<Effect.Error<typeof fallibleTask>, ApplicationError>
>;
const recoveredTask = fallibleTask.pipe(
  Effect.catchTag("ApplicationError", (error) => Effect.succeed(error.reason)),
);
type _RecoveryRemovesApplicationError = Assert<
  Equals<Effect.Error<typeof recoveredTask>, never>
>;
const fallibleBody = Effect.fn(function* (_input: { id: string }) {
  return yield* fallibleTask;
});
class FallibleWorkflow extends Cloudflare.Workflow<FallibleWorkflow>()(
  "FallibleWorkflow",
  Effect.succeed(fallibleBody),
) {}
const fallibleWorkflow = Cloudflare.Workflow(
  "FallibleWorkflowFunction",
  { workflowName: "fallible-workflow-function" },
  Effect.succeed(fallibleBody),
);
type _WorkflowHandlerRetainsApplicationError = Assert<
  Equals<Effect.Error<ReturnType<FallibleWorkflow>>, ApplicationError>
>;
type _WorkflowDeclarationDoesNotFailWithBodyError = Assert<
  Equals<Effect.Error<typeof fallibleWorkflow>, never>
>;

const container = Cloudflare.Container("Sandbox", { image: "alpine:latest" });
const program = Effect.gen(function* () {
  return yield* Cloudflare.Worker("Worker", {
    main: "./src/worker.ts",
    assets: "./public",
    env: {
      MY_WORKFLOW: Cloudflare.Workflow<{ value: string }>("Greeting", {
        className: "MyWorkflow",
      }),
      EFFECT_WORKFLOW: Effect.succeed(
        Cloudflare.Workflow<{ count: number }>("Count"),
      ),
      GREETING: "hello",
      CONFIG: Config.succeed("configured"),
      SECRET: Config.succeed(Redacted.make("secret")),
      EFFECT: Effect.succeed(42),
      OUTPUT: Output.literal("output"),
      CONTAINER: container,
    },
  });
});

type DeclaredWorker = Effect.Success<typeof program>;
type DeclaredEnv = DeclaredWorker["env"];
type MyWorkflow = DeclaredEnv["MY_WORKFLOW"];
type _WorkflowNameIsOutput = Assert<
  Equals<MyWorkflow["workflowName"], Output.Output<string>>
>;
type _ScriptNameIsOutput = Assert<
  Equals<MyWorkflow["scriptName"], Output.Output<string>>
>;
type _ClassNameIsString = Assert<Equals<MyWorkflow["className"], string>>;
type _ParamsArePreserved = Assert<
  Equals<Exclude<MyWorkflow["Params"], undefined>, { value: string }>
>;
type _EffectWorkflowParams = Assert<
  Equals<
    Exclude<DeclaredEnv["EFFECT_WORKFLOW"]["Params"], undefined>,
    { count: number }
  >
>;
type _Literal = Assert<Equals<DeclaredEnv["GREETING"], "hello">>;
type _Config = Assert<Equals<DeclaredEnv["CONFIG"], string>>;
type _Secret = Assert<Equals<DeclaredEnv["SECRET"], Redacted.Redacted<string>>>;
type _Effect = Assert<Equals<DeclaredEnv["EFFECT"], number>>;
type _OutputStaysDeferred = Assert<
  DeclaredEnv["OUTPUT"] extends Output.Output<string> ? true : false
>;
type _Assets = Assert<Equals<DeclaredEnv["ASSETS"], Cloudflare.Assets>>;
type _ContainerStaysDeclaration = Assert<
  Equals<DeclaredEnv["CONTAINER"], typeof container>
>;

type Env = Cloudflare.InferEnv<typeof program>;
type _DeclaredEnvRuntimeWorkflow = Assert<
  Equals<
    Cloudflare.InferEnv<DeclaredEnv>["MY_WORKFLOW"],
    Workflow<{ value: string }>
  >
>;
type _RuntimeWorkflow = Assert<
  Equals<Env["MY_WORKFLOW"], Workflow<{ value: string }>>
>;
type _RuntimeEffectWorkflow = Assert<
  Equals<Env["EFFECT_WORKFLOW"], Workflow<{ count: number }>>
>;
type _RuntimeConfig = Assert<Equals<Env["CONFIG"], string>>;
type _RuntimeSecret = Assert<Equals<Env["SECRET"], string>>;
type _RuntimeEffect = Assert<Equals<Env["EFFECT"], number>>;
type _RuntimeOutput = Assert<Env["OUTPUT"] extends string ? true : false>;
// InferEnv returns ambient native types, whose DOM signatures differ from cf's module types.
type _RuntimeAssets = Assert<Equals<Env["ASSETS"], Service>>;
type _RuntimeContainer = Assert<
  Equals<Env["CONTAINER"], DurableObjectNamespace<Rpc.DurableObjectBranded>>
>;

type ClassWorker = Effect.Success<typeof AsyncWorkflowWorker>;
type ClassEnv = Cloudflare.InferEnv<typeof AsyncWorkflowWorker>;
type InstanceEnv = Cloudflare.InferEnv<AsyncWorkflowWorker>;
type _ClassOutput = Assert<
  Equals<
    ClassWorker["env"]["MY_WORKFLOW"]["workflowName"],
    Output.Output<string>
  >
>;
type _ClassRuntimeWorkflow = Assert<
  Equals<ClassEnv["MY_WORKFLOW"], Workflow<{ value: string }>>
>;
type _ClassInstanceWorkflow = Assert<
  Equals<InstanceEnv["MY_WORKFLOW"], ClassEnv["MY_WORKFLOW"]>
>;
type _ClassAssets = Assert<Equals<ClassEnv["ASSETS"], Service>>;

const effectPropsWorker = Cloudflare.Worker(
  "EffectPropsWorker",
  Effect.succeed({
    main: "./src/worker.ts",
    env: { WORKFLOW: Cloudflare.Workflow<{ value: string }>("Greeting") },
  }),
);
type _EffectPropsOutput = Assert<
  Equals<
    Effect.Success<typeof effectPropsWorker>["env"]["WORKFLOW"]["workflowName"],
    Output.Output<string>
  >
>;

type _ExternalWorkerIsAWorker = Assert<
  DeclaredWorker extends Cloudflare.Worker ? true : false
>;
type _BaseWorkerHasNoEnv = Assert<
  Equals<Extract<"env", keyof Cloudflare.Worker>, never>
>;

const referencedWorker = Cloudflare.Worker.ref("Worker");
type _ReferenceHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof referencedWorker>>, never>
>;

const nativeImplementation = Effect.succeed({
  fetch: Effect.succeed(HttpServerResponse.text("hello")),
});
const inlineWorker = Cloudflare.Worker(
  "InlineWorker",
  {
    main: "./src/worker.ts",
    env: { STR: "hello" },
  },
  nativeImplementation,
);
class EffectWorker extends Cloudflare.Worker<EffectWorker>()(
  "EffectWorker",
  {
    main: "./src/worker.ts",
    env: { STR: "hello" },
  },
  nativeImplementation,
) {}
class UnboundWorker extends Cloudflare.Worker<
  UnboundWorker,
  {
    ping: Effect.Effect<string>;
  }
>()("UnboundWorker") {}
const madeWorker = Effect.gen(function* () {
  return yield* UnboundWorker;
}).pipe(
  Effect.provide(
    UnboundWorker.make(
      { main: "./src/worker.ts", env: { STR: "hello" } },
      Effect.succeed({ ping: Effect.succeed("pong") }),
    ),
  ),
);

type _MadeWorkerHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof madeWorker>>, never>
>;
type _InlineWorkerHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof inlineWorker>>, never>
>;
type _EffectClassHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof EffectWorker>>, never>
>;
type _UnboundWorkerHasNoEnv = Assert<
  Equals<Extract<"env", keyof Effect.Success<typeof UnboundWorker>>, never>
>;
type _WorkerRuntimeRetainsEnv = Assert<
  "env" extends keyof Effect.Success<typeof Cloudflare.Worker> ? true : false
>;

export const subscription = Effect.gen(function* () {
  const worker = yield* program;
  return yield* Cloudflare.Queues.Subscription("WorkflowEvents", {
    source: worker.env.MY_WORKFLOW,
    events: ["instance.completed"],
    queueId: "queue-id",
  });
});

type _SubscriptionResult = Assert<
  Equals<Effect.Success<typeof subscription>, Cloudflare.Queues.Subscription>
>;
type _SubscriptionPropsStayNormalized = Assert<
  Equals<
    Cloudflare.Queues.Subscription["Props"]["source"],
    Cloudflare.Queues.SubscriptionSource
  >
>;
type _SubscriptionResourceClass = Assert<
  typeof Cloudflare.Queues.Subscription extends ResourceClass<Cloudflare.Queues.Subscription>
    ? true
    : false
>;
type _SubscriptionReference = Assert<
  Equals<
    Effect.Success<ReturnType<typeof Cloudflare.Queues.Subscription.ref>>,
    Cloudflare.Queues.Subscription
  >
>;

const referencedWorkflow = Cloudflare.Workflow.ref("Greeting", {
  stack: "workflow-host",
  stage: "production",
});
type _WorkflowRefSignature = Assert<
  Equals<
    typeof Cloudflare.Workflow.ref,
    typeof Cloudflare.Workflows.WorkflowResource.ref
  >
>;
type _WorkflowRefResult = Assert<
  Equals<
    Effect.Success<typeof referencedWorkflow>,
    Cloudflare.Workflows.WorkflowResource
  >
>;
type _WorkflowRefRequirements = Assert<
  Equals<Effect.Services<typeof referencedWorkflow>, never>
>;
type _WorkflowRefNameIsOutput = Assert<
  Equals<
    Effect.Success<typeof referencedWorkflow>["workflowName"],
    Output.Output<string, never>
  >
>;
type _WorkflowHandleIsNotASource = Assert<
  Equals<
    Cloudflare.Workflows.WorkflowHandle extends Cloudflare.Queues.SubscriptionInput["source"]
      ? true
      : false,
    false
  >
>;

export const workflowResourceSubscriptions = Effect.gen(function* () {
  const props = { events: ["instance.completed"], queueId: "queue-id" };
  const workflow = yield* Cloudflare.Workflows.WorkflowResource("Owned", {
    className: "MyWorkflow",
    scriptName: "host-worker",
  });
  yield* Cloudflare.Queues.Subscription("ResourceEvents", {
    ...props,
    source: workflow,
  });
  yield* Cloudflare.Queues.Subscription("SameStackRefEvents", {
    ...props,
    source: yield* Cloudflare.Workflow.ref("Owned"),
  });
  yield* Cloudflare.Queues.Subscription(
    "CrossStackRefEvents",
    Effect.gen(function* () {
      yield* Cloudflare.Queues.Subscription.Self;
      return { ...props, source: yield* referencedWorkflow };
    }),
  );
  const Subscription = yield* Cloudflare.Queues.Subscription;
  yield* Subscription("YieldedRefEvents", {
    ...props,
    source: yield* Cloudflare.Workflow.ref("Owned"),
  });
  yield* Subscription(
    "YieldedEffectRefEvents",
    Effect.map(referencedWorkflow, (source) => ({ ...props, source })),
  );
});

export const subscriptionConstructors = Effect.gen(function* () {
  const worker = yield* program;
  const props = {
    source: worker.env.MY_WORKFLOW,
    events: ["instance.completed"],
    queueId: "queue-id",
  };
  const effectProps = Effect.gen(function* () {
    yield* Cloudflare.Queues.Subscription.Self;
    return props;
  });
  const effectSubscription = Cloudflare.Queues.Subscription(
    "EffectEvents",
    effectProps,
  );
  type _EffectPropsRequirements = Assert<
    Equals<
      Effect.Services<typeof effectSubscription>,
      Effect.Services<typeof effectProps> | Cloudflare.Providers
    >
  >;
  const Subscription = yield* Cloudflare.Queues.Subscription;
  const yieldedSubscription = Subscription("YieldedEvents", props);
  type _YieldedRequirements = Assert<
    Equals<Effect.Services<typeof yieldedSubscription>, never>
  >;
  const yieldedEffectSubscription = Subscription(
    "YieldedEffectEvents",
    effectProps,
  );
  type _YieldedEffectRequirements = Assert<
    Equals<
      Effect.Services<typeof yieldedEffectSubscription>,
      Effect.Services<typeof effectProps>
    >
  >;
  const Extended = Cloudflare.Queues.Subscription({ description: "events" });
  type _MethodExtension = Assert<Equals<typeof Extended.description, "events">>;
  yield* Extended("ExtendedEvents", props);
  yield* Extended("ExtendedEffectEvents", Effect.succeed(props));
  yield* Subscription("YieldedEvents", props);
  yield* Subscription("YieldedEffectEvents", Effect.succeed(props));
  yield* Cloudflare.Queues.Subscription("EffectBindingEvents", {
    ...props,
    source: worker.env.EFFECT_WORKFLOW,
  });
  yield* Cloudflare.Queues.Subscription("ExplicitEvents", {
    ...props,
    source: {
      type: "workflows.workflow",
      workflowName: worker.env.MY_WORKFLOW.workflowName,
    },
  });
  yield* Cloudflare.Queues.Subscription(
    "ExplicitEffectEvents",
    Effect.succeed({
      ...props,
      source: { type: "r2" as const },
    }),
  );
  const unbound: Cloudflare.Queues.SubscriptionInput = {
    ...props,
    // @ts-expect-error A Workflow declaration has no bound deployment identity.
    source: Cloudflare.Workflow("UnboundWorkflow"),
  };
});
