import { Artifacts } from "@/Artifacts";
import { isResolved } from "@/Diff.ts";
import * as Provider from "@/Provider.ts";
import { Resource, type ResourceBinding } from "@/Resource";
import * as State from "@/State/index";
import { isUnknown } from "@/Util/unknown";
import * as Context from "effect/Context";
import { Data } from "effect";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

// Bucket
export type BucketProps = {
  name?: string;
};

export interface Bucket extends Resource<
  "Test.Bucket",
  BucketProps,
  {
    name: string;
    bucketArn: string;
  }
> {}

export const Bucket = Resource<Bucket>("Test.Bucket");

const bucketProvider = () =>
  Provider.succeed(Bucket, {
    diff: Effect.fn(function* ({ id, news, output }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      if (output !== undefined) return output;
      return {
        name: news.name ?? id,
        bucketArn: `arn:test:bucket:us-east-1:123456789:${id}`,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      return;
    }),
  });

// Queue
export type QueueProps = {
  name?: string;
};

export interface Queue extends Resource<
  "Test.Queue",
  QueueProps,
  {
    name: string;
    queueUrl: string;
  }
> {}

export const Queue = Resource<Queue>("Test.Queue");

export const queueProvider = () =>
  Provider.succeed(Queue, {
    diff: Effect.fn(function* ({ id, news = {}, output }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {} }) {
      const name = news.name ?? id;
      return {
        name,
        queueUrl: `https://test.queue.com/${name}`,
      };
    }),
    delete: Effect.fn(function* ({ output }) {}),
  });

export type FunctionProps = {
  name?: string;
  env?: Record<string, string>;
};

export interface Function extends Resource<
  "Test.Function",
  FunctionProps,
  {
    name: string;
    env: Record<string, string>;
    functionArn: string;
  }
> {}

export const Function = Resource<Function>("Test.Function");

export const functionProvider = () =>
  Provider.succeed(Function, {
    diff: Effect.fn(function* ({ id, news, output }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {} }) {
      return {
        name: news.name ?? id,
        env: news.env ?? {},
        functionArn: `arn:aws:lambda:us-west-2:084828582823:function:${id}`,
      };
    }),
    delete: Effect.fn(function* ({ output }) {}),
  });

export type BindingTargetProps = {
  name?: string;
  string?: string;
  replaceString?: string;
};

export interface BindingTarget extends Resource<
  "Test.BindingTarget",
  BindingTargetProps,
  {
    name: string;
    string: string;
    env: Record<string, string>;
    replaceString: BindingTargetProps["replaceString"];
  },
  {
    env?: Record<string, string>;
  }
> {}

export const BindingTarget = Resource<BindingTarget>("Test.BindingTarget");

export const bindingTargetProvider = () =>
  Provider.effect(
    BindingTarget,
    Effect.gen(function* () {
      return {
        diff: Effect.fn(function* ({ id, news = {}, olds = {}, newBindings }) {
          if (!isResolved(news)) return undefined;
          const hooks = Option.getOrUndefined(
            yield* Effect.serviceOption(TestResourceHooks),
          );
          if (hooks?.diff && isResolved(newBindings)) {
            yield* hooks.diff(id, newBindings as ResourceBinding[]);
          }
          const n = news as BindingTargetProps;
          const o = olds as BindingTargetProps;
          if (n.replaceString !== o.replaceString) {
            return {
              action: "replace",
            };
          }
          if (n.name !== o.name || n.string !== o.string) {
            return {
              action: "update",
            };
          }
          return undefined;
        }),
        precreate: Effect.fn(function* ({ id, news = {} }) {
          return {
            name: news.name ?? id,
            string: news.string ?? id,
            env: {},
            replaceString: news.replaceString,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, olds, bindings }) {
          // The hook routing tracks the engine's create-vs-update intent.
          // `olds === undefined` covers greenfield AND replacement-create
          // (engine resets olds when minting a new instance), which is
          // exactly when the test wants `failOn("X", "create")` to fire.
          // `output === undefined` would miss replacements with `precreate`
          // because precreate populates `output` before reconcile runs.
          const hooks = Option.getOrUndefined(
            yield* Effect.serviceOption(TestResourceHooks),
          );
          if (olds === undefined) {
            if (hooks?.create) {
              yield* hooks.create(id, news as TestResourceProps);
            }
          } else {
            if (hooks?.update) {
              yield* hooks.update(id, news as TestResourceProps);
            }
          }
          return {
            name: news.name ?? id,
            string: news.string ?? id,
            env: Object.assign(
              {},
              ...bindings.map(
                (binding: any) => binding.env ?? binding.data?.env ?? {},
              ),
            ),
            replaceString: news.replaceString,
          };
        }),
        delete: Effect.fn(function* ({ id }) {
          const hooks = Option.getOrUndefined(
            yield* Effect.serviceOption(TestResourceHooks),
          );
          if (hooks?.delete) {
            yield* hooks.delete(id);
          }
          return;
        }),
      };
    }),
  );

