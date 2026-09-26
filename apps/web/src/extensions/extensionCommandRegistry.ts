import { isElectron } from "../env";
import {
  extensionCommandForPlugin,
  extensionCommandName,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  GlobalCommandDescriptor,
  GlobalCommandHandler,
} from "@t3tools/extension-sdk/environment";
import type { ViewCommandHandler } from "@t3tools/extension-sdk/host";
import {
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
} from "@t3tools/shared/keybindings";
import type {
  KeybindingShortcut,
  KeybindingWhenNode,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  matchesShortcut,
  matchesWhenClause,
  resolveShortcutCommand,
  shortcutConflictKey,
  type ShortcutEventLike,
  type ShortcutMatchContext,
} from "../keybindings";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { installedSurfaceRecord, installedWorkspaceContext } from "./installedContext";
import { randomUUID } from "../lib/utils";
import {
  extensionPanelSurface,
  selectThreadExtensionDock,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { readProject, readThreadShell } from "../state/entities";
import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  authorizeCaller,
  ClientProviderOpError,
  readInputObject,
  readInputString,
  type ClientLocalProvider,
  type ClientProviderAuthDeps,
  type ClientProviderInvokeCall,
} from "./clientProviderTypes";

export interface ExtensionCommandDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly defaultKey?: string;
  readonly when?: string;
  readonly scope: "surface" | "thread" | "global";
  readonly activation?: {
    readonly surfaceId: string;
    readonly placement: "side-panel" | "bottom-dock";
  };
}

interface CompiledCommand extends ExtensionCommandDescriptor {
  readonly whenAst: KeybindingWhenNode | null;
  readonly defaultShortcut: KeybindingShortcut | null;
}

interface CommandRegistration {
  readonly token: string;
  readonly environmentId: string;
  readonly installationId: string;
  readonly installationGeneration: number;
  /**
   * The client-side liveness generation at register time — the server-minted
   * `installationGeneration` is not observable from the client, so binding
   * staleness compares this against `deps.installationGeneration` instead.
   */
  readonly clientGeneration: number | null;
  readonly context: ViewContext;
  readonly contextKey: string;
  readonly commandSetHash: string;
  readonly commands: readonly CompiledCommand[];
  /** The raw descriptors, retained so a reconnect can replay the same set. */
  readonly rawCommands: readonly ExtensionCommandDescriptor[];
  readonly installationScoped: boolean;
  /**
   * The client-provider connection epoch this registration was committed
   * under. A reconnect bumps the epoch; the set stays fenced until the flush
   * replays it (the idempotent path refreshes this field).
   */
  readonly connectionEpoch: number;
  readonly handler?: GlobalCommandHandler;
}

interface CommandBinding {
  readonly bindingId: string;
  readonly token: string;
  readonly environmentId: string;
  readonly installationId: string;
  readonly hostKey: string;
  readonly viewId: string;
  readonly context: ViewContext;
  readonly handler: ViewCommandHandler;
}

export interface CommandRegistrationResult {
  readonly commandId: string;
  readonly status: "registered" | "rejected";
  readonly reason?: string;
}

export interface ExtensionCommandEnvironmentDeps {
  /** Current generation for an installation id, or null when uninstalled/ineligible. */
  readonly installationGeneration: (installationId: string) => number | null;
  /** Manifest surfaces for an installation id (for activation eligibility checks). */
  readonly installationSurfaces: (installationId: string) =>
    | readonly {
        readonly id: string;
        readonly title: string;
        readonly placements: readonly string[];
        readonly clients: readonly string[];
        readonly scope: string;
        readonly stateVersion: number;
      }[]
    | null;
  /** The installation's granted project ids — activation requires an eligible thread. */
  readonly installationGrants: (installationId: string) => readonly string[] | null;
  /** The client tag surfaces declare (`"web" | "desktop"`). */
  readonly client: string;
  /**
   * The resolved user/native keybinding config — `listConflicts` reports who
   * actually claims a plugin's `defaultKey` through the real resolution order.
   */
  readonly keybindings?: () => ResolvedKeybindingsConfig;
}

/** A staged `ClientHost.registerGlobalCommands` entry awaiting its commit flush. */
export interface StagedGlobalCommands {
  readonly commands: readonly GlobalCommandDescriptor[];
  readonly handler?: GlobalCommandHandler;
  readonly listeners: Set<() => void>;
  status: "staged" | "active" | "rejected";
  token?: string | undefined;
  rejections?: readonly { commandId: string; reason: string }[] | undefined;
}

const registrations = new Map<string, CommandRegistration>();
const bindings = new Map<string, CommandBinding>();
const staged = new Map<string, StagedGlobalCommands[]>();
const environmentDeps = new Map<string, ExtensionCommandEnvironmentDeps>();
/**
 * Per-environment seam liveness: `epoch` bumps on every `registered` frame,
 * `live` tracks whether a connection is currently established. Environments
 * that never connected (tests, pre-seam callers) have no entry and are live.
 */
