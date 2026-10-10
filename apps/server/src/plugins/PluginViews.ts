// @effect-diagnostics nodeBuiltinImport:off
/**
 * Isolated plugin views: the views enabled plugins declare, the exact bytes
 * a client host runs them from, and the calls a mounted view makes into its
 * own plugin.
 *
 * A view's files are read once per installation generation, between the
 * catalogue's consent and a fresh digest of the whole directory that must
 * still equal the consented one. A mismatch serves nothing and asks the
 * catalogue to re-inspect, which disables the installation. Everything a
 * client gets is bound to `(installationId, generation)`: disable, remove, a
 * byte change, or a re-enable drops the views from the next snapshot at once,
 * and later fetches and calls for the old generation are refused.
 */
import * as NodeCrypto from "node:crypto";

import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_VIEW_BUNDLE_MAX_BYTES,
  PLUGIN_VIEW_BUNDLE_MAX_ENCODED_BYTES,
  PLUGIN_VIEW_CALL_TIMEOUT_MS,
  PLUGIN_VIEW_MESSAGE_MAX_BYTES,
  PLUGIN_VIEW_SCRIPT_MAX_BYTES,
  PLUGIN_VIEW_STYLE_MAX_BYTES,
  PLUGIN_VIEWS_CAPABILITY,
  PluginViewError,
  PluginViewsManifest,
  pluginInstallationStatus,
  pluginViewHandler,
  type PluginCatalogSnapshot,
  type PluginInstallation,
  type PluginInstallationId,
  type PluginView,
  type PluginViewAsset,
  type PluginViewBundle,
  type PluginViewBundleInput,
  type PluginViewCallInput,
  type PluginViewCallResult,
  type PluginViewDeclaration,
  type PluginViewProblem,
  type PluginViewsSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { PluginCatalog } from "./PluginCatalog.ts";
import { digestPluginSourceFiles } from "./pluginSource.ts";

const MAX_MANIFEST_BYTES = 64 * 1024;

const decodeViewsManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginViewsManifest));

// The HTML parser rewrites CR and NUL, ends a script at `</script` and a style at
// `</style`, and `<!--`/`<script` switch script parsing into escaped states. The
// text a frame runs would then differ from the hashed bytes, so these are refused.
const UNSAFE_SCRIPT = /<\/script|<!--|<script|[\r\0]/i;
const UNSAFE_STYLE = /<\/style|[\r\0]/i;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
/** Encoded UTF-8 bytes of a JSON value, the measure every view message bound uses. */
const jsonBytes = (value: Schema.Json) => Buffer.byteLength(encodeJson(value));

const viewError = (reason: string, message: string) => new PluginViewError({ reason, message });

interface LoadedView {
  readonly declaration: PluginViewDeclaration;
  readonly bundle: PluginViewBundle;
}

/** One generation's views, loaded at most once. */
interface Entry {
  readonly generation: number;
  readonly digest: string;
  readonly loaded: Deferred.Deferred<ReadonlyMap<string, LoadedView>, PluginViewError>;
  outcome:
    | { readonly _tag: "loading" }
    | { readonly _tag: "ready"; readonly views: ReadonlyMap<string, LoadedView> }
    | { readonly _tag: "failed"; readonly message: string };
}

/** The consented digest an installation's views are served under, if it may show views now. */
const servingDigest = (installation: PluginInstallation) =>
  pluginInstallationStatus(installation) === "enabled" &&
  installation.consent?.capabilities.includes(PLUGIN_VIEWS_CAPABILITY)
    ? installation.consent.digest
    : undefined;

export class PluginViews extends Context.Service<
  PluginViews,
  {
    /** The current views, then a fresh snapshot after every change. */
    readonly subscribe: Stream.Stream<PluginViewsSnapshot>;
    /** The consented bytes of one view of the given generation. */
    readonly readBundle: (
      input: PluginViewBundleInput,
    ) => Effect.Effect<PluginViewBundle, PluginViewError>;
    /** Calls the plugin handler `view:<viewId>:<handler>` for a view of the given generation. */
    readonly call: (
      input: PluginViewCallInput,
    ) => Effect.Effect<PluginViewCallResult, PluginViewError>;
  }
>()("t3/plugins/PluginViews") {}

