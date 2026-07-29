import * as Output from "@/Output";
import { ref as makeRef } from "@/Ref";
import type { ResourceLike } from "@/Resource";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State/InMemoryState";
import type { ResourceState } from "@/State/ResourceState";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const provideState = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(inMemoryState()));

const fakeResource = <T extends string, A extends object>(
  type: T,
  fqn: string,
  logicalId: string = fqn,
): ResourceLike<T, any, A> =>
  ({
    Type: type,
    FQN: fqn,
    LogicalId: logicalId,
    Namespace: undefined,
  }) as any;

describe("Output.evaluate", () => {
  describe("primitives and plain values", () => {
    it.effect("returns primitive values as-is", () =>
      provideState(
        Effect.gen(function* () {
          expect(yield* Output.evaluate(42, {})).toBe(42);
          expect(yield* Output.evaluate("hello", {})).toBe("hello");
          expect(yield* Output.evaluate(true, {})).toBe(true);
          expect(yield* Output.evaluate(null, {})).toBe(null);
          expect(yield* Output.evaluate(undefined, {})).toBe(undefined);
        }),
      ),
    );

    it.effect("recursively evaluates plain objects", () =>
      provideState(
        Effect.gen(function* () {
          const result = yield* Output.evaluate({ a: 1, b: { c: "x" } }, {});
          expect(result).toEqual({ a: 1, b: { c: "x" } });
        }),
      ),
    );

    it.effect("recursively evaluates arrays", () =>
      provideState(
        Effect.gen(function* () {
          const result = yield* Output.evaluate([1, "two", { k: 3 }], {});
          expect(result).toEqual([1, "two", { k: 3 }]);
        }),
      ),
    );
  });

  describe("Redacted", () => {
    it.effect("preserves Redacted values at the top level", () =>
      provideState(
        Effect.gen(function* () {
          const secret = Redacted.make("hunter2");
          const result = yield* Output.evaluate(secret, {});
          expect(Redacted.isRedacted(result)).toBe(true);
          expect(Redacted.value(result as Redacted.Redacted<string>)).toBe(
            "hunter2",
          );
        }),
      ),
    );

    it.effect("preserves Redacted values nested inside an object", () =>
      provideState(
        Effect.gen(function* () {
          const secret = Redacted.make("hunter2");
          const result = yield* Output.evaluate(
            { value: secret, name: "x" },
            {},
          );
          expect(result.name).toBe("x");
          expect(Redacted.isRedacted(result.value)).toBe(true);
          expect(Redacted.value(result.value)).toBe("hunter2");
        }),
      ),
    );

    it.effect("preserves Redacted values nested inside an array", () =>
      provideState(
        Effect.gen(function* () {
          const secret = Redacted.make("hunter2");
          const [result] = yield* Output.evaluate([secret], {});
          expect(Redacted.isRedacted(result)).toBe(true);
          expect(Redacted.value(result)).toBe("hunter2");
        }),
      ),
    );
  });

  describe("Config", () => {
    it.effect("resolves a Config value at the top level", () =>
      provideState(
        Effect.gen(function* () {
          const result = yield* Output.evaluate(Config.succeed(1337), {});
          expect(result).toBe(1337);
        }),
      ),
    );

    it.effect("resolves a Config value nested inside an object", () =>
      provideState(
        Effect.gen(function* () {
          const result = yield* Output.evaluate(
            { port: Config.succeed(8080), host: "localhost" },
            {},
          );
          expect(result).toEqual({ port: 8080, host: "localhost" });
        }),
      ),
    );

    it.effect("resolves a Config value nested inside an array", () =>
      provideState(
        Effect.gen(function* () {
          const [result] = yield* Output.evaluate([Config.succeed(42)], {});
          expect(result).toBe(42);
        }),
      ),
    );

    it.effect("resolves a Config against the ConfigProvider environment", () =>
      provideState(
        Effect.gen(function* () {
          const result = yield* Output.evaluate(
            { port: Config.number("PORT").pipe(Config.withDefault(1337)) },
            {},
          ).pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { PORT: "8080" } }),
              ),
            ),
          );
          expect(result).toEqual({ port: 8080 });
        }),
      ),
    );

    it.effect("a Config resolving to a Redacted keeps it wrapped", () =>
      provideState(
        Effect.gen(function* () {
          const result = yield* Output.evaluate(
            Config.succeed(Redacted.make("hunter2")),
            {},
          );
          expect(Redacted.isRedacted(result)).toBe(true);
          expect(
            Redacted.value(result as unknown as Redacted.Redacted<string>),
          ).toBe("hunter2");
        }),
      ),
    );
  });

  describe("LiteralExpr", () => {
    it.effect("evaluates Output.literal(value)", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.literal("foo");
          expect(yield* Output.evaluate(expr, {})).toBe("foo");
        }),
      ),
    );

    it.effect("evaluates a literal nested within an object", () =>
      provideState(
        Effect.gen(function* () {
          const result = yield* Output.evaluate(
            { greeting: Output.literal("hi") },
            {},
          );
          expect(result).toEqual({ greeting: "hi" });
        }),
      ),
    );
  });

  describe("ResourceExpr", () => {
    it.effect("resolves to the upstream value keyed by FQN", () =>
      provideState(
        Effect.gen(function* () {
          const src = fakeResource("Test.Bucket", "MyBucket");
          const expr = Output.of(src);
          const result = yield* Output.evaluate(expr, {
            MyBucket: { name: "my-bucket" },
          });
          expect(result).toEqual({ name: "my-bucket" });
        }),
      ),
    );

    it.effect("fails with MissingSourceError when upstream is absent", () =>
      provideState(
        Effect.gen(function* () {
          const src = fakeResource("Test.Bucket", "Missing");
          const expr = Output.of(src);
          const exit = yield* Effect.exit(Output.evaluate(expr, {}));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const failure = exit.cause.toJSON() as any;
            expect(JSON.stringify(failure)).toContain("MissingSourceError");
          }
        }),
      ),
    );

    it.effect("evaluates a raw resource (isResource branch)", () =>
      provideState(
        Effect.gen(function* () {
          const src = fakeResource("Test.Bucket", "RawBucket");
          const result = yield* Output.evaluate(src as any, {
            RawBucket: { ok: true },
          });
          expect(result).toEqual({ ok: true });
        }),
      ),
    );

    it.effect("raw resource with missing upstream fails", () =>
      provideState(
        Effect.gen(function* () {
          const src = fakeResource("Test.Bucket", "Gone");
          const exit = yield* Effect.exit(Output.evaluate(src as any, {}));
          expect(Exit.isFailure(exit)).toBe(true);
        }),
      ),
    );

    it("classifies resource expressions when a stable kind shadows the discriminator", () => {
      const src = fakeResource("Test.Database", "Database");
      const expr = new Output.ResourceExpr(src, { kind: "postgresql" });

      expect((expr as any).kind).toBe("postgresql");
      expect(Output.isResourceExpr(expr)).toBe(true);
    });
  });

  describe("PropExpr", () => {
    it.effect("accesses a property on a resource expression", () =>
      provideState(
        Effect.gen(function* () {
          const src = fakeResource<"Test.Bucket", { name: string }>(
            "Test.Bucket",
            "B",
          );
          const expr = Output.of(src) as any;
          const result = yield* Output.evaluate(expr.name, {
            B: { name: "the-name" },
          });
          expect(result).toBe("the-name");
        }),
      ),
    );

    it.effect("returns undefined when accessing missing property", () =>
      provideState(
        Effect.gen(function* () {
          const src = fakeResource("Test.Bucket", "B2");
          const expr = Output.of(src) as any;
          const result = yield* Output.evaluate(expr.missing, {
            B2: { other: 1 },
          });
          expect(result).toBeUndefined();
        }),
      ),
    );

    it.effect("supports nested property access", () =>
      provideState(
        Effect.gen(function* () {
          const src = fakeResource("Test.Bucket", "B3");
          const expr = Output.of(src) as any;
          const result = yield* Output.evaluate(expr.nested.deep, {
            B3: { nested: { deep: "value" } },
          });
          expect(result).toBe("value");
        }),
      ),
    );
  });

  describe("ApplyExpr (map)", () => {
    it.effect("applies a synchronous function over a literal", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.map(Output.literal(2), (n) => n * 3);
          expect(yield* Output.evaluate(expr, {})).toBe(6);
        }),
      ),
    );

    it.effect("composes multiple maps", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.literal(2).pipe(
            Output.map((n: number) => n + 1),
            Output.map((n: number) => n * 10),
          );
          expect(yield* Output.evaluate(expr, {})).toBe(30);
        }),
      ),
    );

    it.effect("maps over a resource attribute", () =>
      provideState(
        Effect.gen(function* () {
          const src = fakeResource("Test.Bucket", "B4");
          const expr = (Output.of(src) as any).name.pipe(
            Output.map((s: string) => s.toUpperCase()),
          );
          const result = yield* Output.evaluate(expr, {
            B4: { name: "abc" },
          });
          expect(result).toBe("ABC");
        }),
      ),
    );
  });

  describe("EffectExpr (mapEffect)", () => {
    it.effect("evaluates an effectful transformation", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.literal(5).pipe(
            Output.mapEffect((n: number) => Effect.succeed(n * 2)),
          );
          expect(yield* Output.evaluate(expr, {})).toBe(10);
        }),
      ),
    );

    it.effect("chains multiple effectful transformations", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.literal("a").pipe(
            Output.mapEffect((s: string) => Effect.succeed(s + "b")),
            Output.mapEffect((s) => Effect.succeed(s + "c")),
          );
          expect(yield* Output.evaluate(expr, {})).toBe("abc");
        }),
      ),
    );
  });

  describe("FlatMapExpr (flatMap)", () => {
    it.effect("flattens an Output returned from the function", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.literal(5).pipe(
            Output.flatMap((n: number) => Output.literal(n * 2)),
          );
          expect(yield* Output.evaluate(expr, {})).toBe(10);
        }),
      ),
    );

    it.effect("supports the data-first form", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.flatMap(Output.literal("a"), (s: string) =>
            Output.literal(s + "b"),
          );
          expect(yield* Output.evaluate(expr, {})).toBe("ab");
        }),
      ),
    );

    it.effect("chains multiple flatMaps", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.literal(1).pipe(
            Output.flatMap((n: number) => Output.literal(n + 1)),
            Output.flatMap((n: number) => Output.literal(n * 10)),
          );
          expect(yield* Output.evaluate(expr, {})).toBe(20);
        }),
      ),
    );

    it.effect("flatMaps into another resource's output", () =>
      provideState(
        Effect.gen(function* () {
          const a = fakeResource("Test.A", "FA");
          const b = fakeResource("Test.B", "FB");
          const expr = (Output.of(a) as any).name.pipe(
            Output.flatMap(() => (Output.of(b) as any).name),
          );
          const result = yield* Output.evaluate(expr, {
            FA: { name: "a-name" },
            FB: { name: "b-name" },
          });
          expect(result).toBe("b-name");
        }),
      ),
    );

    it.effect("can flatMap into a non-Output literal value", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.literal(3).pipe(
            Output.flatMap((n: number) => Output.asOutput(n + 1)),
          );
          expect(yield* Output.evaluate(expr, {})).toBe(4);
        }),
      ),
    );

    it("tracks only the source expression as upstream", () => {
      const a = fakeResource("Test.A", "UA");
      const expr = (Output.of(a) as any).name.pipe(
        Output.flatMap((s: string) => Output.literal(s)),
      );
      expect(Object.keys(Output.upstream(expr))).toEqual(["UA"]);
    });
  });

  describe("method-style combinators on a proxied Output", () => {
    // Resource outputs are Proxies, so `.map(fn)` / `.mapEffect(fn)` /
    // `.flatMap(fn)` / `.apply(fn)` / `.effect(fn)` must be callable as
    // methods (not just via `Output.map(output, fn)` / `.pipe(...)`).
    const resourceOutput = () => {
      const src = fakeResource<"Test.Bucket", { name: string }>(
        "Test.Bucket",
        "M",
      );
      return (Output.of(src) as any).name as Output.Output<string>;
    };

    it.effect(".map(fn) builds an ApplyExpr", () =>
      provideState(
        Effect.gen(function* () {
          const expr = (resourceOutput() as any).map((s: string) =>
            s.toUpperCase(),
          );
          expect(Output.isApplyExpr(expr)).toBe(true);
          expect(yield* Output.evaluate(expr, { M: { name: "abc" } })).toBe(
            "ABC",
          );
        }),
      ),
    );

    it.effect(".apply(fn) builds an ApplyExpr", () =>
      provideState(
        Effect.gen(function* () {
          const expr = (resourceOutput() as any).apply((s: string) =>
            s.toUpperCase(),
          );
          expect(Output.isApplyExpr(expr)).toBe(true);
          expect(yield* Output.evaluate(expr, { M: { name: "abc" } })).toBe(
            "ABC",
          );
        }),
      ),
    );

    it.effect(".mapEffect(fn) builds an EffectExpr", () =>
      provideState(
        Effect.gen(function* () {
          const expr = (resourceOutput() as any).mapEffect((s: string) =>
            Effect.succeed(s + "!"),
          );
          expect(Output.isEffectExpr(expr)).toBe(true);
          expect(yield* Output.evaluate(expr, { M: { name: "abc" } })).toBe(
            "abc!",
          );
        }),
      ),
    );

    it.effect(".effect(fn) builds an EffectExpr", () =>
      provideState(
        Effect.gen(function* () {
          const expr = (resourceOutput() as any).effect((s: string) =>
            Effect.succeed(s + "!"),
          );
          expect(Output.isEffectExpr(expr)).toBe(true);
          expect(yield* Output.evaluate(expr, { M: { name: "abc" } })).toBe(
            "abc!",
          );
        }),
      ),
    );

    it.effect(".flatMap(fn) builds a FlatMapExpr", () =>
      provideState(
        Effect.gen(function* () {
          const expr = (resourceOutput() as any).flatMap((s: string) =>
            Output.literal(s + "?"),
          );
          expect(Output.isFlatMapExpr(expr)).toBe(true);
          expect(yield* Output.evaluate(expr, { M: { name: "abc" } })).toBe(
            "abc?",
          );
        }),
      ),
    );
  });

  describe("AllExpr", () => {
    it.effect("evaluates all wrapped outputs in parallel", () =>
      provideState(
        Effect.gen(function* () {
          const expr = Output.all(
            Output.literal(1),
            Output.literal("two"),
            Output.literal(true),
          );
          const result = yield* Output.evaluate(expr, {});
          expect(result).toEqual([1, "two", true]);
        }),
      ),
    );

    it.effect("evaluates all with resource expressions", () =>
      provideState(
        Effect.gen(function* () {
          const a = fakeResource("Test.A", "A");
          const b = fakeResource("Test.B", "B");
          const expr = Output.all(Output.of(a), Output.of(b));
          const result = yield* Output.evaluate(expr, {
            A: { x: 1 },
            B: { y: 2 },
          });
          expect(result).toEqual([{ x: 1 }, { y: 2 }]);
        }),
      ),
    );
  });

  describe("RefExpr", () => {
    const provideStackStage = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      stack = "myStack",
      stage = "myStage",
    ) =>
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Stack, { name: stack } as any),
            Layer.succeed(Stage, stage),
          ),
        ),
      );

    it.effect("resolves a Ref against in-memory state", () =>
      Effect.gen(function* () {
        const initial = {
          myStack: {
            myStage: {
              myResource: {
                fqn: "myResource",
                attr: { hello: "world" },
              } as unknown as ResourceState,
            },
          },
        };
        const r = makeRef<ResourceLike>("myResource");
        const expr = Output.of(r);
        const result = yield* provideStackStage(
          Output.evaluate(expr, {}).pipe(
            Effect.provide(inMemoryState(initial)),
          ),
        );
        expect(result).toEqual({ hello: "world" });
      }),
    );

    it.effect("uses explicit stack/stage when provided on the ref", () =>
      Effect.gen(function* () {
        const initial = {
          otherStack: {
            otherStage: {
              someResource: {
                fqn: "someResource",
                attr: { v: 1 },
              } as unknown as ResourceState,
            },
          },
        };
        const r = makeRef<ResourceLike>("someResource", {
          stack: "otherStack",
          stage: "otherStage",
        });
        const expr = Output.of(r);
        // No Stack/Stage layers needed since the ref carries them.
        const result = yield* Output.evaluate(expr, {}).pipe(
          Effect.provide(inMemoryState(initial)),
        );
        expect(result).toEqual({ v: 1 });
      }),
    );

    it.effect(
      "fails with InvalidReferenceError when ref target is missing",
      () =>
        Effect.gen(function* () {
          const r = makeRef<ResourceLike>("ghost", {
            stack: "s",
            stage: "t",
          });
          const expr = Output.of(r);
          const exit = yield* Effect.exit(
            Output.evaluate(expr, {}).pipe(Effect.provide(inMemoryState())),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause.toJSON())).toContain(
              "InvalidReferenceError",
            );
          }
        }),
    );

    it.effect(
      "PropExpr on a Ref reads the attribute from persisted state",
      () =>
        Effect.gen(function* () {
          const initial = {
            myStack: {
              myStage: {
                shared: {
                  fqn: "shared",
                  attr: { url: "https://example.com", name: "shared" },
                } as unknown as ResourceState,
              },
            },
          };
          const r = makeRef<ResourceLike>("shared");
          const expr = (Output.of(r) as any).url as Output.Output<string>;
          const result = yield* provideStackStage(
            Output.evaluate(expr, {}).pipe(
              Effect.provide(inMemoryState(initial)),
            ),
          );
          expect(result).toBe("https://example.com");
        }),
    );
  });

  describe("StackRefExpr", () => {
    const provideStage = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      stage = "myStage",
    ) => effect.pipe(Effect.provide(Layer.succeed(Stage, stage)));

    it.effect("Output.stackRef resolves to the persisted stack output", () =>
      Effect.gen(function* () {
        const expr = yield* Output.stackRef<{ url: string }>("Backend");
        const result = yield* provideStage(
          Output.evaluate(expr, {}).pipe(
            Effect.provide(
              inMemoryState(
                {},
                { Backend: { myStage: { url: "https://api.example.com" } } },
              ),
            ),
          ),
        );
        expect(result).toEqual({ url: "https://api.example.com" });
      }),
    );

    it.effect("explicit stage overrides the ambient Stage", () =>
      Effect.gen(function* () {
        const expr = yield* Output.stackRef<{ url: string }>("Backend", {
          stage: "prod",
        });
        // No Stage layer is provided — the ref carries it explicitly.
        const result = yield* Output.evaluate(expr, {}).pipe(
          Effect.provide(
            inMemoryState(
              {},
              { Backend: { prod: { url: "https://prod.example.com" } } },
            ),
          ),
        );
        expect(result).toEqual({ url: "https://prod.example.com" });
      }),
    );

    it.effect("PropExpr off a stackRef reads a single attribute", () =>
      Effect.gen(function* () {
        const backend = yield* Output.stackRef<{ url: string }>("Backend");
        const expr = (backend as any).url as Output.Output<string>;
        const result = yield* provideStage(
          Output.evaluate(expr, {}).pipe(
            Effect.provide(
              inMemoryState(
                {},
                { Backend: { myStage: { url: "https://api.example.com" } } },
              ),
            ),
          ),
        );
        expect(result).toBe("https://api.example.com");
      }),
    );

    it.effect(
      "fails with InvalidReferenceError when the target stack/stage has no persisted output",
      () =>
        Effect.gen(function* () {
          const expr = yield* Output.stackRef<{ url: string }>("Backend", {
            stage: "ghost",
          });
          const exit = yield* Effect.exit(
            Output.evaluate(expr, {}).pipe(Effect.provide(inMemoryState())),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(
              exit.cause,
            ) as Output.InvalidReferenceError;
            expect(err._tag).toBe("InvalidReferenceError");
            expect(err.stack).toBe("Backend");
            expect(err.stage).toBe("ghost");
          }
        }),
    );
  });

  describe("composition", () => {
    it.effect("evaluates outputs nested inside arrays and objects", () =>
      provideState(
        Effect.gen(function* () {
          const a = fakeResource("Test.A", "RA");
          const b = fakeResource("Test.B", "RB");
          const value = {
            list: [Output.of(a), Output.literal("lit")],
            nested: {
              prop: (Output.of(b) as any).name.pipe(
                Output.map((s: string) => `name=${s}`),
              ),
            },
            scalar: 42,
          };
          const result = yield* Output.evaluate(value, {
            RA: { foo: "f" },
            RB: { name: "bee" },
          });
          expect(result).toEqual({
            list: [{ foo: "f" }, "lit"],
            nested: { prop: "name=bee" },
            scalar: 42,
          });
        }),
      ),
    );
  });
});

