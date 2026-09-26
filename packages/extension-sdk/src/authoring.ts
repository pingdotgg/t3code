import type { SurfaceDescriptor, Json } from "./contracts.js";
import type { SurfaceContribution, ViewSession } from "./host.js";
import type { SurfaceRenderer } from "./react.js";
import {
  ENVIRONMENT_ASSET_MEDIA_TYPES,
  validateAssetPath,
  validateEnvironmentPackage,
  type ClientHost,
  type ClientFactory,
  type EnvironmentAsset,
  type EnvironmentPackage,
} from "./environment.js";
import {
  bindApi,
  type ApiDefinition,
  type ApiRequirement,
  type PluginDependency,
  type TypedApi,
  type ApiMethodTypes,
} from "./capabilities.js";
import {
  BROWSER_FRAMES,
  BROWSER_SURFACE,
  browserFramesApi,
  resourcesLeaseApi,
  type BrowserFramesViewState,
  type BrowserSurfaceAcquireResult,
  type BrowserSurfaceDenial,
  type BrowserSurfaceLease,
  type BrowserSurfaceRect,
  type BrowserSurfaceSessionRef,
} from "./catalogue.js";
import { validateContext } from "./contracts.js";

export type RestoreFieldType = "boolean" | "number" | "string";
export interface RestoreStateSchema {
  /**
   * Required keys and their JSON primitive types. Undeclared keys are ignored so a
   * later stateVersion can add fields without rejecting older saves outright.
   */
  readonly fields: Readonly<Record<string, RestoreFieldType>>;
  /** Declared fields that may be absent in older saves. */
  readonly optional?: readonly string[];
}
type RestoreFieldValue<T> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : never;
type OptionalKeys<S extends RestoreStateSchema> = S["optional"] extends readonly (infer O)[]
  ? O
  : never;
/** The TypeScript shape a RestoreStateSchema accepts; persist this via session.save. */
export type RestoreState<S extends RestoreStateSchema> = {
  [K in keyof S["fields"] as K extends OptionalKeys<S> ? never : K]: RestoreFieldValue<
    S["fields"][K]
  >;
} & {
  [K in keyof S["fields"] as K extends OptionalKeys<S> ? K : never]?: RestoreFieldValue<
    S["fields"][K]
  >;
};

const statePreview = (state: Json) => {
  const encoded = JSON.stringify(state);
  return encoded.length > 200 ? encoded.slice(0, 200) + "…" : encoded;
};
const shapeText = (schema: RestoreStateSchema) => {
  const optional = new Set(schema.optional ?? []);
  return (
    "{" +
    Object.entries(schema.fields)
      .map(([key, type]) => key + (optional.has(key) ? "?" : "") + ": " + type)
      .join(", ") +
    "}"
  );
};
const restoreFix =
  "Fix the value passed to session.save() or the stored record. If the persisted shape changed on purpose, update the surface's stateSchema and bump stateVersion so incompatible saves are not restored.";

/**
 * Builds a validateRestore that accepts null (nothing saved yet) or an object
 * matching the schema, and throws an error naming the expectation, the received
 * value and the fix for anything else.
 */
