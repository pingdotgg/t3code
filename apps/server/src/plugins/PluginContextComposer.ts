/**
 * Host-owned composition of plugin-contributed agent instructions.
 *
 * A plugin could give the agent tools and react to events, but could not TELL it
 * anything. This is that seam. It is deliberately the ONLY place plugin text becomes
 * developer instructions, so a provider driver cannot assemble instructions and
 * silently omit plugins by not knowing about them.
 *
 * The trust model, stated once here because it is easy to get wrong: contributed text
 * is INFLUENCE OVER THE AGENT, and ordering does not contain it. Putting host text
 * last is a weak heuristic, not a control — a plugin can write "ignore any later
 * instruction about X" and be just as effective. Plugins are semi-trusted code running
 * with the user's consent; the controls are the capability gate and consent copy that
 * says so plainly. Nothing here sandboxes natural language, and no comment should
 * imply otherwise.
 *
 * @module plugins/PluginContextComposer
 */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { PluginContextDescriptor } from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Per-contribution ceiling. Static text over this is rejected at REGISTRATION, so a
 * plugin author learns at activation rather than having every turn silently degrade.
 */
export const CONTEXT_MAX_BYTES_PER_PLUGIN = 8 * 1024;

/**
 * Ceiling across ALL plugins for one turn.
 *
 * A per-plugin cap alone permits `N x cap` of text in every turn, competing with the
 * user's actual work for the model's window. Contributions are included in order until
 * this fills; the rest are SKIPPED and recorded. Never truncated: a cut mid-sentence
 * changes the meaning of an instruction and is invisible to everyone.
 */
export const CONTEXT_MAX_BYTES_TOTAL = 32 * 1024;

/** How long ONE dynamic contributor may run before it is abandoned. */
export const CONTEXT_CONTRIBUTOR_TIMEOUT = Duration.seconds(5);

/**
 * Ceiling for the whole gather, however many plugins contribute.
 *
 * Per-contributor timeouts alone stack: 10 plugins x 5s is a 50s stall before the user
 * sees anything. This bounds what the user actually waits for.
 */
export const CONTEXT_GATHER_TIMEOUT = Duration.seconds(10);

export interface PluginContextEntry {
  readonly pluginId: string;
  readonly descriptor: PluginContextDescriptor;
}

export interface PluginContextTurn {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly interactionMode: string | undefined;
}

/** What was included and what was not — recorded so "the agent ignored my rule" is debuggable. */
export interface PluginContextRecord {
  readonly pluginId: string;
  readonly name: string;
  readonly bytes: number;
  readonly skipped:
    | "over-per-plugin-budget"
    | "over-total-budget"
    | "failed"
    | "timed-out"
    | "empty"
    | null;
}

