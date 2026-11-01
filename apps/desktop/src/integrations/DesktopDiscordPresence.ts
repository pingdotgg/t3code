import {
  DEFAULT_DISCORD_PRESENCE_FIELDS,
  type DesktopDiscordPresence as DiscordPresenceState,
  type DesktopDiscordPresenceStatus,
  type DiscordPresenceField,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { DiscordIpcClient, type DiscordActivity } from "./discord/discordIpc.ts";
import {
  DEFAULT_DISCORD_PRESENCE_BRANDING,
  discordActivityForPresence,
  resolveDiscordPresenceBranding,
  type DiscordPresenceBranding,
} from "./discord/presenceActivity.ts";

// Injected by the desktop build; absent under tests and unbundled runs.
declare const __T3CODE_BUILD_DISCORD_CLIENT_ID__: string | undefined;

/** The narrow surface the service needs, so tests can supply a fake client. */
export interface DiscordPresenceClient {
  readonly setActivity: (activity: DiscordActivity | null) => void;
  readonly close: () => void;
}

export interface DiscordPresenceConnectInput {
  readonly clientId: string;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly onClose: () => void;
}

export type DiscordPresenceConnector = (
  input: DiscordPresenceConnectInput,
) => Promise<DiscordPresenceClient>;

export interface DesktopDiscordPresenceOptions {
  readonly connector?: DiscordPresenceConnector;
  readonly clientId?: string;
  readonly fields?: ReadonlyArray<DiscordPresenceField>;
  readonly branding?: DiscordPresenceBranding;
  /** Called on every status transition. Defaults to a no-op, so tests stay Electron-free. */
  readonly onStatusChange?: (status: DesktopDiscordPresenceStatus) => void;
}

const defaultConnector: DiscordPresenceConnector = (input) => DiscordIpcClient.connect(input);

/** An environment override wins over the baked-in app id; empty disables the feature. */
function resolveDiscordClientId(environment: NodeJS.ProcessEnv): string {
  const override = environment.T3CODE_DISCORD_CLIENT_ID;
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return typeof __T3CODE_BUILD_DISCORD_CLIENT_ID__ === "undefined"
    ? ""
    : __T3CODE_BUILD_DISCORD_CLIENT_ID__.trim();
}

export class DesktopDiscordPresence extends Context.Service<
  DesktopDiscordPresence,
  {
    /** Publishes the summary, or clears presence when `null`. Best-effort. */
    readonly set: (presence: DiscordPresenceState | null) => Effect.Effect<void>;
    /** Sets which facts the activity presents; re-applies the current summary. */
    readonly configure: (fields: ReadonlyArray<DiscordPresenceField>) => Effect.Effect<void>;
    /** Current connection state, for the settings UI. */
    readonly getStatus: () => Effect.Effect<DesktopDiscordPresenceStatus>;
  }
>()("@t3tools/desktop/integrations/DesktopDiscordPresence") {}

export const make = Effect.fn("DesktopDiscordPresence.make")(function* (
  options: DesktopDiscordPresenceOptions = {},
) {
  const context = yield* Effect.context<never>();
  const runSync = Effect.runSyncWith(context);
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const clock = yield* Clock.Clock;
  const connector = options.connector ?? defaultConnector;
  const clientId = (options.clientId ?? resolveDiscordClientId(environment)).trim();
  const branding = options.branding ?? DEFAULT_DISCORD_PRESENCE_BRANDING;
  const sessionStartedAtMs = clock.currentTimeMillisUnsafe();
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const initialFields =
    options.fields ??
    (yield* clientSettings.get.pipe(
      Effect.map((stored) =>
        Option.match(stored, {
          onNone: () => DEFAULT_DISCORD_PRESENCE_FIELDS,
          onSome: (settings) => settings.discordPresenceFields,
        }),
      ),
      // Do not publish default fields when the user's saved selection cannot be read.
      Effect.orElseSucceed(() => []),
    ));

  const desired = yield* Ref.make<DiscordPresenceState | null>(null);
  const connection = yield* Ref.make<DiscordPresenceClient | null>(null);
  const applyMutex = yield* Semaphore.make(1);
  let connectionToken: object | null = null;
  const fields = yield* Ref.make<ReadonlyArray<DiscordPresenceField>>(initialFields);
  // `unconfigured` means this build has no Discord app id at all; otherwise we
  // are `connecting` until the first publish attempt resolves.
  const status = yield* Ref.make<DesktopDiscordPresenceStatus>(
    clientId.length === 0 ? "unconfigured" : "connecting",
  );
  const onStatusChange = options.onStatusChange;

  // Broadcasts only on an actual transition, so a long offline period logs once
  // per drop rather than once per publish attempt.
  const setStatus = (next: DesktopDiscordPresenceStatus): Effect.Effect<void> =>
    Ref.modify(status, (current) => (current === next ? [false, current] : [true, next])).pipe(
      Effect.flatMap((changed) =>
        changed
          ? Effect.gen(function* () {
              if (next === "disconnected") {
                yield* Effect.logWarning(
                  "Discord Rich Presence is unavailable; is the Discord desktop app running?",
                );
              }
              yield* Effect.sync(() => onStatusChange?.(next));
            })
          : Effect.void,
      ),
    );

  const clearConnection = Effect.gen(function* () {
    const client = yield* Ref.getAndSet(connection, null);
    connectionToken = null;
    if (client === null) return;
    // Clear before closing so Discord drops the status immediately rather than
    // waiting for the socket to be noticed as gone.
    yield* Effect.try(() => client.setActivity(null)).pipe(Effect.ignore);
    client.close();
    yield* setStatus("disconnected");
  });

  // Reuses the live socket, or connects once. None means Discord is unreachable.
  const ensureClient = Effect.gen(function* () {
    const existing = yield* Ref.get(connection);
    if (existing !== null) return Option.some(existing);
    const token = {};
    connectionToken = token;
    const connected = yield* Effect.tryPromise(() =>
      connector({
        clientId,
        platform,
        environment,
        // The socket is gone; drop it and report the disconnect so the next
        // apply reconnects.
        onClose: () => {
          if (connectionToken !== token) return;
          runSync(Ref.set(connection, null));
          runSync(setStatus("disconnected"));
        },
      }),
    ).pipe(Effect.option);
    if (Option.isNone(connected)) {
      yield* setStatus("disconnected");
      return Option.none<DiscordPresenceClient>();
    }
    yield* Ref.set(connection, connected.value);
    yield* setStatus("connected");
    return connected;
  });

  const applyOnce = Effect.gen(function* () {
    if ((yield* Ref.get(desired)) === null) {
      yield* clearConnection;
      return;
    }
    const client = yield* ensureClient;
    if (Option.isNone(client)) return;
    // Disabling or updating presence can happen while the connector is pending.
    const presence = yield* Ref.get(desired);
    if (presence === null) {
      yield* clearConnection;
      return;
    }
    const activeFields = yield* Ref.get(fields);
    const activity = discordActivityForPresence(
      presence,
      sessionStartedAtMs,
      activeFields,
      branding,
    );
    yield* Effect.sync(() => client.value.setActivity(activity));
  }).pipe(applyMutex.withPermits(1));

  const set = Effect.fn("desktop.discordPresence.set")(function* (
    presence: DiscordPresenceState | null,
  ) {
    // Without a registered Discord app id there is nothing to publish.
    if (clientId.length === 0) return;
    yield* Ref.set(desired, presence);
    yield* applyOnce.pipe(Effect.ignore);
  });

  const configure = Effect.fn("desktop.discordPresence.configure")(function* (
    requested: ReadonlyArray<DiscordPresenceField>,
  ) {
    const changed = yield* Ref.modify(fields, (current) =>
      Equal.equals(current, requested) ? [false, current] : [true, requested],
    );
    // Nothing else re-pushes on a field change, so re-render the current
    // summary with the new selection.
    if (changed) yield* applyOnce.pipe(Effect.ignore);
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Ref.set(desired, null);
      yield* applyMutex.withPermits(1)(clearConnection);
    }).pipe(Effect.ignore),
  );

  return DesktopDiscordPresence.of({
    set,
    configure,
    getStatus: Effect.fn("DesktopDiscordPresence.getStatus")(() => Ref.get(status)),
  });
});

export const layer = Layer.effect(
  DesktopDiscordPresence,
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runSync = Effect.runSyncWith(context);
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* make({
      branding: resolveDiscordPresenceBranding(environment),
      onStatusChange: (status) => {
        try {
          runSync(electronWindow.sendAll(IpcChannels.DISCORD_PRESENCE_STATUS_CHANNEL, status));
        } catch {
          // Status is advisory; a failed push must not break publishing.
        }
      },
    });
  }),
);
