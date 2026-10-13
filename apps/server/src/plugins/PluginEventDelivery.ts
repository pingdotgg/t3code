/**
 * The part of plugin event delivery that the plugin catalogue calls into. It
 * lets the catalogue start a plugin's event cursor, show how delivery is
 * going, and resume it, without depending on the event feed, which itself
 * depends on the catalogue.
 */
import {
  PLUGIN_EVENTS_CAPABILITY,
  type PluginEventDeliveryState,
  type PluginInstallationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

export class PluginEventDelivery extends Context.Service<
  PluginEventDelivery,
  {
    /**
     * Gives an installation that declares `events` its starting cursor, the
     * current end of the event log, unless it already has one. The catalogue
     * runs this in the transaction that saves the installation as enabled, so
     * every event committed after the enable is delivered and none from
     * before it. Re-enables and restarts keep the stored cursor.
     */
    readonly begin: (
      installationId: PluginInstallationId,
      capabilities: ReadonlyArray<string>,
    ) => Effect.Effect<void, SqlError.SqlError>;
    /** The delivery state of one registration, if the feed reported one. */
    readonly state: (
      installationId: PluginInstallationId,
      generation: number,
    ) => Effect.Effect<Option.Option<PluginEventDeliveryState>>;
    /** Reports a registration's state; `undefined` when it no longer delivers. */
    readonly report: (
      installationId: PluginInstallationId,
      generation: number,
      state: PluginEventDeliveryState | undefined,
    ) => Effect.Effect<void>;
    /** Signals each reported change of a state (never a cursor move). Sliding, 1. */
    readonly changes: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    /** Restarts quarantined or retrying delivery from its cursor. Nothing else changes. */
    readonly resume: (installationId: PluginInstallationId) => Effect.Effect<void>;
    /** Installs what `resume` runs, for as long as the scope is open. */
    readonly handleResume: (
      resume: (installationId: PluginInstallationId) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/plugins/PluginEventDelivery") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const states = new Map<
    PluginInstallationId,
    { readonly generation: number; readonly state: PluginEventDeliveryState }
  >();
  const changes = yield* PubSub.sliding<void>(1);
  let resume: ((installationId: PluginInstallationId) => Effect.Effect<void>) | undefined;

  return PluginEventDelivery.of({
    begin: (installationId, capabilities) =>
      capabilities.includes(PLUGIN_EVENTS_CAPABILITY)
        ? Effect.gen(function* () {
            // One statement, so the end it reads is the end when the row is written.
            yield* sql`
              INSERT INTO plugin_event_cursors (installation_id, acknowledged_sequence, updated_at)
              SELECT ${installationId}, COALESCE(MAX(sequence), 0), ${DateTime.formatIso(yield* DateTime.now)}
              FROM orchestration_events
              WHERE application_event_version = 2
                AND aggregate_kind = 'thread'
              ON CONFLICT (installation_id) DO NOTHING
            `;
          })
        : Effect.void,
    state: (installationId, generation) =>
      Effect.sync(() => {
        const current = states.get(installationId);
        return current?.generation === generation ? Option.some(current.state) : Option.none();
      }),
    report: (installationId, generation, state) =>
      Effect.suspend(() => {
        const current = states.get(installationId);
        if (state === undefined) {
          if (current?.generation !== generation) return Effect.void;
          states.delete(installationId);
        } else {
          if (current?.generation === generation && Equal.equals(current.state, state))
            return Effect.void;
          states.set(installationId, { generation, state });
        }
        return PubSub.publish(changes, undefined).pipe(Effect.asVoid);
      }),
    changes: PubSub.subscribe(changes),
    resume: (installationId) => Effect.suspend(() => resume?.(installationId) ?? Effect.void),
    handleResume: (handler) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          resume = handler;
        }),
        () =>
          Effect.sync(() => {
            if (resume === handler) resume = undefined;
          }),
      ),
  });
});

export const layer = Layer.effect(PluginEventDelivery, make);
