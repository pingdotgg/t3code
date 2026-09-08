/**
 * The credential-demand seam for credential-free `alchemy dev`.
 *
 * A dev run whose plan is entirely local must never touch (or prompt for)
 * cloud credentials. When the plan DOES need the cloud — a resource opted
 * out of local emulation via `Alchemy.remote()`, a local Worker binding
 * that proxies to a remote resource (`dev: { remote: true }`), or the
 * deletion of a row that was last reconciled live — credentials are
 * demanded exactly once, up front, in the exec process (which owns the
 * tty), BEFORE apply begins:
 *
 *   - interactive: the provider's existing `configure` flow runs, prefixed
 *     with a human-readable reason naming the demanding resources
 *     (threaded via {@link ConfigureContext}'s `reason`).
 *   - non-interactive: fail with the typed {@link CredentialsRequired}
 *     error naming the demanding resources and pointing at `alchemy login`.
 *
 * The RPC sidecar never prompts — its stdio is piped and it only ever
 * reads credentials persisted by this seam (or a prior `alchemy login`).
 *
 * Non-dev runs (`alchemy deploy` / `destroy`) never enter this seam:
 * state-store init and live providers drive the pre-existing lazy
 * credential-resolution flow unchanged.
 */
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { BindingNode, Plan } from "../Plan.ts";
import { isNonInteractive } from "../Util/interactive.ts";
import { AuthProviders, type ConfigureContext } from "./AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "./Profile.ts";

/** Why a plan row demands live (cloud) credentials during a dev run. */
export type CredentialDemandReason =
  /** The resource's resolved provider mode is `"live"` (`Alchemy.remote()`). */
  | "remote"
  /** Binding data carries a truthy `devRemote` entry — the local runtime proxies this binding to the real cloud. */
  | "remote-binding"
  /** The plan deletes a row stamped `providerMode: "live"` — the live provider must run to delete it. */
  | "live-delete";

export interface DemandingResource {
  /** FQN of the demanding resource within the stack. */
  readonly fqn: string;
  readonly reason: CredentialDemandReason;
}

/**
 * All the resources of one cloud provider that demand live credentials.
 * `provider` is the auth-provider name, derived from the resource Type's
 * leading namespace segment (`"AWS.S3.Bucket"` → `"AWS"`, matching the
 * name the cloud's auth provider registers under).
 */
export interface CredentialDemand {
  readonly provider: string;
  readonly resources: readonly DemandingResource[];
}

/**
 * A dev-mode plan needs cloud credentials, none are configured for the
 * active profile, and the process is non-interactive so the configure flow
 * cannot run. The message names the demanding resources and the fix.
 */
export class CredentialsRequired extends Data.TaggedError(
  "CredentialsRequired",
)<{
  message: string;
  /** Auth-provider name whose credentials are missing (e.g. `"AWS"`). */
  provider: string;
  /** FQNs of the resources demanding the credentials. */
  resources: string[];
  /** Short summary of why the credentials are needed. */
  reason: string;
}> {}

const describeReason = (reason: CredentialDemandReason): string => {
  switch (reason) {
    case "remote":
      return "runs against the real cloud via Alchemy.remote()";
    case "remote-binding":
      return "has a binding that proxies to a remote resource (dev: { remote: true })";
    case "live-delete":
      return "deletes an instance that was deployed to the real cloud";
  }
};

/** `"AWS.S3.Bucket"` → `"AWS"` (the auth-provider name). */
const cloudOf = (type: string): string => type.split(".")[0] ?? type;

const resourceLines = (demand: CredentialDemand): string =>
  demand.resources
    .map((r) => `  - ${r.fqn} (${describeReason(r.reason)})`)
    .join("\n");

/**
 * Build the typed {@link CredentialsRequired} failure for a demand.
 * Exported so tests can pin the message format.
 */
export const credentialsRequired = (
  demand: CredentialDemand,
  profileName: string,
): CredentialsRequired =>
  new CredentialsRequired({
    provider: demand.provider,
    resources: demand.resources.map((r) => r.fqn),
    reason: [...new Set(demand.resources.map((r) => r.reason))].join(", "),
    message:
      `${demand.provider} credentials are required, but none are configured ` +
      `for profile '${profileName}' and this process is non-interactive so ` +
      "they can't be configured now.\n" +
      `These resources require ${demand.provider} credentials:\n` +
      `${resourceLines(demand)}\n` +
      `Run \`alchemy login --profile ${profileName}\` to configure ` +
      "credentials, or set CI=1 to use environment-variable credentials.",
  });

/**
 * The human-readable reason shown at the top of an interactive configure
 * flow triggered by this seam (threaded via {@link ConfigureContext}).
 */
const demandBanner = (demand: CredentialDemand): string =>
  `This dev session requires ${demand.provider} credentials:\n` +
  resourceLines(demand);

