import { Browser } from "@/Cloudflare/Workers/Browser.ts";
import { Images } from "@/Cloudflare/Images/Images.ts";
import { RateLimit } from "@/Cloudflare/Workers/RateLimit.ts";
import { VersionMetadata } from "@/Cloudflare/Workers/VersionMetadata.ts";
import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import { Resource } from "@/Resource";
import * as Test from "@/Test/Alchemy";
import { effectClass } from "@/Util/effect.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { TestLayers, TestResource } from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

// A throwaway resource type used to exercise the `({ methods })` overload
// without mutating the shared `TestResource`.
interface MethodsResource extends Resource<
  "Test.EffectableMethods",
  {},
  { value: string }
> {}

describe("Effectable: migrated constructs are real Effects", () => {
  test(
    "Resource constructor class is an Effect",
    Effect.gen(function* () {
      expect(Effect.isEffect(TestResource)).toBe(true);
      // still iterable (yield*-able)
      expect(typeof (TestResource as any)[Symbol.iterator]).toBe("function");
    }),
  );

  test(
    "Resource.ref(...) returns an Effect",
    Effect.gen(function* () {
      expect(Effect.isEffect(TestResource.ref("X"))).toBe(true);
    }),
  );

  test(
    "a resource instance call is an Effect",
    Effect.gen(function* () {
      expect(Effect.isEffect(TestResource("A", { string: "x" }))).toBe(true);
    }),
  );

  test(
    "effectClass(...) and its subclasses are Effects",
    Effect.gen(function* () {
      const Klass = effectClass(Effect.succeed(1));
      expect(Effect.isEffect(Klass)).toBe(true);

      class Sub extends effectClass<{ x: number }>()(
        Effect.succeed({ x: 1 }),
      ) {}
      // static Effect protocol is inherited through the constructor chain
      expect(Effect.isEffect(Sub)).toBe(true);
    }),
  );

  test(
    "Platform/Worker construct is an Effect",
    Effect.gen(function* () {
      const w = Worker("EffectableProbeWorker", { main: "./unused.ts" });
      expect(Effect.isEffect(w)).toBe(true);
      expect(typeof (w as any)[Symbol.iterator]).toBe("function");
    }),
  );
});

describe("Effectable: deliberate non-Effect binding markers", () => {
  // These markers MUST stay non-Effects (InferEnv + the Worker `env`-value
  // resolver both branch on `Effect.isEffect`). They remain yield*-able via
  // `[Symbol.iterator]`. See the marker JSDoc for the rationale.
  const markers: Array<[name: string, marker: any]> = [
    ["Images", Images("IMAGES")],
    [
      "RateLimit",
      RateLimit("THROTTLE", {
        namespaceId: 1,
        simple: { limit: 1, period: 60 },
      }),
    ],
    ["Browser", Browser("BROWSER")],
    ["VersionMetadata", VersionMetadata("CF_VERSION_METADATA")],
  ];

  for (const [name, marker] of markers) {
    test(
      `${name} marker is NOT an Effect but stays yield*-able`,
      Effect.gen(function* () {
        expect(Effect.isEffect(marker)).toBe(false);
        expect(typeof marker[Symbol.iterator]).toBe("function");
      }),
    );
  }
});

describe("Effectable: Effect.all / Effect.forEach over constructs", () => {
  test(
    "Effect.all over effectClass instances executes each",
    Effect.gen(function* () {
      const [a, b] = yield* Effect.all([
        effectClass(Effect.succeed(1)),
        effectClass(Effect.succeed(2)),
      ]);
      expect([a, b]).toEqual([1, 2]);
    }),
  );

  test(
    "Effect.forEach over effectClass instances executes each",
    Effect.gen(function* () {
      const result = yield* Effect.forEach(
        [effectClass(Effect.succeed("a")), effectClass(Effect.succeed("b"))],
        (eff) => eff,
      );
      expect(result).toEqual(["a", "b"]);
    }),
  );

  test.provider(
    "Effect.all over resource constructor calls deploys all of them",
    (stack) =>
      Effect.gen(function* () {
        const strings = yield* Effect.gen(function* () {
          const resources = yield* Effect.all([
            TestResource("A", { string: "a" }),
            TestResource("B", { string: "b" }),
          ]);
          return resources.map((r) => r.string);
        }).pipe(stack.deploy);
        expect(strings).toEqual(["a", "b"]);
      }),
  );

  test.provider(
    "Effect.forEach over resource constructor calls deploys all of them",
    (stack) =>
      Effect.gen(function* () {
        const strings = yield* Effect.gen(function* () {
          const resources = yield* Effect.forEach(["A", "B", "C"], (id) =>
            TestResource(id, { string: id.toLowerCase() }),
          );
          return resources.map((r) => r.string);
        }).pipe(stack.deploy);
        expect(strings).toEqual(["a", "b", "c"]);
      }),
  );
});

describe("Effectable: overloads", () => {
  test(
    "yield* a bare Resource class resolves to its constructor",
    Effect.gen(function* () {
      const ctor = yield* TestResource;
      expect(typeof ctor).toBe("function");
    }),
  );

  test(
    "Resource class .pipe behaves as piping an Effect",
    Effect.gen(function* () {
      const piped = TestResource.pipe(Effect.map((ctor) => typeof ctor));
      expect(Effect.isEffect(piped)).toBe(true);
      expect(yield* piped).toBe("function");
    }),
  );

  test(
    "Resource({ methods }) augments the class and keeps it an Effect",
    Effect.gen(function* () {
      const R = Resource<MethodsResource>("Test.EffectableMethods");
      const augmented = R({ greet: () => "hi" });
      // the `({ methods })` overload mutates + returns the same class
      expect(augmented).toBe(R);
      expect((R as any).greet()).toBe("hi");
      expect(Effect.isEffect(R)).toBe(true);
    }),
  );

  test.provider(
    "Resource accepts props-as-Effect (Effect<Props> overload)",
    (stack) =>
      Effect.gen(function* () {
        const value = yield* Effect.gen(function* () {
          const A = yield* TestResource(
            "A",
            Effect.succeed({ string: "fromEffect" }),
          );
          return A.string;
        }).pipe(stack.deploy);
        expect(value).toEqual("fromEffect");
      }),
  );

  test(
    "Worker.of(shape) returns the shape and the tagged class is an Effect",
    Effect.gen(function* () {
      const W = (Worker as any)()("EffectableTaggedWorker", {
        main: "./unused.ts",
      });
      expect(Effect.isEffect(W)).toBe(true);
      expect(typeof W.of).toBe("function");
      expect(W.of({ foo: 1 })).toEqual({ foo: 1 });
    }),
  );
});