describe("Output.interpolate", () => {
  it.effect("interpolates literal values into a template", () =>
    provideState(
      Effect.gen(function* () {
        const expr = Output.interpolate`hello ${Output.literal("world")}!`;
        expect(yield* Output.evaluate(expr, {})).toBe("hello world!");
      }),
    ),
  );

  it.effect("interpolates resource attributes", () =>
    provideState(
      Effect.gen(function* () {
        const src = fakeResource("Test.Bucket", "Buck");
        // @ts-expect-error
        const name = Output.of(src).name;
        const expr = Output.interpolate`s3://${name}/key`;
        const result = yield* Output.evaluate(expr, {
          Buck: { name: "my-bucket" },
        });
        expect(result).toBe("s3://my-bucket/key");
      }),
    ),
  );

  it.effect("renders nullish args as empty strings", () =>
    provideState(
      Effect.gen(function* () {
        const expr = Output.interpolate`a${Output.literal(null)}b${Output.literal(
          undefined,
        )}c`;
        expect(yield* Output.evaluate(expr, {})).toBe("abc");
      }),
    ),
  );
});

describe("Output coercion guard", () => {
  // These guard against the long-standing footgun where coercing an
  // unresolved Output silently produced a placeholder — the inspect
  // string for string-hints, or NaN for number-hints. Both let bogus
  // values flow into resource props and ultimately into the cloud.

  it("throws on template-literal interpolation of a raw Output", () => {
    const src = fakeResource("Test.Bucket", "Buck");
    // @ts-expect-error — synthetic prop access
    const name = Output.of(src).name;
    expect(() => `${name}`).toThrow(/Output\.interpolate/);
  });

  it("throws on string concatenation with a raw Output", () => {
    const src = fakeResource("Test.Bucket", "Buck");
    // @ts-expect-error — synthetic prop access
    const name = Output.of(src).name;
    expect(() => "s3://" + name).toThrow(/Output\.interpolate/);
  });

  it("throws on number coercion of a raw Output", () => {
    const src = fakeResource("Test.Bucket", "Buck");
    // @ts-expect-error — synthetic prop access
    const name = Output.of(src).name;
    expect(() => +name).toThrow(/Output\.(interpolate|map)/);
  });

  it("throws on arithmetic with a raw Output", () => {
    const src = fakeResource("Test.Bucket", "Buck");
    // @ts-expect-error — synthetic prop access
    const name = Output.of(src).name;
    expect(() => (name as unknown as number) * 2).toThrow(
      /Output\.(interpolate|map)/,
    );
  });
});