const bindingDemandsRemote = (
  bindings: readonly BindingNode[] | undefined,
): boolean =>
  (bindings ?? []).some((binding) => {
    // A binding being REMOVED needs no runtime proxy — the restarted
    // local instance simply no longer carries it.
    if (binding.action === "delete") return false;
    const data = binding.data as
      | { devRemote?: Record<string, boolean> }
      | null
      | undefined;
    return (
      data != null &&
      typeof data === "object" &&
      data.devRemote != null &&
      typeof data.devRemote === "object" &&
      Object.values(data.devRemote).some((remote) => remote === true)
    );
  });

/**
 * Scan a plan for rows that need live (cloud) credentials during a dev
 * run, grouped by cloud provider:
 *
 *   1. resources whose resolved provider mode is `"live"` (`Alchemy.remote()`)
 *   2. resources whose binding data carries a truthy `devRemote` entry
 *      (the local runtime proxies that binding to the real cloud)
 *   3. planned deletions of rows stamped `providerMode: "live"`
 *
 * Pure and side-effect-free — callers gate on the run being a dev run
 * (in a live run every dual-provider row resolves `"live"` and the
 * pre-existing lazy credential flow applies instead).
 *
 * Mode-agnostic rows (`mode === undefined`, single-implementation
 * providers that run live even in dev) are deliberately NOT collected:
 * they resolve credentials lazily exactly as they do today.
 */
export const collectCredentialDemands = (plan: Plan): CredentialDemand[] => {
  const byProvider = new Map<string, Map<string, CredentialDemandReason>>();
  const add = (
    type: string,
    fqn: string,
    reason: CredentialDemandReason,
  ): void => {
    const provider = cloudOf(type);
    const resources =
      byProvider.get(provider) ?? new Map<string, CredentialDemandReason>();
    if (!resources.has(fqn)) resources.set(fqn, reason);
    byProvider.set(provider, resources);
  };
  for (const [fqn, node] of Object.entries(plan.resources)) {
    if (node.mode === "live") {
      add(node.resource.Type, fqn, "remote");
    } else if (bindingDemandsRemote(node.bindings)) {
      add(node.resource.Type, fqn, "remote-binding");
    }
  }
  for (const [fqn, node] of Object.entries(plan.deletions)) {
    if (node !== undefined && node.mode === "live") {
      add(node.resource.Type, fqn, "live-delete");
    }
  }
  return [...byProvider.entries()].map(([provider, resources]) => ({
    provider,
    resources: [...resources.entries()].map(([fqn, reason]) => ({
      fqn,
      reason,
    })),
  }));
};

export interface DemandCredentialsOptions {
  /**
   * Overrides {@link isNonInteractive} — a test seam. When `true`, a
   * missing profile fails with {@link CredentialsRequired} instead of
   * driving the interactive configure flow.
   */
  readonly nonInteractive?: boolean;
}

/**
 * Ensure credentials exist for every demand, prompting at most once per
 * provider and only when nothing is configured yet:
 *
 *   - already configured for the active profile → no-op (never re-prompts)
 *   - missing + interactive → the provider's `configure` flow runs (via
 *     `AlchemyProfile.loadOrConfigure`), prefixed with a reason naming the
 *     demanding resources
 *   - missing + non-interactive (and not CI) → typed
 *     {@link CredentialsRequired} failure
 *   - CI → `loadOrConfigure` picks the provider's non-interactive default
 *     (env-var credentials), matching every other CI path
 *
 * Demands whose cloud has no registered auth provider are skipped (bare
 * engine runs with test providers demand nothing). All context is
 * resolved optionally, so the effect is safe to run in any environment.
 */
export const demandCredentials = Effect.fn("Alchemy.demandCredentials")(
  function* (
    demands: readonly CredentialDemand[],
    options?: DemandCredentialsOptions,
  ) {
    if (demands.length === 0) return;
    const registry = Option.getOrUndefined(
      yield* Effect.serviceOption(AuthProviders),
    );
    const profile = Option.getOrUndefined(
      yield* Effect.serviceOption(AlchemyProfile),
    );
    if (registry === undefined || profile === undefined) return;
    const profileName = yield* ALCHEMY_PROFILE;
    const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
    const nonInteractive = options?.nonInteractive ?? isNonInteractive();
    for (const demand of demands) {
      const auth = registry[demand.provider];
      if (auth == null) continue;
      const existing = yield* profile.getProfile(profileName);
      if (existing?.[auth.name] != null) continue;
      if (!ci && nonInteractive) {
        return yield* credentialsRequired(demand, profileName);
      }
      const ctx: ConfigureContext = { ci, reason: demandBanner(demand) };
      yield* profile.loadOrConfigure(auth, profileName, ctx);
    }
  },
);

/**
 * The one-call seam wired into the dev path: scan the plan for live
 * demand and, if any, run {@link demandCredentials} BEFORE apply begins.
 */
export const demandPlanCredentials = (
  plan: Plan,
  options?: DemandCredentialsOptions,
) => demandCredentials(collectCredentialDemands(plan), options);
