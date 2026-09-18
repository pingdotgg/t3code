/**
 * The credential-demand seam for credential-free `alchemy dev`.
 *
 * A dev run whose plan is entirely local must never touch (or prompt for)
 * cloud credentials. When the plan DOES need the cloud — a resource opted
 * out of local emulation via `Alchemy.remote()`, a local Worker binding
 * that proxies to a remote resource (`dev: { remote: true }`), or the
 * deletion of a row that was last reconciled live — credentials are
 * validated up front, BEFORE apply begins: the gate resolves each demanded
 * provider's credentials through the same precedence the run will use. The
 * seam never starts a login flow: missing credentials fail with the typed
 * {@link CredentialsRequired} error naming the demanding resources and
 * pointing at `alchemy profile edit` — the profile command is the only
 * place logins happen.
 *
 * How deep the up-front resolution goes is PROVIDER-DEPENDENT — it runs
 * the provider's `read`, no more:
 *
 * - Cloudflare's `read` eagerly checks OAuth expiry, silently refreshes,
 *   and persists under the profile lock — so a dead refresh token fails
 *   here as a typed `NeedsReauth`, and child processes (which only ever
 *   read what a parent persisted) start with a warm token.
 * - AWS's `read` returns a credentials RECIPE whose inner effect stays
 *   unevaluated (SSO tokens are loaded lazily by consumers), so an
 *   expired SSO token passes the gate and still surfaces mid-run. Local-mode
 *   AWS providers carry a floci-scoped environment of their own (see
 *   `AWS/Local/FlociServices.ts`) and ensure the emulator there.
 *
 * The demand scan keys on provider MODE, not plan action — noop live rows
 * still demand (their runtime proxies need live credentials to serve), so
 * a watch restart re-runs this resolution even for an unchanged plan.
 *
 * Non-dev runs (`alchemy deploy` / `destroy`) never enter this seam:
 * state-store init and live providers drive the pre-existing lazy
 * credential-resolution flow unchanged.
 */
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { BindingNode, Plan } from "../Plan.ts";
import { profileCommandHint } from "../Util/interactive.ts";
import {
  AuthError,
  AuthProviders,
  NeedsReauth,
  presentEnvironment,
} from "./AuthProvider.ts";
import {
  ALCHEMY_PROFILE,
  DEFAULT_PROFILE_NAME,
  ProfileStore,
  SuppressMissingProviderConfig,
} from "./Profile.ts";
import { resolveProviderConfig } from "./Resolve.ts";

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
 * A dev-mode plan needs cloud credentials and none are configured for the
 * active profile. The message names the demanding resources and the exact
 * `alchemy profile edit` invocation that fixes it.
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
): Effect.Effect<never, CredentialsRequired> =>
  Effect.gen(function* () {
    const command = yield* profileCommandHint(
      `alchemy profile edit --profile ${profileName} --add ${demand.provider}`,
    );
    return yield* new CredentialsRequired({
      provider: demand.provider,
      resources: demand.resources.map((r) => r.fqn),
      reason: [...new Set(demand.resources.map((r) => r.reason))].join(", "),
      message:
        `${demand.provider} credentials are required, but none are configured ` +
        `for profile '${profileName}'.\n` +
        `These resources require ${demand.provider} credentials:\n` +
        `${resourceLines(demand)}\n` +
        `Run \`${command}\` to configure ` +
        "credentials, or set CI=1 to use environment-variable credentials.",
    });
  });

/**
 * The slice of binding data the demand scan cares about: local runtimes
 * mark cloud-proxied bindings with a truthy `devRemote` entry.
 */
const RemoteBindingData = Schema.Struct({
  devRemote: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});

const decodeRemoteBindingData = Schema.decodeUnknownResult(RemoteBindingData);