describe("Redacted stack-output serialization (regression #598)", () => {
  // A resource whose attribute is a `Redacted<string>` — e.g. `Random.text`,
  // which pr-package's AuthTokenValue exposes. When such an attribute flows
  // into a Stack output it is JSON-serialized for persistence to state /
  // Doppler / GH secrets. `JSON.stringify(Redacted)` returns the literal
  // string "<redacted>", so a publisher reading the output would send
  // `Bearer <redacted>` instead of the real token. The fix is to unwrap with
  // `Output.map(Redacted.value)` before returning it from the stack.
  const SECRET = "1486c434bd35732a185d1712c587ddfafd9e1c8d7a94fb15cf6ece51128";
  const redactedResource = () => {
    const src = fakeResource<
      "Alchemy.Random",
      { text: Redacted.Redacted<string> }
    >("Alchemy.Random", "AuthTokenValue");
    return (Output.of(src) as any).text as Output.Output<
      Redacted.Redacted<string>
    >;
  };
  const env = { AuthTokenValue: { text: Redacted.make(SECRET) } };

  it.effect(
    'a raw Redacted output serializes to the literal "<redacted>" (the bug)',
    () =>
      provideState(
        Effect.gen(function* () {
          const result = yield* Output.evaluate(redactedResource(), env);
          // The evaluated value is still a Redacted, and persisting it as a
          // stack output (JSON) loses the real token.
          expect(Redacted.isRedacted(result)).toBe(true);
          expect(JSON.stringify({ authToken: result })).toBe(
            '{"authToken":"<redacted>"}',
          );
        }),
      ),
  );

  it.effect("Output.map(Redacted.value) emits the real token (the fix)", () =>
    provideState(
      Effect.gen(function* () {
        const expr = redactedResource().pipe(Output.map(Redacted.value));
        const result = yield* Output.evaluate(expr, env);
        expect(result).toBe(SECRET);
        expect(JSON.stringify({ authToken: result })).toBe(
          `{"authToken":"${SECRET}"}`,
        );
      }),
    ),
  );
});

