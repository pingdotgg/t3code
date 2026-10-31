import {
  assessSandboxStart,
  ExecutionEnvironmentDescriptor,
  type EnvironmentId,
  type SandboxCreateInput,
  type SandboxCreateResult,
  type SandboxCredentialEnvironment,
  type SandboxCredentialEnvironmentsInput,
  type SandboxCredentialEnvironmentsResult,
  type SandboxDeleteInput,
  type SandboxExtendInput,
  type SandboxExtendResult,
  type SandboxLifecycleInput,
  type SandboxLimitsInput,
  type SandboxLimitsResult,
  type SandboxListResult,
  type SandboxRecord,
  type SandboxResumeResult,
  type SandboxStopResult,
  SandboxProviderError,
  type SandboxProviderInfo,
  type SandboxProviderKind,
  type SandboxProvidersResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { HttpClient, HttpClientRequest } from "effect/http";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import {
  requestJson,
  shellQuote,
  type SandboxProviderConfig,
  type SandboxProviderDriver,
  type SandboxProviderStatus,
  type SandboxUsage,
} from "./SandboxProvider.ts";
import { SANDBOX_PROVIDER_DRIVERS } from "./providers/index.ts";

// Starts `t3 serve` only when nothing answers on its port, then waits for it. Shared by install and
// resume because providers without systemd do not bring the server back after a stop.
const SERVE_SCRIPT = `if ! curl -fsS http://127.0.0.1:3773/.well-known/t3/environment >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1 && t3 service install >/dev/null 2>&1; then
    sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
    t3 service restart >/dev/null 2>&1 || true
  else
    nohup t3 serve --host 0.0.0.0 --port 3773 >"$HOME/.t3/sandbox-server.log" 2>&1 &
  fi
fi
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS http://127.0.0.1:3773/.well-known/t3/environment >/dev/null 2>&1; then
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
tail -50 "$HOME/.t3/sandbox-server.log" >&2 || true
exit 1`;

const installScript = (label: string) => `set -eu
export PATH="$HOME/.local/bin:$PATH"
# The label file is read by \`t3 serve\` itself, so it works on providers without sudo, systemd,
# or a writable /etc/machine-info. The hostname is only a convenience for the machine's UI.
mkdir -p "$HOME/.t3"
printf '%s\n' ${shellQuote(label)} >"$HOME/.t3/environment-label"
if command -v hostnamectl >/dev/null 2>&1; then
  sudo -n hostnamectl set-hostname --pretty ${shellQuote(label)} 2>/dev/null || true
fi
if ! command -v t3 >/dev/null 2>&1; then
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL -o "$installer" https://t3.codes/install.sh
  sh "$installer"
  rm -f "$installer"
  trap - EXIT
fi
export PATH="$HOME/.local/bin:$PATH"
if ! command -v t3 >/dev/null 2>&1; then
  echo "The t3 CLI did not install." >&2
  exit 1
fi
${SERVE_SCRIPT}`;

const RESUME_SCRIPT = `set -eu
export PATH="$HOME/.local/bin:$PATH"
if ! command -v t3 >/dev/null 2>&1; then
  echo "The t3 CLI is missing." >&2
  exit 1
fi
${SERVE_SCRIPT}`;

const PAIR_SCRIPT = `set -eu
export PATH="$HOME/.local/bin:$PATH"
t3 pair --ttl 30m`;

const cloneScript = (repositoryUrl: string) => `set -eu
mkdir -p "$HOME/workspace"
cd "$HOME/workspace"
if [ ! -d .git ]; then
  git clone --depth 1 ${shellQuote(repositoryUrl)} .
fi`;

const parsePairingToken = (output: string): string | null => {
  const match = /^\s*Token:\s*(\S+)\s*$/mu.exec(output);
  return match?.[1] ?? null;
};

// `starting` has no record state, and an `error` record means T3 is not serving on a machine the
// provider reports running, so neither overwrites what the record says.
const reconcileState = (
  current: SandboxRecord["state"],
  status: SandboxProviderStatus | null,
): SandboxRecord["state"] =>
  status === null || status === "starting" || (current === "error" && status === "running")
    ? current
    : status;

const findDriver = (kind: SandboxProviderKind): SandboxProviderDriver => {
  const driver = SANDBOX_PROVIDER_DRIVERS.find((candidate) => candidate.info.kind === kind);
  if (driver === undefined) {
    throw new Error(`No sandbox provider driver is registered for '${kind}'.`);
  }
  return driver;
};

export class SandboxProvisioner extends Context.Service<
  SandboxProvisioner,
  {
    readonly providers: Effect.Effect<SandboxProvidersResult>;
    readonly create: (
      input: SandboxCreateInput,
    ) => Effect.Effect<SandboxCreateResult, SandboxProviderError>;
    readonly delete: (input: SandboxDeleteInput) => Effect.Effect<void, SandboxProviderError>;
    readonly environments: (
      input: SandboxCredentialEnvironmentsInput,
    ) => Effect.Effect<SandboxCredentialEnvironmentsResult, SandboxProviderError>;
    readonly limits: (
      input: SandboxLimitsInput,
    ) => Effect.Effect<SandboxLimitsResult, SandboxProviderError>;
    readonly list: Effect.Effect<SandboxListResult, SandboxProviderError>;
    readonly stop: (
      input: SandboxLifecycleInput,
    ) => Effect.Effect<SandboxStopResult, SandboxProviderError>;
    readonly resume: (
      input: SandboxLifecycleInput,
    ) => Effect.Effect<SandboxResumeResult, SandboxProviderError>;
    readonly extend: (
      input: SandboxExtendInput,
    ) => Effect.Effect<SandboxExtendResult, SandboxProviderError>;
    /** Stops sandboxes past their deadline and syncs every other record with its provider. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/sandbox/SandboxProvisioner") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const records = yield* SandboxRecords.SandboxRecordRepository;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const onHttp = Effect.provideService(HttpClient.HttpClient, httpClient);

  const resolveApiKey = Effect.fn("SandboxProvisioner.resolveApiKey")(function* (
    provider: SandboxProviderKind,
    apiKey: string | undefined,
  ) {
    const provided = apiKey?.trim() ?? "";
    if (provided !== "") {
      yield* settings
        .updateSettings({
          sandboxProviders: { [provider]: { apiKey: provided } },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SandboxProviderError({
                provider,
                stage: "config",
                detail: "Could not save the provider API key on this server.",
                cause,
              }),
          ),
        );
      return provided;
    }
    const saved = (yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new SandboxProviderError({
            provider,
            stage: "config",
            detail: "Could not read the provider API key from this server's settings.",
            cause,
          }),
      ),
    )).sandboxProviders[provider]?.apiKey.trim();
    if (saved === undefined || saved === "") {
      return yield* new SandboxProviderError({
        provider,
        stage: "config",
        detail: `Add a ${provider} API key to create this sandbox.`,
      });
    }
    return saved;
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const readRecord = (environmentId: EnvironmentId) =>
    records
      .get(environmentId)
      .pipe(
        Effect.orDie,
        Effect.map(
          Option.getOrThrowWith(
            () => new Error(`No sandbox record exists for environment ${environmentId}.`),
          ),
        ),
      );

  const providers = settings.getSettings.pipe(
    Effect.map((value): SandboxProvidersResult => ({
      providers: SANDBOX_PROVIDER_DRIVERS.map((driver): SandboxProviderInfo => ({
        ...driver.info,
        configured: (value.sandboxProviders[driver.info.kind]?.apiKey.trim() ?? "") !== "",
        capabilities: {
          limits: driver.limits !== undefined,
          stopResume: driver.stop !== undefined && driver.resume !== undefined,
          credentialEnvironments: driver.listEnvironments !== undefined,
          extend: driver.extend !== undefined,
        },
      })),
    })),
    Effect.orDie,
  );

  // Refuses a start the provider would refuse or that cannot fit, before anything bills. Limits that
  // cannot be read never block: the provider stays the authority and reports its own error.
  const preflightStart = Effect.fn("SandboxProvisioner.preflightStart")(function* (
    driver: SandboxProviderDriver,
    config: SandboxProviderConfig,
    size: string | undefined,
  ) {
    if (driver.limits === undefined) return null;
    const limits = yield* onHttp(driver.limits({ config })).pipe(Effect.orElseSucceed(() => null));
    if (limits === null) return null;
    const { blocked } = assessSandboxStart(limits, {
      providerLabel: driver.info.label,
      nowMillis: DateTime.toEpochMillis(yield* DateTime.now),
      ...(size === undefined ? {} : { size }),
    });
    if (blocked !== null) {
      return yield* new SandboxProviderError({
        provider: driver.info.kind,
        stage: "config",
        code: blocked.code,
        detail: blocked.reason,
        ...(blocked.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: blocked.retryAfterSeconds }),
      });
    }
    return limits;
  });

  const create = Effect.fn("SandboxProvisioner.create")(function* (input: SandboxCreateInput) {
    const driver = findDriver(input.provider);
    const apiKey = yield* resolveApiKey(input.provider, input.apiKey);
    const config = { apiKey };
    const label = input.label?.trim() || `${driver.info.label} sandbox`;
    const size = input.size?.trim() || driver.defaultSize;
    if (input.environment !== undefined && input.allowCredentials !== true) {
      return yield* new SandboxProviderError({
        provider: input.provider,
        stage: "config",
        detail:
          "This sandbox would receive the credential environment's secrets. Confirm that explicitly first.",
      });
    }
    const limits = yield* preflightStart(driver, config, size);
    // The record keeps the clamped lifetime, so its deadline matches what the provider enforces.
    const ttlMinutes = Math.min(input.ttlMinutes ?? 480, limits?.maxTtlMinutes ?? Infinity);

    const idempotencyKey = yield* crypto.randomUUIDv4().pipe(
      Effect.mapError(
        (cause) =>
          new SandboxProviderError({
            provider: input.provider,
            stage: "create",
            detail: "Could not generate a request id for the provider.",
            cause,
          }),
      ),
    );
    const sandbox = yield* onHttp(
      driver.create({
        config,
        name: label,
        size,
        ttlMinutes,
        environment: input.environment,
        idempotencyKey,
      }),
    );

    // A machine that costs money must not survive a failure or an interruption (a client
    // disconnecting mid-install interrupts this fiber), so cleanup runs on every non-success exit.
    const stopOnFailure = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
      onHttp(effect).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : onHttp(driver.destroy({ config, sandboxId: sandbox.id })).pipe(Effect.ignore),
        ),
      );

    const httpBaseUrl = yield* stopOnFailure(
      sandbox.publicUrl === undefined
        ? driver.exposePort({ config, sandboxId: sandbox.id, port: driver.serverPort })
        : Effect.succeed(sandbox.publicUrl),
    );

    if (input.repositoryUrl !== undefined && input.repositoryUrl.trim() !== "") {
      yield* stopOnFailure(
        driver.execute({
          config,
          sandboxId: sandbox.id,
          command: cloneScript(input.repositoryUrl.trim()),
          timeoutSeconds: 300,
        }),
      );
    }

    yield* stopOnFailure(
      driver.execute({
        config,
        sandboxId: sandbox.id,
        command: installScript(label),
        timeoutSeconds: 600,
      }),
    );

    const pairingCode = yield* stopOnFailure(
      driver
        .execute({
          config,
          sandboxId: sandbox.id,
          command: PAIR_SCRIPT,
          timeoutSeconds: 60,
        })
        .pipe(
          Effect.flatMap((paired) => {
            const code = parsePairingToken(paired.stdout);
            return code === null
              ? Effect.fail(
                  new SandboxProviderError({
                    provider: input.provider,
                    stage: "pair",
                    detail: "The sandbox did not return a pairing code.",
                  }),
                )
              : Effect.succeed(code);
          }),
        ),
    );

    const descriptor = yield* stopOnFailure(
      requestJson({
        provider: input.provider,
        stage: "pair",
        schema: ExecutionEnvironmentDescriptor,
        request: HttpClientRequest.get(
          `${httpBaseUrl.replace(/\/+$/, "")}/.well-known/t3/environment`,
        ),
      }),
    );
    const createdAt = yield* nowIso;
    const record: SandboxRecord = {
      environmentId: descriptor.environmentId,
      provider: input.provider,
      sandboxId: sandbox.id,
      label,
      size,
      state: "running",
      createdAt,
      updatedAt: createdAt,
      hardDeadlineAt: DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(createdAt), { minutes: ttlMinutes }),
      ),
      ttlMinutes,
      httpBaseUrl,
      ...(input.environment === undefined ? {} : { credentialEnvironment: input.environment }),
    };
    yield* records.put(record).pipe(Effect.orDie);

    return {
      provider: input.provider,
      sandboxId: sandbox.id,
      environmentId: descriptor.environmentId,
      label,
      httpBaseUrl,
      pairingCode,
    } satisfies SandboxCreateResult;
  });

  const remove = Effect.fn("SandboxProvisioner.delete")(function* (input: SandboxDeleteInput) {
    const record = yield* records.get(input.environmentId).pipe(Effect.orDie);
    if (Option.isNone(record) || record.value.state !== "deleted") {
      const driver = findDriver(input.provider);
      const apiKey = yield* resolveApiKey(input.provider, undefined);
      yield* onHttp(driver.destroy({ config: { apiKey }, sandboxId: input.sandboxId })).pipe(
        // Deleted from the provider's dashboard before the sweep noticed: the record still goes.
        Effect.catchIf(
          (error) => error.code === "not_found",
          () => Effect.void,
        ),
      );
    }
    yield* records.remove(input.environmentId).pipe(Effect.orDie);
  });

  const environments = Effect.fn("SandboxProvisioner.environments")(function* (
    input: SandboxCredentialEnvironmentsInput,
  ) {
    const driver = findDriver(input.provider);
    if (driver.listEnvironments === undefined) {
      return { environments: [] as ReadonlyArray<SandboxCredentialEnvironment> };
    }
    const apiKey = yield* resolveApiKey(input.provider, undefined);
    const listed = yield* onHttp(driver.listEnvironments({ config: { apiKey } }));
    return { environments: listed };
  });

  const limits = Effect.fn("SandboxProvisioner.limits")(function* (input: SandboxLimitsInput) {
    const driver = findDriver(input.provider);
    if (driver.limits === undefined) return { limits: null } satisfies SandboxLimitsResult;
    const apiKey = yield* resolveApiKey(input.provider, undefined).pipe(Effect.option);
    if (Option.isNone(apiKey)) return { limits: null } satisfies SandboxLimitsResult;
    return {
      limits: yield* onHttp(driver.limits({ config: { apiKey: apiKey.value } })),
    } satisfies SandboxLimitsResult;
  });

  const list = records.list.pipe(
    Effect.orDie,
    Effect.map((sandboxes): SandboxListResult => ({ sandboxes })),
  );

  const stop = Effect.fn("SandboxProvisioner.stop")(function* (input: SandboxLifecycleInput) {
    const record = yield* readRecord(input.environmentId);
    const driver = findDriver(record.provider);
    if (driver.stop === undefined) {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        detail: "This provider cannot stop a sandbox.",
      });
    }
    const apiKey = yield* resolveApiKey(record.provider, undefined);
    yield* onHttp(driver.stop({ config: { apiKey }, sandboxId: record.sandboxId }));
    const updated: SandboxRecord = {
      ...record,
      state: "stopped",
      updatedAt: yield* nowIso,
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return { sandbox: updated } satisfies SandboxStopResult;
  });

  const resume = Effect.fn("SandboxProvisioner.resume")(function* (input: SandboxLifecycleInput) {
    const record = yield* readRecord(input.environmentId);
    const driver = findDriver(record.provider);
    if (record.state === "expired" || record.state === "deleted") {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "start",
        code: record.state === "expired" ? "snapshot_expired" : "not_found",
        detail:
          record.state === "expired"
            ? `${driver.info.label} no longer keeps this stopped sandbox's disk. Delete it and create a new one.`
            : `${driver.info.label} no longer has this sandbox. Delete it and create a new one.`,
      });
    }
    if (driver.resume === undefined) {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        detail: "This provider cannot resume a sandbox.",
      });
    }
    // The deadline is the sandbox's lifetime, not a per-resume window: stopping and resuming must
    // not hand back another full TTL, or the hard limit would never bind.
    const now = yield* nowIso;
    if (
      record.hardDeadlineAt !== null &&
      DateTime.toEpochMillis(DateTime.makeUnsafe(record.hardDeadlineAt)) <=
        DateTime.toEpochMillis(DateTime.makeUnsafe(now))
    ) {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "start",
        detail: `This sandbox reached its ${Math.round((record.ttlMinutes / 60) * 10) / 10}-hour limit. Delete it and create a new one.`,
      });
    }
    const remainingMinutes =
      record.hardDeadlineAt === null
        ? record.ttlMinutes
        : Math.max(
            1,
            Math.ceil(
              (DateTime.toEpochMillis(DateTime.makeUnsafe(record.hardDeadlineAt)) -
                DateTime.toEpochMillis(DateTime.makeUnsafe(now))) /
                60_000,
            ),
          );
    const apiKey = yield* resolveApiKey(record.provider, undefined);
    // Providers such as Boat count a resume as a start, so it gets the same preflight as create.
    const limits = yield* preflightStart(driver, { apiKey }, undefined);
    const resumed = yield* onHttp(
      driver.resume({
        config: { apiKey },
        sandboxId: record.sandboxId,
        // The provider's own TTL is a backstop; it must not outlive the record's deadline.
        ttlMinutes: Math.min(remainingMinutes, limits?.maxTtlMinutes ?? Infinity),
      }),
    );
    const httpBaseUrl = resumed.publicUrl ?? record.httpBaseUrl;
    yield* onHttp(
      driver.execute({
        config: { apiKey },
        sandboxId: record.sandboxId,
        command: RESUME_SCRIPT,
        timeoutSeconds: 180,
      }),
    ).pipe(
      Effect.catch((cause) =>
        records.put({ ...record, state: "error", updatedAt: now, httpBaseUrl }).pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.fail(
              new SandboxProviderError({
                provider: record.provider,
                stage: "start",
                detail: "The sandbox resumed, but T3 Code did not start on it.",
                cause,
              }),
            ),
          ),
        ),
      ),
    );
    const updated: SandboxRecord = {
      ...record,
      state: "running",
      updatedAt: now,
      httpBaseUrl,
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return { sandbox: updated, httpBaseUrl: updated.httpBaseUrl } satisfies SandboxResumeResult;
  });

  const extend = Effect.fn("SandboxProvisioner.extend")(function* (input: SandboxExtendInput) {
    const record = yield* readRecord(input.environmentId);
    const driver = findDriver(record.provider);
    const refuse = (detail: string) =>
      Effect.fail(new SandboxProviderError({ provider: record.provider, stage: "config", detail }));
    if (driver.extend === undefined) {
      return yield* refuse("This provider cannot extend a sandbox.");
    }
    if (record.state !== "running" && record.state !== "stopped") {
      return yield* refuse("Only a running or stopped sandbox can be extended.");
    }
    if (record.hardDeadlineAt === null) {
      return yield* refuse("This sandbox has no lifetime limit to extend.");
    }
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const deadlineMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(record.hardDeadlineAt));
    if (deadlineMillis <= nowMillis) {
      return yield* refuse(
        `This sandbox reached its ${Math.round((record.ttlMinutes / 60) * 10) / 10}-hour limit. Delete it and create a new one.`,
      );
    }
    const cap = (yield* settings.getSettings.pipe(Effect.orDie)).sandboxLifetimeCapMinutes;
    // `ttlMinutes` is the lifetime from creation to the deadline, so the cap bounds it directly.
    const granted = Math.min(input.minutes, cap - record.ttlMinutes);
    if (granted <= 0) {
      return yield* refuse(
        `This sandbox is at the ${Math.round((cap / 60) * 10) / 10}-hour lifetime limit set in Settings.`,
      );
    }
    const deadline = deadlineMillis + granted * 60_000;
    const apiKey = yield* resolveApiKey(record.provider, undefined);
    const limits =
      driver.limits === undefined
        ? null
        : yield* onHttp(driver.limits({ config: { apiKey } })).pipe(
            Effect.orElseSucceed(() => null),
          );
    yield* onHttp(
      driver.extend({
        config: { apiKey },
        sandboxId: record.sandboxId,
        // A plan that caps auto-stop lower stops the machine early; T3's deadline still stands.
        ttlMinutes: Math.min(
          Math.ceil((deadline - nowMillis) / 60_000),
          limits?.maxTtlMinutes ?? Infinity,
        ),
        running: record.state === "running",
      }),
    );
    const updated: SandboxRecord = {
      ...record,
      ttlMinutes: record.ttlMinutes + granted,
      hardDeadlineAt: DateTime.formatIso(DateTime.makeUnsafe(deadline)),
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMillis)),
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return { sandbox: updated } satisfies SandboxExtendResult;
  });

  // The sweep reads records, then waits on the provider; a user action in between wins.
  const putIfUnchanged = Effect.fn("SandboxProvisioner.putIfUnchanged")(function* (
    read: SandboxRecord,
    next: SandboxRecord,
  ) {
    const current = yield* records.get(read.environmentId);
    if (Option.isNone(current)) return;
    if (current.value.updatedAt !== read.updatedAt || current.value.state !== read.state) return;
    yield* records.put(next);
  }, Effect.orDie);

  const sweepRecord = Effect.fn("SandboxProvisioner.sweepRecord")(function* (
    record: SandboxRecord,
    config: SandboxProviderConfig,
    cost: SandboxUsage | undefined,
    now: DateTime.Utc,
  ) {
    const driver = findDriver(record.provider);
    const withCost: SandboxRecord =
      cost === undefined ? record : { ...record, costDollars: cost.dollars, costSince: cost.since };
    const pastDeadline =
      record.hardDeadlineAt !== null &&
      DateTime.toEpochMillis(DateTime.makeUnsafe(record.hardDeadlineAt)) <=
        DateTime.toEpochMillis(now);
    // A resume that could not start T3 leaves the machine running (and billing) as `error`.
    if (pastDeadline && (record.state === "running" || record.state === "error") && driver.stop) {
      return yield* onHttp(driver.stop({ config, sandboxId: record.sandboxId })).pipe(
        Effect.andThen(
          putIfUnchanged(record, {
            ...withCost,
            state: "stopped",
            updatedAt: DateTime.formatIso(now),
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("sandbox deadline stop failed", {
            environmentId: record.environmentId,
            sandboxId: record.sandboxId,
            cause,
          }),
        ),
      );
    }
    // An unreachable provider says nothing about the machine, so the record keeps its state.
    const status =
      driver.status === undefined
        ? null
        : yield* onHttp(driver.status({ config, sandboxId: record.sandboxId })).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("sandbox status check failed", {
                environmentId: record.environmentId,
                sandboxId: record.sandboxId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
    const state = reconcileState(record.state, status);
    if (state !== record.state) {
      yield* putIfUnchanged(record, { ...withCost, state, updatedAt: DateTime.formatIso(now) });
    } else if (
      withCost.costDollars !== record.costDollars ||
      withCost.costSince !== record.costSince
    ) {
      // Cost alone is not a lifecycle change, so it keeps `updatedAt` and the list order.
      yield* putIfUnchanged(record, withCost);
    }
  });

  const sweep = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const live = (yield* records.list.pipe(Effect.orDie)).filter(
      (record) => record.state !== "deleted",
    );
    const configs = new Map<SandboxProviderKind, SandboxProviderConfig>();
    const costs = new Map<SandboxProviderKind, ReadonlyMap<string, SandboxUsage>>();
    for (const provider of new Set(live.map((record) => record.provider))) {
      const apiKey = yield* resolveApiKey(provider, undefined).pipe(Effect.option);
      if (Option.isNone(apiKey)) continue;
      const config = { apiKey: apiKey.value };
      configs.set(provider, config);
      const driver = findDriver(provider);
      if (driver.usage === undefined) continue;
      yield* onHttp(driver.usage({ config })).pipe(
        Effect.tap((usage) => Effect.sync(() => costs.set(provider, usage))),
        Effect.catch((cause) =>
          Effect.logWarning("sandbox usage read failed", { provider, cause }),
        ),
      );
    }
    yield* Effect.forEach(
      live,
      (record) => {
        const config = configs.get(record.provider);
        return config === undefined
          ? Effect.void
          : sweepRecord(record, config, costs.get(record.provider)?.get(record.sandboxId), now);
      },
      { concurrency: 4, discard: true },
    );
  });

  return SandboxProvisioner.of({
    providers,
    create,
    delete: remove,
    environments,
    limits,
    list,
    stop,
    resume,
    extend,
    sweep,
  });
});

export const layer = Layer.effect(SandboxProvisioner, make);

export const layerSweep = Layer.effectDiscard(
  Effect.gen(function* () {
    const provisioner = yield* SandboxProvisioner;
    yield* forkParked(
      provisioner.sweep.pipe(
        Effect.catchCause((cause) => Effect.logWarning("sandbox sweep failed", { cause })),
        Effect.repeat(Schedule.spaced("1 minute")),
      ),
    );
  }),
);