export function restoreStateValidator(
  surfaceId: string,
  stateVersion: number,
  schema: RestoreStateSchema,
): (state: Json) => boolean {
  return (state) => {
    if (state === null) return true;
    const prefix = `Invalid restore state for "${surfaceId}" (stateVersion ${stateVersion}): `;
    const expected = `expected null (nothing saved yet) or an object matching ${shapeText(schema)}`;
    if (typeof state !== "object" || Array.isArray(state))
      throw new Error(`${prefix}${expected}; received ${statePreview(state)}. ${restoreFix}`);
    const optional = new Set(schema.optional ?? []);
    for (const [key, type] of Object.entries(schema.fields)) {
      const value = (state as Record<string, Json>)[key];
      if (value === undefined) {
        if (optional.has(key)) continue;
        throw new Error(
          `${prefix}missing required field "${key}" (${type}). Expected ${shapeText(schema)}; received ${statePreview(state)}. ${restoreFix}`,
        );
      }
      if (typeof value !== type)
        throw new Error(
          `${prefix}expected field "${key}" to be ${type}, received ${typeof value} (${statePreview(value)}). Expected ${shapeText(schema)}. ${restoreFix}`,
        );
    }
    return true;
  };
}
/** Default restore policy: fresh views get null; anything else explains the missing declaration. */
function nullOnlyValidator(surfaceId: string): (state: Json) => boolean {
  return (state) => {
    if (state === null) return true;
    throw new Error(
      `Invalid restore state for "${surfaceId}": the surface received persisted state ${statePreview(state)} but declares neither stateSchema nor validateRestore, so only null is accepted. Declare a stateSchema (or a validateRestore predicate) on the surface, and bump stateVersion if the shape differs from older saves.`,
    );
  };
}

export interface AuthoredSurface extends Omit<
  SurfaceDescriptor,
  "id" | "capabilities" | "stateVersion" | "placements" | "clients"
> {
  /** Local contribution name. The package identity supplies the namespace. */
  readonly name: string;
  readonly placements?: SurfaceDescriptor["placements"];
  readonly clients?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly stateVersion?: number;
  /** Declared persisted shape; compiles to validateRestore with actionable errors. */
  readonly stateSchema?: RestoreStateSchema;
  /** Explicit predicate; takes precedence over stateSchema. */
  readonly validateRestore?: SurfaceContribution<SurfaceRenderer>["validateRestore"];
  createView(
    host: ClientHost,
    session: ViewSession,
  ): ReturnType<SurfaceContribution<SurfaceRenderer>["createView"]>;
}
/** A declared package asset. `path` is both source-relative and package-relative; the CLI supplies the verified byteLength and sha256 at pack time. */
export interface AuthoredAsset {
  readonly path: string;
  readonly mediaType: EnvironmentAsset["mediaType"];
}
export interface ExtensionSource {
  readonly id: string;
  readonly version: string;
  readonly surfaces?: readonly AuthoredSurface[];
  readonly provides?: readonly ApiDefinition[];
  readonly requires?: readonly ApiRequirement[];
  readonly dependencies?: readonly PluginDependency[];
  /** Separate Node source entry, bundled only for the server. */
  readonly serverEntry?: string;
  /** Verified files packed beside the entries; selecting assets emits package format 4. */
  readonly assets?: readonly AuthoredAsset[];
}
export interface AuthoredExtension {
  readonly package: EnvironmentPackage;
  readonly client?: ClientFactory;
  readonly serverEntry?: string;
  readonly assets?: readonly AuthoredAsset[];
}

/** Produces existing installable contracts. It neither installs code nor grants authority. */
export function defineExtension(source: ExtensionSource): AuthoredExtension {
  const surfaces = source.surfaces ?? [];
  const provides = source.provides ?? [];
  const assets = source.assets ?? [];
  for (const asset of assets) {
    validateAssetPath(asset?.path);
    if (!ENVIRONMENT_ASSET_MEDIA_TYPES.includes(asset?.mediaType as EnvironmentAsset["mediaType"]))
      throw new Error("Invalid package asset media type");
  }
  const manifest = {
    id: source.id,
    version: source.version,
    apiVersion: 1 as const,
    surfaces: surfaces.map(
      ({
        name,
        title,
        scope,
        placements,
        clients,
        capabilities,
        claimsTerminalFocus,
        stateVersion,
      }) => ({
        id: source.id + "/" + name,
        title,
        scope,
        placements: placements ?? ["side-panel" as const],
        clients: clients ?? ["web", "desktop"],
        capabilities: capabilities ?? [],
        ...(claimsTerminalFocus === true ? { claimsTerminalFocus: true } : {}),
        stateVersion: stateVersion ?? 1,
      }),
    ),
  };
  const pkg = validateEnvironmentPackage({
    format: assets.length ? 4 : provides.some((api) => api.streams?.length) ? 3 : 2,
    manifest,
    ...(surfaces.length ? { clientEntry: "client.mjs" } : {}),
    ...(source.serverEntry ? { serverEntry: "server.mjs" } : {}),
    tools: [],
    provides,
    requires: source.requires ?? [],
    dependencies: source.dependencies ?? [],
    // The packer replaces this placeholder with verified digests; declared paths survive on the extension.
    ...(assets.length ? { assets: [] } : {}),
  });
  return {
    package: pkg,
    ...(assets.length ? { assets } : {}),
    ...(source.serverEntry ? { serverEntry: source.serverEntry } : {}),
    ...(surfaces.length
      ? {
          client: (host: ClientHost) => ({
            manifest: pkg.manifest,
            surfaces: surfaces.map((surface) => {
              const id = source.id + "/" + surface.name;
              return {
                id,
                validateRestore:
                  surface.validateRestore ??
                  (surface.stateSchema
                    ? restoreStateValidator(id, surface.stateVersion ?? 1, surface.stateSchema)
                    : nullOnlyValidator(id)),
                createView: (session: ViewSession) => surface.createView(host, session),
              };
            }),
          }),
        }
      : {}),
  };
}

