/**
 * PluginViews - Isolated plugin views: what a plugin declares, what the
 * server delivers, and what crosses the bridge between a client host and a
 * running view.
 *
 * A plugin with the `views` capability lists its views under `views` in
 * `t3-plugin.json`. Each view is one script (and optionally one stylesheet)
 * from the plugin directory. The server serves those exact bytes, read under
 * the installation's consented digest and current generation, over the
 * authenticated environment RPC; nothing is exposed by URL. A client runs a
 * view in an opaque-origin sandboxed frame whose CSP pins the script hashes,
 * and talks to it over one MessagePort carrying the JSON text messages below.
 *
 * Authority comes from the host's binding of the port (environment,
 * installation, generation, view), never from message fields. The
 * installation generation is the revocation epoch: disable, remove, a byte
 * change, or a re-enable ends it, and the server refuses fetches and calls
 * for an old generation.
 *
 * @module PluginViews
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PluginInstallationId } from "./pluginCatalog.ts";

/** The manifest capability a plugin declares to ship views. */
export const PLUGIN_VIEWS_CAPABILITY = "views";

const PLUGIN_VIEW_MAX_PER_PLUGIN = 8;
export const PLUGIN_VIEW_SCRIPT_MAX_BYTES = 1024 * 1024;
export const PLUGIN_VIEW_STYLE_MAX_BYTES = 256 * 1024;
/** Script plus style of one view. */
export const PLUGIN_VIEW_BUNDLE_MAX_BYTES = 1024 * 1024;
/**
 * Script plus style of one view as JSON strings, the form the RPC delivers.
 * Escaping can grow text up to sixfold, so this bounds the wire separately.
 */
export const PLUGIN_VIEW_BUNDLE_MAX_ENCODED_BYTES = 2 * 1024 * 1024;

/** Encoded UTF-8 bytes of one bridge message, in either direction. */
export const PLUGIN_VIEW_MESSAGE_MAX_BYTES = 64 * 1024;
/** Nesting depth of a bridge message's JSON value. */
export const PLUGIN_VIEW_MESSAGE_MAX_DEPTH = 32;
/** Calls a mounted view may have outstanding; more are answered `busy`. */
export const PLUGIN_VIEW_MAX_IN_FLIGHT_CALLS = 16;
/** Token bucket for messages from a view: burst size and refill per second. */
export const PLUGIN_VIEW_MESSAGE_BURST = 64;
export const PLUGIN_VIEW_MESSAGES_PER_SECOND = 32;
/** Invalid or over-rate messages a mount tolerates (each dropped) before it is torn down. */
export const PLUGIN_VIEW_MAX_VIOLATIONS = 8;
/** The host pings a view this often and tears it down if a ping goes unanswered until the next. */
export const PLUGIN_VIEW_PING_INTERVAL_MS = 5_000;
/** Server-side bound on one view call before the plugin's answer is refused. */
export const PLUGIN_VIEW_CALL_TIMEOUT_MS = 30_000;

/** Window messages of the handshake, outside the port: the frame says `ready`, the host answers `connect` with the port. */
export const PLUGIN_VIEW_READY_MESSAGE = "t3-view:ready";
export const PLUGIN_VIEW_CONNECT_MESSAGE = "t3-view:connect";

/** Unique within one plugin. */
const PluginViewId = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
);

/** Where a client shows a view. Only the right-panel side panel exists in v1. */
const PluginViewPlacement = Schema.Literal("side-panel");

/** Relative path inside the plugin directory, without `..` segments. */
const assetPath = (pattern: RegExp) =>
  Schema.String.check(Schema.isMaxLength(256), Schema.isPattern(pattern));

/** One entry of `views` in `t3-plugin.json`. */
const PluginViewDeclaration = Schema.Struct({
  id: PluginViewId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  placement: PluginViewPlacement,
  /** Runs after the host bootstrap; bundle everything the view needs into it. */
  script: assetPath(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:\0]+\.js$/),
  style: Schema.optionalKey(assetPath(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:\0]+\.css$/)),
});
export type PluginViewDeclaration = typeof PluginViewDeclaration.Type;

