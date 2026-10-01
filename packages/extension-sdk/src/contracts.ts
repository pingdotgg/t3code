import type { TextContributionDescriptor } from "./context.js";
/** Serializable descriptors. No renderer, credentials, or app store crosses this boundary. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export type Placement = "side-panel" | "bottom-dock" | "full-page" | "compact-detail";
export interface ResourceRef {
  readonly namespace: string;
  readonly id: string;
  readonly environmentId: string;
  readonly projectId?: string;
  readonly threadId?: string;
}
export interface ViewContext {
  readonly resource: ResourceRef;
  readonly workspaceRevision?: string;
  readonly client: string;
}
export interface SurfaceDescriptor {
  readonly id: string;
  readonly title: string;
  readonly placements: readonly Placement[];
  readonly clients: readonly string[];
  readonly scope: "environment" | "project" | "thread";
  readonly capabilities: readonly string[];
  /**
   * Declares that the surface captures terminal input. The host then marks the
   * surface's frame as extension-owned terminal focus so its capture-phase
   * keybinding dispatch stops routing focused-terminal commands (split, new,
   * close) at native terminal surfaces while this view is focused.
   */
  readonly claimsTerminalFocus?: boolean;
  readonly stateVersion: number;
}
export interface ExtensionManifest {
  readonly id: string;
  readonly apiVersion: 1;
  readonly version: string;
  readonly surfaces: readonly SurfaceDescriptor[];
  readonly composerContexts?: readonly TextContributionDescriptor[];
  readonly messageDecorations?: readonly TextContributionDescriptor[];
}
export interface ViewRecord {
  readonly version: 1;
  readonly surfaceId: string;
  readonly context: ViewContext;
  readonly placement: Placement;
  readonly stateVersion: number;
  readonly restoreState: Json;
  readonly fallback: string;
}
export const API_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export function assertId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/.test(value) ||
    value.length > 160
  )
    throw new Error("Expected namespaced identity (publisher.extension[/contribution])");
}
export function copyJson<T>(value: T, maxBytes = MAX_PAYLOAD_BYTES): T {
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 32) throw new Error("Payload nesting exceeds limit");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || seen.has(item))
      throw new Error("Expected finite, acyclic JSON data");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error("Expected plain JSON object");
    seen.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  const encodedBytes = new TextEncoder().encode(encoded).length;
  if (encodedBytes > maxBytes) {
    // Only computed on failure: report the largest string leaf by dotted path
    // so the caller can see which field blew the envelope.
    let largest: { readonly path: string; readonly bytes: number } | undefined;
    const findLargest = (item: unknown, path: string): void => {
      if (typeof item === "string") {
        const bytes = new TextEncoder().encode(item).length;
        if (!largest || bytes > largest.bytes) largest = { path, bytes };
        return;
      }
      if (Array.isArray(item)) item.forEach((child, i) => findLargest(child, `${path}[${i}]`));
      else if (item && typeof item === "object")
        for (const [key, child] of Object.entries(item))
          findLargest(child, path ? `${path}.${key}` : key);
    };
    findLargest(value, "");
    throw new Error(
      `Payload exceeds byte limit (${encodedBytes} bytes > ${maxBytes}-byte envelope)` +
        (largest
          ? `; largest field "${largest.path || "(root)"}" is ${largest.bytes} UTF-8 bytes`
          : ""),
    );
  }
  return JSON.parse(encoded) as T;
}
export function validateContext(value: ViewContext): ViewContext {
  const context = copyJson(value);
  assertId(context.resource.namespace);
  for (const part of [context.resource.id, context.resource.environmentId, context.client])
    if (typeof part !== "string" || !part || part.length > 1024)
      throw new Error("Invalid context identity");
  for (const part of [
    context.resource.projectId,
    context.resource.threadId,
    context.workspaceRevision,
  ])
    if (part !== undefined && (typeof part !== "string" || !part || part.length > 1024))
      throw new Error("Invalid optional context identity");
  if (context.resource.threadId && !context.resource.projectId)
    throw new Error("Thread requires project scope");
  return context;
}
export function resourceKey(resource: ResourceRef): string {
  return JSON.stringify([
    resource.namespace,
    resource.environmentId,
    resource.projectId ?? null,
    resource.threadId ?? null,
    resource.id,
  ]);
}
export function validateManifest(value: ExtensionManifest): ExtensionManifest {
  const manifest = copyJson(value);
  assertId(manifest.id);
  if (
    manifest.id.includes("/") ||
    manifest.apiVersion !== API_VERSION ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:[+][a-zA-Z0-9.-]+)?$/.test(manifest.version)
  )
    throw new Error("Incompatible extension manifest");
  if (!Array.isArray(manifest.surfaces) || manifest.surfaces.length > 64)
    throw new Error("Invalid surfaces");
  const ids = new Set<string>();
  for (const surface of manifest.surfaces) {
    assertId(surface.id);
    if (!surface.id.startsWith(manifest.id + "/") || ids.has(surface.id))
      throw new Error("Duplicate or foreign contribution");
    ids.add(surface.id);
    if (
      typeof surface.title !== "string" ||
      !surface.title ||
      surface.title.length > 200 ||
      !Number.isSafeInteger(surface.stateVersion) ||
      surface.stateVersion < 1
    )
      throw new Error("Invalid surface metadata");
    if (!["environment", "project", "thread"].includes(surface.scope))
      throw new Error("Invalid scope");
    if (
      !Array.isArray(surface.placements) ||
      !surface.placements.length ||
      surface.placements.some(
        (p: unknown) =>
          !["side-panel", "bottom-dock", "full-page", "compact-detail"].includes(p as string),
      )
    )
      throw new Error("Invalid placement");
    if (
      !Array.isArray(surface.clients) ||
      !surface.clients.length ||
      surface.clients.some((c: unknown) => typeof c !== "string" || !c)
    )
      throw new Error("Invalid clients");
    if (!Array.isArray(surface.capabilities)) throw new Error("Invalid capabilities");
    surface.capabilities.forEach(assertId);
    if (
      surface.claimsTerminalFocus !== undefined &&
      typeof surface.claimsTerminalFocus !== "boolean"
    )
      throw new Error("Invalid terminal focus claim");
  }
  for (const descriptors of [manifest.composerContexts ?? [], manifest.messageDecorations ?? []]) {
    if (!Array.isArray(descriptors) || descriptors.length > 16)
      throw new Error("Invalid text contributions");
    for (const descriptor of descriptors) {
      assertId(descriptor.id);
      if (!descriptor.id.startsWith(manifest.id + "/") || ids.has(descriptor.id))
        throw new Error("Duplicate or foreign contribution");
      ids.add(descriptor.id);
      if (
        typeof descriptor.title !== "string" ||
        !descriptor.title.trim() ||
        descriptor.title.length > 200 ||
        !Array.isArray(descriptor.clients) ||
        !descriptor.clients.length ||
        descriptor.clients.some(
          (client: unknown) => typeof client !== "string" || !client || client.length > 100,
        )
      )
        throw new Error("Invalid text contribution metadata");
    }
  }
  return manifest;
}