export function requireApi(
  api: { readonly definition: ApiDefinition },
  versionRange = "^" + api.definition.version,
): ApiRequirement {
  return { id: api.definition.id, versionRange };
}

export type ApiReadState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "unavailable"; readonly error: string };

/** Read-only React query: scope, visibility, cancellation and stale-result suppression are supplied. */
/* oxlint-disable react/hooks -- React is injected once per host/view lifetime, avoiding a bundled second React. */
export function useApiRead<T extends ApiMethodTypes, K extends keyof T & string>(
  host: ClientHost,
  session: ViewSession,
  api: TypedApi<T>,
  method: K,
  input: T[K]["input"],
): ApiReadState<T[K]["output"]> {
  const { useEffect, useState } = host.React;
  const definition = api.definition.methods?.find((item) => item.name === method);
  if (!definition || definition.effect !== "read")
    throw new Error("useApiRead requires a declared read method");
  const [visible, setVisible] = useState(session.visible);
  const key = JSON.stringify([api.definition, method, input, session.context, visible]);
  const [state, setState] = useState<{ key: string; result: ApiReadState<T[K]["output"]> }>();
  useEffect(() => session.onVisibility(setVisible), [session]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const client = bindApi(api, host, session.context);
    setState({ key, result: { status: "loading" } });
    void client.invoke(method, input, signal).then(
      (value) => {
        if (!signal.aborted) setState({ key, result: { status: "ready", value } });
      },
      (error) => {
        if (!signal.aborted)
          setState({
            key,
            result: {
              status: "unavailable",
              error: error instanceof Error ? error.message : "API unavailable",
            },
          });
      },
    );
    return () => controller.abort();
  }, [key, host, session]);
  return state?.key === key ? state.result : { status: "loading" };
}
/* oxlint-enable react/hooks */

export interface BrowserSurfaceSlotOptions {
  /** Session identity from `t3.browser/sessions`; null presents nothing. */
  readonly session: BrowserSurfaceSessionRef | null;
  /** Combined visibility — the slot hides when the view or the surface is hidden. */
  readonly visible: boolean;
  readonly cornerRadius?: number;
  readonly zIndex?: number;
}

export interface BrowserSurfaceSlot {
  /** Attach to the element whose viewport-relative bounds carry the surface. */
  readonly ref: (element: HTMLElement | null) => void;
  /** The held lease; `lease.state` carries named unsupported and end states. */
  readonly lease: BrowserSurfaceLease | null;
  /** Named acquire failure — grant, scope, epoch or host. Render it as-is. */
  readonly denial: BrowserSurfaceDenial | null;
}

