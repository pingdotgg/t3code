export { SurfaceVisibilityContext } from "./surfaceVisibility.js";
import {
  createContextSnapshotId,
  validateContextContent,
  validateContextSnapshot,
  type ComposerContextContribution,
  type MessageDecorationContribution,
  type MessageContext,
  type MessageCard,
  type TextContributionDescriptor,
} from "./context.js";
import { assertId, copyJson, resourceKey, validateContext, validateManifest } from "./contracts.js";
import type {
  ExtensionManifest,
  Json,
  Placement,
  SurfaceDescriptor,
  ViewContext,
  ViewRecord,
} from "./contracts.js";

/** A plugin command handler bound to a `t3.ui/keybindings` registration. */
export type ViewCommandHandler = (call: {
  readonly commandId: string;
  readonly context: ViewContext;
}) => void;

/**
 * Host-rendered chrome for a view's panel tab, drawn beside the manifest
 * title the way native tabs show a page icon and audio state. The host
 * derives the public-provider icon from `pageUrl`; a captured
 * `faviconDataUrl` beats it; with neither the host keeps its default icon.
 */
export interface ViewTabIndicators {
  /** The http(s) page the tab represents. */
  readonly pageUrl?: string;
  /** A captured favicon: `data:image/*;base64`, at most 8192 chars. */
  readonly faviconDataUrl?: string;
  /** "audible" is playing sound; "muted" has sound the user silenced. */
  readonly audio?: "audible" | "muted";
  /**
   * A static badge: "running" is live work, "unread" is something that
   * finished while the user was not looking. `count` is an integer 1-999
   * (the host abbreviates past 99); absent draws a dot.
   */
  readonly badge?: { readonly kind: "running" | "unread"; readonly count?: number };
}

const TAB_FAVICON_DATA_URL =
  /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function validateTabBadge(value: unknown): NonNullable<ViewTabIndicators["badge"]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tab badge must be an object");
  const { kind, count, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new Error("Tab badge accepts only kind and count");
  if (kind !== "running" && kind !== "unread")
    throw new Error('Tab badge kind must be "running" or "unread"');
  if (
    count !== undefined &&
    (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 999)
  )
    throw new Error("Tab badge count must be an integer from 1 to 999");
  return count === undefined ? { kind } : { kind, count: count as number };
}

/** Returns a plain copy of valid indicators; throws on anything else. */
export function validateTabIndicators(value: unknown): ViewTabIndicators {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tab indicators must be an object");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !["pageUrl", "faviconDataUrl", "audio", "badge"].includes(key)))
    throw new Error("Tab indicators accept only pageUrl, faviconDataUrl, audio and badge");
  const { pageUrl, faviconDataUrl, audio, badge } = input;
  if (pageUrl !== undefined) {
    let protocol: string | null = null;
    try {
      protocol = typeof pageUrl === "string" ? new URL(pageUrl).protocol : null;
    } catch {
      protocol = null;
    }
    if (
      typeof pageUrl !== "string" ||
      pageUrl.length > 2048 ||
      (protocol !== "http:" && protocol !== "https:")
    )
      throw new Error("Tab pageUrl must be an http(s) URL of at most 2048 chars");
  }
  if (
    faviconDataUrl !== undefined &&
    (typeof faviconDataUrl !== "string" ||
      faviconDataUrl.length > 8192 ||
      !TAB_FAVICON_DATA_URL.test(faviconDataUrl))
  )
    throw new Error("Tab faviconDataUrl must be a base64 image data URL of at most 8192 chars");
  if (audio !== undefined && audio !== "audible" && audio !== "muted")
    throw new Error('Tab audio must be "audible" or "muted"');
  return {
    ...(pageUrl === undefined ? {} : { pageUrl: pageUrl as string }),
    ...(faviconDataUrl === undefined ? {} : { faviconDataUrl: faviconDataUrl as string }),
    ...(audio === undefined ? {} : { audio }),
    ...(badge === undefined ? {} : { badge: validateTabBadge(badge) }),
  };
}

