/**
 * Plugin policy hooks over agent approval requests.
 *
 * The agent asks permission before running a command, reading a file, or changing
 * one. A policy plugin gets to see that request first — "never let it touch
 * production", "block writes outside the workspace".
 *
 * THE DESIGN DECISION, and the reason this is safe enough to exist:
 *
 *   A policy hook may only DENY or DEFER. It can never ALLOW.
 *
 * A hook that could auto-approve would be the single most dangerous thing in the
 * plugin system: a buggy or hostile plugin would silently green-light `rm -rf` on a
 * request the user would have refused, and the user would never see the prompt. So
 * the vocabulary simply does not contain "allow". A hook can only make the system
 * MORE restrictive than it already is, never less. The worst a broken policy plugin
 * can do is block work that should have been permitted — annoying, visible, and
 * recoverable by disabling the plugin. That asymmetry is deliberate: the failure mode
 * points at inconvenience rather than at damage.
 *
 * Everything else follows from it. A hook that fails, hangs, or dies DEFERS, because
 * "defer" means "ask the user" — the behaviour the host had before any plugin
 * existed. Failing that way cannot escalate anything.
 *
 * @module plugins/PluginPolicyRegistry
 */
import type {
  PluginPolicyDecision,
  PluginPolicyDescriptor,
  PluginPolicyRequest,
} from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * How long ONE hook may take before the host stops waiting.
 *
 * The user is sitting in front of an approval prompt that has not appeared yet, so
 * this is deliberately short. A hook that misses it defers.
 */
const HOOK_TIMEOUT = Duration.seconds(3);

/** Ceiling for evaluating every hook, so N slow plugins cannot stack. */
const EVALUATION_TIMEOUT = Duration.seconds(5);

export interface PluginPolicyOutcome {
  /** "deny" only when a hook denied. Otherwise the host's normal flow continues. */
  readonly decision: "deny" | "defer";
  /** Which plugin denied, for the UI to explain WHY a request was blocked. */
  readonly deniedBy: string | null;
  /** The hook's own reason. Shown to the user; never invented by the host. */
  readonly reason: string | null;
}

const DEFER: PluginPolicyOutcome = { decision: "defer", deniedBy: null, reason: null };

export class PluginPolicyRegistry extends Context.Service<
  PluginPolicyRegistry,
  {
    readonly put: (
      pluginId: string,
      descriptors: ReadonlyArray<PluginPolicyDescriptor>,
    ) => Effect.Effect<void>;
    readonly remove: (pluginId: string) => Effect.Effect<void>;
    /**
     * Ask every hook. FIRST DENY WINS and short-circuits: once something is denied,
     * no later hook can undo it (nothing can — there is no "allow"), so continuing to
     * run hooks would only add latency to a decision already made.
     *
     * Never fails: a broken plugin defers.
     */
    readonly evaluate: (request: PluginPolicyRequest) => Effect.Effect<PluginPolicyOutcome>;
  }
>()("t3/plugins/PluginPolicyRegistry") {}

export const make = Effect.fn("PluginPolicyRegistry.make")(function* () {
  const entries = new Map<string, ReadonlyArray<PluginPolicyDescriptor>>();

  const runHook = (
    pluginId: string,
    descriptor: PluginPolicyDescriptor,
    request: PluginPolicyRequest,
  ): Effect.Effect<PluginPolicyDecision | null> =>
    // Effect.suspend so the plugin-supplied `onApprovalRequest` is INVOKED inside
    // the effect. Called eagerly (`descriptor.onApprovalRequest(request).pipe(...)`),
    // a synchronous throw would escape before `catchCause` is wired and fail
    // `evaluate` outright — the opposite of the "a broken hook DEFERS" contract.
    // Suspending turns that throw into a captured defect the catchCause below folds
    // into a defer.
    Effect.suspend(() => descriptor.onApprovalRequest(request)).pipe(
      Effect.timeoutOrElse({
        duration: HOOK_TIMEOUT,
        // Timing out DEFERS. The user is waiting on a prompt that has not appeared;
        // making them wait longer for a hook that is already broken helps nobody.
        orElse: () =>
          Effect.logWarning("plugin policy hook timed out; deferring", {
            pluginId,
            name: descriptor.name,
          }).pipe(Effect.as(null)),
      }),
      Effect.catchCause((cause) =>
        // A failing hook DEFERS rather than denying. Denying on failure sounds
        // "safe", but it would mean a crashed plugin silently blocks all work with
        // no way for the user to tell why — and deferring is exactly the behaviour
        // the host had before the plugin existed, so it cannot escalate anything.
        Effect.logWarning("plugin policy hook failed; deferring", {
          pluginId,
          name: descriptor.name,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );

  const evaluate: PluginPolicyRegistry["Service"]["evaluate"] = (request) =>
    Effect.gen(function* () {
      for (const [pluginId, descriptors] of entries) {
        for (const descriptor of descriptors) {
          const decision = yield* runHook(pluginId, descriptor, request);
          if (decision?.decision === "deny") {
            yield* Effect.logInfo("plugin policy denied a request", {
              pluginId,
              name: descriptor.name,
              kind: request.kind,
            });
            return {
              decision: "deny",
              deniedBy: pluginId,
              // The plugin's own words. A host-invented reason would be a guess at
              // why someone else's rule fired.
              reason: decision.reason ?? null,
            } satisfies PluginPolicyOutcome;
          }
        }
      }
      return DEFER;
    }).pipe(
      Effect.timeoutOrElse({
        duration: EVALUATION_TIMEOUT,
        orElse: () => Effect.succeed(DEFER),
      }),
    );

  return PluginPolicyRegistry.of({
    put: (pluginId, descriptors) =>
      Effect.sync(() => {
        entries.set(pluginId, descriptors);
      }),
    remove: (pluginId) =>
      Effect.sync(() => {
        entries.delete(pluginId);
      }),
    evaluate,
  });
});

export const layer = Layer.effect(PluginPolicyRegistry, make());