export interface ComposedPluginContext {
  readonly text: string;
  readonly records: ReadonlyArray<PluginContextRecord>;
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Contributions are joined with a blank line, which costs real bytes. */
const SEPARATOR = "\n\n";
const SEPARATOR_BYTES = byteLength(SEPARATOR);

/**
 * Reject an oversized STATIC contribution at registration.
 *
 * Returns the reason, or null when the descriptor is acceptable. Dynamic text cannot
 * be checked here — its length is unknown until it runs — so the total budget is
 * enforced at gather time instead.
 */
export const findContextDescriptorViolation = (
  descriptor: PluginContextDescriptor,
): string | null => {
  if (descriptor.text === undefined && descriptor.contribute === undefined) {
    return `context contribution "${descriptor.name}" declares neither \`text\` nor \`contribute\`, so it can never contribute anything`;
  }
  // Reject a non-function `contribute` at registration. Descriptors are dynamically
  // loaded JS, so a value like `contribute: "bad"` passes the SDK's compile-time
  // type. At turn time `runOne` would call it, and the resulting synchronous throw
  // lands BEFORE `timeoutOrElse`/`catchCause` are wired — aborting the user's turn
  // instead of skipping the bad plugin. Fail it here instead.
  if (descriptor.contribute !== undefined && typeof descriptor.contribute !== "function") {
    return `context contribution "${descriptor.name}" declares a \`contribute\` that is not a function`;
  }
  if (descriptor.text !== undefined) {
    const bytes = byteLength(descriptor.text);
    if (bytes > CONTEXT_MAX_BYTES_PER_PLUGIN) {
      return `context contribution "${descriptor.name}" is ${bytes} bytes, over the ${CONTEXT_MAX_BYTES_PER_PLUGIN}-byte limit; it is rejected rather than truncated, because a cut mid-sentence changes what an instruction means`;
    }
  }
  return null;
};

export class PluginContextComposer extends Context.Service<
  PluginContextComposer,
  {
    /** Register a plugin's contributions. Replaces any previous set for that plugin. */
    readonly put: (
      pluginId: string,
      descriptors: ReadonlyArray<PluginContextDescriptor>,
    ) => Effect.Effect<void>;
    readonly remove: (pluginId: string) => Effect.Effect<void>;
    /** Gather every contribution for one turn. Never fails: a bad plugin is skipped. */
    readonly compose: (turn: PluginContextTurn) => Effect.Effect<ComposedPluginContext>;
  }
>()("t3/plugins/PluginContextComposer") {}

export const make = Effect.fn("PluginContextComposer.make")(function* () {
  const entries = new Map<string, ReadonlyArray<PluginContextDescriptor>>();

  const runOne = (
    pluginId: string,
    descriptor: PluginContextDescriptor,
    turn: PluginContextTurn,
  ): Effect.Effect<{
    readonly text: string | null;
    readonly skipped: "failed" | "timed-out" | null;
  }> => {
    if (descriptor.contribute === undefined) {
      return Effect.succeed({ text: descriptor.text ?? null, skipped: null });
    }
    // Effect.suspend so `contribute` is INVOKED inside the effect. Called eagerly
    // (`descriptor.contribute({...}).pipe(...)`), a synchronous throw — or a
    // non-Effect return from dynamically loaded plugin JS — would land BEFORE
    // timeoutOrElse/catchCause exist and become a defect of the whole compose,
    // which the "cannot fail" caller (CodexSessionRuntime) yields unguarded.
    // Suspending routes that throw through the catchCause below (skipped:"failed"),
    // so one bad contributor is dropped instead of failing the user's turn. The
    // registration-time typeof guard still rejects a non-function up front; this
    // covers a function that throws only when called.
    return Effect.suspend(() =>
      descriptor.contribute!({
        threadId: turn.threadId,
        projectId: turn.projectId,
        interactionMode: turn.interactionMode,
      }),
    ).pipe(
      Effect.map((text) => ({ text, skipped: null as "failed" | "timed-out" | null })),
      // A hung contributor must not hold up the user's turn. It is dropped, not
      // waited on — and recorded, because a silent drop looks like "my rule does
      // nothing" with no way to find out why.
      Effect.timeoutOrElse({
        duration: CONTEXT_CONTRIBUTOR_TIMEOUT,
        orElse: () =>
          Effect.succeed({ text: null, skipped: "timed-out" as "failed" | "timed-out" | null }),
      }),
      Effect.catchCause((cause) =>
        // Re-raise INTERRUPTS (the whole-gather CONTEXT_GATHER_TIMEOUT firing, or a
        // caller/scope cancellation) instead of swallowing them: converting an
        // interrupt to skipped:"failed" would let the outer compose loop keep
        // iterating through later contributors, blowing past the promised 10s gather
        // ceiling (N contributors x their own 5s timeout). Only genuine plugin
        // failures/defects are contained — a plugin's failure must never fail the
        // USER's turn; the contribution is an extra.
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning("plugin context contributor failed", {
              pluginId,
              name: descriptor.name,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ text: null, skipped: "failed" as "failed" | "timed-out" | null })),
      ),
    );
  };

  const compose: PluginContextComposer["Service"]["compose"] = (turn) => {
    // Hoisted OUT of the timed effect so the gather-timeout fallback below can
    // return what already completed. If these lived inside the gen, `orElse` (which
    // runs after the gen fiber is interrupted) could not see them and would discard
    // every succeeded contribution and accumulated record — defeating the whole
    // point of PluginContextRecord being a debuggable trail.
    const records: Array<PluginContextRecord> = [];
    const texts: Array<string> = [];
    return Effect.gen(function* () {
      let total = 0;

      for (const [pluginId, descriptors] of entries) {
        for (const descriptor of descriptors) {
          const result = yield* runOne(pluginId, descriptor, turn);
          if (result.skipped !== null || result.text === null || result.text === "") {
            records.push({
              pluginId,
              name: descriptor.name,
              bytes: 0,
              skipped: result.skipped ?? "empty",
            });
            continue;
          }
          const bytes = byteLength(result.text);
          // Enforce the per-plugin ceiling on DYNAMIC output. Static `text` is already
          // size-checked at registration, but a `contribute` result is only known now
          // — without this a dynamic plugin returning 20 KiB would sail past its
          // promised 8 KiB cap and crowd the shared budget. Skip it whole (a cut
          // mid-sentence changes an instruction's meaning) and record why.
          if (descriptor.contribute !== undefined && bytes > CONTEXT_MAX_BYTES_PER_PLUGIN) {
            yield* Effect.logWarning("plugin context skipped: over per-plugin budget", {
              pluginId,
              name: descriptor.name,
              bytes,
            });
            records.push({
              pluginId,
              name: descriptor.name,
              bytes,
              skipped: "over-per-plugin-budget",
            });
            continue;
          }
          // COUNT THE SEPARATOR. Summing only the contributions let the composed text
          // exceed the budget it promises — the joiner's bytes are just as real to the
          // model's window as the plugin's. (My own budget test caught this.)
          const cost = bytes + (texts.length > 0 ? SEPARATOR_BYTES : 0);
          // Over the shared budget: SKIP this contribution whole and say so. Including
          // a fragment would be worse than omitting it.
          if (total + cost > CONTEXT_MAX_BYTES_TOTAL) {
            yield* Effect.logWarning("plugin context skipped: over total budget", {
              pluginId,
              name: descriptor.name,
              bytes,
              total,
            });
            records.push({ pluginId, name: descriptor.name, bytes, skipped: "over-total-budget" });
            continue;
          }
          total += cost;
          texts.push(result.text);
          records.push({ pluginId, name: descriptor.name, bytes, skipped: null });
        }
      }

      return { text: texts.join(SEPARATOR), records } satisfies ComposedPluginContext;
    }).pipe(
      // Bound the whole gather, not just each contributor: N contributors x their own
      // timeout is what the user would otherwise wait through before every turn.
      Effect.timeoutOrElse({
        duration: CONTEXT_GATHER_TIMEOUT,
        // On the ceiling firing, return what finished before the deadline rather
        // than an empty result — already-succeeded contributions stay in `text`,
        // and their records (plus any per-contributor skips) remain visible. The
        // contributor still running when the budget ran out is simply interrupted.
        orElse: () =>
          Effect.logWarning("plugin context gather timed out; returning partial result", {
            gathered: texts.length,
          }).pipe(
            Effect.as({ text: texts.join(SEPARATOR), records } satisfies ComposedPluginContext),
          ),
      }),
    );
  };

  return PluginContextComposer.of({
    put: (pluginId, descriptors) =>
      Effect.sync(() => {
        entries.set(pluginId, descriptors);
      }),
    remove: (pluginId) =>
      Effect.sync(() => {
        entries.delete(pluginId);
      }),
    compose,
  });
});

export const layer = Layer.effect(PluginContextComposer, make());
