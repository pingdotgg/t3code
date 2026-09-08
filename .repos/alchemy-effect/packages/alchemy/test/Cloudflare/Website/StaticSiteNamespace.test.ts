import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Namespace from "@/Namespace.ts";
import * as Stack from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { inMemoryState, type State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({
  providers: Layer.empty,
  state: inMemoryState(),
});

// A resource declared once, at module scope, and referenced from a site's
// `env` — the pattern `examples/cloudflare-website-tanstack-start` uses.
const Cache = Cloudflare.KV.Namespace("Cache", {});

/** Compile the stack and return its registered resources. */
const compile = <A, Err = never, Req = never>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<Stack.CompiledStack["resources"], Err, State> =>
  effect.pipe(
    // @ts-expect-error - Stack.make's typing erases R unsoundly here
    Stack.make({
      name: "test",
      providers: Layer.empty,
      state: inMemoryState(),
    }),
    Effect.provideService(Stage, "test"),
    Effect.map((stack: Stack.CompiledStack) => stack.resources),
  );

/** Compile the stack and return the FQN of every registered resource. */
const fqns = <A, Err = never, Req = never>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<string[], Err, State> =>
  compile(effect).pipe(
    Effect.map((resources) => Object.keys(resources).sort()),
  );

test(
  "StaticSite declares env resources in the caller's namespace",
  Effect.gen(function* () {
    const keys = yield* fqns(
      Effect.gen(function* () {
        yield* Cache;
        yield* Cloudflare.Website.StaticSite("Site", {
          command: "echo build",
          outdir: "dist",
          main: "./worker.ts",
          env: { CACHE: Cache },
        });
      }),
    );
    // Only the build sub-resource is namespaced; the Worker is the site
    // itself and `Cache` stays where the caller declared it.
    expect(keys).toEqual(["Cache", "Site", "Site/Build"]);
  }),
);

test(
  "StaticSite claims its pre-#1053 `<id>/Worker` FQN, including when nested",
  Effect.gen(function* () {
    const resources = yield* compile(
      Effect.gen(function* () {
        // Top-level site.
        yield* Cloudflare.Website.StaticSite("Site", {
          command: "echo build",
          outdir: "dist",
          main: "./worker.ts",
        });
        // Site nested inside a caller namespace — the former FQN must
        // resolve under the same `App/` prefix as the site itself.
        yield* Cloudflare.Website.StaticSite("Nested", {
          command: "echo build",
          outdir: "dist",
          main: "./worker.ts",
        }).pipe(Namespace.push("App"));
      }),
    );
    expect(resources["Site"]?.FormerFqns).toEqual(["Site/Worker"]);
    expect(resources["App/Nested"]?.FormerFqns).toEqual(["App/Nested/Worker"]);
  }),
);

test(
  "Vite declares env resources in the caller's namespace",
  Effect.gen(function* () {
    const keys = yield* fqns(
      Effect.gen(function* () {
        yield* Cache;
        yield* Cloudflare.Website.Vite("Site", {
          main: "./worker.ts",
          env: { CACHE: Cache },
        });
      }),
    );
    expect(keys).toEqual(["Cache", "Site"]);
  }),
);

test(
  "Astro forwards the prerender environment to its source provider",
  Effect.gen(function* () {
    const resources = yield* compile(
      Cloudflare.Website.Astro("Astro", {
        prerenderEnvironment: "node",
        sessionKVBindingName: false,
      }),
    );
    expect(resources["Astro"]?.Props.source).toMatchObject({
      provider: "@alchemy.run/frontend-frameworks/astro/source",
      devMode: "server",
      options: {
        prerenderEnvironment: "node",
      },
    });
  }),
);
