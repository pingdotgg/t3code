// @effect-diagnostics nodeBuiltinImport:off
/**
 * Installs trusted plugins from an npm registry into directories the server
 * owns, then hands each one to the catalogue like any added directory.
 *
 * Installing runs nothing. One exact version is resolved, its tarball must
 * match the registry's sha512 integrity, and the archive is checked whole
 * before a byte is written (see `npmTarball.ts`). Package scripts never run
 * and dependencies are never installed: a package must bundle what it needs,
 * so a package with an install script, or whose dependencies (or theirs in
 * turn) do not resolve inside it, is refused. The catalogue then requires
 * consent to the unpacked digest before the plugin can be enabled.
 *
 * Layout under `<state>/plugins/npm/<key>/`:
 * - `package/` the installed version: the catalogue installation's directory.
 * - `npm.json` where it came from, and an update swap in progress, if any.
 * - `.staging-*` a version being unpacked or a staged update; never survives a restart.
 * - `.previous` the replaced version, only while an update is being applied.
 *
 * An update unpacks next to `package/` and leaves it running. Applying it
 * first journals the swap in `npm.json`, then hands the catalogue one step
 * (`PluginCatalog.replace`) that stops the installation, swaps the
 * directories, and consents to the staged digest; that consent is the commit
 * point, and a failure before it puts the old directory back. The journal is
 * then settled by another catalogue step (`PluginCatalog.settleReplace`),
 * which decides from the consent it holds at that moment: finished when it
 * has consent to the new digest, otherwise rolled back from `.previous` after
 * the plugin has stopped. Until settling works, the journal and `.previous`
 * stay, and it is retried before every npm step, after every catalogue
 * change, and at startup.
 *
 * Every file move or deletion under the root is one catalogue step that
 * claims the paths first (`replace`, `settleReplace`, `changeFiles`): it is
 * refused while any installation is rooted there, whatever its id, and waits
 * until every process that ran from those files has exited. A deletion that
 * is refused or fails stays queued and is retried the same way.
 *
 * Removing the installation from the catalogue deletes its `<key>` directory.
 */
import * as NodeCrypto from "node:crypto";

import {
  PluginCatalogError,
  PluginNpmIntegrity,
  PluginNpmSource,
  PluginNpmVersion,
  PluginSourceDigest,
  type PluginInstallationId,
  type PluginInstallationInput,
  type PluginNpmAddInput,
  type PluginNpmApplyUpdateInput,
  type PluginNpmInstallationResult,
  type PluginNpmListResult,
  type PluginNpmPackage,
  type PluginNpmPackageResult,
  type PluginNpmStagedUpdate,
  type PluginNpmStageUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { ServerConfig } from "../config.ts";
import { PluginCatalog, summarizePluginManifest } from "./PluginCatalog.ts";
import { loadPluginDirectory } from "./PluginManifestLoader.ts";
import { digestPluginSource } from "./pluginSource.ts";
import {
  defaultNpmTarballLimits,
  readNpmTarball,
  type NpmTarballFile,
  type NpmTarballLimits,
} from "./npmTarball.ts";

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** `PluginCatalogError.reason` values this module adds. */
type PluginNpmFailure =
  | "npm-invalid-request"
  | "npm-not-found"
  | "npm-registry-unavailable"
  | "npm-registry-invalid"
  | "npm-integrity-missing"
  | "npm-integrity-mismatch"
  | "npm-too-large"
  | "npm-archive-unsafe"
  | "npm-package-mismatch"
  | "npm-install-scripts"
  | "npm-dependencies"
  | "npm-plugin-id-changed"
  | "npm-no-update";

const npmError = (
  reason: PluginNpmFailure | "not-found" | "already-added" | "source-changed" | "storage",
  message: string,
  installationId?: PluginInstallationId,
) =>
  new PluginCatalogError({
    reason,
    message,
    ...(installationId === undefined ? {} : { installationId }),
  });

const storageError = (cause: unknown) =>
  Effect.logWarning("Plugin npm storage failed", { cause }).pipe(
    Effect.andThen(Effect.fail(npmError("storage", "Could not write the plugin's files."))),
  );

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_METADATA_REDIRECTS = 5;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
/** Dependency declarations followed through one package's bundled tree. */
const MAX_DEPENDENCY_EDGES = 20_000;

const NpmVersionMetadata = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dist: Schema.Struct({ tarball: Schema.String, integrity: Schema.optionalKey(Schema.String) }),
});
const decodeMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(NpmVersionMetadata));

