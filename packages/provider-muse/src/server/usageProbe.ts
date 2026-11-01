import type { MuseSettings } from "../settings.ts";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { DEFAULT_TIMEOUT_MS, spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import { MuseSubscriptionUsage } from "./protocol.ts";
import { compareMuseVersions } from "./maintenance.ts";
import {
  museStatusUsageLimits,
  nextMuseUsageAccount,
  type MuseUsageAccount,
} from "./usageLimits.ts";

const decodeUsage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      allowance: Schema.NullOr(
        Schema.Struct({
          asOfMs: MuseSubscriptionUsage.fields.observedAtMs,
          tier: Schema.String,
          window: Schema.Struct({
            usedPercent: MuseSubscriptionUsage.fields.window.fields.usedPercent,
            resetsAtMs: MuseSubscriptionUsage.fields.window.fields.resetsAtMs,
          }),
          weekly: MuseSubscriptionUsage.fields.weekly,
        }),
      ),
    }),
  ),
);

const readMuseUsage = Effect.fn("MuseUsageProbe.read")(
  function* (settings: MuseSettings, environment: NodeJS.ProcessEnv, cwd?: string) {
    const command = yield* resolveSpawnCommand(settings.binaryPath, ["usage", "--json"], {
      env: environment,
    });
    const result = yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(command.command, command.args, {
        env: environment,
        shell: command.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
    if (result.code !== 0) return undefined;
    const { allowance } = yield* decodeUsage(result.stdout);
    if (!allowance) return undefined;
    return {
      observedAtMs: allowance.asOfMs,
      tier: allowance.tier,
      // CLI schema v1 omits duration; Meta's session allowance is a five-hour window.
      window: { ...allowance.window, windowDurationMins: 300 },
      weekly: allowance.weekly,
    } satisfies MuseSubscriptionUsage;
  },
  Effect.timeout(DEFAULT_TIMEOUT_MS),
  Effect.orElseSucceed(() => undefined),
);

export interface MuseUsageReport {
  readonly usage: MuseSubscriptionUsage;
  readonly generation: number;
}

export interface MuseUsageState {
  readonly account: Ref.Ref<MuseUsageAccount>;
  readonly latestUsage: Ref.Ref<MuseUsageReport | undefined>;
  readonly permit: Semaphore.Semaphore;
}

export const refreshMuseUsage = Effect.fn("MuseUsageProbe.refresh")(function* (input: {
  readonly settings: MuseSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly provider: ServerProviderDraft;
  readonly state: MuseUsageState;
}) {
  const { provider, state } = input;
  const { account: initialAccount, dropped } = yield* state.permit.withPermits(1)(
    Effect.gen(function* () {
      const account = nextMuseUsageAccount(yield* Ref.get(state.account), provider.auth);
      const latest = yield* Ref.get(state.latestUsage);
      const dropped = latest !== undefined && latest.generation !== account.generation;
      yield* Ref.set(state.account, account);
      if (dropped) yield* Ref.set(state.latestUsage, undefined);
      return { account, dropped };
    }),
  );
  const canRead =
    provider.enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.auth.status === "authenticated" &&
    provider.auth.type === "accountLogin" &&
    initialAccount.identity != null &&
    provider.version !== null &&
    compareMuseVersions(provider.version, "1.4.13") >= 0;
  // Network I/O must not hold the permit shared with inline usage notifications.
  const usage = canRead
    ? yield* readMuseUsage(input.settings, input.environment, input.cwd)
    : undefined;
  return yield* state.permit.withPermits(1)(
    Effect.gen(function* () {
      const currentAccount = yield* Ref.get(state.account);
      const previous = yield* Ref.get(state.latestUsage);
      // Another refresh changed accounts while this CLI read was in flight.
      if (currentAccount !== initialAccount) {
        return {
          account: currentAccount,
          latestUsage: previous,
          provider: { ...provider, usageLimits: undefined },
        };
      }
      const account = currentAccount;
      let latestUsage = previous;
      if (usage && (!latestUsage || usage.observedAtMs > latestUsage.usage.observedAtMs)) {
        latestUsage = { usage, generation: account.generation };
      }
      const usageLimits = museStatusUsageLimits({
        auth: provider.auth,
        enabled: provider.enabled,
        observation: latestUsage?.usage,
        dropped,
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
      });
      yield* Ref.set(state.account, account);
      yield* Ref.set(state.latestUsage, latestUsage);
      return { account, latestUsage, provider: { ...provider, usageLimits } };
    }),
  );
});