export type DeletedBindingRegressionProps = {
  name?: string;
};

export interface DeletedBindingRegressionTarget extends Resource<
  "Test.DeletedBindingRegressionTarget",
  DeletedBindingRegressionProps,
  {
    name: string;
    env: Record<string, string>;
  },
  {
    env?: Record<string, string>;
  }
> {}

export const DeletedBindingRegressionTarget =
  Resource<DeletedBindingRegressionTarget>(
    "Test.DeletedBindingRegressionTarget",
  );

export const deletedBindingRegressionProvider = () =>
  Provider.succeed(DeletedBindingRegressionTarget, {
    diff: Effect.fn(function* () {}),
    precreate: Effect.fn(function* ({ id, news = {} }) {
      return {
        name: news.name ?? id,
        env: {},
      };
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, bindings }) {
      return {
        name: news.name ?? id,
        env: Object.assign(
          {},
          ...bindings.map(
            (binding: any) => binding.env ?? binding.data?.env ?? {},
          ),
        ),
      };
    }),
    delete: Effect.fn(function* () {}),
  });

export type ArtifactProbeProps = {
  value: string;
};

export interface ArtifactProbe extends Resource<
  "Test.ArtifactProbe",
  ArtifactProbeProps,
  {
    value: string;
    artifactValue: string | undefined;
  }
> {}

export const ArtifactProbe = Resource<ArtifactProbe>("Test.ArtifactProbe");

export const artifactProbeProvider = () =>
  Provider.succeed(ArtifactProbe, {
    diff: Effect.fn(function* ({ news, olds }) {
      const next = news as ArtifactProbeProps;
      const prev = olds as ArtifactProbeProps | undefined;
      const artifacts = yield* Artifacts;
      const previous = yield* artifacts.get<string>("memo");
      if (
        previous !== undefined &&
        previous !== next.value &&
        previous !== prev?.value
      ) {
        return { action: "replace" as const };
      }
      yield* artifacts.set("memo", next.value);
      return next.value !== prev?.value
        ? { action: "update" as const }
        : undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const props = news as ArtifactProbeProps;
      const artifacts = yield* Artifacts;
      return {
        value: props.value,
        artifactValue: yield* artifacts.get<string>("memo"),
      };
    }),
    delete: Effect.fn(function* () {}),
  });

// TestResource

export type TestResourceProps = {
  string?: string;
  stringArray?: string[];
  object?: {
    string: string;
  };
  replaceString?: string;
  redacted?: Redacted.Redacted<string>;
  redactedArray?: Redacted.Redacted<string>[];
};

export interface TestResource extends Resource<
  "Test.TestResource",
  TestResourceProps,
  {
    string: string;
    stringArray: string[];
    stableString: string;
    stableArray: string[];
    replaceString: TestResourceProps["replaceString"];
    redacted: Redacted.Redacted<string> | undefined;
    redactedArray: Redacted.Redacted<string>[] | undefined;
  }
> {}

export class TestResourceHooks extends Context.Service<
  TestResourceHooks,
  {
    create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    delete?: (id: string) => Effect.Effect<void, any>;
    /**
     * If provided, invoked from a binding-aware provider's `diff` with the
     * exact `newBindings` array the engine handed it. Lets a test assert what
     * the plan stage observes (e.g. that duplicates were collapsed by sid).
     */
    diff?: (
      id: string,
      newBindings: ResourceBinding[],
    ) => Effect.Effect<void, any>;
    /**
     * If provided, the read hook is invoked for the resource's `read` lifecycle
     * operation. Return:
     *   - attrs (any object) to simulate an existing cloud resource that is
     *     adoptable
     *   - `undefined` to simulate a resource that does not exist
     *   - fail with `OwnedBySomeoneElse` to reject adoption
     */
    read?: (
      id: string,
    ) => Effect.Effect<TestResource["Attributes"] | undefined, any>;
  }
>()("TestResourceHooks") {}

export const TestResource = Resource<TestResource>("Test.TestResource");