const OVERFLOW_CLIP_PATTERN = /(auto|scroll|hidden|clip)/;
const OCCLUSION_POLL_MS = 400;
/**
 * `host-unavailable` is the only transient denial — the host says "retry
 * once synchronization completes". A mounted slot must recover without a
 * remount, so acquisition retries on a bounded backoff; exhausting it leaves
 * the named denial rendered, which is terminal until the caller remounts or
 * changes the session identity. Every other denial is stable and never
 * retried.
 */
const ACQUIRE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * The composited webview is a fixed-position sibling, not a DOM descendant —
 * ancestor `overflow` does not clip it. Intersect the slot's rect with every
 * overflow-clipping ancestor's box and the viewport so `present` only ever
 * covers pixels the slot could actually show. Returns null when fully clipped.
 */
function clippedSlotRect(element: HTMLElement): BrowserSurfaceRect | null {
  const bounds = element.getBoundingClientRect();
  let x1 = bounds.x;
  let y1 = bounds.y;
  let x2 = bounds.x + bounds.width;
  let y2 = bounds.y + bounds.height;
  let node = element.parentElement;
  while (node && node !== element.ownerDocument.documentElement) {
    const style = getComputedStyle(node);
    if (
      OVERFLOW_CLIP_PATTERN.test(style.overflowX) ||
      OVERFLOW_CLIP_PATTERN.test(style.overflowY)
    ) {
      // Overflow clips at the padding box, but getBoundingClientRect returns
      // the border box — clientLeft/clientTop inset past the border and
      // clientWidth/clientHeight exclude it (and any scrollbar). Scale by
      // rect/offset so a CSS-transformed ancestor still clips proportionally.
      const clip = node.getBoundingClientRect();
      const scaleX = node.offsetWidth > 0 ? clip.width / node.offsetWidth : 1;
      const scaleY = node.offsetHeight > 0 ? clip.height / node.offsetHeight : 1;
      const cx = clip.x + node.clientLeft * scaleX;
      const cy = clip.y + node.clientTop * scaleY;
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      x2 = Math.min(x2, cx + node.clientWidth * scaleX);
      y2 = Math.min(y2, cy + node.clientHeight * scaleY);
    }
    node = node.parentElement;
  }
  const viewport = element.ownerDocument.defaultView;
  x1 = Math.max(x1, 0);
  y1 = Math.max(y1, 0);
  x2 = Math.min(x2, viewport?.innerWidth ?? x2);
  y2 = Math.min(y2, viewport?.innerHeight ?? y2);
  if (x2 <= x1 || y2 <= y1) return null;
  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.round(x2 - x1),
    height: Math.round(y2 - y1),
  };
}

/**
 * Probe the center of the visible region: the only elements allowed to paint
 * above the slot are the slot's own descendants and presented native surfaces
 * (`data-preview-viewport`), which z-order correctly among themselves.
 * Anything else — a modal, overlay, or covering panel — means hide.
 */
function slotOccluded(element: HTMLElement, clip: BrowserSurfaceRect): boolean {
  const stack = element.ownerDocument.elementsFromPoint(
    clip.x + clip.width / 2,
    clip.y + clip.height / 2,
  );
  const index = stack.indexOf(element);
  const covering = index === -1 ? stack : stack.slice(0, index);
  return covering.some(
    (node) =>
      !element.contains(node) &&
      !(typeof node.closest === "function" && node.closest("[data-preview-viewport]") !== null),
  );
}

/**
 * The SDK mirror of the native BrowserSurfaceSlot: owns the acquire/present/
 * release cycle for a plugin-rendered slot element. Geometry is observed with
 * ResizeObserver + window resize + capture-phase scroll, clipped to the slot's
 * visible region, and forwarded through the lease's frame-coalesced
 * `present`. There is no automatic re-acquire — a `superseded` end is
 * terminal for the lease; the caller must remount the slot element or change
 * the session identity (clear it and open a fresh session) to acquire again.
 * The one exception is a `host-unavailable` acquire denial, which is
 * explicitly transient ("retry when synchronization completes"): the hook
 * retries it on a bounded backoff, and a lease that ends `session-unverified`
 * may likewise be re-acquired by remount or identity change once the host
 * recovers.
 */
