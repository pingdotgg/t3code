/**
 * ProviderUsageRefresher — the on-demand usage feed.
 *
 * Clients call this from ambient triggers (window focus, thread opened,
 * meter hovered). Debouncing lives here rather than in each client so three
 * clients hovering the same meter at once produce one upstream call.
 *
 * Only Claude needs a pull. Codex volunteers its numbers over the
 * app-server connection — on every turn while a session is live, and once
 * per status probe otherwise — so a separate pull would spawn a process to
 * learn something already on its way.
 *
 * @module ProviderUsageRefresher
 */
import {
  ClaudeSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";

import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import { resolveClaudeConfigDirPath } from "./Drivers/ClaudeSkills.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { fetchClaudeUsage, readClaudeAccessToken } from "./claudeUsageFetch.ts";
import { ProviderUsageLimitsStore } from "./ProviderUsageLimits.ts";
import { normalizeClaudeUsage } from "./usageLimits.ts";

export class ProviderUsageRefresher extends Context.Service<
  ProviderUsageRefresher,
  {
    /**
     * Pull a fresh reading for one instance. Debounced per instance and
     * silently a no-op when the provider does not support pulls or the pull
     * fails — callers never need to handle an error.
     */
    readonly refresh: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  }
>()("t3/provider/ProviderUsageRefresher") {}

const CLAUDE_AGENT = ProviderDriverKind.make("claudeAgent");
const CLAUDE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_AGENT);

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

export const make = Effect.gen(function* () {
  const layerScope = yield* Scope.Scope;
  const settingsService = yield* ServerSettingsService;
  const { cwd: workspaceCwd } = yield* ServerConfig;
  const usageStore = yield* ProviderUsageLimitsStore;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  /**
   * Resolve the Claude config for one configured instance, or `null` when
   * the instance is not a Claude instance at all. Explicit
   * `providerInstances` envelopes win; the legacy default instance falls
   * back to the single-instance-per-driver settings block.
   */
  const resolveClaudeSettings = Effect.fn("resolveClaudeSettings")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) {
      return null;
    }
    const envelope = settings.providerInstances[instanceId];
    if (envelope !== undefined) {
      if (envelope.driver !== CLAUDE_AGENT) {
        return null;
      }
      return yield* decodeClaudeSettings(envelope.config ?? {}).pipe(
        Effect.orElseSucceed(() => null),
      );
    }
    return instanceId === CLAUDE_DEFAULT_INSTANCE_ID ? settings.providers.claudeAgent : null;
  });

  const refreshClaude = Effect.fn("refreshClaudeUsage")(function* (
    instanceId: ProviderInstanceId,
    claudeSettings: ClaudeSettings,
  ) {
    // Snapshot the clear-generation before any credential work. The token
    // about to be read belongs to the configuration current *now*; if the
    // instance is rebuilt at any point after this line, `clear` bumps the
    // generation and the guarded `set` below drops the reading instead of
    // writing the old account's numbers onto the new instance. Snapshotting
    // any later would leave a gap where a rebuild lands between the token
    // read and the snapshot and the guard wrongly passes.
    const generation = yield* usageStore.generation(instanceId);
    // Resolve exactly the directory the spawned CLI would use — including
    // an ambient `CLAUDE_CONFIG_DIR` that `makeClaudeEnvironment` leaves
    // in place when the instance sets no `homePath`. Reading a different
    // directory than the CLI writes means authenticating as one account
    // and drawing meters for another. The workspace cwd matters for the
    // same reason: a relative `CLAUDE_CONFIG_DIR` resolves against the
    // spawned CLI's cwd, not the server's.
    const environment = yield* HostProcessEnvironment;
    const credentialsDir = yield* resolveClaudeConfigDirPath(
      claudeSettings,
      environment,
      workspaceCwd,
    );
    const accessToken = yield* readClaudeAccessToken(credentialsDir, {
      // The macOS keychain item is global and carries no instance
      // identity, so it may only stand in for the instance that has no
      // config-dir override of its own. Borrowing it for an explicitly
      // scoped instance would read another account's token.
      allowKeychain:
        claudeSettings.homePath.trim().length === 0 &&
        (environment.CLAUDE_CONFIG_DIR?.trim() ?? "").length === 0,
    });
    if (accessToken === null) {
      return;
    }
    // Claim only once a token is in hand: claiming earlier burns the
    // debounce window on a missing or expired token, which keeps the
    // meters blank for another minute after the user logs in. The claim
    // still precedes the upstream call, so concurrent callers collapse
    // into one HTTP request; the token read they each repeat is local.
    const claimed = yield* usageStore.claimRefreshSlot(instanceId);
    if (!claimed) {
      return;
    }
    const payload = yield* fetchClaudeUsage(accessToken);
    const usage = normalizeClaudeUsage(payload, DateTime.formatIso(yield* DateTime.now));
    if (usage === null) {
      return;
    }
    // The OAuth endpoint reports every bucket, so this is authoritative:
    // a window it omits really is gone.
    yield* usageStore.set(instanceId, usage, "full", { ifGenerationIs: generation });
  });

  const runRefresh = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const claudeSettings = yield* resolveClaudeSettings(instanceId);
      if (claudeSettings === null || !claudeSettings.enabled) {
        return;
      }
      yield* refreshClaude(instanceId, claudeSettings);
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      // Ambient telemetry: a failed reading keeps the last-known numbers
      // and never surfaces to the user.
      Effect.ignoreCause({ log: true }),
    );

  // Fork onto this layer's scope, not the caller's. A refresh can take up
  // to 15 seconds on the slow path (locked keychain, then a stalled HTTP
  // request), and callers are ambient UI triggers — a hover must not hold
  // an RPC open that long. Forking also decouples the work from the
  // client: a disconnect mid-refresh would otherwise interrupt the fiber
  // after `claimRefreshSlot` had already burned the 60s slot, leaving the
  // meters stale for a full minute with nothing in flight.
  const refresh = (instanceId: ProviderInstanceId) =>
    Effect.forkIn(runRefresh(instanceId), layerScope).pipe(Effect.asVoid);

  return { refresh } satisfies ProviderUsageRefresher["Service"];
});

export const layer = Layer.effect(ProviderUsageRefresher, make);
