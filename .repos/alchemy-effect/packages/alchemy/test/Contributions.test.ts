import { assert, describe, expect, it, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Command from "effect/cli/Command";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Alchemist from "@/Alchemist/index.ts";
import { providerCommand } from "@/Cli/commands/provider.ts";
import * as Contributions from "@/Contributions.ts";
import * as Interaction from "@/Interaction.ts";

interface Dependency {
  /** `package.json` of the dependency; omit to leave it uninstalled. */
  readonly manifest?: object;
  /** Files beside it, by name. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * A project in a temp directory, outside the repo, so a dependency's provider
 * only loads when it's resolved from the dependency itself.
 */
const project = (
  dependencies: Readonly<Record<string, Dependency>>,
  options: { readonly directory?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (options.directory !== undefined) {
      yield* fs.makeDirectory(options.directory, { recursive: true });
    }
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-provider-",
      directory: options.directory,
    });
    yield* fs.writeFileString(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "project",
        dependencies: Object.fromEntries(Object.keys(dependencies).map((name) => [name, "*"])),
      }),
    );
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (dependency.manifest === undefined) continue;
      const directory = path.join(root, "node_modules", name);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "package.json"),
        JSON.stringify({ name, type: "module", ...dependency.manifest }),
      );
      for (const [file, contents] of Object.entries(dependency.files ?? {})) {
        yield* fs.writeFileString(path.join(directory, file), contents);
      }
    }
    return root;
  });

const contributingPackage = (name: string, provider: string): Dependency => ({
  manifest: {
    exports: { "./Contributions": "./Contributions.js" },
    alchemy: { contributes: [`${name}/Contributions`] },
  },
  files: { "Contributions.js": provider },
});