/* oxlint-disable react/hooks -- hooks come from the injected host React identity. */
export function useBrowserSurfaceSlot(
  host: ClientHost,
  session: ViewSession,
  options: BrowserSurfaceSlotOptions,
): BrowserSurfaceSlot {
  const { useCallback, useLayoutEffect, useRef, useState } = host.React;
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [result, setResult] = useState<BrowserSurfaceAcquireResult | null>(null);
  // Lease transitions are host-originated; the bump re-reads lease.state.
  const [, setLeaseVersion] = useState(0);
  const targetKey = options.session ? `${options.session.serverEpoch}${options.session.tabId}` : "";
  const presentationRef = useRef({
    visible: options.visible,
    cornerRadius: options.cornerRadius ?? 0,
    zIndex: options.zIndex ?? 30,
  });
  const updateRef = useRef<(() => void) | null>(null);

  const ref = useCallback((node: HTMLElement | null) => setElement(node), []);

  useLayoutEffect(() => {
    presentationRef.current = {
      visible: options.visible,
      cornerRadius: options.cornerRadius ?? 0,
      zIndex: options.zIndex ?? 30,
    };
    updateRef.current?.();
  }, [options.visible, options.cornerRadius, options.zIndex]);

  useLayoutEffect(() => {
    setResult(null);
    if (!element || !options.session) return;
    const surface = host.browserSurface;
    const major = Number.parseInt(surface?.version.split(".")[0] ?? "", 10);
    if (!surface || surface.id !== BROWSER_SURFACE || major !== 1) {
      setResult({
        ok: false,
        denial: {
          reason: "host-unavailable",
          detail: `This host does not implement ${BROWSER_SURFACE}@1.x.`,
        },
      });
      return;
    }
    const surfaceSession = options.session;
    let detach: () => void = () => {};
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;

    const attach = (held: BrowserSurfaceLease) => {
      let poll: ReturnType<typeof setInterval> | null = null;
      const unsubscribe = held.onDidChangeState((next) => {
        setLeaseVersion((value) => value + 1);
        if (next.kind === "ended" && poll !== null) {
          clearInterval(poll);
          poll = null;
        }
      });
      // Nothing composites on an unsupported host — the lease still reports
      // its named state, but no geometry or occlusion work is worth running.
      if (!surface.presentation.supported) {
        detach = () => {
          unsubscribe();
          held.release();
        };
        return;
      }
      // A suppressed slot keeps its last footprint and skips every DOM read —
      // one present flips the native surface off and the occlusion poll stops
      // until the slot is visible again; nothing remains to probe.
      let hidden = !presentationRef.current.visible;
      let lastRect: BrowserSurfaceRect = { x: 0, y: 0, width: 1, height: 1 };
      const update = () => {
        if (held.state.kind === "ended") return;
        const prefs = presentationRef.current;
        if (!prefs.visible) {
          if (poll !== null) {
            clearInterval(poll);
            poll = null;
          }
          if (!hidden) {
            hidden = true;
            held.present(lastRect, false, prefs.cornerRadius, prefs.zIndex);
          }
          return;
        }
        hidden = false;
        // Sibling overlays (modals, panels) do not trigger geometry events —
        // poll the occlusion probe so a covered surface still hides.
        if (poll === null) poll = setInterval(update, OCCLUSION_POLL_MS);
        // The webview is not clipped by the slot's overflow ancestors —
        // present the visible intersection and hide when nothing of it is on
        // screen.
        const clip = clippedSlotRect(element);
        const occluded = clip !== null && slotOccluded(element, clip);
        const rect =
          clip ??
          (() => {
            const bounds = element.getBoundingClientRect();
            return {
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              width: Math.max(1, Math.round(bounds.width)),
              height: Math.max(1, Math.round(bounds.height)),
            };
          })();
        lastRect = rect;
        held.present(rect, clip !== null && !occluded, prefs.cornerRadius, prefs.zIndex);
      };
      updateRef.current = update;
      update();
      const observer = new ResizeObserver(update);
      observer.observe(element);
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
      detach = () => {
        if (poll !== null) clearInterval(poll);
        observer.disconnect();
        window.removeEventListener("resize", update);
        window.removeEventListener("scroll", update, true);
        if (updateRef.current === update) updateRef.current = null;
        unsubscribe();
        held.release();
      };
    };

    const tryAcquire = () => {
      if (disposed) return;
      const acquired = surface.acquire({
        context: session.context,
        session: surfaceSession,
        signal: session.signal,
      });
      if (!acquired.ok) {
        setResult(acquired);
        if (
          acquired.denial.reason === "host-unavailable" &&
          attempts < ACQUIRE_RETRY_DELAYS_MS.length
        ) {
          retry = setTimeout(tryAcquire, ACQUIRE_RETRY_DELAYS_MS[attempts]);
          attempts += 1;
        }
        return;
      }
      setResult(acquired);
      attach(acquired.lease);
    };
    tryAcquire();
    return () => {
      disposed = true;
      if (retry !== null) clearTimeout(retry);
      detach();
    };
    // The lease is re-acquired only when the element or session identity changes.
  }, [element, targetKey, host, session]);

  return {
    ref,
    lease: result?.ok ? result.lease : null,
    denial: result && !result.ok ? result.denial : null,
  };
}

