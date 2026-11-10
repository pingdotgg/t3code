import { pathToFileURL } from "node:url";
import type * as Command from "effect/cli/Command";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { HttpClient } from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { AlchemyContext } from "./AlchemyContext.ts";
import type { ArtifactStore } from "./Artifacts.ts";
import type { AuthProviders } from "./Auth/AuthProvider.ts";
import type { CredentialsStore } from "./Auth/Credentials.ts";
import type { ProfileStore } from "./Auth/Profile.ts";
import type { Interaction } from "./Interaction.ts";
import type { State } from "./State/State.ts";
import { UserFacingError } from "./UserFacingError.ts";
import type { PlatformServices } from "./Util/PlatformServices.ts";

/**
 * What a provider contributes to Alchemy outside a stack: the parts the CLI,
 * the Alchemist API and the test harness need before (or without) importing
 * the user's `alchemy.run.ts`.
 *
 * A contributions module is imported on every CLI start, so it holds
 * metadata and lazy `import()`s only; the provider's code loads when a field
 * is used.
 *
 * A package declares what it contributes in `package.json`:
 *
 * ```json
 * { "alchemy": { "contributes": ["@alchemy.run/aws/Contributions"] } }
 * ```
 *
 * {@link load} reads that field from `alchemy` itself and from the project's
 * dependencies.
 */
export interface Contributions {
  /** Unique across loaded providers, e.g. `"aws"`. */
  readonly name: string;
  /**
   * Registers the provider's `AuthProvider` into `AuthProviders`, so
   * `alchemy profile` and login work without a stack that uses the provider.
   */
  readonly auth?: Lazy<Layer.Layer<never, never, ContributionServices>>;
  /**
   * The provider's state stores by `--backend` name, e.g. `{ aws: ... }`,
   * each reachable from a profile alone as `alchemy state --backend <name>`.
   * Names are global: two providers contributing one name is an error.
   */
  readonly stateStores?: Readonly<Record<string, StateStore>>;
  /** CLI commands the provider adds. */
  readonly cli?: Cli;
  /**
   * Services the test harness runs tests under when `ALCHEMY_TEST_DEV` is
   * set, e.g. a local emulator for the provider's SDK clients.
   */
  readonly testServices?: Lazy<TestServices>;
  /**
   * Environment variables `alchemy dev` sets on itself before it starts, so
   * its sidecars and the processes they launch inherit them, e.g. a local
   * emulator's CA bundle. A variable that is already set wins.
   */
  readonly devEnv?: Lazy<
    Effect.Effect<Readonly<Record<string, string>>, never, FileSystem.FileSystem | Path.Path>
  >;
}

/**
 * The services every host of provider code provides: the CLI and the Alchemist
 * API both run it under them. A provider supplies anything else it needs
 * itself, so a field can never require a service no host provides.
 */
export type HostServices =
  | PlatformServices
  | HttpClient
  | AlchemyContext
  | ProfileStore
  | CredentialsStore
  | ArtifactStore
  | Interaction;

/** What auth layers and state stores run under: the host's services and the auth registry. */
export type ContributionServices = HostServices | AuthProviders;

/** What a CLI command runs under: the host's services, `Interaction` included. */
export type CliServices = HostServices;

/** A provider's own failure: any tagged error with a message for the user. */
export type ContributionFailure = { readonly _tag: string; readonly message: string };
/**
 * A field loaded when used, so importing a provider module stays cheap. Build
 * one with {@link lazy}.
 */
export type Lazy<A> = Effect.Effect<A, ContributionError>;

/**
 * A {@link Lazy} field from a module of the provider's, imported on first
 * use:
 *
 * ```ts
 * auth: Contributions.lazy(() => import("./AuthProvider.ts"), (module) => module.AwsAuth),
 * ```
 */
export const lazy = <M, A>(load: () => Promise<M>, pick: (module: M) => A): Lazy<A> =>
  Effect.tryPromise({
    try: load,
    catch: (cause) =>
      new ContributionError({ message: "Could not import a provider module", cause }),
  }).pipe(Effect.map(pick));

export interface StateStore {
  /** Shown when listing stores; no provider code loads to show it. */
  readonly description: string;
  /** The store itself, loaded when it's used. */
  readonly load: Lazy<StateStoreImpl>;
}

export interface StateStoreImpl {
  /** The store's `State` layer: the provider's own `state` function. */
  readonly layer: (
    options: StateStoreOptions,
  ) => Layer.Layer<State, ContributionFailure, ContributionServices>;
  /** Provisioning, teardown and logs, for the operations the store supports. */
  readonly lifecycle?: StateStoreLifecycle;
}

