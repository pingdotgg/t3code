import {
  isProviderAvailable,
  managedCapabilityDenial,
  type ManagedPolicySummary,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { getOnboardingProviderState } from "./providerReadiness.logic";

type ComputerSettings = Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;

// Ready agents first, then ones that need a sign-in or a look. Never ranked by vendor.
const FOUND_ORDER = { ready: 0, signIn: 1, attention: 2 } as const;
type FoundState = keyof typeof FOUND_ORDER;

const isFoundState = (state: string): state is FoundState => state in FOUND_ORDER;

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

/**
 * An agent's state for new threads on this computer. The server also lists agents that only some
 * projects turn on, lists an agent it could not load as off, which Turn on cannot fix, and can pass
 * a CLI whose version it knows is broken.
 */
export function welcomeAgentState(
  provider: ServerProvider,
  settings: ComputerSettings | null | undefined,
) {
  if (!isProviderAvailable(provider)) return "attention";
  if (settings && !resolveProjectProviderInstanceEnabled(settings, null, provider.instanceId)) {
    return "disabled";
  }
  const state = getOnboardingProviderState(provider);
  if (state === "ready" && provider.compatibilityAdvisory?.status === "broken") return "attention";
  // An ACP agent that is not prepared reports the same fields as one still being checked.
  return state === "checking" && provider.driver === ACP_REGISTRY_DRIVER ? "attention" : state;
}

/**
 * Splits a computer's allowed providers into agents already on it and agents the user can add.
 * Order inside each group is by state, then by the name the user sees. Agents still being
 * checked are listed with the ones to add, so a slow check never drops an agent.
 */
export function groupWelcomeAgents(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
  settings: ComputerSettings | null | undefined,
  nameOf: (provider: ServerProvider) => string,
  isAllowed: (provider: ServerProvider) => boolean,
) {
  const found: Array<{ readonly provider: ServerProvider; readonly state: FoundState }> = [];
  const available: ServerProvider[] = [];
  let checking = providers == null;
  let readyCount = 0;
  for (const provider of providers ?? []) {
    if (!isAllowed(provider)) continue;
    const state = welcomeAgentState(provider, settings);
    if (state === "ready") readyCount += 1;
    if (state === "checking") checking = true;
    if (isFoundState(state)) found.push({ provider, state });
    else available.push(provider);
  }
  const byName = (a: ServerProvider, b: ServerProvider) => nameOf(a).localeCompare(nameOf(b));
  found.sort(
    (a, b) => FOUND_ORDER[a.state] - FOUND_ORDER[b.state] || byName(a.provider, b.provider),
  );
  available.sort(byName);
  return { checking, readyCount, found: found.map((entry) => entry.provider), available };
}

/** Older settings can also keep `enabled: false` inside `config`, which still turns the agent off. */
export function turnedOnInstance(instance: ProviderInstanceConfig): ProviderInstanceConfig {
  const { config } = instance;
  const configOff =
    typeof config === "object" &&
    config !== null &&
    "enabled" in config &&
    config.enabled === false;
  return {
    ...instance,
    enabled: true,
    ...(configOff ? { config: { ...config, enabled: true } } : {}),
  };
}

/** A CLI the server knows is too old or otherwise broken for T3 Code; Settings updates it. */
export function isBrokenVersion(provider: ServerProvider) {
  return provider.installed && provider.compatibilityAdvisory?.status === "broken";
}

/**
 * What "Use existing CLI" does next for Codex: wait for the CLI's own check, open its terminal,
 * or stop. Only the ChatGPT sign-in runtime reports `setup.canAuthenticate`.
 */
export function cliTerminalStep(
  provider: ServerProvider,
  settings: ComputerSettings | null | undefined,
) {
  if (provider.setup?.canAuthenticate === true) return "wait";
  const state = welcomeAgentState(provider, settings);
  if (state === "checking") return "wait";
  // A broken version is updated from its row, and an installed, signed-in CLI needs no terminal.
  if (isBrokenVersion(provider)) return "done";
  if (provider.installed && provider.auth.status === "authenticated") return "done";
  // The terminal shows the command first, so it also helps a CLI whose check failed.
  const fixable =
    state === "install" ||
    state === "signIn" ||
    (state === "attention" && isProviderAvailable(provider));
  return fixable ? "open" : "done";
}

/**
 * Whether Codex's row opens its setup card, which offers ChatGPT sign-in or the CLI. A signed-in
 * or broken Codex gets its plain row action instead, since the card has nothing left for it.
 */
export function codexNeedsSetup(
  provider: ServerProvider,
  settings: ComputerSettings | null | undefined,
) {
  if (
    provider.driver !== "codex" ||
    provider.auth.status === "authenticated" ||
    isBrokenVersion(provider)
  ) {
    return false;
  }
  const state = welcomeAgentState(provider, settings);
  return (
    state === "install" ||
    state === "signIn" ||
    (state === "attention" && isProviderAvailable(provider))
  );
}

/**
 * The phone joins by signing in to T3 Connect, which shares the primary computer. Another
 * computer, a build without T3 Connect, or a policy that turns it off gets no Phone section.
 */
export function welcomeOffersPhone(input: {
  readonly isPrimary: boolean;
  readonly cloud: boolean;
  // Relay read and write access, which sharing this computer through T3 Connect needs.
  readonly canShare: boolean;
  readonly policy: ManagedPolicySummary | undefined;
}) {
  return (
    input.isPrimary &&
    input.cloud &&
    input.canShare &&
    managedCapabilityDenial(input.policy, "remoteClients") === undefined &&
    managedCapabilityDenial(input.policy, "connect") === undefined
  );
}

/**
 * The Codex instance the setup card shows, or null when the card is closed. A rebuild briefly
 * drops an instance from the list, so the card keeps its last status meanwhile instead of
 * unmounting and losing a sign-in in progress.
 */
export function codexCardProvider(input: {
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
  readonly instanceId: ProviderInstanceId | null;
  readonly last: ServerProvider | null;
  readonly settings: ComputerSettings | null | undefined;
}) {
  if (input.instanceId === null) return null;
  const provider =
    input.providers?.find((candidate) => candidate.instanceId === input.instanceId) ??
    (input.last?.instanceId === input.instanceId ? input.last : undefined);
  if (provider === undefined) return null;
  const open =
    codexNeedsSetup(provider, input.settings) ||
    welcomeAgentState(provider, input.settings) === "checking";
  return open ? provider : null;
}

/**
 * The computer the Welcome page sets up. A ChatGPT sign-in returns to the computer it set up, and
 * Settings opens the page for a connected computer; either id counts only once the catalog knows
 * it, so an unknown one falls back to this computer.
 */
export function resolveWelcomeEnvironmentId<Id extends string>(input: {
  readonly resumeEnvironmentId: Id | undefined;
  readonly requestedEnvironmentId: Id | undefined;
  readonly primaryEnvironmentId: Id | null;
  readonly knownEnvironmentIds: ReadonlyArray<Id>;
}): Id | null {
  const known = (id: Id | undefined) =>
    id !== undefined && input.knownEnvironmentIds.includes(id) ? id : undefined;
  return (
    known(input.resumeEnvironmentId) ??
    known(input.requestedEnvironmentId) ??
    input.primaryEnvironmentId
  );
}