describe("Output.isOutput / isExpr", () => {
  it("identifies Output expressions", () => {
    expect(Output.isOutput(Output.literal(1))).toBe(true);
    expect(Output.isOutput(Output.all(Output.literal(1)))).toBe(true);
    expect(Output.isExpr(Output.literal(1))).toBe(true);
  });

  it("rejects non-Output values", () => {
    expect(Output.isOutput(1)).toBeFalsy();
    expect(Output.isOutput("x")).toBeFalsy();
    expect(Output.isOutput(null)).toBeFalsy();
    expect(Output.isOutput(undefined)).toBeFalsy();
    expect(Output.isOutput({})).toBeFalsy();
    expect(Output.isOutput([])).toBeFalsy();
  });
});

describe("Output.asOutput", () => {
  it.effect("wraps a plain value as a literal Output", () =>
    provideState(
      Effect.gen(function* () {
        const o = Output.asOutput("foo");
        expect(Output.isOutput(o)).toBe(true);
        expect(yield* Output.evaluate(o, {})).toBe("foo");
      }),
    ),
  );

  it.effect("wraps an Effect as an EffectExpr", () =>
    provideState(
      Effect.gen(function* () {
        const o = Output.asOutput(Effect.succeed(123));
        expect(Output.isOutput(o)).toBe(true);
        expect(yield* Output.evaluate(o, {})).toBe(123);
      }),
    ),
  );

  it("returns the same Output if already an Output", () => {
    const o = Output.literal("x");
    expect(Output.asOutput(o)).toBe(o);
  });
});