/** The options every state store's `state(...)` takes. */
export interface StateStoreOptions {
  /** A store other than the account's default, by logical name. */
  readonly name?: string;
}

/** Which store a lifecycle operation acts on, under the profile core resolved. */
export interface StateStoreTarget {
  /** A store other than the account's default, by logical name. */
  readonly name?: string;
}

export interface StateStoreLifecycle {
  /** Provision the store, or adopt it when it exists. Idempotent. */
  readonly bootstrap?: (
    input: StateStoreTarget & {
      /** Redeploy an existing store instead of adopting it. */
      readonly force?: boolean;
    },
  ) => Effect.Effect<StateStoreBootstrap, ContributionFailure, ContributionServices>;
  /** Delete the store and its backing resources. Idempotent. */
  readonly teardown?: (
    input: StateStoreTarget,
  ) => Effect.Effect<StateStoreTeardown, ContributionFailure, ContributionServices>;
  /** The store's past log entries, oldest first. */
  readonly logs?: (
    input: StateStoreTarget & { readonly limit?: number; readonly since?: Date },
  ) => Effect.Effect<ReadonlyArray<StateStoreLogEntry>, ContributionFailure, ContributionServices>;
  /** The store's log entries as they happen. */
  readonly tailLogs?: (
    input: StateStoreTarget,
  ) => Stream.Stream<StateStoreLogEntry, ContributionFailure, ContributionServices>;
}

export interface StateStoreBootstrap {
  readonly status: "created" | "adopted" | "redeployed";
  /** The store's physical name: its Worker, its bucket. */
  readonly store: string;
  /** Where it lives, e.g. `{ account: "…", region: "us-east-1" }`. */
  readonly location: Readonly<Record<string, string>>;
}

export interface StateStoreTeardown {
  /** What was deleted, by physical name. */
  readonly deleted: ReadonlyArray<string>;
}

export interface StateStoreLogEntry {
  readonly timestamp: Date;
  readonly message: string;
}

export interface Cli {
  /**
   * The `alchemy provider <provider name>` subcommand. Its description lists it
   * in help; the command itself loads only when it runs.
   */
  readonly provider?: {
    readonly description: string;
    readonly load: Lazy<AnyCommand>;
  };
}

// Any command, whatever its name, errors and the CLI services it runs under.
export type AnyCommand = Command.Command<any, any, any, ContributionFailure, CliServices>;

export interface TestServices {
  /** Provided to test bodies and stack programs, closest wins. */
  readonly layer: Layer.Layer<any, ContributionFailure, never>;
  /** Rewrites the test's outbound HTTP, e.g. onto the emulator's gateway. */
  readonly mapRequest?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest;
  /** Set on the test process before anything forks, unless already set. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Declare a provider; the identity function, keeping its literal type. */
export const make = <const P extends Contributions>(provider: P): P => provider;

export class ContributionError extends Data.TaggedError("ContributionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly [UserFacingError] = true;
}

const Manifest = Schema.Struct({
  name: Schema.optional(Schema.String),
  main: Schema.optional(Schema.String),
  exports: Schema.optional(Schema.Unknown),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  alchemy: Schema.optional(
    Schema.Struct({ contributes: Schema.String.pipe(Schema.Array, Schema.optional) }),
  ),
});

const readManifest = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return undefined;
  const text = yield* fs.readFileString(file);
  return yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) => new ContributionError({ message: `Invalid JSON in ${file}`, cause }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
    Effect.mapError(
      (cause) => new ContributionError({ message: `Invalid package manifest ${file}`, cause }),
    ),
  );
});

