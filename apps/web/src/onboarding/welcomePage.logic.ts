import {
  isProviderAvailable,
  managedCapabilityDenial,
  type ManagedPolicySummary,
  ProviderDriverKind,
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
  // A broken version needs an update, which its row offers; signing in again would not help.
  if (provider.compatibilityAdvisory?.status === "broken") return "done";
  // The terminal shows the command first, so it also helps a CLI whose check failed.
  const fixable =
    state === "install" ||
    state === "signIn" ||
    (state === "attention" && isProviderAvailable(provider));
  return fixable ? "open" : "done";
}

/**
 * How the Welcome page offers the phone: T3 Connect sign-in, a pairing code, or not at all.
 * Both act on the primary computer, so another computer gets neither.
 */
export function welcomePhonePath(input: {
  readonly isPrimary: boolean;
  readonly cloud: boolean;
  // Relay read and write access, which sharing this computer through T3 Connect needs.
  readonly canShare: boolean;
  readonly policy: ManagedPolicySummary | undefined;
}) {
  if (!input.isPrimary || managedCapabilityDenial(input.policy, "remoteClients") !== undefined) {
    return null;
  }
  return input.cloud &&
    input.canShare &&
    managedCapabilityDenial(input.policy, "connect") === undefined
    ? "connect"
    : "pairing";
}