const connectionFences = new Map<string, { epoch: number; live: boolean }>();
const paletteListeners = new Set<() => void>();
let paletteRevision = 0;
let activeThreadRef: ScopedThreadRef | null = null;
let bindingSerial = 0;

const stagedKey = (environmentId: string, installationId: string) =>
  `${environmentId}${installationId}`;

function notifyPalette() {
  paletteRevision++;
  for (const listener of paletteListeners) listener();
}

export function subscribeExtensionCommands(listener: () => void): () => void {
  paletteListeners.add(listener);
  // Focus moves change tier-1/2 eligibility without touching the registry —
  // invalidate on the next microtask (after activeElement settles) so a
  // palette opened mid-focus-shift still arbitrates the live focus state.
  const onFocusChange = () => queueMicrotask(notifyPalette);
  if (typeof document !== "undefined") {
    document.addEventListener("focusin", onFocusChange);
    document.addEventListener("focusout", onFocusChange);
  }
  return () => {
    paletteListeners.delete(listener);
    if (typeof document !== "undefined") {
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
    }
  };
}

export function extensionCommandRevision(): number {
  return paletteRevision;
}

export function setActiveExtensionThreadRef(ref: ScopedThreadRef | null): void {
  activeThreadRef = ref;
  notifyPalette();
}

/**
 * Client-provider seam lifecycle for command fencing. `connected` opens a new
 * epoch: every prior registration stays disabled until the flush replays it
 * through `registerCommands` (which mints the new epoch). `disconnected`
 * fences everything immediately — no stale dispatch on a dead socket.
 */
export function noteClientProviderConnection(environmentId: string, connected: boolean): void {
  const current = connectionFences.get(environmentId);
  if (connected) {
    connectionFences.set(environmentId, { epoch: (current?.epoch ?? 0) + 1, live: true });
  } else {
    connectionFences.set(environmentId, { epoch: current?.epoch ?? 0, live: false });
  }
  notifyPalette();
}

const connectionEpochFor = (environmentId: string) =>
  connectionFences.get(environmentId)?.epoch ?? 0;

export function configureExtensionCommandEnvironment(
  environmentId: string,
  deps: ExtensionCommandEnvironmentDeps,
): void {
  environmentDeps.set(environmentId, deps);
}

export function unconfigureExtensionCommandEnvironment(environmentId: string): void {
  environmentDeps.delete(environmentId);
  connectionFences.delete(environmentId);
  for (const [token, registration] of registrations)
    if (registration.environmentId === environmentId) {
      registrations.delete(token);
      for (const [bindingId, binding] of bindings)
        if (binding.token === token) bindings.delete(bindingId);
    }
  for (const [bindingId, binding] of bindings)
    if (binding.environmentId === environmentId) bindings.delete(bindingId);
  for (const [key, entries] of staged)
    if (key.startsWith(environmentId + "")) {
      for (const entry of entries) {
        entry.status = "rejected";
        for (const listener of entry.listeners) listener();
      }
      staged.delete(key);
    }
  notifyPalette();
}

function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

/**
 * Context identity for registration/bind matching. `workspaceRevision` is a
 * freshness stamp recomputed on every invoke — a replayed registration or a
 * re-bind after reconnect carries a new revision for the SAME context, so it
 * must not participate in identity.
 */
function contextKeyFor(context: ViewContext): string {
  const { workspaceRevision: _revision, ...identity } = context;
  return canonicalJson(identity as unknown as Json);
}

const COMMAND_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/;

function compileCommand(command: ExtensionCommandDescriptor): CompiledCommand {
  return {
    ...command,
    whenAst: command.when ? parseKeybindingWhenExpression(command.when) : null,
    defaultShortcut: command.defaultKey ? parseKeybindingShortcut(command.defaultKey) : null,
  };
}

/**
 * `t3.client/keybindings.registerCommands` implementation. Idempotent on
 * `{installationId, installationGeneration, context, commandSetHash}` — a
 * remount or reconnect replay of the same set returns the live token.
 */
