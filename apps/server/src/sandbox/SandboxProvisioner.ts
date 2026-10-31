import {
  ExecutionEnvironmentDescriptor,
  type EnvironmentId,
  type SandboxCreateInput,
  type SandboxCreateResult,
  type SandboxCredentialEnvironment,
  type SandboxCredentialEnvironmentsInput,
  type SandboxCredentialEnvironmentsResult,
  type SandboxDeleteInput,
  type SandboxLifecycleInput,
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import { requestJson, shellQuote, type SandboxProviderDriver } from "./SandboxProvider.ts";
import { SANDBOX_PROVIDER_DRIVERS } from "./providers/index.ts";

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
if ! curl -fsS http://127.0.0.1:3773/.well-known/t3/environment >/dev/null 2>&1; then
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
    readonly list: Effect.Effect<SandboxListResult, SandboxProviderError>;
    readonly stop: (
      input: SandboxLifecycleInput,
    ) => Effect.Effect<SandboxStopResult, SandboxProviderError>;
    readonly resume: (
      input: SandboxLifecycleInput,
    ) => Effect.Effect<SandboxResumeResult, SandboxProviderError>;
    readonly sweepDeadlines: Effect.Effect<void>;
  }
>()("t3/sandbox/SandboxProvisioner") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const records = yield* SandboxRecords.SandboxRecordRepository;
  const httpClient = yield* HttpClient.HttpClient;
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
      })),
    })),
    Effect.orDie,
  );

  const create = Effect.fn("SandboxProvisioner.create")(function* (input: SandboxCreateInput) {
    const driver = findDriver(input.provider);
    const apiKey = yield* resolveApiKey(input.provider, input.apiKey);
    const config = { apiKey };
    const label = input.label?.trim() || `${driver.info.label} sandbox`;
    const size = input.size?.trim() || driver.defaultSize;
    const ttlMinutes = input.ttlMinutes ?? 480;
    if (input.environment !== undefined && input.allowCredentials !== true) {
      return yield* new SandboxProviderError({
        provider: input.provider,
        stage: "config",
        detail:
          "This sandbox would receive the credential environment's secrets. Confirm that explicitly first.",
      });
    }

    const sandbox = yield* onHttp(
      driver.create({
        config,
        name: label,
        size,
        ttlMinutes,
        environment: input.environment,
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
    const driver = findDriver(input.provider);
    const apiKey = yield* resolveApiKey(input.provider, undefined);
    yield* onHttp(driver.destroy({ config: { apiKey }, sandboxId: input.sandboxId }));
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
    const resumed = yield* onHttp(
      driver.resume({
        config: { apiKey },
        sandboxId: record.sandboxId,
        // The provider's own TTL is a backstop; it must not outlive the record's deadline.
        ttlMinutes: remainingMinutes,
      }),
    );
    const updated: SandboxRecord = {
      ...record,
      state: "running",
      updatedAt: now,
      httpBaseUrl: resumed.publicUrl ?? record.httpBaseUrl,
    };
    yield* records.put(updated).pipe(Effect.orDie);
    return { sandbox: updated, httpBaseUrl: updated.httpBaseUrl } satisfies SandboxResumeResult;
  });

  const sweepDeadlines = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const nowMillis = DateTime.toEpochMillis(now);
    const all = yield* records.list.pipe(Effect.orDie);
    for (const record of all) {
      if (record.state !== "running" || record.hardDeadlineAt === null) continue;
      if (DateTime.toEpochMillis(DateTime.makeUnsafe(record.hardDeadlineAt)) > nowMillis) continue;
      const driver = findDriver(record.provider);
      if (driver.stop === undefined) continue;
      const apiKey = yield* resolveApiKey(record.provider, undefined).pipe(Effect.option);
      if (Option.isNone(apiKey)) continue;
      yield* onHttp(
        driver.stop({ config: { apiKey: apiKey.value }, sandboxId: record.sandboxId }),
      ).pipe(
        Effect.tap(() =>
          records
            .put({ ...record, state: "stopped", updatedAt: DateTime.formatIso(now) })
            .pipe(Effect.orDie),
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
  });

  return SandboxProvisioner.of({
    providers,
    create,
    delete: remove,
    environments,
    list,
    stop,
    resume,
    sweepDeadlines,
  });
});

export const layer = Layer.effect(SandboxProvisioner, make);
