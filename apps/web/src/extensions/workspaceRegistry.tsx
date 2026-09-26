import type {
  MessageCard,
  MessageContext,
  TextContributionDescriptor,
} from "@t3tools/extension-sdk/context";
import {
  validateManifest,
  type ViewContext,
  type ViewRecord,
} from "@t3tools/extension-sdk/contracts";
import { createExtensionHost, type Extension, type HostOptions } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";
import { useCallback, useSyncExternalStore } from "react";
import { createNativeSurfaceBridge } from "./nativeBridge";

type Registration = {
  environmentId: string | undefined;
  extension: Extension<SurfaceRenderer>;
  bridge: ReturnType<typeof createNativeSurfaceBridge<null>>;
  host: ReturnType<typeof createExtensionHost<SurfaceRenderer>>;
};
const registrations = new Map<string, Registration>();
const listeners = new Set<() => void>();
let textRevision = 0;
let titlesByEnvironment = new Map<string, ReadonlyMap<string, string>>();
let contextsByEnvironment = new Map<string, readonly TextContributionDescriptor[]>();
const EMPTY_TITLES: ReadonlyMap<string, string> = new Map();
const EMPTY_CONTEXTS: readonly TextContributionDescriptor[] = [];
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const scoped = (environmentId?: string) => {
  const winners = new Map<string, Registration>();
  for (const entry of registrations.values())
    if (entry.environmentId === undefined) winners.set(entry.extension.manifest.id, entry);
  if (environmentId !== undefined)
    for (const entry of registrations.values())
      if (entry.environmentId === environmentId) winners.set(entry.extension.manifest.id, entry);
  return [...winners.values()];
};
function notify() {
  textRevision++;
  const scopes = new Set([
    "",
    ...[...registrations.values()].map((entry) => entry.environmentId ?? ""),
  ]);
  const titles = new Map<string, ReadonlyMap<string, string>>();
  const contexts = new Map<string, readonly TextContributionDescriptor[]>();
  for (const scope of scopes) {
    const entries = scoped(scope || undefined);
    titles.set(
      scope,
      new Map(
        entries.flatMap((entry) =>
          entry.extension.manifest.surfaces.map((surface) => [surface.id, surface.title] as const),
        ),
      ),
    );
    contexts.set(scope, [
      ...new Map(
        entries
          .flatMap((entry) => [
            ...entry.host.contextDescriptors("web"),
            ...entry.host.contextDescriptors("desktop"),
          ])
          .map((item) => [item.id, item]),
      ).values(),
    ]);
  }
  titlesByEnvironment = titles;
  contextsByEnvironment = contexts;
  for (const listener of listeners) listener();
}