export const testResourceProvider = () =>
  Provider.effect(
    TestResource,
    Effect.gen(function* () {
      return {
        read: Effect.fn(function* ({ id, output }) {
          const hooks = Option.getOrUndefined(
            yield* Effect.serviceOption(TestResourceHooks),
          );
          if (hooks?.read) {
            return (yield* hooks.read(id)) as any;
          }
          return output;
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const n = news as TestResourceProps;
          const o = olds as TestResourceProps;
          if (n.replaceString !== o.replaceString) {
            return {
              action: "replace",
            };
          }
          const redactedValue = (
            r: Redacted.Redacted<string> | undefined,
          ): string | undefined =>
            r && Redacted.isRedacted(r) ? Redacted.value(r) : undefined;
          const redactedArrayValues = (
            arr: Redacted.Redacted<string>[] | undefined,
          ): string[] | undefined => arr?.map((r) => Redacted.value(r));
          const oldRedactedArr = redactedArrayValues(o.redactedArray);
          const newRedactedArr = redactedArrayValues(n.redactedArray);
          return isUnknown(n.string) ||
            isUnknown(n.stringArray) ||
            n.string !== o.string ||
            n.stringArray?.length !== o.stringArray?.length ||
            !!n.stringArray !== !!o.stringArray ||
            n.stringArray?.some(isUnknown) ||
            n.stringArray?.some((s, i) => s !== o.stringArray?.[i]) ||
            redactedValue(n.redacted) !== redactedValue(o.redacted) ||
            oldRedactedArr?.length !== newRedactedArr?.length ||
            !!oldRedactedArr !== !!newRedactedArr ||
            newRedactedArr?.some((s, i) => s !== oldRedactedArr?.[i])
            ? {
                action: "update",
                stables: ["stableString", "stableArray"],
              }
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, olds }) {
          const hooks = Option.getOrUndefined(
            yield* Effect.serviceOption(TestResourceHooks),
          );
          // Branch on `olds` (engine's create-vs-update intent), not
          // `output` — replacements arrive with a precreate stub in
          // `output` but `olds === undefined`.
          if (olds === undefined) {
            if (hooks?.create) {
              yield* hooks.create(id, news);
            }
          } else {
            if (hooks?.update) {
              yield* hooks.update(id, news);
            }
          }
          return {
            string: news.string ?? id,
            stringArray: news.stringArray ?? [],
            stableString: id,
            stableArray: [id],
            replaceString: news.replaceString,
            redacted: news.redacted,
            redactedArray: news.redactedArray,
          };
        }),
        delete: Effect.fn(function* ({ id }) {
          const hooks = Option.getOrUndefined(
            yield* Effect.serviceOption(TestResourceHooks),
          );
          if (hooks?.delete) {
            yield* hooks.delete(id);
          }
          return;
        }),
      };
    }),
  );

// StaticStablesResource - A test resource that has static stables on the provider
// This simulates resources like VPC, Subnet, etc. where certain properties (e.g., vpcId, subnetId)
// are always stable and defined on the provider itself, not returned dynamically by diff()

export type StaticStablesResourceProps = {
  string?: string;
  tags?: Record<string, string>;
  replaceString?: string;
};

export interface StaticStablesResource extends Resource<
  "Test.StaticStablesResource",
  StaticStablesResourceProps,
  {
    string: string;
    tags: Record<string, string>;
    stableId: string;
    stableArn: string;
    replaceString: StaticStablesResourceProps["replaceString"];
  }
> {}

export class StaticStablesResourceHooks extends Context.Service<
  StaticStablesResourceHooks,
  {
    create?: (
      id: string,
      props: StaticStablesResourceProps,
    ) => Effect.Effect<void, any>;
    update?: (
      id: string,
      props: StaticStablesResourceProps,
    ) => Effect.Effect<void, any>;
    delete?: (id: string) => Effect.Effect<void, any>;
  }
>()("StaticStablesResourceHooks") {}

export const StaticStablesResource = Resource<StaticStablesResource>(
  "Test.StaticStablesResource",
);