export const make = Effect.fn("PluginViews.make")(function* () {
  const catalog = yield* PluginCatalog;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;

  const entries = new Map<PluginInstallationId, Entry>();
  let installations: ReadonlyArray<PluginInstallation> = [];
  const snapshot = yield* SubscriptionRef.make<PluginViewsSnapshot>({ views: [], problems: [] });

  /** Reads one asset as strict UTF-8 text from inside `directory`, with its `/` path and hex hash. */
  const readAsset = Effect.fnUntraced(function* (
    directory: string,
    relative: string,
    kind: "script" | "style",
  ) {
    const fail = (detail: string) => viewError("invalid-view", `${relative} ${detail}`);
    const maxBytes = kind === "script" ? PLUGIN_VIEW_SCRIPT_MAX_BYTES : PLUGIN_VIEW_STYLE_MAX_BYTES;
    const real = yield* fs
      .realPath(path.resolve(directory, relative))
      .pipe(Effect.mapError(() => fail("does not exist.")));
    const inside = path.relative(directory, real);
    // `..board.js` stays inside; only a whole `..` segment leaves.
    if (
      inside === "" ||
      inside === ".." ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    )
      return yield* fail("resolves outside the plugin directory.");
    const info = yield* fs.stat(real).pipe(Effect.mapError(() => fail("is not readable.")));
    if (info.type !== "File") return yield* fail("is not a file.");
    if (Number(info.size) > maxBytes) return yield* fail(`is larger than ${maxBytes} bytes.`);
    const bytes = yield* fs.readFile(real).pipe(Effect.mapError(() => fail("is not readable.")));
    if (bytes.length > maxBytes) return yield* fail(`is larger than ${maxBytes} bytes.`);
    const text = yield* Effect.try({
      try: () => utf8.decode(bytes),
      catch: () => fail("is not valid UTF-8."),
    });
    if (text.charCodeAt(0) === 0xfeff) return yield* fail("starts with a byte order mark.");
    if ((kind === "script" ? UNSAFE_SCRIPT : UNSAFE_STYLE).test(text))
      return yield* fail(
        kind === "script"
          ? "contains CR, NUL, `<!--`, `<script`, or `</script`, which cannot be inlined exactly."
          : "contains CR, NUL, or `</style`, which cannot be inlined exactly.",
      );
    const hash = NodeCrypto.createHash("sha256").update(bytes).digest();
    return {
      asset: { text, sha256: hash.toString("base64") } satisfies PluginViewAsset,
      bytes: bytes.length,
      file: inside.split(path.sep).join("/"),
      hash: hash.toString("hex"),
    };
  });

  /** Reads every declared view, with the hash of each file read by its relative path. */
  const readViews = Effect.fnUntraced(function* (installation: PluginInstallation, digest: string) {
    const directory = installation.directory;
    const manifestPath = path.join(directory, PLUGIN_MANIFEST_FILE);
    const info = yield* fs
      .stat(manifestPath)
      .pipe(
        Effect.mapError(() => viewError("invalid-view", `${PLUGIN_MANIFEST_FILE} is missing.`)),
      );
    if (info.type !== "File" || Number(info.size) > MAX_MANIFEST_BYTES)
      return yield* viewError("invalid-view", `${PLUGIN_MANIFEST_FILE} is too large.`);
    const manifestBytes = yield* fs
      .readFile(manifestPath)
      .pipe(
        Effect.mapError(() =>
          viewError("invalid-view", `${PLUGIN_MANIFEST_FILE} is not readable.`),
        ),
      );
    const read = new Map([
      [PLUGIN_MANIFEST_FILE, NodeCrypto.createHash("sha256").update(manifestBytes).digest("hex")],
    ]);
    const manifest = yield* decodeViewsManifest(new TextDecoder().decode(manifestBytes)).pipe(
      Effect.mapError((error) =>
        viewError(
          "invalid-view",
          `The views in ${PLUGIN_MANIFEST_FILE} are invalid: ${error.message}`,
        ),
      ),
    );
    const views = new Map<string, LoadedView>();
    for (const declaration of manifest.views) {
      if (views.has(declaration.id))
        return yield* viewError("invalid-view", `The view id ${declaration.id} is declared twice.`);
      const script = yield* readAsset(directory, declaration.script, "script");
      const style =
        declaration.style === undefined
          ? null
          : yield* readAsset(directory, declaration.style, "style");
      // A file read again must match its earlier read, or one view could keep bytes the digest never saw.
      for (const asset of style === null ? [script] : [script, style]) {
        if ((read.get(asset.file) ?? asset.hash) !== asset.hash)
          return yield* viewError(
            "source-changed",
            "The plugin's files changed while its views were read.",
          );
        read.set(asset.file, asset.hash);
      }
      if (script.bytes + (style?.bytes ?? 0) > PLUGIN_VIEW_BUNDLE_MAX_BYTES)
        return yield* viewError(
          "invalid-view",
          `The view ${declaration.id} is larger than ${PLUGIN_VIEW_BUNDLE_MAX_BYTES} bytes.`,
        );
      // JSON escaping can grow text sixfold; this bounds what the RPC actually sends.
      if (
        jsonBytes(script.asset.text) + (style === null ? 0 : jsonBytes(style.asset.text)) >
        PLUGIN_VIEW_BUNDLE_MAX_ENCODED_BYTES
      )
        return yield* viewError(
          "invalid-view",
          `The view ${declaration.id} is larger than ${PLUGIN_VIEW_BUNDLE_MAX_ENCODED_BYTES} bytes once encoded for delivery.`,
        );
      views.set(declaration.id, {
        declaration,
        bundle: {
          installationId: installation.installationId,
          generation: installation.generation,
          viewId: declaration.id,
          sourceDigest: digest,
          script: script.asset,
          style: style?.asset ?? null,
        },
      });
    }
    return { views: views as ReadonlyMap<string, LoadedView>, read };
  });

  /** Reads every declared view, then checks the directory still has the consented bytes. */
  const load = Effect.fnUntraced(function* (installation: PluginInstallation, digest: string) {
    // The catalogue disables an installation whose bytes changed; its next snapshot drops the views.
    const revoke = (message: string) =>
      catalog
        .refresh({ installationId: installation.installationId })
        .pipe(
          Effect.ignore,
          Effect.forkIn(scope),
          Effect.andThen(viewError("source-changed", message)),
        );
    // The whole directory must still have the consented bytes; anything else revokes.
    const verify = digestPluginSourceFiles(installation.directory).pipe(
      Effect.catch((error) => revoke(error.reason)),
      Effect.flatMap(({ source, contents }) =>
        source.digest === digest
          ? Effect.succeed(contents)
          : revoke("The plugin's files changed since they were approved, so it was disabled."),
      ),
    );
    // A file that no longer reads as a view may have been edited since approval.
    const { views, read } = yield* readViews(installation, digest).pipe(
      Effect.tapError(() => verify),
    );
    const contents = yield* verify;
    // Serve only bytes that pass covered, not a file changed and restored around the reads.
    for (const [file, hash] of read)
      if (contents.get(file) !== hash)
        return yield* viewError(
          "source-changed",
          "The plugin's files changed while its views were read.",
        );
    return views;
  });

  /** Rebuilds the snapshot from the latest catalogue and whatever has loaded. */
  const publish = Effect.suspend(() => {
    const views: Array<PluginView> = [];
    const problems: Array<PluginViewProblem> = [];
    for (const installation of installations) {
      const entry = entries.get(installation.installationId);
      if (entry === undefined || entry.generation !== installation.generation) continue;
      if (entry.outcome._tag === "failed")
        problems.push({
          installationId: installation.installationId,
          generation: installation.generation,
          message: entry.outcome.message,
        });
      if (entry.outcome._tag !== "ready") continue;
      for (const { declaration } of entry.outcome.views.values())
        views.push({
          installationId: installation.installationId,
          generation: installation.generation,
          pluginId: installation.manifest?.id ?? "",
          pluginName: installation.manifest?.name ?? "",
          viewId: declaration.id,
          title: declaration.title,
          placement: declaration.placement,
        });
    }
    return SubscriptionRef.set(snapshot, { views, problems });
  });

  /**
   * The entry loading this generation's views, started now if no entry has
   * it yet. A finished load republishes if its entry is still current.
   */
  const ensure = (installation: PluginInstallation, digest: string) =>
    Effect.suspend(() => {
      const installationId = installation.installationId;
      const existing = entries.get(installationId);
      if (existing?.generation === installation.generation && existing.digest === digest)
        return Effect.succeed(existing);
      const entry: Entry = {
        generation: installation.generation,
        digest,
        loaded: Deferred.makeUnsafe(),
        outcome: { _tag: "loading" },
      };
      entries.set(installationId, entry);
      const settle = (
        outcome: Entry["outcome"],
        done: Effect.Effect<boolean>,
      ): Effect.Effect<void> =>
        Effect.suspend(() => {
          entry.outcome = outcome;
          return done.pipe(
            Effect.andThen(entries.get(installationId) === entry ? publish : Effect.void),
          );
        });
      return load(installation, digest).pipe(
        Effect.catchDefect(() =>
          Effect.fail(viewError("unavailable", "The plugin's views could not be read.")),
        ),
        Effect.matchEffect({
          onFailure: (error) =>
            settle({ _tag: "failed", message: error.message }, Deferred.fail(entry.loaded, error)),
          onSuccess: (views) =>
            settle({ _tag: "ready", views }, Deferred.succeed(entry.loaded, views)),
        }),
        Effect.forkIn(scope),
        Effect.as(entry),
      );
    });

  /**
   * Follows one catalogue snapshot: forgets generations that ended, so their
   * views leave the next snapshot before anything else happens, and starts
   * loading generations that began.
   */
  const follow = Effect.fnUntraced(function* (catalogSnapshot: PluginCatalogSnapshot) {
    installations = catalogSnapshot.installations;
    const serving = installations.flatMap((installation) => {
      const digest = servingDigest(installation);
      return digest === undefined ? [] : [{ installation, digest }];
    });
    for (const [installationId, entry] of entries) {
      const still = serving.find(
        ({ installation }) => installation.installationId === installationId,
      );
      if (
        still === undefined ||
        still.installation.generation !== entry.generation ||
        still.digest !== entry.digest
      )
        entries.delete(installationId);
    }
    for (const { installation, digest } of serving) yield* ensure(installation, digest);
    yield* publish;
  });

  yield* catalog.subscribe.pipe(Stream.runForEach(follow), Effect.forkIn(scope));

  /** The installation if `generation` of it may show views now, with its consented digest. */
  const serving = Effect.fnUntraced(function* (
    installationId: PluginInstallationId,
    generation: number,
  ) {
    const installation = (yield* catalog.list).installations.find(
      (candidate) => candidate.installationId === installationId,
    );
    if (installation === undefined)
      return yield* viewError("not-found", "That plugin is not installed here.");
    const digest = servingDigest(installation);
    if (digest === undefined)
      return yield* viewError("unavailable", "The plugin is not enabled with views.");
    if (installation.generation !== generation)
      return yield* viewError(
        "generation-changed",
        "The plugin was enabled again since this view was opened.",
      );
    return { installation, digest };
  });

  /**
   * One view of a generation that is current now. Checked again after the
   * load, so a generation that ended meanwhile serves nothing.
   */
  const current = Effect.fnUntraced(function* (
    installationId: PluginInstallationId,
    generation: number,
    viewId: string,
  ) {
    const { installation, digest } = yield* serving(installationId, generation);
    const views = yield* Deferred.await((yield* ensure(installation, digest)).loaded);
    if ((yield* serving(installationId, generation)).digest !== digest)
      return yield* viewError("unavailable", "The plugin was disabled or replaced.");
    const view = views.get(viewId);
    if (view === undefined) return yield* viewError("not-found", "The plugin has no such view.");
    return view;
  });

  const readBundle = Effect.fn("PluginViews.readBundle")(function* (input: PluginViewBundleInput) {
    return (yield* current(input.installationId, input.generation, input.viewId)).bundle;
  });

  const call = Effect.fn("PluginViews.call")(function* (input: PluginViewCallInput) {
    yield* current(input.installationId, input.generation, input.viewId);
    if (jsonBytes(input.input) > PLUGIN_VIEW_MESSAGE_MAX_BYTES)
      return yield* viewError("too-large", "The view's call input is too large.");
    const value = yield* catalog
      .invoke(input.installationId, pluginViewHandler(input.viewId, input.handler), input.input, {
        generation: input.generation,
        timeout: PLUGIN_VIEW_CALL_TIMEOUT_MS,
      })
      .pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "PluginCatalogError":
              return viewError(error.reason, error.message);
            case "PluginCallFailedError":
              return viewError("call-failed", error.reason);
            case "PluginTimeoutError":
              return viewError("timeout", error.message);
            case "PluginBusyError":
              return viewError("busy", error.message);
            case "PluginPayloadTooLargeError":
              return viewError("too-large", error.message);
            default:
              return viewError("unavailable", error.message);
          }
        }),
      );
    if (jsonBytes(value) > PLUGIN_VIEW_MESSAGE_MAX_BYTES)
      return yield* viewError("too-large", "The plugin's answer is too large for a view.");
    return { value };
  });

  return PluginViews.of({
    subscribe: SubscriptionRef.changes(snapshot).pipe(Stream.changes),
    readBundle,
    call,
  });
});

export const layer = Layer.effect(PluginViews, make());