export function registerCommands(input: {
  readonly environmentId: string;
  readonly installationId: string;
  readonly installationGeneration: number;
  readonly context: ViewContext;
  readonly commands: readonly ExtensionCommandDescriptor[];
  /** The calling installation's granted capabilities — global/activation scopes need extra grants. */
  readonly capabilities: readonly string[];
  readonly installationScoped?: boolean;
  readonly handler?: GlobalCommandHandler;
}): { commandSetToken: string; results: CommandRegistrationResult[] } {
  const deps = environmentDeps.get(input.environmentId);
  const results: CommandRegistrationResult[] = [];
  const accepted: ExtensionCommandDescriptor[] = [];
  const surfaces = deps?.installationSurfaces(input.installationId) ?? null;
  for (const command of input.commands) {
    const reject = (reason: string) =>
      results.push({ commandId: command.id, status: "rejected", reason });
    if (
      typeof command.id !== "string" ||
      !COMMAND_ID_PATTERN.test(command.id) ||
      command.id.length > 80
    ) {
      reject("invalid command id");
      continue;
    }
    if (typeof command.title !== "string" || !command.title.trim() || command.title.length > 200) {
      reject("invalid title");
      continue;
    }
    if (command.scope !== "surface" && command.scope !== "thread" && command.scope !== "global") {
      reject("invalid scope");
      continue;
    }
    if (command.scope === "global" && !input.capabilities.includes("t3.ui/keybindings.global")) {
      reject("missing grant t3.ui/keybindings.global");
      continue;
    }
    if (command.when && parseKeybindingWhenExpression(command.when) === null) {
      reject("invalid when expression");
      continue;
    }
    if (command.defaultKey && parseKeybindingShortcut(command.defaultKey) === null) {
      reject("invalid default key");
      continue;
    }
    if (command.activation !== undefined) {
      if (command.scope !== "global" || input.installationScoped !== true) {
        reject("activation requires an installation-scoped global command");
        continue;
      }
      if (!input.capabilities.includes("t3.ui/panels")) {
        reject("missing grant t3.ui/panels");
        continue;
      }
      const surface = surfaces?.find((candidate) => candidate.id === command.activation!.surfaceId);
      if (!surface || !surface.placements.includes(command.activation.placement)) {
        reject("activation names no own surface and declared placement");
        continue;
      }
    }
    accepted.push(command);
    results.push({ commandId: command.id, status: "registered" });
  }
  const contextKey = contextKeyFor(input.context);
  const commandSetHash = canonicalJson(input.commands as unknown as Json);
  for (const registration of registrations.values()) {
    if (
      registration.environmentId === input.environmentId &&
      registration.installationId === input.installationId &&
      registration.installationGeneration === input.installationGeneration &&
      registration.contextKey === contextKey &&
      registration.commandSetHash === commandSetHash
    ) {
      // Reconnect replay: the same set re-committed on a new connection
      // adopts the new epoch and becomes dispatchable again; the stored
      // context refreshes so its workspaceRevision is the live one. The
      // freshly validated `accepted` set replaces the compiled commands —
      // a replay under reduced capabilities drops what revalidation rejects.
      const commands = accepted.map(compileCommand);
      if (
        registration.connectionEpoch !== connectionEpochFor(input.environmentId) ||
        registration.context !== input.context ||
        registration.commands.length !== commands.length ||
        registration.installationScoped !== (input.installationScoped === true)
      ) {
        registrations.set(registration.token, {
          ...registration,
          context: input.context,
          commands,
          installationScoped: input.installationScoped === true,
          connectionEpoch: connectionEpochFor(input.environmentId),
        });
        notifyPalette();
      }
      return { commandSetToken: registration.token, results };
    }
  }
  const token = `cmdset-${randomUUID()}`;
  registrations.set(token, {
    token,
    environmentId: input.environmentId,
    installationId: input.installationId,
    installationGeneration: input.installationGeneration,
    clientGeneration: deps?.installationGeneration(input.installationId) ?? null,
    context: input.context,
    contextKey,
    commandSetHash,
    commands: accepted.map(compileCommand),
    rawCommands: input.commands,
    installationScoped: input.installationScoped === true,
    connectionEpoch: connectionEpochFor(input.environmentId),
    ...(input.handler ? { handler: input.handler } : {}),
  });
  notifyPalette();
  return { commandSetToken: token, results };
}

/**
 * Committed registrations in commit order, for connection-loss replay. The
 * flush re-invokes `registerCommands` for each through the real invokeApi
 * path — grants and context re-validate server-side on every replay.
 */
export function committedCommandRegistrations(environmentId: string): readonly {
  readonly installationId: string;
  readonly context: ViewContext;
  readonly commands: readonly ExtensionCommandDescriptor[];
}[] {
  return [...registrations.values()]
    .filter((registration) => registration.environmentId === environmentId)
    .map((registration) => ({
      installationId: registration.installationId,
      context: registration.context,
      commands: registration.rawCommands,
    }));
}

/**
 * Drops every registration, binding, and staged entry a dead installation
 * owned — a stopped factory's commands must never stay dispatchable.
 */
export function unregisterInstallationCommands(
  environmentId: string,
  installationId: string,
): void {
  let changed = false;
  for (const [token, registration] of registrations) {
    if (
      registration.environmentId !== environmentId ||
      registration.installationId !== installationId
    )
      continue;
    registrations.delete(token);
    for (const [bindingId, binding] of bindings)
      if (binding.token === token) bindings.delete(bindingId);
    changed = true;
  }
  const key = stagedKey(environmentId, installationId);
  const entries = staged.get(key);
  if (entries) {
    for (const entry of entries) {
      if (entry.status === "rejected") continue;
      entry.status = "rejected";
      for (const listener of entry.listeners) listener();
    }
    staged.delete(key);
    changed = true;
  }
  if (changed) notifyPalette();
}

