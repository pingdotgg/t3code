import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Namespace from "@/Namespace.ts";
import * as Stack from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { inMemoryState, type State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Context from "effect/Context";
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
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:website",
      "local",
    ],
  },
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
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:website",
      "local",
    ],
  },
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
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:website",
      "local",
    ],
  },
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
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:website",
      "local",
    ],
  },
);

class WebsiteRoot extends Context.Service<WebsiteRoot, string>()(
  "WebsiteRoot",
) {}

const astroProps = Effect.gen(function* () {
  const rootDir = yield* WebsiteRoot;
  return {
    rootDir,
    astro: { output: "static" as const },
    assets: { notFoundHandling: "404-page" as const },
  };
});

class AstroFromEffect extends Cloudflare.Website.Astro<AstroFromEffect>()(
  "AstroClass",
  astroProps,
) {}

const AstroFromEffectFunction = Cloudflare.Website.Astro(
  "AstroFunction",
  astroProps,
);

// Both overloads must retain the props Effect's requirements without adding an error.
const functionRequiresRoot: WebsiteRoot extends Effect.Services<
  typeof AstroFromEffectFunction
>
  ? true
  : false = true;
const classRequiresRoot: WebsiteRoot extends Effect.Services<
  typeof AstroFromEffect
>
  ? true
  : false = true;
const functionIsInfallible: [
  Effect.Error<typeof AstroFromEffectFunction>,
] extends [never]
  ? true
  : false = true;
const classIsInfallible: [Effect.Error<typeof AstroFromEffect>] extends [never]
  ? true
  : false = true;

test(
  "Astro function and class constructors evaluate typed props Effects before declaring resources",
  Effect.gen(function* () {
    expect(
      functionRequiresRoot &&
        classRequiresRoot &&
        functionIsInfallible &&
        classIsInfallible,
    ).toBe(true);
    const resources = yield* compile(
      Effect.all([AstroFromEffectFunction, AstroFromEffect]).pipe(
        Effect.provideService(WebsiteRoot, "./typed-astro"),
      ),
    );
    // Static output must suppress auto-provisioning the session namespace.
    expect(Object.keys(resources).sort()).toEqual([
      "AstroClass",
      "AstroFunction",
    ]);
    for (const id of ["AstroClass", "AstroFunction"]) {
      expect(resources[id]?.Props.source).toMatchObject({
        rootDir: "./typed-astro",
        options: { astro: { output: "static" } },
      });
      expect(resources[id]?.Props.assets).toEqual({
        notFoundHandling: "404-page",
      });
    }
  }),
  {
    tags: [
      "unit",
      "provider:cloudflare",
      "provider:cloudflare:website",
      "local",
    ],
  },
);
