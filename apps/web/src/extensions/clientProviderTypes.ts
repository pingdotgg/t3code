import type { ClientProviderCaller, ClientProviderEmitEvent } from "@t3tools/contracts";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { InstalledPackage } from "./installedController";

/**
 * One `invoke` frame delivered to a local `t3.client/*` provider. The seam
 * already verified socket ownership; `caller`/`context` are broker-forwarded
 * identities the provider re-checks against locally known grants.
 */
export interface ClientProviderInvokeCall {
  readonly method: string;
  readonly input: Json;
  readonly context: ViewContext;
  readonly caller: ClientProviderCaller;
  readonly signal: AbortSignal;
}

/**
 * One `subscriptionOpen` frame. `emit` is pre-bound to the frame's
 * `subscriptionId`; providers never mint correlation ids themselves.
 */
export interface ClientProviderStreamCall {
  readonly name: string;
  readonly input: Json;
  readonly context: ViewContext;
  readonly caller: ClientProviderCaller;
  readonly emit: (event: ClientProviderEmitEvent) => void;
}

/** A host-owned `t3.client/*` provider implementation. */
export interface ClientLocalProvider {
  invoke(call: ClientProviderInvokeCall): Json | Promise<Json>;
  openStream?(call: ClientProviderStreamCall): (() => void) | Promise<() => void>;
}

/** Error shape mirrored back through `respond` as `{ok:false}`. */
export class ClientProviderOpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function readInputObject(input: Json): Record<string, Json> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new ClientProviderOpError("provider-rejected", "Expected an object input");
  return input as Record<string, Json>;
}

export function readInputString(
  input: Record<string, Json>,
  key: string,
  required = true,
): string | undefined {
  const value = input[key];
  if (value === undefined) {
    if (required) throw new ClientProviderOpError("provider-rejected", `Missing ${key}`);
    return undefined;
  }
  if (typeof value !== "string" || !value)
    throw new ClientProviderOpError("provider-rejected", `Invalid ${key}`);
  return value;
}

/** What a provider needs to re-authorize a broker-forwarded caller locally. */
export interface ClientProviderAuthDeps {
  readonly environmentId: string;
  readonly installations: () => readonly InstalledPackage[] | undefined;
}

/**
 * The provider re-checks the broker-forwarded caller + context against the
 * installation's locally known grants: the server authenticates the caller,
 * but the client owns the final grant decision for client-local state.
 */
export function authorizeCaller(
  deps: ClientProviderAuthDeps,
  caller: ClientProviderCaller,
  context: ViewContext,
  grants: readonly string[],
): InstalledPackage {
  const installation = deps.installations()?.find((item) => item.id === caller.installationId);
  if (!installation || installation.contentHash !== caller.contentHash)
    throw new ClientProviderOpError("client-target-denied", "Unknown or stale caller");
  for (const grant of grants) {
    if (!installation.grants.capabilities.includes(grant))
      throw new ClientProviderOpError("client-target-denied", `Missing grant ${grant}`);
  }
  if (context.resource.environmentId !== deps.environmentId)
    throw new ClientProviderOpError("client-target-denied", "Foreign environment context");
  const projectId = context.resource.projectId;
  if (projectId !== undefined && !installation.grants.projectIds.some((id) => id === projectId))
    throw new ClientProviderOpError("client-target-denied", "Context outside granted scope");
  return installation;
}