const bindingDemandsRemote = (
  bindings: readonly BindingNode[] | undefined,
): boolean =>
  (bindings ?? []).some((binding) => {
    // A binding being REMOVED needs no runtime proxy — the restarted
    // local instance simply no longer carries it.
    if (binding.action === "delete") return false;
    const data = decodeRemoteBindingData(binding.data);
    return (
      Result.isSuccess(data) &&
      Object.values(data.success.devRemote ?? {}).some(
        (remote) => remote === true,
      )
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

/**
 * Re-fail a warm-up resolution error with the demand attached, so the user
 * sees WHY a dev run wanted cloud credentials. Tags are preserved —
 * consumers match `NeedsReauth`/`AuthError` by tag, never by message.
 */
const attachDemandContext =
  (demand: CredentialDemand) =>
  <A, R>(
    self: Effect.Effect<A, AuthError | NeedsReauth, R>,
  ): Effect.Effect<A, AuthError | NeedsReauth, R> =>
    self.pipe(
      Effect.mapError((error) => {
        const message =
          `${error.message}\n` +
          `These resources require ${demand.provider} credentials:\n` +
          resourceLines(demand);
        return error._tag === "NeedsReauth"
          ? new NeedsReauth({
              provider: error.provider,
              profile: error.profile,
              message,
              cause: error.cause,
            })
          : new AuthError({ message, cause: error.cause });
      }),
    );

/**
 * Validate credentials for every demand. Never starts a login flow —
 * logging in belongs to `alchemy profile edit` exclusively:
 *
 *   - configured for the active profile → resolve the credentials through
 *     the exact precedence the run will use ({@link resolveProviderConfig}:
 *     CI environment, explicit env vars, then the profile). Resolution
 *     runs the provider's `read` — how much that validates and warms is
 *     provider-dependent (see the module header): Cloudflare eagerly
 *     refreshes and persists so a dead refresh token fails HERE as a
 *     typed {@link NeedsReauth} naming the demanding resources, while
 *     AWS's lazy credential recipe defers SSO-token failures to mid-run.
 *   - missing → typed {@link CredentialsRequired} failure with the exact
 *     `alchemy profile edit` invocation to run
 *   - CI → validates the provider's environment credentials directly,
 *     matching every other CI path without creating profile state
 *
 * Demands whose cloud has no registered auth provider are skipped (bare
 * engine runs with test providers demand nothing). All context is
 * resolved optionally, so the effect is safe to run in any environment —
 * and a plan with zero demand touches no credentials at all.
 */
export const demandCredentials = Effect.fn("Alchemy.demandCredentials")(
  function* (demands: readonly CredentialDemand[]) {
    if (demands.length === 0) return;
    const registry = Option.getOrUndefined(
      yield* Effect.serviceOption(AuthProviders),
    );
    const profile = Option.getOrUndefined(
      yield* Effect.serviceOption(ProfileStore),
    );
    if (registry === undefined || profile === undefined) return;
    const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false));
    // CI credentials come exclusively from the environment. Do not require
    // or inspect a local profile first: CI runners intentionally have no
    // profile manifest, and doing so would also risk consulting a developer's
    // stored profiles when this path is exercised locally under Doppler.
    const configuredProfile = yield* Config.option(ALCHEMY_PROFILE);
    const profileName = Option.getOrElse(
      configuredProfile,
      () => DEFAULT_PROFILE_NAME,
    );
    yield* Effect.forEach(
      demands,
      (demand) =>
        Effect.gen(function* () {
          const auth = registry[demand.provider];
          if (auth == null) return;
          if (ci) {
            if (auth.readEnvironment === undefined) {
              return yield* credentialsRequired(demand, profileName);
            }
            return yield* auth.readEnvironment.pipe(
              attachDemandContext(demand),
            );
          }
          // Read-only precheck of the two non-CI configuration sources the
          // resolution precedence below consults: environment credentials
          // (which win regardless of the selected profile), or a profile
          // entry. "Nothing configured" fails with the actionable
          // {@link CredentialsRequired} here, WITHOUT entering
          // `resolveProviderConfig`: its profile path goes through
          // `ensureProfile`, which fails a nonexistent profile with a
          // generic ProfileError that would bury which resources demanded
          // credentials and what command fixes it.
          const envUsable =
            auth.readEnvironment !== undefined &&
            (yield* presentEnvironment(auth.environment)) !== undefined;
          const existing = yield* profile.getProfile(profileName);
          if (existing?.providers[auth.name] == null && !envUsable) {
            return yield* credentialsRequired(demand, profileName);
          }
          // Something IS configured — resolve through the same precedence
          // the run's lazy credential flow uses, so the gate can never
          // pass something resolution would later reject (or vice versa).
          // Suppressed missing-config mode turns a check/resolve race into
          // the typed tag below instead of a generic AuthError; it also
          // mutes the env-credentials warning here — the run's own
          // resolution still emits it.
          const resolved = yield* resolveProviderConfig(demand.provider).pipe(
            Effect.provideService(AuthProviders, registry),
            Effect.provideService(ProfileStore, profile),
            Effect.provideService(SuppressMissingProviderConfig, true),
            Effect.catchTag("MissingProviderConfig", () =>
              credentialsRequired(demand, profileName),
            ),
            Effect.catchTag(
              "ProfileError",
              (error) =>
                new AuthError({ message: error.message, cause: error }),
            ),
          );
          yield* resolved.resolve.pipe(attachDemandContext(demand));
        }),
      { concurrency: 4, discard: true },
    );
  },
);

/**
 * Plan-time seam for `Alchemy.remote()` rows. The planner probes every new
 * resource with its provider's `read` (engine-level adoption) — for a
 * live-mode row in a dev run that is a real cloud call, made BEFORE
 * {@link demandPlanCredentials} could run in apply. Demanding here first
 * turns "nothing configured" into the typed {@link CredentialsRequired}
 * (naming the rows and the exact `alchemy profile edit` command) instead
 * of whatever raw error the first credential-less read produces. Bindings
 * and live deletions are still gated in apply — nothing reads for them
 * during plan.
 */
export const demandRemoteCredentials = (
  resources: ReadonlyArray<{ readonly Type: string; readonly FQN: string }>,
) => {
  const byProvider = new Map<string, DemandingResource[]>();
  for (const resource of resources) {
    const provider = cloudOf(resource.Type);
    byProvider.set(provider, [
      ...(byProvider.get(provider) ?? []),
      { fqn: resource.FQN, reason: "remote" },
    ]);
  }
  return demandCredentials(
    [...byProvider.entries()].map(([provider, resources]) => ({
      provider,
      resources,
    })),
  );
};

/**
 * The one-call seam wired into the dev path: scan the plan for live
 * demand and, if any, run {@link demandCredentials} BEFORE apply begins.
 */
export const demandPlanCredentials = (plan: Plan) =>
  demandCredentials(collectCredentialDemands(plan));