export interface ViewSession {
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly restoring: boolean;
  readonly visible: boolean;
  onVisibility(listener: (visible: boolean) => void): () => void;
  readonly restoreState: Json;
  /**
   * Receives a host navigation into this live view: the restore state a new
   * open would have started from (a file link to the file already shown).
   * It leaves the view's saved state alone; the view saves what it applies.
   * Without a listener the host restarts the view from that state instead.
   * Absent on hosts that predate it, which always restart.
   */
  onNavigate?(listener: (restoreState: Json) => void): () => void;
  /** Monotonic within this session; old/hidden/disposed publications return false. */
  publish(sequence: number, state: Json): boolean;
  save(state: Json): boolean;
  invoke(capability: string, input: Json): Promise<Json>;
  /**
   * Binds this view-session's handler to a `t3.ui/keybindings` registration
   * and returns the binding store's `bindingId`. The token must name a live
   * registration whose context deep-equals this session's context; stale
   * generations fail `binding-stale`, foreign/dead tokens `binding-unknown`.
   * Idempotent per (view-session, token). The binding dies with the view.
   */
  bindCommands(commandSetToken: string, handler: ViewCommandHandler): string;
  /**
   * Replaces the host-rendered tab indicators (null clears them). Allowed
   * while hidden — a background tab still shows its icon and audio. Invalid
   * indicators throw; a disposed session returns false. Cleared when the
   * view restarts or closes.
   */
  setTabIndicators(indicators: ViewTabIndicators | null): boolean;
  onDispose(cleanup: () => void): void;
}
export interface ViewController<Renderer> {
  readonly renderer: Renderer;
  dispose?(): void;
}
export interface SurfaceContribution<Renderer> {
  readonly id: string;
  validateRestore(state: Json): boolean;
  createView(session: ViewSession): ViewController<Renderer> | Promise<ViewController<Renderer>>;
}
export interface Extension<Renderer> {
  readonly manifest: ExtensionManifest;
  readonly surfaces: readonly SurfaceContribution<Renderer>[];
  readonly composerContexts?: readonly ComposerContextContribution[];
  readonly messageDecorations?: readonly MessageDecorationContribution[];
}
export interface ServiceCall {
  readonly extensionId: string;
  readonly surfaceId: string;
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly input: Json;
}
export interface HostService {
  readonly capability: string;
  /** Must enforce authenticated domain ownership; descriptor scope is not authentication. */
  invoke(call: ServiceCall): Json | Promise<Json>;
}
export interface HostOptions {
  readonly services?: readonly HostService[];
  /** Host-owned grant check, repeated on every service invocation. */
  authorize(extensionId: string, capability: string, context: ViewContext): boolean;
  readonly timeoutMs?: number;
  readonly maxViews?: number;
  readonly maxPendingCalls?: number;
  /**
   * Backs `ViewSession.bindCommands`. The host owns the binding store and
   * mints the returned `bindingId`; it validates token liveness, caller
   * generation, and context equality. Absent on hosts without a seam.
   */
  readonly bindCommands?: (call: {
    readonly extensionId: string;
    readonly hostKey: string;
    readonly viewId: string;
    readonly context: ViewContext;
    readonly commandSetToken: string;
    readonly handler: ViewCommandHandler;
  }) => { readonly bindingId: string; readonly unbind: () => void };
}
export interface ViewSnapshot {
  readonly id: string;
  readonly record: ViewRecord;
  readonly status: "loading" | "ready" | "hidden" | "unavailable" | "error";
  readonly reason: string | null;
  readonly state: Json;
  readonly generation: number;
  /** Set only while the view publishes indicators. */
  readonly tab?: ViewTabIndicators;
}
interface Registration<R> {
  manifest: ExtensionManifest;
  contributions: Map<string, SurfaceContribution<R>>;
  composerContexts: Map<string, ComposerContextContribution>;
  messageDecorations: Map<string, MessageDecorationContribution>;
  enabled: boolean;
}
interface Entry<R> {
  snapshot: ViewSnapshot;
  registration: Registration<R> | undefined;
  descriptor: SurfaceDescriptor | undefined;
  controller: ViewController<R> | undefined;
  abort: AbortController;
  activity: AbortController;
  visibility: Set<(visible: boolean) => void>;
  navigation: Set<(restoreState: Json) => void>;
  cleanup: Set<() => void>;
  sequence: number;
  pending: number;
}
let nextHostSerial = 0;
const failure = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 500) : "Extension failed";
const statePreview = (state: Json) => {
  const encoded = JSON.stringify(state);
  return encoded.length > 200 ? encoded.slice(0, 200) + "…" : encoded;
};