/** Trusted bootstrap remains global; installed packages register for exactly one authenticated environment. */
export function registerWorkspaceExtension(
  extension: Extension<SurfaceRenderer>,
  hostOptions: HostOptions = { authorize: () => false },
  scope?: { readonly environmentId: string },
) {
  extension = {
    ...extension,
    manifest: validateManifest(extension.manifest),
    surfaces: extension.surfaces.map((surface) => ({ ...surface })),
  };
  const key = JSON.stringify([scope?.environmentId, extension.manifest.id]);
  if (registrations.has(key)) throw new Error("Extension already registered");
  const peers = [...registrations.values()].filter(
    (entry) => entry.environmentId === scope?.environmentId,
  );
  if (peers.length >= 64) throw new Error("Workspace extension limit reached");
  if (
    peers.some((entry) =>
      entry.extension.manifest.surfaces.some((surface) =>
        extension.manifest.surfaces.some((candidate) => candidate.id === surface.id),
      ),
    )
  )
    throw new Error("Surface already registered");
  const host = createExtensionHost<SurfaceRenderer>(hostOptions);
  host.register(extension);
  const entry: Registration = {
    environmentId: scope?.environmentId,
    extension,
    host,
    bridge: createNativeSurfaceBridge<null>(() => extension, hostOptions),
  };
  registrations.set(key, entry);
  notify();
  return () => {
    if (registrations.get(key) !== entry) return;
    registrations.delete(key);
    host.dispose();
    notify();
  };
}
/** Resolve only the selected installed owner, without substituting a global first-party surface. */
export function installedSurfaceDescriptor(
  environmentId: string,
  extensionId: string,
  surfaceId: string,
) {
  return registrations
    .get(JSON.stringify([environmentId, extensionId]))
    ?.extension.manifest.surfaces.find((surface) => surface.id === surfaceId);
}
export function useWorkspaceSurfaceTitles(environmentId?: string) {
  const get = useCallback(
    () =>
      titlesByEnvironment.get(environmentId ?? "") ?? titlesByEnvironment.get("") ?? EMPTY_TITLES,
    [environmentId],
  );
  return useSyncExternalStore(subscribe, get, get);
}
export function workspaceSurfaceTitle(surfaceId: string, fallback: string, environmentId?: string) {
  return (
    (titlesByEnvironment.get(environmentId ?? "") ?? titlesByEnvironment.get(""))?.get(surfaceId) ??
    fallback
  );
}
export function WorkspaceExtensionSurface(props: {
  readonly record: ViewRecord;
  readonly visible: boolean;
  readonly onRecordChange?: (record: ViewRecord) => void;
}) {
  const get = useCallback(
    () =>
      scoped(props.record.context.resource.environmentId)
        .reverse()
        .find((entry) =>
          entry.extension.manifest.surfaces.some(
            (surface) => surface.id === props.record.surfaceId,
          ),
        )?.bridge ?? null,
    [props.record.surfaceId, props.record.context.resource.environmentId],
  );
  const bridge = useSyncExternalStore(subscribe, get, get);
  return bridge ? (
    <bridge.Surface
      record={props.record}
      visible={props.visible}
      bindings={null}
      {...(props.onRecordChange ? { onRecordChange: props.onRecordChange } : {})}
      retainHiddenPresentation
    />
  ) : (
    <div role="status">{props.record.fallback}</div>
  );
}
export function useWorkspaceContextDescriptors(environmentId?: string) {
  const get = useCallback(
    () =>
      contextsByEnvironment.get(environmentId ?? "") ??
      contextsByEnvironment.get("") ??
      EMPTY_CONTEXTS,
    [environmentId],
  );
  return useSyncExternalStore(subscribe, get, get);
}
export function captureWorkspaceContext(id: string, context: ViewContext) {
  const host = scoped(context.resource.environmentId)
    .reverse()
    .find((entry) =>
      entry.host.contextDescriptors(context.client).some((item) => item.id === id),
    )?.host;
  if (!host) throw new Error("Context contribution unavailable");
  return host.captureContext(id, context);
}
const getTextRevision = () => textRevision;
export function useWorkspaceTextRevision() {
  return useSyncExternalStore(subscribe, getTextRevision, getTextRevision);
}
export function decorateWorkspaceMessage(
  message: MessageContext,
  client: string,
  revision: number,
) {
  if (revision !== textRevision) return [];
  const cards: MessageCard[] = [];
  let remaining = 16;
  for (const { host } of scoped(message.environmentId)) {
    if (cards.length >= 4 || remaining <= 0) break;
    const count = host.messageDecorationCount(client);
    if (!count) continue;
    cards.push(
      ...host.decorateMessage(message, client, {
        maxCards: 4 - cards.length,
        maxContributions: remaining,
      }),
    );
    remaining -= Math.min(remaining, count);
  }
  return cards;
}
export function workspaceHasMessageDecorations() {
  return [...registrations.values()].some((entry) => entry.host.messageDecorationCount() > 0);
}
/** Reactivity must be observed even when a compiled row mounted before registration. */
export function useWorkspaceHasMessageDecorations() {
  return useSyncExternalStore(
    subscribe,
    workspaceHasMessageDecorations,
    workspaceHasMessageDecorations,
  );
}