const DependencyMap = Schema.Record(Schema.String, Schema.Unknown);
const BundledDependencies = Schema.Union([Schema.Array(Schema.String), Schema.Boolean]);
const NpmPackageJson = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  scripts: Schema.optionalKey(DependencyMap),
  dependencies: Schema.optionalKey(DependencyMap),
  optionalDependencies: Schema.optionalKey(DependencyMap),
  peerDependencies: Schema.optionalKey(DependencyMap),
  peerDependenciesMeta: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ optional: Schema.optionalKey(Schema.Boolean) })),
  ),
  bundleDependencies: Schema.optionalKey(BundledDependencies),
  bundledDependencies: Schema.optionalKey(BundledDependencies),
});
type NpmPackageJson = typeof NpmPackageJson.Type;
const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(NpmPackageJson));
const decodePackageJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(NpmPackageJson));

/** `npm.json`: the installed version and, while an update is applied, the one replacing it. */
const NpmRecord = Schema.Struct({
  source: PluginNpmSource,
  swap: Schema.optionalKey(Schema.Struct({ source: PluginNpmSource, digest: PluginSourceDigest })),
});
type NpmRecord = typeof NpmRecord.Type;
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(NpmRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(NpmRecord));
const isExactVersion = Schema.is(PluginNpmVersion);
const isIntegrity = Schema.is(PluginNpmIntegrity);

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

interface Resolved {
  readonly version: PluginNpmVersion;
  readonly integrity: PluginNpmIntegrity;
  readonly tarball: string;
}

interface Installed {
  /** `<root>/<key>`. */
  readonly home: string;
  /** `<home>/package`, the catalogue installation's directory. */
  readonly directory: string;
  readonly installationId: PluginInstallationId;
  source: PluginNpmSource;
  staged: { readonly update: PluginNpmStagedUpdate; readonly directory: string } | undefined;
  /** A swap journaled in `npm.json` and not yet finished or rolled back. */
  swap:
    | {
        readonly previous: PluginNpmSource;
        readonly next: PluginNpmSource;
        readonly digest: string;
      }
    | undefined;
}

const toPackage = (entry: Installed): PluginNpmPackage => ({
  installationId: entry.installationId,
  source: entry.source,
  stagedUpdate: entry.staged?.update ?? null,
});

// Over plain http the registry's integrity and the tarball travel together, so
// the digest check would authenticate nothing; only a loopback registry may use it.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether metadata fetched from `url` can vouch for a tarball's integrity. */
const isTrustedRegistryUrl = (url: URL) =>
  url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));

/** Registry base URL without a trailing slash; credentials, queries, and fragments are refused. */
const normalizeRegistry = (input: string) => {
  const url = URL.parse(input);
  if (
    url === null ||
    !isTrustedRegistryUrl(url) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return Effect.fail(
      npmError(
        "npm-invalid-request",
        "Enter the registry as an https URL (http only on this machine) without credentials, query, or fragment.",
      ),
    );
  return Effect.succeed(url.href.replace(/\/+$/, ""));
};

/** What a package needs at run time; a peer it marks optional is left out. */
const runtimeDependencies = (packageJson: NpmPackageJson) => [
  ...new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}).filter(
      (peer) => packageJson.peerDependenciesMeta?.[peer]?.optional !== true,
    ),
  ]),
];

/** `<parent>node_modules/<name>/package.json`, with the last `node_modules` taken. */
const BUNDLED_MANIFEST = /^(.*\/)?node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\/package\.json$/;

/**
 * Follows every runtime dependency from the root through the shipped
 * `node_modules` the way Node looks them up, but never above the package
 * root: one found nowhere inside would come from outside what the user
 * consented to, or not at all. Returns why the package is refused, if it is.
 */