/** Find `node_modules/<name>/package.json` from `dir` upwards. */
const findDependencyManifest = Effect.fn(function* (dir: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = dir;
  while (true) {
    const candidate = path.join(current, "node_modules", name, "package.json");
    if (yield* fs.exists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
});

/**
 * The packages a project in `dir` can contribute providers from: the direct
 * dependencies of every `package.json` from `dir` up (a workspace package and
 * the monorepo root above it), plus every installed `@alchemy.run/*` package
 * reachable from `dir`, which a monorepo root can import without listing.
 */
const candidatePackages = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = new Set<string>();
  let current = dir;
  while (true) {
    const manifest = yield* readManifest(path.join(current, "package.json"));
    for (const name of Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies })) {
      names.add(name);
    }
    const scope = path.join(current, "node_modules", PACKAGE_SCOPE);
    if (yield* fs.exists(scope)) {
      for (const entry of yield* fs.readDirectory(scope)) names.add(`${PACKAGE_SCOPE}/${entry}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return names;
    current = parent;
  }
});

/** The root `package.json` name of alchemy's own monorepo. */
const MONOREPO_NAME = "@alchemy.run/monorepo";

/**
 * The `package.json` of every sibling package when alchemy runs from its own
 * monorepo checkout (`packages/alchemy` under a root named
 * {@link MONOREPO_NAME}). Empty for every installed copy of alchemy.
 */
const monorepoManifests = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const own = path.dirname(yield* path.fromFileUrl(new URL("../package.json", import.meta.url)));
  const packages = path.dirname(own);
  const root = yield* readManifest(path.join(path.dirname(packages), "package.json")).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (root?.name !== MONOREPO_NAME) return [];
  const files: string[] = [];
  for (const entry of yield* fs.readDirectory(packages)) {
    const file = path.join(packages, entry, "package.json");
    if (path.join(packages, entry) !== own && (yield* fs.exists(file))) files.push(file);
  }
  return files.sort();
});

/** The npm scope of alchemy's own provider packages. */
const PACKAGE_SCOPE = "@alchemy.run";

/** A provider specifier, and the manifest that declared it when not alchemy's own. */
interface Declared {
  readonly specifier: string;
  readonly manifest?: {
    readonly file: string;
    readonly directory: string;
    readonly name: string | undefined;
    readonly main: string | undefined;
    readonly exports: unknown;
  };
}

/**
 * The conditions an ESM `import` matches. Node picks the first matching key in
 * the `exports` object's own order, so only membership matters here.
 */
const importConditions = new Set(
  typeof Bun !== "undefined" ? ["bun", "import", "node", "default"] : ["import", "node", "default"],
);

/** An `exports` target under {@link importConditions}, with `*` filled in. */
const exportTarget = (target: unknown, star: string): string | undefined => {
  if (typeof target === "string") return target.replaceAll("*", star);
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = exportTarget(candidate, star);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (typeof target === "object" && target !== null) {
    for (const [condition, value] of Object.entries(target)) {
      if (!importConditions.has(condition)) continue;
      const resolved = exportTarget(value, star);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
};

/** A package's own subpath (`"."`, `"./Contributions"`) through its `exports` map. */
const packageExport = (exports: unknown, main: string | undefined, subpath: string) => {
  if (exports === undefined) return subpath === "." ? (main ?? "./index.js") : subpath;
  const entries =
    typeof exports === "object" && exports !== null && !Array.isArray(exports)
      ? Object.entries(exports)
      : [];
  // Subpath keys, or the package's one export ("exports": "./index.js").
  const map = new Map<string, unknown>(
    entries.some(([key]) => key.startsWith(".")) ? entries : [[".", exports]],
  );
  if (map.has(subpath)) return exportTarget(map.get(subpath), "");
  for (const [pattern, target] of map) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      return exportTarget(target, subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
};

/**
 * Resolve a dependency's provider from the dependency itself, through its own
 * `exports` with ESM import conditions: under pnpm alchemy usually can't see
 * a project's dependencies, and a CommonJS resolver would pick `require`
 * targets for a module loaded with `import()`. A provider specifier must name
 * the package that declares it.
 */
const resolveDeclared = ({ specifier, manifest }: Declared) =>
  Effect.gen(function* () {
    if (manifest === undefined) return specifier;
    const path = yield* Path.Path;
    const { name } = manifest;
    if (name === undefined || (specifier !== name && !specifier.startsWith(`${name}/`))) {
      return yield* new ContributionError({
        message: `${specifier}, contributed by ${manifest.file}, must name that package (${name ?? "unnamed"})`,
      });
    }
    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const target = packageExport(manifest.exports, manifest.main, subpath);
    if (target === undefined) {
      return yield* new ContributionError({
        message: `${specifier} is not exported for import by ${manifest.file}`,
      });
    }
    return pathToFileURL(path.join(manifest.directory, target)).href;
  });

/** A module's default export as contributions; only the name is checked. */
const isContributions = (value: unknown): value is Contributions =>
  Predicate.hasProperty(value, "name") && typeof value.name === "string";

const importContributions = (declared: Declared) =>
  Effect.flatMap(resolveDeclared(declared), (url) =>
    Effect.tryPromise({
      try: (): Promise<{ readonly default?: unknown }> => import(url),
      catch: (cause) =>
        new ContributionError({ message: `Could not import ${declared.specifier}`, cause }),
    }),
  ).pipe(
    Effect.flatMap((module) =>
      isContributions(module.default)
        ? Effect.succeed(module.default)
        : Effect.fail(
            new ContributionError({
              message: `${declared.specifier} has no default export`,
            }),
          ),
    ),
  );

const discover = Effect.fn("Contributions.discover")(function* (cwd: string) {
  const path = yield* Path.Path;
  const declared = new Map<string, Declared>();
  const own = yield* readManifest(
    yield* path.fromFileUrl(new URL("../package.json", import.meta.url)),
  );
  // The project's packages that declare providers, before alchemy's own: the
  // first provider with a name wins, so a provider that moved into its own
  // package replaces the copy still inside alchemy.
  const declare = Effect.fn(function* (file: string, fallback = false) {
    const manifest = yield* readManifest(file);
    for (const specifier of manifest?.alchemy?.contributes ?? []) {
      if (fallback && declared.has(specifier)) continue;
      declared.set(specifier, {
        specifier,
        manifest: {
          file,
          directory: path.dirname(file),
          name: manifest?.name,
          main: manifest?.main,
          exports: manifest?.exports,
        },
      });
    }
  });
  const dependencies = [...(yield* candidatePackages(cwd))].filter((name) => name !== own?.name);
  for (const name of dependencies) {
    const file = yield* findDependencyManifest(cwd, name);
    if (file !== undefined) yield* declare(file);
  }
  // Developing alchemy itself: every package in the monorepo, so the CLI sees
  // all providers without the root installing them. Installed copies win.
  for (const file of yield* monorepoManifests) {
    yield* declare(file, true).pipe(
      Effect.catch((error) => Effect.logDebug(`Skipping ${file}: ${error.message}`)),
    );
  }
  // alchemy's own: the providers that still live in this package.
  for (const specifier of own?.alchemy?.contributes ?? []) declared.set(specifier, { specifier });
  // A provider that fails to load is skipped, never the rest; the first provider
  // with a name wins.
  const providers = new Map<string, Contributions>();
  for (const declaration of declared.values()) {
    const provider = yield* importContributions(declaration).pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(`Skipping ${declaration.specifier}: ${error.message}`),
          undefined,
        ),
      ),
    );
    if (provider === undefined) continue;
    if (providers.has(provider.name)) {
      // Expected for alchemy's own copy of a provider that moved out.
      yield* (declaration.manifest ? Effect.logWarning : Effect.logDebug)(
        `Skipping ${declaration.specifier}: the name ${provider.name} is taken`,
      );
      continue;
    }
    providers.set(provider.name, provider);
  }
  return [...providers.values()];
});

/** `--backend` names alchemy handles itself, so no provider may take them. */
export const RESERVED_BACKENDS: ReadonlyArray<string> = ["local", "configured"];

const loaded = new Map<string, Effect.Effect<ReadonlyArray<Contributions>, ContributionError>>();

/** The providers reachable from the project in `cwd`, loaded once per process. */
export const load = Effect.fn("Contributions.load")(function* (cwd?: string) {
  const dir = cwd ?? (yield* Effect.sync(() => process.cwd()));
  let cached = loaded.get(dir);
  if (cached === undefined) {
    cached = yield* Effect.cached(
      discover(dir).pipe(
        Effect.mapError((error) =>
          error._tag === "ContributionError"
            ? error
            : new ContributionError({ message: "Could not read package manifests", cause: error }),
        ),
        Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
        Effect.provideService(Path.Path, yield* Path.Path),
      ),
    );
    loaded.set(dir, cached);
  }
  return yield* cached;
});

/** The environment every provider contributes to `alchemy dev` (see {@link Contributions.devEnv}). */
export const devEnv = Effect.fn("Contributions.devEnv")(function* () {
  const env: Record<string, string> = {};
  for (const provider of yield* load()) {
    if (provider.devEnv === undefined) continue;
    const contribute = yield* resolve(provider, "devEnv", provider.devEnv);
    Object.assign(env, yield* contribute);
  }
  return env;
});

/** Every provider's state stores, by `--backend` name, with their provider. */
export const stateStores = Effect.fn("Contributions.stateStores")(function* () {
  const stores = new Map<
    string,
    { readonly provider: Contributions; readonly store: StateStore }
  >();
  for (const provider of yield* load()) {
    for (const [backend, store] of Object.entries(provider.stateStores ?? {})) {
      // A state backend name addresses one store, so two providers can't share it.
      const owner = RESERVED_BACKENDS.includes(backend)
        ? "alchemy"
        : stores.get(backend)?.provider.name;
      if (owner !== undefined) {
        return yield* new ContributionError({
          message: `${provider.name} and ${owner} both contribute a state store named ${backend}`,
        });
      }
      stores.set(backend, { provider, store });
    }
  }
  return stores;
});

/** Load one lazy field, failing with a {@link ContributionError} naming the provider. */
export const resolve = <A>(provider: Contributions, field: string, value: Lazy<A>) =>
  value.pipe(
    Effect.mapError(
      (cause) =>
        new ContributionError({
          message: `Could not load ${provider.name}'s ${field}: ${cause.message}`,
          cause,
        }),
    ),
  );