/** Session identity for remote frames — the held `t3.browser/sessions` ref plus its last engine generation. */
export interface RemoteBrowserFramesSession {
  readonly tabId: string;
  readonly serverEpoch: string;
  /** Latest engine-reported generation; the mints fence on it. */
  readonly engineGeneration: string | null;
}

export interface RemoteBrowserFramesOptions {
  readonly session: RemoteBrowserFramesSession | null;
  /** Mount only while the slot is visible and a session is held. */
  readonly enabled: boolean;
}

export type RemoteBrowserFramesStatus =
  | { readonly kind: "idle" }
  /** No remote-frame transport or engine host — fall back to a plain notice. */
  | { readonly kind: "unsupported"; readonly detail: string }
  | { readonly kind: "connecting" }
  | { readonly kind: "streaming" }
  | { readonly kind: "error"; readonly detail: string };

export interface RemoteBrowserFrames {
  readonly ref: (node: HTMLElement | null) => void;
  readonly status: RemoteBrowserFramesStatus;
  /** Whether the input lease is bound — pointer/key events reach the guest. */
  readonly inputConnected: boolean;
  /** Frames the engine produced that this client dropped before painting. */
  readonly droppedFrames: number;
  /** Input packets the hub rejected (replay, stale geometry, rate limit, …). */
  readonly rejectedInput: number;
}

/**
 * The SDK mirror of the remote-frame presenter: mints lease-bound tickets
 * through `t3.browser/frames` and mounts the host's frame view on the
 * element. Use it when `useBrowserSurfaceSlot` reports the host cannot
 * composite (`presentation.supported === false` or no `browserSurface`
 * capability) — it is the remote-client counterpart of the native slot.
 * A view is bound to one session identity; change `options.session` to move
 * it, and set `enabled` false to stop transport entirely.
 */