describe("Contributions.load", { tags: ["unit", "local"] }, () =>
  layer(NodeServices.layer)((it) => {
    it.effect("loads a dependency's providers", () =>
      Effect.gen(function* () {
        const root = yield* project({
          "fake-provider": contributingPackage(
            "fake-provider",
            `export default { name: "fake", stateStores: { fake: { description: "Fake store" } } };`,
          ),
        });
        const providers = yield* Contributions.load(root);
        const names = providers.map((provider) => provider.name);
        expect(names).toContain("fake");
        expect(
          providers.find((provider) => provider.name === "fake")?.stateStores?.fake?.description,
        ).toBe("Fake store");
      }).pipe(Effect.scoped),
    );

    it.effect("skips dependencies without providers and ones not installed", () =>
      Effect.gen(function* () {
        const root = yield* project({
          "plain-package": { manifest: { exports: { ".": "./index.js" } } },
          "not-installed": {},
        });
        const own = yield* Contributions.load(yield* project({}));
        const providers = yield* Contributions.load(root);
        expect(providers.map((provider) => provider.name)).toEqual(
          own.map((provider) => provider.name),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("a dependency's provider replaces alchemy's own of the same name", () =>
      Effect.gen(function* () {
        const root = yield* project({
          "aws-package": contributingPackage(
            "aws-package",
            `export default { name: "aws", from: "aws-package" };`,
          ),
        });
        const aws = (yield* Contributions.load(root)).filter((provider) => provider.name === "aws");
        expect(aws).toHaveLength(1);
        expect(aws[0]).toMatchObject({ from: "aws-package" });
      }).pipe(Effect.scoped),
    );

    it.effect(
      "merges the dev environment providers contribute",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          // Imports `effect`, so the project lives under this package.
          const devEnvProvider = (name: string, env: Record<string, string>) =>
            contributingPackage(
              name,
              `import * as Effect from "effect/Effect";
export default { name: ${JSON.stringify(name)}, devEnv: Effect.succeed(Effect.succeed(${JSON.stringify(env)})) };`,
            );
          const root = yield* project(
            {
              "env-one": devEnvProvider("env-one", { ONE: "1" }),
              "env-two": devEnvProvider("env-two", { TWO: "2" }),
            },
            { directory: path.resolve(import.meta.dirname, "../.alchemy/test-providers") },
          );
          const env = yield* inDirectory(root, Contributions.devEnv());
          expect(env).toMatchObject({ ONE: "1", TWO: "2" });
        }).pipe(Effect.scoped),
      // Exclusive: changes the process's working directory.
      { exclusive: true },
    );

    it.effect("skips a second dependency provider with a taken name", () =>
      Effect.gen(function* () {
        const root = yield* project({
          "first-acme": contributingPackage(
            "first-acme",
            `export default { name: "acme", from: "first" };`,
          ),
          "second-acme": contributingPackage(
            "second-acme",
            `export default { name: "acme", from: "second" };`,
          ),
        });
        const acme = (yield* Contributions.load(root)).filter(
          (provider) => provider.name === "acme",
        );
        expect(acme).toHaveLength(1);
        expect(acme[0]).toMatchObject({ from: "first" });
      }).pipe(Effect.scoped),
    );

    it.effect("skips a provider that fails to load, keeping the others", () =>
      Effect.gen(function* () {
        const root = yield* project({
          "no-default": contributingPackage(
            "no-default",
            `export const provider = { name: "nope" };`,
          ),
          "fake-provider": contributingPackage("fake-provider", `export default { name: "fake" };`),
        });
        const names = (yield* Contributions.load(root)).map((provider) => provider.name);
        expect(names).toContain("fake");
        expect(names).not.toContain("nope");
      }).pipe(Effect.scoped),
    );
    it.effect("resolves a dependency's provider with import conditions", () =>
      Effect.gen(function* () {
        const root = yield* project({
          "import-only": {
            manifest: {
              exports: { "./Contributions": { import: "./Contributions.js" } },
              alchemy: { contributes: ["import-only/Contributions"] },
            },
            files: { "Contributions.js": `export default { name: "import-only" };` },
          },
          dual: {
            manifest: {
              exports: {
                "./Contributions": { require: "./Contributions.cjs", import: "./Contributions.js" },
              },
              alchemy: { contributes: ["dual/Contributions"] },
            },
            files: {
              "Contributions.js": `export default { name: "dual-esm" };`,
              "Contributions.cjs": `module.exports = { default: { name: "dual-cjs" } };`,
            },
          },
        });
        const names = (yield* Contributions.load(root)).map((provider) => provider.name);
        expect(names).toContain("import-only");
        expect(names).toContain("dual-esm");
        expect(names).not.toContain("dual-cjs");
      }).pipe(Effect.scoped),
    );

    it.effect("discovers a provider declared by an ancestor package.json", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* project({
          "fake-provider": contributingPackage("fake-provider", `export default { name: "fake" };`),
        });
        const workspace = path.join(root, "apps", "infra");
        yield* fs.makeDirectory(workspace, { recursive: true });
        yield* fs.writeFileString(
          path.join(workspace, "package.json"),
          JSON.stringify({ name: "infra" }),
        );
        const names = (yield* Contributions.load(workspace)).map((provider) => provider.name);
        expect(names).toContain("fake");
      }).pipe(Effect.scoped),
    );

    it.effect("discovers an installed @alchemy.run package the project doesn't list", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* project({});
        const directory = path.join(root, "node_modules", "@alchemy.run", "fake");
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          path.join(directory, "package.json"),
          JSON.stringify({
            name: "@alchemy.run/fake",
            type: "module",
            exports: { "./Contributions": "./Contributions.js" },
            alchemy: { contributes: ["@alchemy.run/fake/Contributions"] },
          }),
        );
        yield* fs.writeFileString(
          path.join(directory, "Contributions.js"),
          `export default { name: "fake" };`,
        );
        const names = (yield* Contributions.load(root)).map((provider) => provider.name);
        expect(names).toContain("fake");
      }).pipe(Effect.scoped),
    );

    it.effect("skips a provider whose specifier names another package", () =>
      Effect.gen(function* () {
        const root = yield* project({
          borrower: {
            manifest: { alchemy: { contributes: ["fake-provider/Contributions"] } },
          },
        });
        const own = yield* Contributions.load(yield* project({}));
        const providers = yield* Contributions.load(root);
        expect(providers.map((provider) => provider.name)).toEqual(
          own.map((provider) => provider.name),
        );
      }).pipe(Effect.scoped),
    );

    const storeNames = (dependencies: Record<string, string>) =>
      Effect.gen(function* () {
        const root = yield* project(
          Object.fromEntries(
            Object.entries(dependencies).map(([name, source]) => [
              name,
              contributingPackage(name, source),
            ]),
          ),
        );
        return yield* inDirectory(root, Contributions.stateStores());
      });

    it.effect(
      "a provider contributes several state stores",
      () =>
        Effect.gen(function* () {
          const stores = yield* storeNames({
            "multi-store": `export default { name: "multi", stateStores: {
            "multi-kv": { description: "KV" },
            "multi-sql": { description: "SQL" },
          } };`,
          });
          expect(stores.get("multi-kv")?.provider.name).toBe("multi");
          expect(stores.get("multi-sql")?.store.description).toBe("SQL");
        }).pipe(Effect.scoped),
      // Exclusive: changes the process's working directory.
      { exclusive: true },
    );

    it.effect(
      "two providers contributing one state store name is an error",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            storeNames({
              "first-store": `export default { name: "first", stateStores: { kv: { description: "KV" } } };`,
              "second-store": `export default { name: "second", stateStores: { kv: { description: "KV" } } };`,
            }),
          );
          expect(contributionErrorMessage(error)).toBe(
            "second and first both contribute a state store named kv",
          );
        }).pipe(Effect.scoped),
      { exclusive: true },
    );

    it.effect(
      "a state store named after a backend alchemy reserves is an error",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            storeNames({
              "local-store": `export default { name: "other", stateStores: { local: { description: "Local" } } };`,
            }),
          );
          expect(contributionErrorMessage(error)).toBe(
            "other and alchemy both contribute a state store named local",
          );
        }).pipe(Effect.scoped),
      { exclusive: true },
    );
  }),
);