const findUnbundled = (files: ReadonlyArray<NpmTarballFile>, root: NpmPackageJson) => {
  // Parent directory (`""` or ending in `/`) -> package name -> that package's manifest.
  const shipped = new Map<string, Map<string, NpmTarballFile>>();
  for (const file of files) {
    const match = BUNDLED_MANIFEST.exec(file.path);
    if (match === null) continue;
    const parent = match[1] ?? "";
    const names = shipped.get(parent) ?? new Map<string, NpmTarballFile>();
    names.set(match[2]!, file);
    shipped.set(parent, names);
  }
  const queue: Array<readonly [string, NpmPackageJson]> = [["", root]];
  const seen = new Set<NpmTarballFile>();
  let edges = 0;
  for (let index = 0; index < queue.length; index++) {
    const [from, packageJson] = queue[index]!;
    // Where `from` looks, nearest first: itself and each ancestor that is not a `node_modules`.
    const parents = [""];
    let prefix = "";
    for (const segment of from === "" ? [] : from.split("/")) {
      prefix += `${segment}/`;
      if (segment !== "node_modules") parents.push(prefix);
    }
    parents.reverse();
    for (const dependency of runtimeDependencies(packageJson)) {
      if (++edges > MAX_DEPENDENCY_EDGES)
        return `The package declares more than ${MAX_DEPENDENCY_EDGES} dependencies in its bundled tree.`;
      const parent = parents.find((candidate) => shipped.get(candidate)?.has(dependency));
      if (parent === undefined)
        return `${from === "" ? "The package" : from} depends on ${dependency}, which the package does not ship.`;
      const manifest = shipped.get(parent)!.get(dependency)!;
      if (seen.has(manifest)) continue;
      seen.add(manifest);
      const decoded =
        manifest.data.length > MAX_PACKAGE_JSON_BYTES
          ? Option.none()
          : decodePackageJsonOption(new TextDecoder().decode(manifest.data));
      if (Option.isNone(decoded)) return `${manifest.path} is not a readable package.json.`;
      queue.push([`${parent}node_modules/${dependency}`, decoded.value]);
    }
  }
  return undefined;
};

/** Refuses a package that would need a script or an install step T3 never runs. */
const checkPackage = Effect.fnUntraced(function* (
  files: ReadonlyArray<NpmTarballFile>,
  name: string,
  version: string,
) {
  const manifest = files.find((file) => file.path === "package.json");
  if (manifest === undefined || manifest.data.length > MAX_PACKAGE_JSON_BYTES)
    return yield* npmError("npm-package-mismatch", "The package has no readable package.json.");
  const packageJson = yield* decodePackageJson(new TextDecoder().decode(manifest.data)).pipe(
    Effect.mapError(() =>
      npmError("npm-package-mismatch", "The package's package.json is invalid."),
    ),
  );
  if (packageJson.name !== name || packageJson.version !== version)
    return yield* npmError(
      "npm-package-mismatch",
      `The tarball contains ${packageJson.name ?? "an unnamed package"}@${packageJson.version ?? "?"}, not ${name}@${version}.`,
    );
  const scripts = INSTALL_SCRIPTS.filter((script) => packageJson.scripts?.[script] !== undefined);
  if (files.some((file) => file.path === "binding.gyp"))
    scripts.push("a native build (binding.gyp)");
  if (scripts.length > 0)
    return yield* npmError(
      "npm-install-scripts",
      `The package needs ${scripts.join(", ")} to run at install, and T3 never runs package scripts.`,
    );
  const bundled = packageJson.bundleDependencies ?? packageJson.bundledDependencies ?? [];
  const unlisted = runtimeDependencies(packageJson).filter(
    (dependency) => !(bundled === true || (Array.isArray(bundled) && bundled.includes(dependency))),
  );
  const refusal =
    unlisted.length > 0
      ? `The package depends on ${unlisted.join(", ")} without bundling it.`
      : findUnbundled(files, packageJson);
  if (refusal !== undefined)
    return yield* npmError(
      "npm-dependencies",
      `${refusal} T3 installs no dependencies; bundle the plugin into its package.`,
    );
});

export class PluginNpm extends Context.Service<
  PluginNpm,
  {
    readonly list: Effect.Effect<PluginNpmListResult>;
    /** Downloads, verifies, and unpacks one exact version, then adds it to the catalogue. Runs nothing. */
    readonly add: (
      input: PluginNpmAddInput,
    ) => Effect.Effect<PluginNpmInstallationResult, PluginCatalogError>;
    /** Unpacks a version next to the installed one, replacing any earlier staged update. */
    readonly stageUpdate: (
      input: PluginNpmStageUpdateInput,
    ) => Effect.Effect<PluginNpmPackageResult, PluginCatalogError>;
    /** Consents to the staged digest and swaps it in; the old version comes back on failure. */
    readonly applyUpdate: (
      input: PluginNpmApplyUpdateInput,
    ) => Effect.Effect<PluginNpmInstallationResult, PluginCatalogError>;
    readonly discardUpdate: (
      input: PluginInstallationInput,
    ) => Effect.Effect<PluginNpmPackageResult, PluginCatalogError>;
  }