export function useRemoteBrowserFrames(
  host: ClientHost,
  session: ViewSession,
  options: RemoteBrowserFramesOptions,
): RemoteBrowserFrames {
  const { useCallback, useEffect, useRef, useState } = host.React;
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState<RemoteBrowserFramesStatus>({ kind: "idle" });
  const [view, setView] = useState<BrowserFramesViewState>({
    status: "connecting",
    inputConnected: false,
    droppedFrames: 0,
    rejectedInput: 0,
  });
  const sessionRef = useRef(options.session);
  sessionRef.current = options.session;
  const targetKey = options.session
    ? `${options.session.serverEpoch} ${options.session.tabId}`
    : "";
  const ref = useCallback((node: HTMLElement | null) => setElement(node), []);

  useEffect(() => {
    setStatus({ kind: "idle" });
    setView({ status: "connecting", inputConnected: false, droppedFrames: 0, rejectedInput: 0 });
    if (!element || !options.enabled || !options.session) return;
    const target = options.session;
    const frames = host.browserFrames;
    const major = Number.parseInt(frames?.version.split(".")[0] ?? "", 10);
    if (!frames || frames.id !== BROWSER_FRAMES || major !== 1) {
      setStatus({
        kind: "unsupported",
        detail: `This host does not implement ${BROWSER_FRAMES}@1.x presentation.`,
      });
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const api = bindApi(browserFramesApi, host, session.context);
    const leases = bindApi(resourcesLeaseApi, host, session.context);
    // The frames mints require held-presentation evidence: a `browser-surface`
    // claim minted through `t3.resources/lease` for this exact session tuple.
    // One claim per view is the presentation slot's identity — the frames
    // authority key includes its server-owned slotId, so renewals and
    // closeInput must reuse the same claim until it nears expiry (then a
    // fresh claim is a fresh slot and mints its own lease).
    // One claim per view is the presentation slot's identity — the frames
    // authority key includes its server-owned slotId, so renewals and
    // closeInput must reuse the same claim until it nears expiry (then a
    // fresh claim is a fresh slot and mints its own lease). Every minted
    // claim is tracked so cleanup can release all of them, and a single
    // in-flight mint is shared so concurrent stream/input acquisition cannot
    // mint two slots and abandon one untracked.
    let surfaceLease: { readonly url: string; readonly expiresAt: number } | null = null;
    const surfaceLeaseUrls = new Set<string>();
    // Operations that mint server-side resources go in here so teardown can
    // wait for them to settle — a mint that resolves after abort still adds
    // its claim to `surfaceLeaseUrls`, and a late openInput still names its
    // lease, both of which cleanup must release.
    const pendingOps = new Set<Promise<unknown>>();
    const track = <T>(op: Promise<T>): Promise<T> => {
      pendingOps.add(op);
      void op.then(
        () => pendingOps.delete(op),
        () => pendingOps.delete(op),
      );
      return op;
    };
    let minting: Promise<string | null> | null = null;
    const mintSurfaceLease = (): Promise<string | null> => {
      if (surfaceLease !== null && surfaceLease.expiresAt - Date.now() > 30_000) {
        return Promise.resolve(surfaceLease.url);
      }
      minting ??= track(
        (async () => {
          try {
            const context = validateContext(session.context);
            const threadId = context.resource.threadId;
            if (!threadId) return null;
            const mint = await leases.invoke(
              "createPresentationUrl",
              {
                resource: {
                  _tag: "browser-surface",
                  threadId,
                  tabId: target.tabId,
                  serverEpoch: target.serverEpoch,
                  allowedCommands: ["attach", "present", "release"],
                },
              },
              signal,
            );
            surfaceLease = { url: mint.url, expiresAt: mint.expiresAt };
            surfaceLeaseUrls.add(mint.url);
            return mint.url;
          } catch {
            return null;
          } finally {
            minting = null;
          }
        })(),
      );
      return minting;
    };
    let detach: () => void = () => {};
    let inputLeaseId: string | null = null;
    // The claim that minted the live input lease — closeInput must name the
    // same slot the lease was minted under, which may be an earlier claim
    // than the one currently cached after rotation.
    let inputLeaseSurfaceUrl: string | null = null;
    void (async () => {
      try {
        const capabilities = await api.invoke("getCapabilities", {}, signal);
        if (signal.aborted) return;
        if (!capabilities.stream.supported) {
          setStatus({
            kind: "unsupported",
            detail: "No engine host serves remote frames for this environment.",
          });
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        setStatus({
          kind: "error",
          detail: error instanceof Error ? error.message : "Browser frames are unavailable.",
        });
        return;
      }
      const presented = frames.present({
        context: session.context,
        session: { tabId: target.tabId, serverEpoch: target.serverEpoch },
        slot: element,
        signal,
        openStream: async () => {
          try {
            const surfaceLease = await mintSurfaceLease();
            if (surfaceLease === null) return null;
            const descriptor = await api.invoke(
              "openStream",
              {
                tabId: target.tabId,
                serverEpoch: target.serverEpoch,
                surfaceLease,
                expectedEngineGeneration: sessionRef.current?.engineGeneration ?? null,
              },
              signal,
            );
            return { ticket: descriptor.ticket, expiresAt: descriptor.expiresAt };
          } catch {
            return null;
          }
        },
        openInput: () =>
          track(
            (async () => {
              try {
                const surfaceLease = await mintSurfaceLease();
                if (surfaceLease === null) return null;
                const lease = await api.invoke(
                  "openInput",
                  {
                    tabId: target.tabId,
                    serverEpoch: target.serverEpoch,
                    surfaceLease,
                    expectedEngineGeneration: sessionRef.current?.engineGeneration ?? null,
                  },
                  signal,
                );
                inputLeaseId = lease.leaseId;
                inputLeaseSurfaceUrl = surfaceLease;
                return {
                  leaseId: lease.leaseId,
                  inputTicket: lease.inputTicket,
                  expiresAt: lease.expiresAt,
                };
              } catch {
                return null;
              }
            })(),
          ),
      });
      if (signal.aborted) {
        if (presented.ok) presented.view.detach();
        return;
      }
      if (!presented.ok) {
        setStatus(
          presented.denial.reason === "frames-unsupported"
            ? { kind: "unsupported", detail: presented.denial.detail }
            : { kind: "error", detail: presented.denial.detail },
        );
        return;
      }
      const unsubscribe = presented.view.onDidChangeState(setView);
      setView(presented.view.state);
      setStatus({ kind: "connecting" });
      detach = () => {
        unsubscribe();
        presented.view.detach();
      };
    })();
    return () => {
      controller.abort();
      detach();
      void (async () => {
        // A mint or openInput in flight when teardown fired can still resolve
        // — the invoke was under `signal`, so it settles promptly — and what
        // it minted must be released below, not left to its TTL.
        await Promise.allSettled(pendingOps);
        // Cleanup must outlive the session's own abort — invoking under
        // `session.signal` (or the already-dead combined `signal`) cancels the
        // release before it can fire whenever teardown raced acquisition. A
        // dedicated bounded signal gives each release a real chance to land.
        const cleanupSignal = AbortSignal.timeout(5_000);
        // Honest release: the socket close already unwinds the hub side; this
        // retires the lease record early so a second presenter does not wait
        // out the TTL. The close names the slot that minted the lease — after
        // claim rotation that can be an earlier claim than the cached one.
        if (inputLeaseId !== null) {
          void api
            .invoke(
              "closeInput",
              {
                leaseId: inputLeaseId,
                ...(inputLeaseSurfaceUrl !== null ? { surfaceLease: inputLeaseSurfaceUrl } : {}),
              },
              cleanupSignal,
            )
            .catch(() => {});
        }
        // Retire every held presentation claim, not just the latest: rotation
        // minted fresh claims whose slots may still hold stream tickets.
        // Releasing invalidates each claim and every ticket under its slot, so
        // a released view's credentials die now rather than at claim expiry.
        for (const presentationUrl of surfaceLeaseUrls) {
          void leases
            .invoke("releasePresentation", { presentationUrl }, cleanupSignal)
            .catch(() => {});
        }
      })();
    };
    // The view is re-presented only when the element or session identity changes.
  }, [element, targetKey, options.enabled, host, session]);

  const statusWithView: RemoteBrowserFramesStatus =
    status.kind !== "connecting"
      ? status
      : view.status === "streaming"
        ? { kind: "streaming" }
        : view.status === "error"
          ? { kind: "error", detail: view.detail ?? "Remote frame transport failed." }
          : { kind: "connecting" };
  return {
    ref,
    status: statusWithView,
    inputConnected: view.inputConnected,
    droppedFrames: view.droppedFrames,
    rejectedInput: view.rejectedInput,
  };
}
/* oxlint-enable react/hooks */