/** Trusted, in-process view host. No domain resource creation/destruction or layout ownership. */
export function createExtensionHost<Renderer>(options: HostOptions) {
  const hostKey = `host-${++nextHostSerial}`;
  const registrations = new Map<string, Registration<Renderer>>();
  const entries = new Map<string, Entry<Renderer>>();
  const listeners = new Set<(view: ViewSnapshot | null, id: string) => void>();
  const services = new Map<string, HostService>();
  const timeout = options.timeoutMs ?? 10_000;
  const maxViews = options.maxViews ?? 64;
  const maxCalls = options.maxPendingCalls ?? 8;
  for (const n of [timeout, maxViews, maxCalls])
    if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid host limit");
  for (const service of options.services ?? []) {
    assertId(service.capability);
    if (services.has(service.capability)) throw new Error("Duplicate host service");
    services.set(service.capability, service);
  }
  // Record and presentation are independently bounded payloads; the envelope is host-owned.
  function copySnapshot(source: ViewSnapshot): ViewSnapshot {
    return { ...source, record: copyJson(source.record), state: copyJson(source.state) };
  }
  const snapshots = new WeakMap<ViewSnapshot, ViewSnapshot>();
  function getSnapshot(id: string): ViewSnapshot | null {
    const source = entries.get(id)?.snapshot;
    if (!source) return null;
    let cached = snapshots.get(source);
    if (!cached) {
      cached = copySnapshot(source);
      function freeze(value: unknown): void {
        if (value && typeof value === "object") {
          Object.values(value).forEach(freeze);
          Object.freeze(value);
        }
      }
      freeze(cached);
      snapshots.set(source, cached);
    }
    return cached;
  }
  let nextId = 0;
  let disposed = false;
  function emit(entry: Entry<Renderer> | null, id: string) {
    for (const listener of listeners) {
      try {
        listener(entry ? copySnapshot(entry.snapshot) : null, id);
      } catch {
        /* A failing observer cannot break another view. */
      }
    }
  }
  function stop(entry: Entry<Renderer>) {
    entry.abort.abort();
    entry.activity.abort();
    entry.visibility.clear();
    entry.navigation.clear();
    const controller = entry.controller;
    entry.controller = undefined;
    try {
      controller?.dispose?.();
    } catch {
      /* Continue releasing all owned subscriptions. */
    }
    for (const cleanup of entry.cleanup) {
      try {
        cleanup();
      } catch {
        /* Independent cleanup. */
      }
    }
    entry.cleanup.clear();
  }
  function setStatus(
    entry: Entry<Renderer>,
    status: ViewSnapshot["status"],
    reason: string | null = null,
  ) {
    entry.snapshot = { ...entry.snapshot, status, reason };
    emit(entry, entry.snapshot.id);
  }
  function deadline<T>(run: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("View cancelled"));
        return;
      }
      const abort = () => finish(new Error("View cancelled"));
      const timer = setTimeout(() => finish(new Error("Extension operation timed out")), timeout);
      let settled = false;
      function finish(error: Error | null, value?: T) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value as T);
      }
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(run)
        .then(
          (value) => finish(null, value),
          (error) => finish(new Error(failure(error))),
        );
    });
  }
  function resolve(record: ViewRecord) {
    const owner = record.surfaceId.split("/")[0]!;
    const registration = registrations.get(owner);
    const descriptor = registration?.manifest.surfaces.find(
      (surface) => surface.id === record.surfaceId,
    );
    let reason: string | null = null;
    if (!registration || !descriptor) reason = "Extension or contribution is unavailable";
    else if (!registration.enabled) reason = "Extension is disabled";
    else if (descriptor.stateVersion !== record.stateVersion)
      reason = "Saved state version is incompatible";
    else if (
      !descriptor.placements.includes(record.placement) ||
      !descriptor.clients.includes(record.context.client)
    )
      reason = "Presentation is unsupported on this client";
    else if (
      (descriptor.scope !== "environment" && !record.context.resource.projectId) ||
      (descriptor.scope === "thread" && !record.context.resource.threadId)
    )
      reason = "Required resource scope is missing";
    else {
      try {
        if (
          descriptor.capabilities.some(
            (cap) => !services.has(cap) || !options.authorize(owner, cap, copyJson(record.context)),
          )
        )
          reason = "Required capability is unavailable";
        else if (
          !registration.contributions
            .get(record.surfaceId)!
            .validateRestore(copyJson(record.restoreState))
        )
          reason =
            `Saved state for "${record.surfaceId}" is invalid: the surface's validateRestore rejected ` +
            `${statePreview(record.restoreState)}. Restore needs the shape the surface declared ` +
            `for stateVersion ${record.stateVersion}; fix the stored record or the validator.`;
      } catch (error) {
        reason = failure(error);
      }
    }
    return { registration, descriptor, reason };
  }
  async function start(entry: Entry<Renderer>, restoring: boolean) {
    stop(entry);
    entry.abort = new AbortController();
    entry.activity = new AbortController();
    entry.sequence = -1;
    const generation = entry.snapshot.generation + 1;
    const { tab: _tab, ...untabbed } = entry.snapshot;
    entry.snapshot = { ...untabbed, generation, state: null };
    const resolved = resolve(entry.snapshot.record);
    entry.registration = resolved.registration;
    entry.descriptor = resolved.descriptor;
    if (resolved.reason) {
      stop(entry);
      setStatus(entry, "unavailable", resolved.reason);
      return;
    }
    const registration = resolved.registration!;
    const contribution = registration.contributions.get(entry.snapshot.record.surfaceId)!;
    const signal = entry.abort.signal;
    const context = copyJson(entry.snapshot.record.context);
    const live = () =>
      !signal.aborted &&
      entries.get(entry.snapshot.id) === entry &&
      entry.snapshot.generation === generation;
    setStatus(entry, "loading");
    let queued = false;
    function notifyCurrent() {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (live()) emit(entry, entry.snapshot.id);
      });
    }
    const session: ViewSession = {
      context: copyJson(context),
      signal,
      restoring,
      get visible() {
        return live() && entry.snapshot.status !== "hidden";
      },
      onVisibility(listener) {
        if (live()) entry.visibility.add(listener);
        return () => {
          entry.visibility.delete(listener);
        };
      },
      restoreState: copyJson(entry.snapshot.record.restoreState),
      onNavigate(listener) {
        if (live()) entry.navigation.add(listener);
        return () => {
          entry.navigation.delete(listener);
        };
      },
      publish(sequence, state) {
        if (
          !live() ||
          entry.snapshot.status === "hidden" ||
          !Number.isSafeInteger(sequence) ||
          sequence <= entry.sequence
        )
          return false;
        const copied = copyJson(state);
        entry.sequence = sequence;
        entry.snapshot = { ...entry.snapshot, state: copied };
        // Presentation and saved records share one bounded microtask notification.
        notifyCurrent();
        return true;
      },
      save(state) {
        if (!live()) return false;
        const copied = copyJson(state);
        if (!contribution.validateRestore(copyJson(copied)))
          throw new Error(
            `Invalid restore state for "${contribution.id}": the surface's validateRestore ` +
              `rejected ${statePreview(copied)}. Pass the shape declared for stateVersion ` +
              `${entry.descriptor!.stateVersion}, or fix the validator if the persisted shape changed.`,
          );
        entry.snapshot = {
          ...entry.snapshot,
          record: validateRecord({ ...entry.snapshot.record, restoreState: copied }),
        };
        notifyCurrent();
        return true;
      },
      async invoke(capability, input) {
        if (!live() || entry.snapshot.status === "hidden") throw new Error("View is inactive");
        if (
          !entry.descriptor!.capabilities.includes(capability) ||
          !options.authorize(registration.manifest.id, capability, copyJson(context))
        )
          throw new Error("Capability denied");
        const service = services.get(capability);
        if (!service) throw new Error("Capability unavailable");
        if (entry.pending >= maxCalls) throw new Error("Too many pending view calls");
        const callInput = copyJson(input);
        entry.pending++;
        const callAbort = new AbortController();
        const cancel = () => callAbort.abort();
        const activitySignal = entry.activity.signal;
        activitySignal.addEventListener("abort", cancel, { once: true });
        try {
          const output = await deadline(() => {
            if (!live() || callAbort.signal.aborted) throw new Error("View cancelled");
            return service.invoke({
              extensionId: registration.manifest.id,
              surfaceId: contribution.id,
              context: copyJson(context),
              signal: callAbort.signal,
              input: callInput,
            });
          }, callAbort.signal);
          if (!live()) throw new Error("Stale view response");
          return copyJson(output);
        } finally {
          callAbort.abort();
          activitySignal.removeEventListener("abort", cancel);
          entry.pending--;
        }
      },
      bindCommands(commandSetToken, handler) {
        if (!live() || entry.snapshot.status === "hidden") throw new Error("View is inactive");
        if (!options.bindCommands) throw new Error("Command binding is unavailable");
        const bound = options.bindCommands({
          extensionId: registration.manifest.id,
          hostKey,
          viewId: entry.snapshot.id,
          context: copyJson(context),
          commandSetToken,
          handler,
        });
        entry.cleanup.add(bound.unbind);
        return bound.bindingId;
      },
      setTabIndicators(indicators) {
        const next = indicators === null ? null : validateTabIndicators(indicators);
        if (!live()) return false;
        const { tab: _tab, ...untabbed } = entry.snapshot;
        entry.snapshot = next === null ? untabbed : { ...untabbed, tab: next };
        notifyCurrent();
        return true;
      },
      onDispose(cleanup) {
        if (live()) entry.cleanup.add(cleanup);
        else {
          try {
            cleanup();
          } catch {
            /* Late cleanup still runs. */
          }
        }
      },
    };
    try {
      const controller = await deadline(async () => {
        if (!live()) throw new Error("View cancelled");
        const result = await contribution.createView(session);
        if (!live()) {
          try {
            result.dispose?.();
          } catch {
            /* Late factory result. */
          }
          throw new Error("View cancelled");
        }
        return result;
      }, signal);
      if (!live()) {
        try {
          controller.dispose?.();
        } catch {
          /* Race with close. */
        }
        return;
      }
      entry.controller = controller;
      if (entry.snapshot.status !== "hidden") setStatus(entry, "ready");
    } catch (error) {
      if (live()) {
        stop(entry);
        setStatus(entry, "error", failure(error));
      }
    }
  }
  function required(id: string) {
    const entry = entries.get(id);
    if (!entry) throw new Error("Unknown view");
    return entry;
  }
  function validateRecord(record: ViewRecord): ViewRecord {
    const copied = copyJson(record);
    assertId(copied.surfaceId);
    if (
      !copied.surfaceId.includes("/") ||
      copied.version !== 1 ||
      !Number.isSafeInteger(copied.stateVersion) ||
      copied.stateVersion < 1 ||
      typeof copied.fallback !== "string" ||
      copied.fallback.length > 2000 ||
      !["side-panel", "bottom-dock", "full-page", "compact-detail"].includes(copied.placement)
    )
      throw new Error("Invalid view record");
    validateContext(copied.context);
    return copied;
  }
  async function open(record: ViewRecord, restoring = false) {
    if (disposed) throw new Error("Host disposed");
    const copied = validateRecord(record);
    if (entries.size >= maxViews) throw new Error("View limit reached");
    const id = `view-${++nextId}`;
    const entry: Entry<Renderer> = {
      snapshot: { id, record: copied, status: "loading", reason: null, state: null, generation: 0 },
      registration: undefined,
      descriptor: undefined,
      controller: undefined,
      abort: new AbortController(),
      activity: new AbortController(),
      visibility: new Set(),
      navigation: new Set(),
      cleanup: new Set(),
      sequence: -1,
      pending: 0,
    };
    entries.set(id, entry);
    await start(entry, restoring);
    return id;
  }
  function close(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    stop(entry);
    emit(null, id);
  }
  function disable(extensionId: string) {
    const registration = registrations.get(extensionId);
    if (!registration) return;
    registration.enabled = false;
    for (const entry of entries.values())
      if (entry.snapshot.record.surfaceId.startsWith(extensionId + "/")) {
        stop(entry);
        setStatus(entry, "unavailable", "Extension is disabled");
      }
  }
  function fail(id: string, error: unknown) {
    const entry = required(id);
    stop(entry);
    setStatus(entry, "error", failure(error));
  }
  return {
    hostKey,
    register(extension: Extension<Renderer>) {
      if (disposed) throw new Error("Host disposed");
      const manifest = validateManifest(extension.manifest);
      if (registrations.has(manifest.id)) throw new Error("Duplicate extension");
      const contributions = new Map<string, SurfaceContribution<Renderer>>();
      for (const surface of extension.surfaces) {
        if (
          contributions.has(surface.id) ||
          !manifest.surfaces.some((item) => item.id === surface.id) ||
          typeof surface.createView !== "function" ||
          typeof surface.validateRestore !== "function"
        )
          throw new Error("Invalid contribution implementation");
        contributions.set(surface.id, { ...surface });
      }
      if (contributions.size !== manifest.surfaces.length)
        throw new Error("Missing contribution implementation");
      function implementations<T extends { readonly id: string }>(
        descriptors: readonly TextContributionDescriptor[],
        supplied: readonly T[],
        method: keyof T,
      ): Map<string, T> {
        const result = new Map<string, T>();
        for (const implementation of supplied) {
          if (
            result.has(implementation.id) ||
            !descriptors.some((item) => item.id === implementation.id) ||
            typeof implementation[method] !== "function"
          )
            throw new Error("Invalid text contribution implementation");
          result.set(implementation.id, { ...implementation });
        }
        if (result.size !== descriptors.length)
          throw new Error("Missing text contribution implementation");
        return result;
      }
      const composerContexts = implementations(
        manifest.composerContexts ?? [],
        extension.composerContexts ?? [],
        "select",
      );
      const messageDecorations = implementations(
        manifest.messageDecorations ?? [],
        extension.messageDecorations ?? [],
        "decorate",
      );
      const registration = {
        manifest,
        contributions,
        composerContexts,
        messageDecorations,
        enabled: true,
      };
      registrations.set(manifest.id, registration);
      return () => {
        if (registrations.get(manifest.id) !== registration) return;
        disable(manifest.id);
        registrations.delete(manifest.id);
      };
    },
    descriptors() {
      return [...registrations.values()]
        .filter((r) => r.enabled)
        .flatMap((r) => copyJson(r.manifest.surfaces));
    },
    contextDescriptors(client: string) {
      return [...registrations.values()]
        .filter((item) => item.enabled)
        .flatMap((item) =>
          copyJson(item.manifest.composerContexts ?? []).filter((descriptor) =>
            descriptor.clients.includes(client),
          ),
        );
    },
    captureContext(id: string, context: ViewContext) {
      if (disposed) throw new Error("Host disposed");
      const safeContext = validateContext(context);
      const registration = [...registrations.values()].find(
        (item) => item.enabled && item.composerContexts.has(id),
      );
      const descriptor = registration?.manifest.composerContexts?.find((item) => item.id === id);
      if (!registration || !descriptor?.clients.includes(context.client))
        throw new Error("Context contribution unavailable");
      const content = validateContextContent(
        registration.composerContexts.get(id)!.select(copyJson(safeContext)),
      );
      return validateContextSnapshot({
        ...content,
        version: 1,
        id: createContextSnapshotId(),
        contributionId: id,
        extensionVersion: registration.manifest.version,
        capturedAt: new Date().toISOString(),
        origin: safeContext.resource,
      });
    },
    messageDecorationCount(client?: string) {
      return [...registrations.values()]
        .filter((item) => item.enabled)
        .reduce(
          (count, item) =>
            count +
            (item.manifest.messageDecorations ?? []).filter(
              (descriptor) => client === undefined || descriptor.clients.includes(client),
            ).length,
          0,
        );
    },
    decorateMessage(
      message: MessageContext,
      client: string,
      limits: { maxCards?: number; maxContributions?: number } = {},
    ): readonly MessageCard[] {
      if (disposed) return [];
      let safeMessage: MessageContext;
      try {
        safeMessage = copyJson(message, 256 * 1024);
        if (
          [safeMessage.environmentId, safeMessage.threadId, safeMessage.messageId].some(
            (id) => typeof id !== "string" || !id,
          ) ||
          typeof safeMessage.text !== "string"
        )
          return [];
      } catch {
        return [];
      }
      const cards: MessageCard[] = [];
      const cardLimit =
        Number.isSafeInteger(limits.maxCards) && limits.maxCards! >= 0
          ? Math.min(limits.maxCards!, 4)
          : 4;
      let remaining =
        Number.isSafeInteger(limits.maxContributions) && limits.maxContributions! >= 0
          ? Math.min(limits.maxContributions!, 16)
          : 16;
      for (const registration of registrations.values()) {
        if (!registration.enabled) continue;
        for (const descriptor of registration.manifest.messageDecorations ?? []) {
          if (!descriptor.clients.includes(client)) continue;
          if (cards.length >= cardLimit || remaining <= 0) return cards;
          remaining -= 1;
          try {
            const content = registration.messageDecorations
              .get(descriptor.id)!
              .decorate(copyJson(safeMessage, 256 * 1024));
            if (content)
              cards.push({ ...validateContextContent(content), contributionId: descriptor.id });
          } catch {
            /* The original message remains the fallback for a failed decoration. */
          }
        }
      }
      return cards;
    },
    open,
    restore(record: ViewRecord) {
      return open(record, true);
    },
    getSnapshot,
    snapshot(id: string) {
      return copySnapshot(required(id).snapshot);
    },
    records() {
      return [...entries.values()].map((entry) => copyJson(entry.snapshot.record));
    },
    renderer(id: string): Renderer | undefined {
      return required(id).controller?.renderer;
    },
    subscribe(listener: (view: ViewSnapshot | null, id: string) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async updateContext(id: string, context: ViewContext) {
      const entry = required(id);
      const copied = validateContext(context);
      // A context switch starts a new view session, never retargets an existing service call.
      const changedResource =
        resourceKey(copied.resource) !== resourceKey(entry.snapshot.record.context.resource);
      entry.snapshot = {
        ...entry.snapshot,
        record: validateRecord({
          ...entry.snapshot.record,
          context: copied,
          restoreState: changedResource ? null : entry.snapshot.record.restoreState,
        }),
      };
      if (entry.snapshot.status === "hidden") {
        stop(entry);
        const { tab: _tab, ...untabbed } = entry.snapshot;
        entry.snapshot = {
          ...untabbed,
          generation: entry.snapshot.generation + 1,
          state: null,
        };
        emit(entry, id);
      } else await start(entry, !changedResource);
    },
    hide(id: string) {
      const entry = required(id);
      if (entry.snapshot.status === "hidden") return;
      entry.activity.abort();
      setStatus(entry, "hidden");
      for (const listener of entry.visibility) {
        try {
          listener(false);
        } catch (error) {
          fail(id, error);
          break;
        }
      }
    },
    async show(id: string) {
      const entry = required(id);
      if (entry.snapshot.status === "hidden" && !entry.abort.signal.aborted) {
        entry.activity = new AbortController();
        setStatus(entry, entry.controller ? "ready" : "loading");
        for (const listener of entry.visibility) {
          try {
            listener(true);
          } catch (error) {
            fail(id, error);
            break;
          }
        }
      } else if (entry.snapshot.status !== "ready" && entry.snapshot.status !== "loading")
        await start(entry, true);
    },
    /**
     * Navigates a live view in place: its listeners receive `restoreState`
     * and it keeps its session and saved state, which it updates itself. A
     * view without one restarts from `restoreState`.
     */
    async navigate(id: string, restoreState: Json) {
      const entry = required(id);
      const record = validateRecord({ ...entry.snapshot.record, restoreState });
      const contribution = entry.registration?.contributions.get(record.surfaceId);
      if (
        !entry.controller ||
        entry.navigation.size === 0 ||
        !contribution?.validateRestore(copyJson(record.restoreState))
      ) {
        entry.snapshot = { ...entry.snapshot, record };
        await start(entry, false);
        return;
      }
      for (const listener of entry.navigation) {
        try {
          listener(copyJson(record.restoreState));
        } catch (error) {
          fail(id, error);
          break;
        }
      }
    },
    move(id: string, placement: Placement) {
      const entry = required(id);
      if (!entry.descriptor?.placements.includes(placement))
        throw new Error("Unsupported placement");
      entry.snapshot = {
        ...entry.snapshot,
        record: validateRecord({ ...entry.snapshot.record, placement }),
      };
      emit(entry, id);
    },
    close,
    disable,
    enable(extensionId: string) {
      const registration = registrations.get(extensionId);
      if (!registration) throw new Error("Unknown extension");
      registration.enabled = true;
    },
    /** React error boundaries and equivalent native adapters report render failures here. */
    fail,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of entries.keys()) close(id);
      registrations.clear();
      listeners.clear();
    },
    diagnostics() {
      return {
        views: entries.size,
        registrations: registrations.size,
        listeners: listeners.size,
        pendingCalls: [...entries.values()].reduce((sum, e) => sum + e.pending, 0),
      };
    },
  };
}
export type ExtensionHost<R> = ReturnType<typeof createExtensionHost<R>>;