export function unregisterCommands(
  environmentId: string,
  commandSetToken: string,
  installationId: string,
): boolean {
  const registration = registrations.get(commandSetToken);
  if (!registration || registration.environmentId !== environmentId) return false;
  // Owner-scoped like the notification seam: a token that is not the
  // caller's own removes nothing of theirs.
  if (registration.installationId !== installationId) return false;
  registrations.delete(commandSetToken);
  for (const [bindingId, binding] of bindings)
    if (binding.token === commandSetToken) bindings.delete(bindingId);
  notifyPalette();
  return true;
}

/**
 * `ViewSession.bindCommands` backing store. Validates token liveness, caller
 * identity + generation, and context equality; mints the `bindingId`.
 * Idempotent per (view-session, token).
 */
export function bindCommands(call: {
  readonly environmentId: string;
  readonly extensionId: string;
  readonly hostKey: string;
  readonly viewId: string;
  readonly context: ViewContext;
  readonly commandSetToken: string;
  readonly handler: ViewCommandHandler;
}): { bindingId: string; unbind: () => void } {
  const registration = registrations.get(call.commandSetToken);
  if (!registration || registration.environmentId !== call.environmentId)
    throw new ClientProviderOpError("binding-unknown", "Unknown command set token");
  if (registration.installationId !== call.extensionId)
    throw new ClientProviderOpError("binding-unknown", "Command set token belongs elsewhere");
  const current = environmentDeps.get(call.environmentId)?.installationGeneration(call.extensionId);
  if (current === null || current === undefined)
    throw new ClientProviderOpError("binding-unknown", "Installation is no longer available");
  if (current !== registration.clientGeneration)
    throw new ClientProviderOpError("binding-stale", "Command set predates the installation");
  if (registration.contextKey !== contextKeyFor(call.context))
    throw new ClientProviderOpError("binding-unknown", "Context does not match the registration");
  const existing = [...bindings.values()].find(
    (binding) =>
      binding.token === call.commandSetToken &&
      binding.hostKey === call.hostKey &&
      binding.viewId === call.viewId,
  );
  if (existing) {
    // A rebind after reconnect carries the refreshed context — the stored
    // binding follows it so dispatch hands the handler the live revision.
    if (existing.context !== call.context || existing.handler !== call.handler) {
      bindings.set(existing.bindingId, {
        ...existing,
        context: call.context,
        handler: call.handler,
      });
      notifyPalette();
    }
    return { bindingId: existing.bindingId, unbind: () => unbind(existing.bindingId) };
  }
  const bindingId = `binding-${++bindingSerial}-${randomUUID()}`;
  const binding: CommandBinding = {
    bindingId,
    token: call.commandSetToken,
    environmentId: call.environmentId,
    installationId: call.extensionId,
    hostKey: call.hostKey,
    viewId: call.viewId,
    context: call.context,
    handler: call.handler,
  };
  bindings.set(bindingId, binding);
  notifyPalette();
  return { bindingId, unbind: () => unbind(bindingId) };
}

function unbind(bindingId: string): void {
  if (bindings.delete(bindingId)) notifyPalette();
}

// ---------------------------------------------------------------------------
// Staged global command sets (ClientHost.registerGlobalCommands)

export function stageGlobalCommands(
  environmentId: string,
  installationId: string,
  commands: readonly GlobalCommandDescriptor[],
  handler: GlobalCommandHandler | undefined,
): StagedGlobalCommands {
  const entry: StagedGlobalCommands = {
    commands,
    ...(handler ? { handler } : {}),
    listeners: new Set(),
    status: "staged",
  };
  const key = stagedKey(environmentId, installationId);
  const entries = staged.get(key) ?? [];
  entries.push(entry);
  staged.set(key, entries);
  return entry;
}

/** Discards staged entries for a factory that never committed. */
export function discardStagedGlobalCommands(environmentId: string, installationId: string): void {
  const key = stagedKey(environmentId, installationId);
  const entries = staged.get(key);
  if (!entries) return;
  for (const entry of entries) {
    if (entry.status !== "staged") continue;
    entry.status = "rejected";
    for (const listener of entry.listeners) listener();
  }
  staged.set(
    key,
    entries.filter((entry) => entry.status !== "rejected"),
  );
}

export function stagedGlobalCommandsFor(
  environmentId: string,
  installationId: string,
): readonly StagedGlobalCommands[] {
  return staged.get(stagedKey(environmentId, installationId)) ?? [];
}

/**
 * Attaches a staged installation-level handler to a committed registration.
 * Handlers are local functions and cannot cross the provider seam, so the
 * flush commits `{commands}` over the wire and lands the handler here.
 */
