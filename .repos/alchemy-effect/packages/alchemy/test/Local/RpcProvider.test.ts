import { AlchemyContext } from "@/AlchemyContext.ts";
import * as Artifacts from "@/Artifacts.ts";
import { InstanceId } from "@/InstanceId.ts";
import * as RpcProvider from "@/Local/RpcProvider.ts";
import type { ProviderService } from "@/Provider.ts";
import { Resource } from "@/Resource.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

interface TestResource extends Resource<
  "Local.RpcProvider.Test",
  {},
  { ok: boolean; artifact: string }
> {}
const TestResource = Resource<TestResource>("Local.RpcProvider.Test");

type StackShape = Omit<StackSpec, "output">;

interface Capture {
  stack?: StackShape;
  stage?: string;
  instanceId?: string;
  artifact?: string;
}

const defaultStack: StackShape = {
  name: "default-stack",
  stage: "default-stage",
  resources: {},
  bindings: {},
  actions: {},
};

describe("Local.RpcProvider.effect", () => {
  it.effect(
    "provides default Stack, Stage, and InstanceId to lifecycle effects",
    () =>
      Effect.gen(function* () {
        const [capture, result] = yield* useProvider((provider) =>
          provider.reconcile({
            id: "r",
            fqn: "r",
            instanceId: "inst-from-arg",
            news: {},
            olds: undefined,
            output: undefined,
            session: undefined as any,
            bindings: [],
          }),
        );
        expect(result).toMatchObject({ ok: true });
        expect(capture.stack).toBe(defaultStack);
        expect(capture.stage).toBe(defaultStack.stage);
        expect(capture.instanceId).toBe("inst-from-arg");
      }),
  );

  it.effect(
    "does not override Stack, Stage, or InstanceId when already provided",
    () =>
      Effect.gen(function* () {
        const overrideStack: StackShape = {
          name: "override-stack",
          stage: "ignored-stage-on-stack",
          resources: {},
          bindings: {},
          actions: {},
        };
        const [capture] = yield* useProvider((provider) =>
          provider
            .reconcile({
              id: "r",
              fqn: "r",
              instanceId: "inst-from-arg",
              news: {},
              olds: undefined,
              output: undefined,
              session: undefined as any,
              bindings: [],
            })
            .pipe(
              Effect.provideService(Stack, overrideStack),
              Effect.provideService(Stage, "override-stage"),
              Effect.provideService(InstanceId, "override-instance-id"),
            ),
        );
        expect(capture.stack).toBe(overrideStack);
        expect(capture.stage).toBe("override-stage");
        expect(capture.instanceId).toBe("override-instance-id");
      }),
  );

  it.effect("provides defaults to Stream-returning lifecycle methods", () =>
    Effect.gen(function* () {
      const [capture, items] = yield* useProvider((provider) =>
        provider.tail!({
          id: "r",
          fqn: "r",
          instanceId: "inst-from-arg",
          props: {},
          output: { ok: true, artifact: "artifact" },
        }).pipe(Stream.runCollect),
      );
      expect(items.length).toBe(1);
      expect(capture.stack).toBe(defaultStack);
      expect(capture.stage).toBe(defaultStack.stage);
      expect(capture.instanceId).toBe("inst-from-arg");
    }),
  );

  it.effect("omits InstanceId fallback when input has no instanceId", () =>
    Effect.gen(function* () {
      const [capture, exit] = yield* useProvider((provider) =>
        provider
          .reconcile({
            id: "r",
            fqn: "r",
            news: {},
            olds: undefined,
            output: undefined,
            session: undefined!,
            instanceId: undefined!,
            bindings: [],
          })
          .pipe(Effect.exit),
      );
      expect(exit._tag).toBe("Failure");
      expect(capture.stack).toBe(defaultStack);
      expect(capture.stage).toBe(defaultStack.stage);
      expect(capture.instanceId).toBeUndefined();
    }),
  );

  it.effect("caches artifacts", () =>
    Effect.gen(function* () {
      const [capture, result] = yield* useProvider((provider) =>
        provider.diff!({
          id: "r",
          fqn: "r",
          news: {},
          olds: undefined,
          output: undefined,
          oldBindings: [],
          newBindings: [],
          instanceId: "inst-from-arg",
        }).pipe(
          Effect.andThen(
            Effect.all({
              sameInstanceId: provider.reconcile({
                id: "r",
                fqn: "r",
                instanceId: "inst-from-arg",
                news: {},
                olds: undefined,
                output: undefined,
                session: undefined as any,
                bindings: [],
              }),
              differentInstanceId: provider.reconcile({
                id: "r",
                fqn: "r",
                instanceId: "inst-from-arg-2",
                news: {},
                olds: undefined,
                output: undefined,
                session: undefined as any,
                bindings: [],
              }),
            }),
          ),
        ),
      );
      expect(capture.artifact).toBeDefined();
      expect(result.sameInstanceId.artifact).toBeDefined();
      expect(result.differentInstanceId.artifact).toBeDefined();
      expect(capture.artifact).toBe(result.sameInstanceId.artifact);
      expect(capture.artifact).not.toBe(result.differentInstanceId.artifact);
    }),
  );
});

const artifact = Effect.sync(() => crypto.randomUUID()).pipe(
  Artifacts.cached("artifact"),
);

const TestResourceProvider = (capture: Capture) =>
  RpcProvider.effect(
    TestResource,
    "ignored://entry",
    Effect.succeed({
      diff: Effect.fn(function* () {
        capture.artifact = yield* artifact;
      }),
      reconcile: Effect.fn(function* (_input: any) {
        capture.stack = yield* Stack;
        capture.stage = yield* Stage;
        capture.instanceId = yield* InstanceId;
        return { ok: true, artifact: yield* artifact };
      }),
      tail: (_input: any) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            capture.stack = yield* Stack;
            capture.stage = yield* Stage;
            capture.instanceId = yield* InstanceId;
            return { timestamp: new Date(0), message: "ok" };
          }),
        ),
      delete: Effect.fn(function* () {}),
    }),
  );

const useProvider = <A, E, R>(
  callback: (provider: ProviderService<TestResource>) => Effect.Effect<A, E, R>,
) => {
  const capture: Capture = {};
  return TestResource.Provider.pipe(
    Effect.flatMap(callback),
    Effect.map((result) => [capture, result] as const),
    Effect.provide(
      Layer.provide(
        TestResourceProvider(capture),
        Layer.mergeAll(
          Layer.succeed(Stack, defaultStack),
          Layer.succeed(Stage, defaultStack.stage),
          Layer.sync(Artifacts.ArtifactStore, Artifacts.createArtifactStore),
          Layer.succeed(AlchemyContext, {
            dotAlchemy: "/tmp/.alchemy",
            dev: false,
            adopt: false,
          }),
        ),
      ),
    ),
  );
};