export const staticStablesResourceProvider = () =>
  Provider.succeed(StaticStablesResource, {
    // KEY DIFFERENCE: Static stables defined on the provider itself
    // These are always stable regardless of what diff() returns
    stables: ["stableId", "stableArn"],
    diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
      if (!isResolved(news)) return undefined;
      const n = news as StaticStablesResourceProps;
      const o = olds as StaticStablesResourceProps;
      // Replace when replaceString changes
      if (n.replaceString !== o.replaceString) {
        return { action: "replace" };
      }
      // For string changes, return update action
      if (n.string !== o.string) {
        return { action: "update" };
      }
      // For tag-only changes, return undefined (no action)
      // This simulates the VPC bug: tags changed, arePropsChanged returns true,
      // but diff() returns undefined because provider doesn't explicitly handle tags
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, olds, output }) {
      const hooks = Option.getOrUndefined(
        yield* Effect.serviceOption(StaticStablesResourceHooks),
      );
      // Branch on `olds` (engine create vs update intent). Replacements
      // pass `output` from the previous generation if any, but engine
      // resets `olds` to `undefined` for the new instance.
      if (olds === undefined) {
        if (hooks?.create) {
          yield* hooks.create(id, news);
        }
        return {
          string: news.string ?? id,
          tags: news.tags ?? {},
          stableId: output?.stableId ?? `stable-${id}`,
          stableArn:
            output?.stableArn ??
            (`arn:test:resource:us-east-1:123456789:${id}` as const),
          replaceString: news.replaceString,
        };
      }
      if (hooks?.update) {
        yield* hooks.update(id, news);
      }
      return {
        string: news.string ?? id,
        tags: news.tags ?? {},
        stableId: output?.stableId ?? `stable-${id}`,
        stableArn:
          output?.stableArn ??
          (`arn:test:resource:us-east-1:123456789:${id}` as const),
        replaceString: news.replaceString,
      };
    }),
    delete: Effect.fn(function* ({ id, output }) {
      yield* Effect.logDebug(output.string);
      const hooks = Option.getOrUndefined(
        yield* Effect.serviceOption(StaticStablesResourceHooks),
      );
      if (hooks?.delete) {
        yield* hooks.delete(id);
      }
      return;
    }),
  });

export type PhasedTargetProps = {
  desired: string;
  replaceKey?: string;
};

export interface PhasedTarget extends Resource<
  "Test.PhasedTarget",
  PhasedTargetProps,
  {
    stableId: string;
    value: string;
    env: Record<string, string>;
    replaceKey: string | undefined;
  },
  {
    env?: Record<string, string>;
  }
> {}

export const PhasedTarget = Resource<PhasedTarget>("Test.PhasedTarget");

const phasedStableId = (replaceKey?: string) =>
  `stable:${replaceKey ?? "default"}`;

const mergeBindingEnv = (bindings: Array<any>) =>
  Object.assign(
    {},
    ...bindings.map((binding) => binding.env ?? binding.data?.env ?? {}),
  );

export const phasedTargetProvider = () =>
  Provider.effect(
    PhasedTarget,
    Effect.gen(function* () {
      return {
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          const n = news as PhasedTargetProps;
          const o = olds as PhasedTargetProps;
          if (n.replaceKey !== o.replaceKey) {
            return { action: "replace" } as const;
          }
          if (n.desired !== o.desired) {
            return { action: "update" } as const;
          }
        }),
        precreate: Effect.fn(function* ({ news }) {
          return {
            stableId: phasedStableId(news.replaceKey),
            value: `pre:${news.desired}`,
            env: {},
            replaceKey: news.replaceKey,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, bindings }) {
          const hooks = Option.getOrUndefined(
            yield* Effect.serviceOption(TestResourceHooks),
          );
          // Branch on `olds` not `output`: replacement-create has
          // precreate-populated `output` but engine-cleared `olds`.
          if (olds === undefined) {
            if (hooks?.create) {
              yield* hooks.create(id, {
                string: news.desired,
                replaceString: news.replaceKey,
              });
            }
          } else {
            if (hooks?.update) {
              yield* hooks.update(id, {
                string: news.desired,
                replaceString: news.replaceKey,
              });
            }
          }
          return {
            stableId: phasedStableId(news.replaceKey),
            value: news.desired,
            env: mergeBindingEnv(bindings),
            replaceKey: news.replaceKey,
          };
        }),
        delete: Effect.fn(function* ({ id }) {
          const hooks = Option.getOrUndefined(
            yield* Effect.serviceOption(TestResourceHooks),
          );
          if (hooks?.delete) {
            yield* hooks.delete(id);
          }
        }),
      };
    }),
  );

// NoPrecreateBindingTarget - like BindingTarget but without precreate,
// used to test cycle detection for resources that cannot break cycles.

export type NoPrecreateBindingTargetProps = {
  string?: string;
};

export interface NoPrecreateBindingTarget extends Resource<
  "Test.NoPrecreateBindingTarget",
  NoPrecreateBindingTargetProps,
  {
    string: string;
    env: Record<string, string>;
  },
  {
    env?: Record<string, string>;
  }