/** The part of `t3-plugin.json` this capability reads; other keys belong to the plugin manifest. */
export const PluginViewsManifest = Schema.Struct({
  views: Schema.Array(PluginViewDeclaration)
    .check(Schema.isMaxLength(PLUGIN_VIEW_MAX_PER_PLUGIN))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

/**
 * A view an enabled installation offers right now. `(installationId,
 * generation, viewId)` is what a host mounts and binds its port to; a later
 * snapshot without that triple revokes it.
 */
const PluginView = Schema.Struct({
  installationId: PluginInstallationId,
  generation: NonNegativeInt,
  pluginId: TrimmedNonEmptyString,
  pluginName: Schema.String,
  viewId: TrimmedNonEmptyString,
  title: Schema.String,
  /** Open on the wire: a host shows only placements it implements. */
  placement: Schema.String,
});
export type PluginView = typeof PluginView.Type;

/** An enabled views installation whose declarations or files could not be served. */
const PluginViewProblem = Schema.Struct({
  installationId: PluginInstallationId,
  generation: NonNegativeInt,
  message: Schema.String,
});
export type PluginViewProblem = typeof PluginViewProblem.Type;

/** Every view the environment offers; each frame replaces the last. */
export const PluginViewsSnapshot = Schema.Struct({
  views: ForwardCompatibleArray(PluginView),
  problems: ForwardCompatibleArray(PluginViewProblem),
});
export type PluginViewsSnapshot = typeof PluginViewsSnapshot.Type;

export const PluginViewBundleInput = Schema.Struct({
  installationId: PluginInstallationId,
  /** The generation the host saw in the snapshot; any other fails `generation-changed`. */
  generation: NonNegativeInt,
  viewId: PluginViewId,
});
export type PluginViewBundleInput = typeof PluginViewBundleInput.Type;

/** One asset as UTF-8 text (no BOM, LF line ends) with the base64 SHA-256 of its bytes. */
const PluginViewAsset = Schema.Struct({
  text: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{43}=$/)),
});
export type PluginViewAsset = typeof PluginViewAsset.Type;

/**
 * The `view-bundle` asset: the bytes of one view as consented. It is bound to
 * `(installationId, generation)` and to the consented source digest it was
 * read under; a host caches it under its environment and those keys only.
 */
export const PluginViewBundle = Schema.Struct({
  installationId: PluginInstallationId,
  generation: NonNegativeInt,
  viewId: TrimmedNonEmptyString,
  sourceDigest: Schema.String,
  script: PluginViewAsset,
  style: Schema.NullOr(PluginViewAsset),
});
export type PluginViewBundle = typeof PluginViewBundle.Type;

export const PLUGIN_VIEW_HANDLER_MAX_LENGTH = 64;
export const PLUGIN_VIEW_HANDLER_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** The name a view calls; the server invokes the plugin handler `view:<viewId>:<handler>`. */
const PluginViewHandlerName = Schema.String.check(
  Schema.isMaxLength(PLUGIN_VIEW_HANDLER_MAX_LENGTH),
  Schema.isPattern(PLUGIN_VIEW_HANDLER_PATTERN),
);

/** The plugin handler a view's call reaches. Plugins register it with `context.proposed.handle`. */
export const pluginViewHandler = (viewId: string, handler: string) => `view:${viewId}:${handler}`;

export const PluginViewCallInput = Schema.Struct({
  installationId: PluginInstallationId,
  generation: NonNegativeInt,
  viewId: PluginViewId,
  handler: PluginViewHandlerName,
  input: Schema.Json,
});
export type PluginViewCallInput = typeof PluginViewCallInput.Type;

export const PluginViewCallResult = Schema.Struct({ value: Schema.Json });
export type PluginViewCallResult = typeof PluginViewCallResult.Type;

/**
 * `reason` is an open set: `not-found`, `unavailable`, `generation-changed`,
 * `source-changed`, `invalid-view`, `too-large`, `busy`, `timeout`,
 * `call-failed`.
 */
export class PluginViewError extends Schema.TaggedError<PluginViewError>()("PluginViewError", {
  reason: Schema.String,
  message: Schema.String,
}) {}

// Bridge messages. Each is one JSON text string on the port; anything else is a violation.

const BridgeId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 31 - 1 }));

/** From the view (through the host bootstrap) to the host. */
export const PluginViewMessage = Schema.TaggedUnion({
  call: { id: BridgeId, handler: PluginViewHandlerName, input: Schema.Json },
  /** Abandons call `id`; the host answers it `cancelled` unless it already answered. */
  cancel: { id: BridgeId },
  pong: { n: NonNegativeInt },
});

/** From the host to the view. The first message on a port is always `init`. */
export const PluginViewHostMessage = Schema.TaggedUnion({
  init: { pluginId: Schema.String, viewId: Schema.String, title: Schema.String },
  result: { id: BridgeId, value: Schema.Json },
  /**
   * `code` is an open set: a `PluginViewError` reason, `cancelled`, `busy`,
   * `rate` (the call arrived over the message rate), `too-deep`, `too-large`, or
   * `invalid` (the answer is not JSON).
   */
  error: { id: BridgeId, code: Schema.String, message: Schema.String },
  ping: { n: NonNegativeInt },
  /** A message from the view was dropped; enough of these end the mount. */
  violation: { reason: Schema.String },
});
export type PluginViewHostMessage = typeof PluginViewHostMessage.Type;