>()("t3/plugins/PluginNpm") {}

interface PluginNpmOptions {
  /** Directory that holds the installed packages. */
  readonly root: string;
  readonly registry?: string;
  readonly limits?: NpmTarballLimits;
  readonly metadataTimeout?: `${number} seconds`;
  readonly tarballTimeout?: `${number} seconds`;
}

export const make = Effect.fn("PluginNpm.make")(function* (options: PluginNpmOptions) {
  const catalog = yield* PluginCatalog;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const scope = yield* Effect.scope;
  const limits = options.limits ?? defaultNpmTarballLimits;
  const defaultRegistry = options.registry ?? DEFAULT_NPM_REGISTRY;

  yield* fs.makeDirectory(options.root, { recursive: true }).pipe(Effect.orDie);
  // The catalogue records real paths, so ours must be real too.
  const root = yield* fs.realPath(options.root).pipe(Effect.orDie);

  const installed = new Map<PluginInstallationId, Installed>();
  const lock = yield* Semaphore.make(1);
  const recovered = yield* Deferred.make<void>();
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * Paths under the root still to delete: removed homes, leftovers, discarded
   * staging, and directories a step made and has not published yet.
   */
  const doomed = new Set<string>();

  /** Deletes `target` as one catalogue step; otherwise keeps it queued. Succeeds with whether it is gone. */
  const release = (target: string) =>
    catalog.changeFiles([target], fs.remove(target, { recursive: true, force: true })).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        (cause._tag === "PluginCatalogError" && cause.reason === "already-added"
          ? Effect.logDebug("Keeping npm plugin files another installation uses", { target })
          : Effect.logWarning("Could not delete npm plugin files; retrying later", {
              target,
              cause,
            })
        ).pipe(Effect.as(false)),
      ),
      Effect.tap((gone) => Effect.sync(() => (gone ? doomed.delete(target) : doomed.add(target)))),
    );

  /** Makes a directory under `parent`, queued for deletion until the step that made it publishes it. */
  const makeOwned = (parent: string, prefix: string) =>
    fs.makeTempDirectory({ directory: parent, prefix }).pipe(
      Effect.tap((directory) => Effect.sync(() => doomed.add(directory))),
      Effect.uninterruptible,
      Effect.catch(storageError),
    );

  const writeRecord = (home: string, record: NpmRecord) =>
    encodeRecord(record).pipe(
      Effect.flatMap((json) => {
        // Write then rename, so `npm.json` is always one whole record.
        const temporary = path.join(home, ".npm.json.tmp");
        return fs
          .writeFileString(temporary, json)
          .pipe(Effect.andThen(fs.rename(temporary, path.join(home, "npm.json"))));
      }),
      Effect.catch(storageError),
    );

  const readRecord = (home: string) =>
    fs
      .readFileString(path.join(home, "npm.json"))
      .pipe(Effect.flatMap(decodeRecord), Effect.option);

  /**
   * GETs metadata from `url`, following each redirect only to a registry
   * address `isTrustedRegistryUrl` accepts: one plain http hop would let a
   * network attacker answer with its own integrity and tarball.
   */
  const getMetadata = Effect.fnUntraced(function* (url: string, what: string) {
    let target = url;
    for (let hop = 0; ; hop += 1) {
      const response = yield* http
        .execute(HttpClientRequest.get(target))
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400 || location === undefined)
        return response;
      const next = URL.parse(location, target);
      if (hop >= MAX_METADATA_REDIRECTS || next === null || !isTrustedRegistryUrl(next))
        return yield* npmError(
          "npm-registry-invalid",
          `The registry redirected the ${what} to an address it cannot be trusted from.`,
        );
      target = next.href;
    }
  });

  /** GETs `url` into memory, at most `maxBytes`. */
  const fetchBytes = (
    url: string,
    maxBytes: number,
    timeout: `${number} seconds`,
    what: string,
    kind: "metadata" | "tarball",
  ) =>
    Effect.gen(function* () {
      // A tarball may come from anywhere: authenticated metadata pinned its integrity.
      const response =
        kind === "metadata"
          ? yield* getMetadata(url, what)
          : yield* http.execute(HttpClientRequest.get(url));
      if (response.status === 404)
        return yield* npmError("npm-not-found", `The registry has no ${what}.`);
      if (response.status < 200 || response.status >= 300)
        return yield* npmError(
          "npm-registry-unavailable",
          `The registry answered ${response.status} for the ${what}.`,
        );
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      yield* response.stream.pipe(
        Stream.runForEach((chunk) => {
          total += chunk.byteLength;
          if (total > maxBytes)
            return Effect.fail(
              npmError("npm-too-large", `The ${what} is larger than ${maxBytes} bytes.`),
            );
          chunks.push(chunk);
          return Effect.void;
        }),
      );
      return Buffer.concat(chunks);
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.catchTags({
        HttpClientError: () =>
          Effect.fail(npmError("npm-registry-unavailable", `Could not download the ${what}.`)),
        TimeoutError: () =>
          Effect.fail(
            npmError("npm-registry-unavailable", `The registry did not send the ${what} in time.`),
          ),
      }),
    );

  /** Asks the registry which exact version `request` names, and its tarball's integrity. */
  const resolve = Effect.fnUntraced(function* (registry: string, name: string, request: string) {
    // Adding checks the registry too, but an installation saved before that check may not pass it.
    const base = URL.parse(registry);
    if (base === null || !isTrustedRegistryUrl(base))
      return yield* npmError(
        "npm-registry-invalid",
        `${name} was installed from ${registry}, which serves packages over plain http. Remove it and add it again from an https registry.`,
      );
    const encodedName = name.startsWith("@") ? name.replace("/", "%2f") : name;
    const what = `${name}@${request}`;
    const body = yield* fetchBytes(
      `${registry}/${encodedName}/${encodeURIComponent(request)}`,
      MAX_METADATA_BYTES,
      options.metadataTimeout ?? "30 seconds",
      `package ${what}`,
      "metadata",
    );
    const metadata = yield* decodeMetadata(new TextDecoder().decode(body)).pipe(
      Effect.mapError(() =>
        npmError("npm-registry-invalid", `The registry's description of ${what} is invalid.`),
      ),
    );
    if (
      metadata.name !== name ||
      !isExactVersion(metadata.version) ||
      (isExactVersion(request) && metadata.version !== request)
    )
      return yield* npmError(
        "npm-registry-invalid",
        `The registry answered ${what} with ${metadata.name}@${metadata.version}.`,
      );
    const integrity = (metadata.dist.integrity ?? "").split(/\s+/).find(isIntegrity);
    if (integrity === undefined)
      return yield* npmError(
        "npm-integrity-missing",
        `The registry publishes no sha512 integrity for ${name}@${metadata.version}.`,
      );
    const tarball = URL.parse(metadata.dist.tarball);
    if (tarball === null || (tarball.protocol !== "https:" && tarball.protocol !== "http:"))
      return yield* npmError(
        "npm-registry-invalid",
        `The registry's tarball address for ${name}@${metadata.version} is not http or https.`,
      );
    return { version: metadata.version, integrity, tarball: tarball.href } satisfies Resolved;
  });

  /** Downloads and checks a resolved version, then writes it into a new staging directory under `home`. */
  const stage = Effect.fnUntraced(function* (home: string, name: string, resolved: Resolved) {
    const tarball = yield* fetchBytes(
      resolved.tarball,
      limits.maxTarballBytes,
      options.tarballTimeout ?? "120 seconds",
      `tarball for ${name}@${resolved.version}`,
      "tarball",
    );
    const actual = `sha512-${NodeCrypto.createHash("sha512").update(tarball).digest("base64")}`;
    if (actual !== resolved.integrity)
      return yield* npmError(
        "npm-integrity-mismatch",
        `The tarball for ${name}@${resolved.version} does not match the registry's integrity. Nothing was installed.`,
      );
    const files = yield* readNpmTarball(tarball, limits).pipe(
      Effect.mapError((error) => npmError(error.reason, error.message)),
    );
    yield* checkPackage(files, name, resolved.version);
    const staging = yield* makeOwned(home, ".staging-");
    yield* Effect.forEach(
      files,
      (file) => {
        const target = path.join(staging, ...file.path.split("/"));
        return fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
          // `wx` never follows or replaces something already there.
          Effect.andThen(
            fs.writeFile(target, file.data, { flag: "wx", mode: file.executable ? 0o755 : 0o644 }),
          ),
        );
      },
      { discard: true },
    ).pipe(
      Effect.catch(storageError),
      Effect.onError(() => release(staging)),
    );
    return staging;
  });

  const findInstalled = (installationId: PluginInstallationId) =>
    Effect.suspend(() => {
      const entry = installed.get(installationId);
      if (entry === undefined)
        return Effect.fail(
          npmError("not-found", "That plugin was not installed from npm here.", installationId),
        );
      if (entry.swap !== undefined)
        return Effect.fail(
          npmError(
            "storage",
            "An earlier update of this plugin could not be finished or undone yet. It is retried before each plugin change and when the server starts.",
            installationId,
          ),
        );
      return Effect.succeed(entry);
    });

  const catalogRow = (installationId: PluginInstallationId) =>
    catalog.list.pipe(
      Effect.flatMap((snapshot) => {
        const row = snapshot.installations.find((item) => item.installationId === installationId);
        return row
          ? Effect.succeed(row)
          : Effect.fail(
              npmError("not-found", "That plugin is not installed here.", installationId),
            );
      }),
    );

  /** Forgets every installation the catalogue no longer has, then deletes what is queued. */
  const collect = Effect.gen(function* () {
    const snapshot = yield* catalog.list;
    const present = new Set(snapshot.installations.map((row) => row.installationId));
    for (const entry of installed.values()) {
      if (present.has(entry.installationId)) continue;
      installed.delete(entry.installationId);
      doomed.add(entry.home);
    }
    for (const target of doomed) yield* release(target);
  });

  /**
   * Finishes or rolls back a journaled swap. The catalogue decides under its
   * management lock, so a consent or enable from another client lands wholly
   * before or after: finished when it holds consent to the new digest,
   * otherwise `.previous` goes back once the plugin has stopped. The decision
   * sets the reported version at once; the journal and `.previous` stay until
   * the cleanup after it has worked, so a failure is retried later and never
   * loses a version.
   */
  const settle = Effect.fnUntraced(function* (entry: Installed) {
    const swap = entry.swap;
    if (swap === undefined) return;
    const previous = path.join(entry.home, ".previous");
    const decide = (files?: Parameters<PluginCatalog["Service"]["settleReplace"]>[1]) =>
      catalog
        .settleReplace({ installationId: entry.installationId, digest: swap.digest }, files)
        .pipe(
          // Removed meanwhile: `collect` deletes the files.
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.succeed("removed" as const),
          ),
        );
    // Without files the step changes nothing, so a commit is known before any probe can fail.
    let outcome = yield* decide();
    // Only npm steps, which hold the npm lock, move `.previous`.
    if (outcome === "rolled-back" && (yield* fs.exists(previous).pipe(Effect.catch(storageError))))
      // Decided again in the step that puts the old files back.
      outcome = yield* decide({
        paths: [entry.home],
        restore: fs
          .remove(entry.directory, { recursive: true, force: true })
          .pipe(Effect.andThen(fs.rename(previous, entry.directory)), Effect.catch(storageError)),
      });
    if (outcome === "removed") return;
    entry.source = outcome === "committed" ? swap.next : swap.previous;
    yield* writeRecord(entry.home, { source: entry.source });
    entry.swap = undefined;
    if (outcome === "committed") yield* release(previous);
  });

  /** Retries every unsettled swap and every deletion that failed before. */
  const tidy = Effect.gen(function* () {
    for (const entry of installed.values())
      if (entry.swap !== undefined)
        yield* settle(entry).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not settle an interrupted plugin update; retrying later", {
              installationId: entry.installationId,
              detail: error.message,
            }),
          ),
        );
    yield* collect;
  });

  /** Never waits for an install in progress; a package the catalogue no longer has is left out. */
  const list = Deferred.await(recovered).pipe(
    Effect.andThen(catalog.list),
    Effect.map((snapshot) => {
      const present = new Set(snapshot.installations.map((row) => row.installationId));
      return {
        // Stable across updates; clients join these to catalogue rows by installation id.
        packages: [...installed.values()]
          .filter((entry) => present.has(entry.installationId))
          .sort((a, b) => a.installationId.localeCompare(b.installationId))
          .map(toPackage),
      };
    }),
  );

  const add = Effect.fn("PluginNpm.add")(function* (input: PluginNpmAddInput) {
    const registry = yield* normalizeRegistry(input.registry ?? defaultRegistry);
    const existing = [...installed.values()].find(
      (entry) => entry.source.registry === registry && entry.source.name === input.name,
    );
    if (existing)
      return yield* npmError(
        "already-added",
        `${input.name} is already installed from this registry. Update it instead.`,
        existing.installationId,
      );
    const resolved = yield* resolve(registry, input.name, input.version);
    const home = yield* makeOwned(root, "pkg-");
    return yield* Effect.gen(function* () {
      const staging = yield* stage(home, input.name, resolved);
      const source: PluginNpmSource = {
        registry,
        name: input.name,
        version: resolved.version,
        integrity: resolved.integrity,
        installedAt: yield* now,
      };
      const directory = path.join(home, "package");
      return yield* Effect.gen(function* () {
        yield* writeRecord(home, { source });
        yield* catalog.changeFiles(
          [home],
          fs.rename(staging, directory).pipe(Effect.catch(storageError)),
        );
        doomed.delete(staging);
        // The catalogue reads the manifest and digests the files; nothing runs.
        const { installation } = yield* catalog.add({ directory });
        const entry: Installed = {
          home,
          directory,
          installationId: installation.installationId,
          source,
          staged: undefined,
          swap: undefined,
        };
        installed.set(entry.installationId, entry);
        doomed.delete(home);
        return { installation, package: toPackage(entry) };
      }).pipe(Effect.uninterruptible);
      // Nothing in the catalogue points here; deleted now, or by a later collection.
    }).pipe(Effect.onError(() => collect));
  });

  const discardStaged = (entry: Installed) =>
    Effect.suspend(() => {
      const staged = entry.staged;
      if (staged === undefined) return Effect.void;
      // Queued as it is dropped, so a step interrupted while waiting to delete it keeps it queued.
      entry.staged = undefined;
      doomed.add(staged.directory);
      return release(staged.directory);
    });

  const stageUpdate = Effect.fn("PluginNpm.stageUpdate")(function* (
    input: PluginNpmStageUpdateInput,
  ) {
    const entry = yield* findInstalled(input.installationId);
    const row = yield* catalogRow(input.installationId);
    const resolved = yield* resolve(entry.source.registry, entry.source.name, input.version);
    const staging = yield* stage(entry.home, entry.source.name, resolved);
    const update = yield* Effect.gen(function* () {
      const registration = yield* loadPluginDirectory(staging).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((error) => npmError("npm-package-mismatch", error.message)),
      );
      if (row.manifest !== null && registration.manifest.id !== row.manifest.id)
        return yield* npmError(
          "npm-plugin-id-changed",
          `The new version is the plugin ${registration.manifest.id}, not ${row.manifest.id}. Install it separately.`,
          input.installationId,
        );
      const source = yield* digestPluginSource(staging, limits).pipe(
        Effect.mapError((error) => npmError("npm-archive-unsafe", error.message)),
      );
      return {
        version: resolved.version,
        integrity: resolved.integrity,
        manifest: summarizePluginManifest(registration.manifest),
        source,
        stagedAt: yield* now,
      } satisfies PluginNpmStagedUpdate;
    }).pipe(Effect.onError(() => release(staging)));
    yield* discardStaged(entry);
    entry.staged = { update, directory: staging };
    doomed.delete(staging);
    return { package: toPackage(entry) };
  });

  const applyUpdate = Effect.fn("PluginNpm.applyUpdate")(function* (
    input: PluginNpmApplyUpdateInput,
  ) {
    const entry = yield* findInstalled(input.installationId);
    const staged = entry.staged;
    if (staged === undefined)
      return yield* npmError(
        "npm-no-update",
        "There is no downloaded update to apply. Download it again.",
        input.installationId,
      );
    if (staged.update.source.digest !== input.digest)
      return yield* npmError(
        "source-changed",
        "The downloaded update is not the one you reviewed. Review the current one.",
        input.installationId,
      );
    const onDisk = yield* digestPluginSource(staged.directory, limits).pipe(Effect.option);
    if (Option.isNone(onDisk) || onDisk.value.digest !== input.digest) {
      yield* discardStaged(entry);
      return yield* npmError(
        "source-changed",
        "The downloaded update changed on disk after it was checked, so it was discarded.",
        input.installationId,
      );
    }
    const next: PluginNpmSource = {
      ...entry.source,
      version: staged.update.version,
      integrity: staged.update.integrity,
      installedAt: yield* now,
    };
    const previous = path.join(entry.home, ".previous");

    // Nothing is stopped or moved before the journal is written, so a failure up to here
    // leaves the installed version running and the staged one ready to apply again.
    if (!(yield* release(previous)))
      return yield* npmError(
        "storage",
        "Could not delete the files an earlier update left behind.",
        input.installationId,
      );
    yield* writeRecord(entry.home, {
      source: entry.source,
      swap: { source: next, digest: input.digest },
    });
    entry.swap = { previous: entry.source, next, digest: input.digest };

    let movedOld = false;
    let movedNew = false;
    const replaced = yield* catalog
      .replace(
        { installationId: input.installationId, digest: input.digest },
        {
          paths: [entry.home],
          swap: fs.rename(entry.directory, previous).pipe(
            Effect.andThen(
              Effect.sync(() => {
                movedOld = true;
              }),
            ),
            Effect.andThen(fs.rename(staged.directory, entry.directory)),
            Effect.andThen(
              Effect.sync(() => {
                movedNew = true;
              }),
            ),
            Effect.catch(storageError),
          ),
          restore: Effect.suspend(() =>
            movedOld
              ? fs
                  .remove(entry.directory, { recursive: true, force: true })
                  .pipe(Effect.andThen(fs.rename(previous, entry.directory)))
              : Effect.void,
          ).pipe(Effect.catch(storageError)),
        },
      )
      .pipe(Effect.exit);
    // The commit point: the new version is the installed one from here, whatever
    // the cleanup below does.
    if (Exit.isSuccess(replaced)) entry.source = next;
    // Staged files that never moved can be applied again.
    if (movedNew || Exit.isSuccess(replaced)) entry.staged = undefined;
    // After the commit a failure here is cleanup only: the apply still succeeds and
    // reports the new version, and npm steps fail `storage` until the journal settles.
    yield* settle(entry).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not settle a plugin update; retrying later", {
          installationId: entry.installationId,
          detail: error.message,
        }),
      ),
    );
    const { installation } = yield* replaced;
    return { installation, package: toPackage(entry) };
  });

  const discardUpdate = Effect.fn("PluginNpm.discardUpdate")(function* (
    input: PluginInstallationInput,
  ) {
    const entry = yield* findInstalled(input.installationId);
    yield* discardStaged(entry);
    return { package: toPackage(entry) };
  });

  /**
   * Reads what was installed before this start: staging directories are
   * deleted, an interrupted update swap is settled, and a directory the
   * catalogue no longer has is deleted.
   */
  const recover = Effect.gen(function* () {
    const snapshot = yield* catalog.list;
    const byDirectory = new Map(snapshot.installations.map((row) => [row.directory, row]));
    const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    for (const name of names) {
      const home = path.join(root, name);
      const directory = path.join(home, "package");
      const row = byDirectory.get(directory);
      if (row === undefined) {
        // Removed from the catalogue, or interrupted before it was added.
        doomed.add(home);
        continue;
      }
      const record = yield* readRecord(home);
      if (Option.isNone(record)) {
        yield* Effect.logWarning("Leaving an npm plugin directory whose npm.json is unreadable", {
          directory,
        });
        continue;
      }
      const { source, swap } = record.value;
      const inside = yield* fs.readDirectory(home).pipe(Effect.orElseSucceed(() => []));
      for (const child of inside)
        if (
          child.startsWith(".staging-") ||
          child.startsWith(".npm.json.tmp") ||
          // Left by a finished update; an unfinished one still needs it.
          (child === ".previous" && swap === undefined)
        )
          doomed.add(path.join(home, child));
      installed.set(row.installationId, {
        home,
        directory,
        installationId: row.installationId,
        source,
        staged: undefined,
        swap:
          swap === undefined
            ? undefined
            : { previous: source, next: swap.source, digest: swap.digest },
      });
    }
    yield* tidy;
  });

  // Taken before any request can be, so requests wait for recovery.
  yield* lock
    .withPermit(recover.pipe(Effect.ensuring(Deferred.succeed(recovered, undefined))))
    .pipe(Effect.forkIn(scope, { startImmediately: true }));
  // A removal through `plugins.remove` deletes the package's files.
  yield* catalog.subscribe.pipe(
    Stream.runForEach(() => lock.withPermit(tidy)),
    Effect.forkIn(scope, { startImmediately: true }),
  );

  const managed = <A, E>(effect: Effect.Effect<A, E>) =>
    lock.withPermit(tidy.pipe(Effect.andThen(effect)));

  return PluginNpm.of({
    list,
    add: (input) => managed(add(input)),
    stageUpdate: (input) => managed(stageUpdate(input)),
    applyUpdate: (input) => managed(applyUpdate(input).pipe(Effect.uninterruptible)),
    discardUpdate: (input) => managed(discardUpdate(input)),
  });
});

export const layer = Layer.effect(
  PluginNpm,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return yield* make({ root: path.join(config.stateDir, "plugins", "npm") });
  }),
);