export function attachRegistrationHandler(
  environmentId: string,
  commandSetToken: string,
  handler: GlobalCommandHandler,
): void {
  const registration = registrations.get(commandSetToken);
  if (!registration || registration.environmentId !== environmentId) return;
  registrations.set(commandSetToken, { ...registration, handler });
  notifyPalette();
}

// ---------------------------------------------------------------------------
// Dispatch

interface DispatchCommandSite {
  readonly registration: CommandRegistration;
  readonly command: CompiledCommand;
}

/**
 * A registration dispatches only while its installation generation is intact
 * AND — when a client-provider connection has ever been seen — the live seam
 * epoch it was committed under. Connection loss fences immediately; replay
 * re-commits under the new epoch.
 */
function registrationIsLive(registration: CommandRegistration): boolean {
  const deps = environmentDeps.get(registration.environmentId);
  if (!deps) return false;
  const generation = deps.installationGeneration(registration.installationId);
  if (generation === null || generation !== registration.clientGeneration) return false;
  const fence = connectionFences.get(registration.environmentId);
  if (fence !== undefined && (!fence.live || fence.epoch !== registration.connectionEpoch))
    return false;
  return true;
}

function commandSites(commandName: string): DispatchCommandSite[] {
  const sites: DispatchCommandSite[] = [];
  for (const registration of registrations.values()) {
    if (!registrationIsLive(registration)) continue;
    const commandId = extensionCommandForPlugin(commandName, registration.installationId);
    if (commandId === null) continue;
    const command = registration.commands.find((candidate) => candidate.id === commandId);
    if (command) sites.push({ registration, command });
  }
  return sites;
}

/** The `hostKey:viewId` pair of the mounted extension view containing focus. */
export function focusedExtensionViewKey(): string | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const marker = active.closest<HTMLElement>("[data-extension-view]");
  return marker?.dataset.extensionView ?? null;
}

/** The `surfaceId` of the mounted extension surface containing focus. */
export function focusedExtensionSurfaceId(): string | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const marker = active.closest<HTMLElement>("[data-extension-surface]");
  return marker?.dataset.extensionSurface ?? null;
}

function bindingViewKey(binding: CommandBinding): string {
  return `${binding.hostKey}:${binding.viewId}`;
}

function bindingThreadKey(binding: CommandBinding): string | null {
  const { environmentId, threadId } = binding.context.resource;
  return threadId ? `${environmentId}:${threadId}` : null;
}

function whenContext(surfaceId: string | null): ShortcutMatchContext {
  const context: ShortcutMatchContext = {
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
    "thread.active": activeThreadRef !== null,
  };
  if (surfaceId) context[`extension.${surfaceId}.focus`] = true;
  return context;
}