> {}

export const NoPrecreateBindingTarget = Resource<NoPrecreateBindingTarget>(
  "Test.NoPrecreateBindingTarget",
);

export const noPrecreateBindingTargetProvider = () =>
  Provider.succeed(NoPrecreateBindingTarget, {
    diff: Effect.fn(function* () {}),
    reconcile: Effect.fn(function* ({ id, news = {}, bindings }) {
      return {
        string: news.string ?? id,
        env: Object.assign(
          {},
          ...bindings.map(
            (binding: any) => binding.env ?? binding.data?.env ?? {},
          ),
        ),
      };
    }),
    delete: Effect.fn(function* () {}),
  });

// DurationResource — exercises Duration round-tripping through state.
// Input Duration must arrive at reconcile as a real Duration object (so the
// resolver doesn't shred its prototype); output Duration must re-hydrate from
// state on a subsequent deploy as a real Duration object too.

export type DurationResourceProps = {
  timeout: Duration.Duration;
};

export interface DurationResource extends Resource<
  "Test.DurationResource",
  DurationResourceProps,
  {
    /** Echoes the input Duration so we can assert what reconcile observed. */
    observedTimeout: Duration.Duration;
    /** Authoritative Duration the provider produces; persisted to state. */
    computedTimeout: Duration.Duration;
  }
> {}

export const DurationResource = Resource<DurationResource>(
  "Test.DurationResource",
);

export const durationResourceProvider = () =>
  Provider.succeed(DurationResource, {
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      // If `news.timeout` was shredded by the resolver into a plain object,
      // these calls would throw or produce nonsense. The test asserts the
      // numeric output so a regression surfaces as a failed assertion.
      const observed = news.timeout;
      const computed = Duration.millis(Duration.toMillis(observed) + 1_000);
      return {
        observedTimeout: observed,
        computedTimeout: computed,
      };
    }),
    delete: Effect.fn(function* () {}),
  });

// Layers
export const TestLayers = () =>
  Layer.mergeAll(
    bucketProvider(),
    queueProvider(),
    functionProvider(),
    bindingTargetProvider(),
    deletedBindingRegressionProvider(),
    artifactProbeProvider(),
    testResourceProvider(),
    staticStablesResourceProvider(),
    phasedTargetProvider(),
    noPrecreateBindingTargetProvider(),
    durationResourceProvider(),
  );

export const InMemoryTestLayers = () =>
  Layer.mergeAll(TestLayers(), State.inMemoryState());

// ── Failure injection helpers ──────────────────────────────────────────────
//
// These helpers produce TestResourceHooks records that can be passed to the
// `hook(...)` test combinator to inject failures or defects into specific
// resource lifecycle methods. `failOn` produces typed failures, while
// `dieOn` and `throwOn` produce defects (uncaught/thrown errors).

export class ResourceFailure extends Data.TaggedError("ResourceFailure")<{
  message: string;
}> {
  constructor(message = "Failed to create") {
    super({ message });
  }
}

type LifecycleHook = "create" | "update" | "delete";

export type LifecycleHooks = {
  create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  delete?: (id: string) => Effect.Effect<void, any>;
};

export const failOn = (
  resourceId: string,
  hook: LifecycleHook,
): LifecycleHooks => ({
  [hook]: (id: string) =>
    id === resourceId
      ? Effect.fail(new ResourceFailure())
      : Effect.succeed(undefined),
});

export const failOnMultiple = (
  failures: Array<{ id: string; hook: LifecycleHook }>,
): LifecycleHooks => {
  const idsFor = (hook: LifecycleHook) =>
    failures.filter((f) => f.hook === hook).map((f) => f.id);
  const createFailures = idsFor("create");
  const updateFailures = idsFor("update");
  const deleteFailures = idsFor("delete");
  return {
    create: (id: string) =>
      createFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
    update: (id: string) =>
      updateFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
    delete: (id: string) =>
      deleteFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
  };
};

export const dieOn = (
  resourceId: string,
  hook: LifecycleHook,
  message = `dieOn:${resourceId}:${hook}`,
): LifecycleHooks => ({
  [hook]: (id: string) =>
    id === resourceId
      ? Effect.die(new Error(message))
      : Effect.succeed(undefined),
});

export const throwOn = (
  resourceId: string,
  hook: LifecycleHook,
  message = `throwOn:${resourceId}:${hook}`,
): LifecycleHooks => ({
  [hook]: (id: string) =>
    Effect.sync(() => {
      if (id === resourceId) {
        throw new Error(message);
      }
    }),
});