describe("Output.upstream / hasOutputs / resolveUpstream", () => {
  it("returns upstream resources from a ResourceExpr", () => {
    const src = fakeResource("Test.A", "FQN-A");
    const expr = Output.of(src);
    const up = Output.upstream(expr);
    expect(Object.keys(up)).toEqual(["FQN-A"]);
  });

  it("returns upstream resources from a PropExpr", () => {
    const src = fakeResource("Test.A", "FQN-A");
    const expr = (Output.of(src) as any).foo;
    expect(Object.keys(Output.upstream(expr))).toEqual(["FQN-A"]);
  });

  it("merges upstream resources from AllExpr", () => {
    const a = fakeResource("Test.A", "A");
    const b = fakeResource("Test.B", "B");
    const expr = Output.all(Output.of(a), Output.of(b));
    expect(Object.keys(Output.upstream(expr)).sort()).toEqual(["A", "B"]);
  });

  it("returns empty upstream for literals", () => {
    expect(Output.upstream(Output.literal(1))).toEqual({});
  });

  it("treats a raw Resource passed directly as an upstream dependency", () => {
    const src = fakeResource("Test.A", "RawA");
    expect(Object.keys(Output.upstream(src as any))).toEqual(["RawA"]);
  });

  it("upstreamAny detects a raw Resource passed directly as a prop value", () => {
    const a = fakeResource("Test.A", "FQN-A");
    const b = fakeResource("Test.B", "FQN-B");
    const props = { image: a, network: b };
    expect(Object.keys(Output.upstreamAny(props)).sort()).toEqual([
      "FQN-A",
      "FQN-B",
    ]);
  });

  it("upstreamAny detects raw Resources nested in arrays/objects", () => {
    const a = fakeResource("Test.A", "FQN-A");
    const b = fakeResource("Test.B", "FQN-B");
    const props = {
      volumes: [{ source: a }],
      env: { ref: b },
    };
    expect(Object.keys(Output.upstreamAny(props)).sort()).toEqual([
      "FQN-A",
      "FQN-B",
    ]);
  });

  it("upstreamAny detects raw Resource at the top level", () => {
    const a = fakeResource("Test.A", "Top");
    expect(Object.keys(Output.upstreamAny(a))).toEqual(["Top"]);
  });

  it("resolveUpstream picks up raw Resources alongside Output expressions", () => {
    const a = fakeResource("Test.A", "A1");
    const b = fakeResource("Test.B", "B1");
    const result = Output.resolveUpstream({
      raw: a,
      via: Output.of(b),
    });
    expect(Object.keys(result).sort()).toEqual(["A1", "B1"]);
  });

  it("hasOutputs is true when an object contains an Output referencing a resource", () => {
    const src = fakeResource("Test.A", "X");
    expect(Output.hasOutputs({ k: Output.of(src) })).toBe(true);
  });

  it("hasOutputs is false for plain values", () => {
    expect(Output.hasOutputs({ k: 1, b: "x" })).toBe(false);
    expect(Output.hasOutputs([1, 2, 3])).toBe(false);
  });

  it("resolveUpstream walks arrays and objects to gather resources", () => {
    const a = fakeResource("Test.A", "RA");
    const b = fakeResource("Test.B", "RB");
    const result = Output.resolveUpstream({
      arr: [Output.of(a)],
      nested: { prop: Output.of(b) },
      scalar: 1,
    });
    expect(Object.keys(result).sort()).toEqual(["RA", "RB"]);
  });
});

describe("Output.toEnvKey / toUpper", () => {
  it("uppercases strings", () => {
    expect(Output.toUpper("hello")).toBe("HELLO");
  });

  it("joins id + suffix and replaces dashes with underscores", () => {
    expect(Output.toEnvKey("my-bucket", "name")).toBe("MY_BUCKET_NAME");
    expect(Output.toEnvKey("svc", "api-key")).toBe("SVC_API_KEY");
  });
});