/** The message of the `ContributionError` a lifecycle route failed with. */
const contributionErrorMessage = (error: unknown) => {
  assert(error instanceof Contributions.ContributionError);
  return error.message;
};

/** Run with the process in `directory`, as the CLI would run in a project. */
const inDirectory = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.cwd();
      process.chdir(directory);
      return previous;
    }),
    () => effect,
    (previous) => Effect.sync(() => process.chdir(previous)),
  );

declare global {
  var __scopedStoreState: "open" | "closed" | undefined;
}

/**
 * A provider whose state store holds a resource its layer's finalizer closes.
 * It imports `effect` and alchemy's `State`, so it lives under this package.
 */
const scopedStoreContributions = Effect.gen(function* () {
  const path = yield* Path.Path;
  const state = path.resolve(import.meta.dirname, "../src/State/State.ts");
  return contributingPackage(
    "scoped-store",
    `import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { State } from ${JSON.stringify(state)};

const layer = Layer.effect(
  State,
  Effect.acquireRelease(
    Effect.sync(() => {
      globalThis.__scopedStoreState = "open";
      return Effect.succeed({
        listStacks: () =>
          globalThis.__scopedStoreState === "open"
            ? Effect.succeed(["open"])
            : Effect.die(new Error("the store's client is closed")),
      });
    }),
    () => Effect.sync(() => void (globalThis.__scopedStoreState = "closed")),
  ),
);

export default {
  name: "scoped-store",
  stateStores: {
    "scoped-store": { description: "Scoped", load: Effect.succeed({ layer: () => layer }) },
  },
};
`,
  );
});

describe("Alchemist.State lifecycle", { tags: ["unit", "local"] }, () =>
  layer(Alchemist.layer())((it) => {
    it.effect(
      "a store's resources stay open until the caller's scope closes",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* project(
            { "scoped-store": yield* scopedStoreContributions },
            { directory: path.resolve(import.meta.dirname, "../.alchemy/test-providers") },
          );
          const stacks = yield* inDirectory(
            root,
            Effect.scoped(
              Effect.flatMap(
                Alchemist.State.store({ type: "provider", backend: "scoped-store" }),
                (store) => store.listStacks(),
              ),
            ),
          );
          expect(stacks).toEqual(["open"]);
          expect(globalThis.__scopedStoreState).toBe("closed");
        }).pipe(Effect.scoped),
      // Exclusive: changes the process's working directory.
      { exclusive: true },
    );

    it.effect("rejects an unknown backend", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Alchemist.State.bootstrap({ type: "provider", backend: "nope" }),
        );
        // The available stores depend on the @alchemy.run packages installed
        // around the repo, so only the stable parts are pinned.
        const message = contributionErrorMessage(error);
        expect(message).toContain("Unknown state backend 'nope'. Available: local, configured");
        expect(message).toContain("Install the package that provides it.");
      }),
    );

    it.effect("rejects an operation the backend doesn't have", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Alchemist.State.logs({ type: "provider", backend: "aws" }),
        );
        expect(contributionErrorMessage(error)).toBe("State backend 'aws' does not support logs.");
      }),
    );
  }),
);

const cliContributions = (
  name: string,
  load: Contributions.Lazy<Contributions.AnyCommand>,
): Contributions.Contributions =>
  Contributions.make({ name, cli: { provider: { description: `${name} commands`, load } } });

const brokenCli = cliContributions(
  "broken",
  Effect.fail(new Contributions.ContributionError({ message: "broken CLI failed to import" })),
);
const workingCli = cliContributions(
  "working",
  Effect.succeed(Command.make("working", {}, () => Effect.void)),
);

describe("alchemy provider", { tags: ["unit", "local"] }, () => {
  it.live("a provider whose CLI fails to load doesn't block another's", () =>
    Effect.gen(function* () {
      const command = yield* Effect.promise(() => providerCommand([brokenCli, workingCli]));
      const run = (args: ReadonlyArray<string>) =>
        Command.runWith(command, { version: "test" })(args).pipe(
          Effect.provide(Layer.mergeAll(Alchemist.layer(), Interaction.layerNonInteractive())),
        );
      yield* run(["working"]);
      const error = yield* Effect.flip(run(["broken"]));
      expect(String(error)).toContain("broken CLI failed to import");
    }),
  );
});

describe("Contributions contract", { tags: ["unit", "local"] }, () => {
  it("rejects a field requiring a service no host provides", () => {
    class PrivateClient extends Context.Service<PrivateClient, { readonly id: string }>()(
      "PrivateClient",
    ) {}
    const provider = Contributions.make({
      name: "needs-private-client",
      // @ts-expect-error PrivateClient is not a host service; the provider must supply it.
      auth: Effect.succeed(
        Layer.effectDiscard(
          Effect.gen(function* () {
            yield* PrivateClient;
          }),
        ),
      ),
    });
    expect(provider.name).toBe("needs-private-client");
  });
});