export type ExtensionCommandDispatch =
  | { readonly kind: "dispatched" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unavailable" };

/**
 * The dispatch-time context for an installation-level handler. With an active
 * thread in the registration's environment, rebuild the real workspace
 * context (fresh project + worktree revision) exactly like the panel
 * activation path; otherwise the registration's own context stands — it
 * carries the workspaceRevision the commit validated.
 */
function dispatchContextFor(registration: CommandRegistration): ViewContext {
  const thread = activeThreadRef;
  if (thread && thread.environmentId === registration.environmentId) {
    const shell = readThreadShell(thread);
    const project = shell?.projectId
      ? readProject(scopeProjectRef(thread.environmentId, shell.projectId))
      : undefined;
    if (shell?.projectId && project) {
      const base = installedWorkspaceContext({
        environmentId: thread.environmentId,
        projectId: shell.projectId,
        threadId: thread.threadId,
        projectWorkspaceRoot: project.workspaceRoot,
        threadWorktreePath: shell.worktreePath ?? null,
        client: registration.context.client,
      });
      return {
        ...base,
        resource: { ...base.resource, namespace: "t3.extensions", id: registration.installationId },
      };
    }
  }
  return registration.context;
}

/**
 * The side-effect-free half of activation resolution — the active thread must
 * exist, its project must be granted, and the named surface must support this
 * client and placement. Palette availability and dispatch share this so an
 * ineligible activation greys out instead of no-ops on selection.
 */
function activationEligible(site: DispatchCommandSite): boolean {
  const { registration, command } = site;
  const activation = command.activation;
  const deps = environmentDeps.get(registration.environmentId);
  const thread = activeThreadRef;
  if (!activation || !deps || !thread || thread.environmentId !== registration.environmentId)
    return false;
  const shell = readThreadShell(thread);
  const projectId = shell?.projectId;
  if (
    !projectId ||
    !(deps.installationGrants(registration.installationId) ?? []).includes(projectId)
  )
    return false;
  const surface = deps
    .installationSurfaces(registration.installationId)
    ?.find((candidate) => candidate.id === activation.surfaceId);
  if (
    !surface ||
    !surface.clients.includes(deps.client) ||
    !surface.placements.includes(activation.placement)
  )
    return false;
  return readProject(scopeProjectRef(thread.environmentId, projectId)) !== null;
}

/**
 * Resolves one extension surface open for the activation fallback, applying
 * the same eligibility filter the native extension menu applies.
 */
function openActivationSurface(site: DispatchCommandSite): boolean {
  const { registration, command } = site;
  const activation = command.activation;
  const deps = environmentDeps.get(registration.environmentId);
  const thread = activeThreadRef;
  if (!activation || !deps || !thread || !activationEligible(site)) return false;
  const shell = readThreadShell(thread);
  const projectId = shell?.projectId;
  if (!projectId) return false;
  const surface = deps
    .installationSurfaces(registration.installationId)
    ?.find((candidate) => candidate.id === activation.surfaceId);
  if (!surface) return false;
  const project = readProject(scopeProjectRef(thread.environmentId, projectId));
  if (!project) return false;
  const context = installedWorkspaceContext({
    environmentId: thread.environmentId,
    projectId,
    threadId: thread.threadId,
    projectWorkspaceRoot: project.workspaceRoot,
    threadWorktreePath: shell?.worktreePath ?? null,
    client: deps.client,
  });
  const record = installedSurfaceRecord(
    registration.installationId,
    {
      id: surface.id,
      title: surface.title,
      placements: surface.placements as readonly (
        | "side-panel"
        | "bottom-dock"
        | "full-page"
        | "compact-detail"
      )[],
      clients: surface.clients,
      scope: surface.scope as "environment" | "project" | "thread",
      capabilities: [],
      stateVersion: surface.stateVersion,
    },
    activation.placement,
    context,
  );
  const store = useRightPanelStore.getState();
  const requested = extensionPanelSurface(thread, record);
  if (!requested) return false;
  const layout =
    activation.placement === "bottom-dock"
      ? selectThreadExtensionDock(store.extensionDockByThreadKey, thread)
      : selectThreadRightPanelState(store.byThreadKey, thread);
  const existing = layout.surfaces.find((entry) => entry.id === requested.id);
  if (existing) {
    if (activation.placement === "bottom-dock") store.activateDockExtension(thread, existing.id);
    else store.activateSurface(thread, existing.id);
    return true;
  }
  return store.openExtension(thread, record);
}

/**
 * One arbitration for dispatch and palette: a side-effect-free resolution of
 * what a command would do right now. Tiers — focused view binding →
 * exactly-one thread-matching binding across ALL registration sets → the
 * installation handler in the active environment → cold activation.
 */
type CommandArbitration =
  | {
      readonly kind: "binding";
      readonly binding: CommandBinding;
      readonly command: CompiledCommand;
    }
  | { readonly kind: "handler"; readonly site: DispatchCommandSite }
  | { readonly kind: "activation"; readonly sites: readonly DispatchCommandSite[] }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unavailable" };

function arbitrateExtensionCommand(
  commandName: string,
  environmentId?: string,
): CommandArbitration {
  const sites = commandSites(commandName).filter(
    (site) => environmentId === undefined || site.registration.environmentId === environmentId,
  );
  if (sites.length === 0) return { kind: "unavailable" };
  const focusedView = focusedExtensionViewKey();
  const focusedSurface = focusedExtensionSurfaceId();
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const when = whenContext(focusedSurface);

  // (1) A focused view-session binding always wins, for any scope.
  const focused: { binding: CommandBinding; command: CompiledCommand }[] = [];
  for (const site of sites) {
    if (!matchesWhenClause(site.command.whenAst ?? undefined, when)) continue;
    for (const binding of bindings.values()) {
      if (binding.token !== site.registration.token) continue;
      if (bindingViewKey(binding) !== focusedView) continue;
      if (site.command.scope === "thread" && bindingThreadKey(binding) !== activeThreadKey)
        continue;
      focused.push({ binding, command: site.command });
    }
  }
  if (focused.length === 1) return { kind: "binding", ...focused[0]! };
  if (focused.length > 1) return { kind: "ambiguous" };

  // (2) Unfocused tiers apply to global commands only.
  const globalSites = sites.filter(
    (site) =>
      site.command.scope === "global" && matchesWhenClause(site.command.whenAst ?? undefined, when),
  );

  // Exactly one thread-matching binding aggregated across every registration
  // set — two sets each contributing a viewer is ambiguity, not first-wins.
  // With no active thread this tier is empty: an arbitrary thread-bound view
  // must never answer — arbitration proceeds to the installation tier.
  const eligible: { binding: CommandBinding; command: CompiledCommand }[] = [];
  if (activeThreadKey !== null) {
    for (const site of globalSites) {
      for (const binding of bindings.values()) {
        if (binding.token !== site.registration.token) continue;
        if (bindingThreadKey(binding) !== activeThreadKey) continue;
        eligible.push({ binding, command: site.command });
      }
    }
  }
  if (eligible.length === 1) return { kind: "binding", ...eligible[0]! };
  if (eligible.length > 1) return { kind: "ambiguous" };

  // (3)+(4) Installation-owned fallbacks run in the intended environment —
  // a sibling environment's handler never answers for this one. With no
  // active thread and no caller-chosen environment, multi-environment
  // claims cannot be arbitrated honestly.
  const activeEnvironmentId = environmentId ?? activeThreadRef?.environmentId;
  const owned = globalSites.filter(
    (site) => site.registration.handler !== undefined || site.command.activation !== undefined,
  );
  if (activeEnvironmentId === undefined) {
    if (new Set(owned.map((site) => site.registration.environmentId)).size > 1)
      return { kind: "ambiguous" };
  }
  const environmentSites =
    activeEnvironmentId !== undefined
      ? owned.filter((site) => site.registration.environmentId === activeEnvironmentId)
      : owned;

  const handlerSite = environmentSites.find((site) => site.registration.handler !== undefined);
  if (handlerSite) return { kind: "handler", site: handlerSite };

  // The activation fallback only lights when the shared eligibility check
  // passes — an ineligible thread/grant/surface greys the palette row instead
  // of no-oping on selection.
  const activationSites = environmentSites.filter(
    (site) => site.command.activation !== undefined && activationEligible(site),
  );
  if (activationSites.length > 0) return { kind: "activation", sites: activationSites };

  return { kind: "unavailable" };
}

/**
 * The single ordered dispatch rule: focused binding → exactly-one
 * thread-matching binding → installation handler → activation fallback.
 * `environmentId` pins arbitration to one environment — the palette passes
 * the row's environment so a cross-environment sibling never dispatches.
 */
export function dispatchExtensionCommand(
  commandName: string,
  environmentId?: string,
): ExtensionCommandDispatch {
  const arbitration = arbitrateExtensionCommand(commandName, environmentId);
  switch (arbitration.kind) {
    case "binding":
      arbitration.binding.handler({
        commandId: arbitration.command.id,
        context: arbitration.binding.context,
      });
      return { kind: "dispatched" };
    case "handler":
      arbitration.site.registration.handler!({
        commandId: arbitration.site.command.id,
        context: dispatchContextFor(arbitration.site.registration),
      });
      return { kind: "dispatched" };
    case "activation":
      for (const site of arbitration.sites) {
        if (openActivationSurface(site)) return { kind: "dispatched" };
      }
      return { kind: "unavailable" };
    case "ambiguous":
      return { kind: "ambiguous" };
    default:
      return { kind: "unavailable" };
  }
}

/**
 * Matches a keydown against plugin `defaultKey` declarations — consulted only
 * after the user's resolved keybindings miss, so user rules always win.
 */
export function extensionCommandForKeydown(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  const focusedSurface = focusedExtensionSurfaceId();
  const when = whenContext(focusedSurface);
  for (const registration of registrations.values()) {
    if (!registrationIsLive(registration)) continue;
    for (const command of registration.commands) {
      if (!command.defaultShortcut) continue;
      if (!matchesWhenClause(command.whenAst ?? undefined, when)) continue;
      if (!matchesShortcut(event, command.defaultShortcut, platform)) continue;
      return extensionCommandName(registration.installationId, command.id);
    }
  }
  return null;
}

/**
 * The client-lifetime keydown listener for extension commands — mounted once
 * by the extensions bootstrap, not inside any view. It runs on the document
 * bubble phase so mounted surfaces (ChatView's capture handler, terminals,
 * editors) always get first claim; an unconsumed key resolves user/native
 * rules first and plugin `defaultKey`s only on a true miss. Bare printable
 * keys are reserved for typing so a plugin default can never preempt text
 * input or type-to-focus.
 */
export function installExtensionCommandKeybindings(
  keybindings: () => ResolvedKeybindingsConfig,
): () => void {
  if (typeof document === "undefined") return () => {};
  const handler = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isCommandPaletteOpen()) return;
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    const command = resolveShortcutCommand(event, keybindings(), {
      context: { terminalFocus: getTerminalFocusOwner() !== null },
    });
    const name =
      command !== null
        ? command.startsWith("ext.")
          ? command
          : null
        : extensionCommandForKeydown(event);
    if (name === null) return;
    if (dispatchExtensionCommand(name).kind === "unavailable") return;
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

// ---------------------------------------------------------------------------
// Palette enumeration + conflicts

export interface PaletteExtensionCommand {
  readonly command: string;
  readonly title: string;
  readonly installationId: string;
  readonly environmentId: string;
  readonly enabled: boolean;
}

/**
 * Enabled state runs the same arbitration dispatch runs — the palette never
 * greys a command that would dispatch, nor lights one that would not.
 * Duplicate registration sets (replays, sibling views) collapse to one row.
 */
export function listPaletteExtensionCommands(): readonly PaletteExtensionCommand[] {
  const items: PaletteExtensionCommand[] = [];
  const seen = new Set<string>();
  for (const registration of registrations.values()) {
    if (!registrationIsLive(registration)) continue;
    for (const command of registration.commands) {
      const name = extensionCommandName(registration.installationId, command.id);
      const key = `${registration.environmentId}\n${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const arbitration = arbitrateExtensionCommand(name, registration.environmentId);
      items.push({
        command: name,
        title: command.title,
        installationId: registration.installationId,
        environmentId: registration.environmentId,
        enabled: arbitration.kind !== "unavailable" && arbitration.kind !== "ambiguous",
      });
    }
  }
  return items;
}

/**
 * Conflict reporting applies the real resolution order to each plugin
 * `defaultKey`: the last matching rule in the resolved config wins — a user
 * rule (or a native default when nothing overrides it) shadows the plugin
 * default; absent any resolved rule, a second plugin default on the same
 * normalized chord is plugin-vs-plugin. Reporting only — never dispatch.
 */
export function listExtensionCommandConflicts(environmentId: string): readonly {
  readonly command: string;
  readonly key: string;
  readonly winner: "user" | "native" | "plugin";
  readonly loser: string;
}[] {
  const conflicts: {
    command: string;
    key: string;
    winner: "user" | "native" | "plugin";
    loser: string;
  }[] = [];
  const deps = environmentDeps.get(environmentId);
  const resolved = deps?.keybindings?.() ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const when = whenContext(focusedExtensionSurfaceId());
  // Native defaults claim a chord as "native" only when the winning rule IS
  // the shipped default — a user rule rebound to a native command is "user".
  const defaultRuleClaims = new Set(
    DEFAULT_RESOLVED_KEYBINDINGS.map(
      (rule) => `${rule.command}${shortcutConflictKey(rule.shortcut)}`,
    ),
  );
  const winnerFor = (conflictKey: string) => {
    for (let index = resolved.length - 1; index >= 0; index -= 1) {
      const rule = resolved[index]!;
      if (!matchesWhenClause(rule.whenAst, when)) continue;
      if (shortcutConflictKey(rule.shortcut) === conflictKey) return rule;
    }
    return null;
  };
  const seen = new Map<string, string>();
  for (const registration of registrations.values()) {
    if (registration.environmentId !== environmentId) continue;
    if (!registrationIsLive(registration)) continue;
    for (const command of registration.commands) {
      if (!command.defaultKey || !command.defaultShortcut) continue;
      // A declaration whose `when` is inactive cannot claim the chord — it is
      // neither a winner nor a loser, matching `extensionCommandForKeydown`.
      if (!matchesWhenClause(command.whenAst ?? undefined, when)) continue;
      const conflictKey = shortcutConflictKey(command.defaultShortcut);
      const full = extensionCommandName(registration.installationId, command.id);
      const winner = winnerFor(conflictKey);
      if (winner !== null && winner.command !== full) {
        const isDefaultRule = defaultRuleClaims.has(`${winner.command}${conflictKey}`);
        conflicts.push({
          command: winner.command,
          key: command.defaultKey,
          winner: isDefaultRule ? "native" : "user",
          loser: full,
        });
        continue;
      }
      const prior = seen.get(conflictKey);
      if (prior !== undefined) {
        // Dispatch resolves first-registered — the earlier plugin wins the
        // chord, so the later declaration is the displaced one.
        conflicts.push({ command: prior, key: command.defaultKey, winner: "plugin", loser: full });
      } else {
        seen.set(conflictKey, full);
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// The t3.client/keybindings provider

export function createKeybindingsClientProvider(deps: ClientProviderAuthDeps): ClientLocalProvider {
  const environmentId = deps.environmentId;
  return {
    invoke(call: ClientProviderInvokeCall): Json {
      const installation = authorizeCaller(deps, call.caller, call.context, ["t3.ui/keybindings"]);
      const input = readInputObject(call.input);
      switch (call.method) {
        case "registerCommands": {
          const commands = input.commands;
          if (!Array.isArray(commands))
            throw new ClientProviderOpError("provider-rejected", "commands must be an array");
          const { commandSetToken, results } = registerCommands({
            environmentId,
            installationId: call.caller.installationId,
            installationGeneration: call.caller.installationGeneration,
            context: call.context,
            commands: commands as unknown as ExtensionCommandDescriptor[],
            capabilities: installation.grants.capabilities,
            installationScoped: input.installationScoped === true,
          });
          return { commandSetToken, results } as unknown as Json;
        }
        case "unregisterCommands": {
          const token = readInputString(input, "commandSetToken")!;
          return {
            unregistered: unregisterCommands(environmentId, token, call.caller.installationId),
          } as unknown as Json;
        }
        case "listConflicts": {
          return { conflicts: listExtensionCommandConflicts(environmentId) } as unknown as Json;
        }
        default:
          throw new ClientProviderOpError(
            "client-provider-unavailable",
            `Unknown keybindings op ${call.method}`,
          );
      }
    },
  };
}
