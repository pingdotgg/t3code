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
  type SandboxSaveTemplateInput,
  type SandboxSaveTemplateResult,
  type SandboxDeleteTemplateInput,
  type SandboxStopResult,
  type SandboxTemplatesInput,
  type SandboxTemplatesResult,
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
    echo "$!" >"$HOME/.t3/sandbox-server.pid"
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

// A template copies the disk, and T3's userdata holds the environment id, auth sessions, and secrets:
// a sandbox started from it would answer as the source with the source's valid bearer sessions.
// So the server stops, by the PID it started or the owner of its port, and its state is removed.
// The installed binary stays, so install on the new sandbox skips the download.
const SCRUB_SCRIPT = `set -eu
export PATH="$HOME/.local/bin:$PATH"
answering() { curl -fsS http://127.0.0.1:3773/.well-known/t3/environment >/dev/null 2>&1; }
# Uninstalling the unit also keeps it from starting T3 on every sandbox made from the template.
if command -v t3 >/dev/null 2>&1; then
  t3 service uninstall >/dev/null 2>&1 || true
fi
pids=""
if command -v ss >/dev/null 2>&1; then
  pids="$(ss -H -ltnp 'sport = :3773' 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)"
fi
if [ -f "$HOME/.t3/sandbox-server.pid" ]; then
  pids="$pids $(cat "$HOME/.t3/sandbox-server.pid")"
fi
for pid in $pids; do
  if tr '\\000' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'serve'; then
    kill "$pid" 2>/dev/null || true
  fi
done
i=0
while answering; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "T3 Code is still running, so its state was not removed." >&2
    exit 1
  fi
  sleep 1
done
rm -rf "$HOME/.t3/userdata" "$HOME/.t3/environment-label" "$HOME/.t3/usage-host-id"
rm -f "$HOME/.t3/sandbox-server.log" "$HOME/.t3/sandbox-server.pid"`;

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
    readonly templates: (
      input: SandboxTemplatesInput,
    ) => Effect.Effect<SandboxTemplatesResult, SandboxProviderError>;
    /**
     * Resets T3 on the sandbox, saves its disk as a template, and deletes it: the sandbox's T3
     * identity is gone, so it could only come back as a different environment.
     */
    readonly saveTemplate: (
      input: SandboxSaveTemplateInput,
    ) => Effect.Effect<SandboxSaveTemplateResult, SandboxProviderError>;
    readonly deleteTemplate: (
      input: SandboxDeleteTemplateInput,
    ) => Effect.Effect<void, SandboxProviderError>;
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

  // A settings patch needs the key, and merges `settings` per field, so a save writes the key and
  // every declared field; an empty value is how a field is cleared.
  const resolveConfig = Effect.fn("SandboxProvisioner.resolveConfig")(function* (
    driver: SandboxProviderDriver,
    provided: {
      readonly apiKey?: string | undefined;
      readonly settings?: Readonly<Record<string, string>> | undefined;
    } = {},
  ) {
    const provider = driver.info.kind;
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
    )).sandboxProviders[provider];
    const providedKey = provided.apiKey?.trim() ?? "";
    const apiKey = providedKey || (saved?.apiKey.trim() ?? "");
    const fields = driver.info.settingsFields ?? [];
    const savedValue = (id: string) => saved?.settings[id]?.trim() ?? "";
    const values = Object.fromEntries(
      fields.map((field) => [
        field.id,
        (provided.settings?.[field.id] ?? savedValue(field.id)).trim(),
      ]),
    );
    if (apiKey === "") {
      return yield* new SandboxProviderError({
        provider,
        stage: "config",
        detail: `Add a ${driver.info.label} API key to create this sandbox.`,
      });
    }
    if (providedKey !== "" || fields.some((field) => values[field.id] !== savedValue(field.id))) {
      yield* settings
        .updateSettings({ sandboxProviders: { [provider]: { apiKey, settings: values } } })
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
    }
    return {
      apiKey,
      settings: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")),
    } satisfies SandboxProviderConfig;
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
        ...(driver.info.settingsFields === undefined
          ? {}
          : { settings: value.sandboxProviders[driver.info.kind]?.settings ?? {} }),
        capabilities: {
          limits: driver.limits !== undefined,
          stopResume: driver.stop !== undefined && driver.resume !== undefined,
          credentialEnvironments: driver.listEnvironments !== undefined,
          extend: driver.extend !== undefined,
          templates:
            driver.saveTemplate !== undefined &&
            driver.listTemplates !== undefined &&
            driver.deleteTemplate !== undefined &&
            driver.stop !== undefined,
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
    const config = yield* resolveConfig(driver, { apiKey: input.apiKey, settings: input.settings });
    const label = input.label?.trim() || `${driver.info.label} sandbox`;
    if (input.environment !== undefined && input.allowCredentials !== true) {
      return yield* new SandboxProviderError({
        provider: input.provider,
        stage: "config",
        detail:
          "This sandbox would receive the credential environment's secrets. Confirm that explicitly first.",
      });
    }
    const template = input.template?.trim() || undefined;
    let size = input.size?.trim() || driver.defaultSize;
    if (template !== undefined) {
      if (driver.listTemplates === undefined) {
        return yield* new SandboxProviderError({
          provider: input.provider,
          stage: "config",
          detail: "This provider cannot start a sandbox from a template.",
        });
      }
      // Fails before anything bills when the template is gone, and the template decides the size.
      const listed = yield* onHttp(driver.listTemplates({ config }));
      const found = listed.templates.find((candidate) => candidate.name === template);
      if (found === undefined) {
        return yield* new SandboxProviderError({
          provider: input.provider,
          stage: "template",
          code: "not_found",
          detail: `${driver.info.label} has no template named ${template}.`,
        });
      }
      size = found.size ?? size;
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
        template,
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

    // A sandbox that answers with an id T3 already tracks was cloned with another environment's
    // identity and sessions; it must never be paired.
    const descriptor = yield* stopOnFailure(
      requestJson({
        provider: input.provider,
        stage: "pair",
        schema: ExecutionEnvironmentDescriptor,
        request: HttpClientRequest.get(
          `${httpBaseUrl.replace(/\/+$/, "")}/.well-known/t3/environment`,
        ),
      }).pipe(
        Effect.tap((described) =>
          records.get(described.environmentId).pipe(
            Effect.orDie,
            Effect.flatMap((existing) =>
              Option.isNone(existing)
                ? Effect.void
                : Effect.fail(
                    new SandboxProviderError({
                      provider: input.provider,
                      stage: "pair",
                      detail:
                        "The new sandbox answered as an environment that already exists, so it was deleted. Save the template again from a sandbox T3 Code set up.",
                    }),
                  ),
            ),
          ),
        ),
      ),
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
      ...(template === undefined ? {} : { template }),
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
      const config = yield* resolveConfig(driver);
      yield* onHttp(driver.destroy({ config, sandboxId: input.sandboxId })).pipe(
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
    const config = yield* resolveConfig(driver);
    const listed = yield* onHttp(driver.listEnvironments({ config }));
    return { environments: listed };
  });

  const limits = Effect.fn("SandboxProvisioner.limits")(function* (input: SandboxLimitsInput) {
    const driver = findDriver(input.provider);
    if (driver.limits === undefined) return { limits: null } satisfies SandboxLimitsResult;
    const config = yield* resolveConfig(driver).pipe(Effect.option);
    if (Option.isNone(config)) return { limits: null } satisfies SandboxLimitsResult;
    return {
      limits: yield* onHttp(driver.limits({ config: config.value })),
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
    const config = yield* resolveConfig(driver);
    yield* onHttp(driver.stop({ config, sandboxId: record.sandboxId }));
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
    const config = yield* resolveConfig(driver);
    // Providers such as Boat count a resume as a start, so it gets the same preflight as create.
    const limits = yield* preflightStart(driver, config, undefined);
    const resumed = yield* onHttp(
      driver.resume({
        config,
        sandboxId: record.sandboxId,
        // The provider's own TTL is a backstop; it must not outlive the record's deadline.
        ttlMinutes: Math.min(remainingMinutes, limits?.maxTtlMinutes ?? Infinity),
      }),
    );
    const httpBaseUrl = resumed.publicUrl ?? record.httpBaseUrl;
    yield* onHttp(
      driver.execute({
        config,
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
    // Saving a template resets T3 on its source; one that failed to save comes back as a different
    // environment, which the client's saved connection cannot reach.
    const described = yield* onHttp(
      requestJson({
        provider: record.provider,
        stage: "start",
        schema: ExecutionEnvironmentDescriptor,
        request: HttpClientRequest.get(
          `${httpBaseUrl.replace(/\/+$/, "")}/.well-known/t3/environment`,
        ),
      }),
    ).pipe(Effect.option);
    if (Option.isSome(described) && described.value.environmentId !== record.environmentId) {
      yield* records
        .put({ ...record, state: "error", updatedAt: now, httpBaseUrl })
        .pipe(Effect.orDie);
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "start",
        detail:
          "T3 Code on this sandbox was reset, so it cannot reconnect as this environment. Delete it.",
      });
    }
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
    const config = yield* resolveConfig(driver);
    const limits =
      driver.limits === undefined
        ? null
        : yield* onHttp(driver.limits({ config })).pipe(Effect.orElseSucceed(() => null));
    yield* onHttp(
      driver.extend({
        config,
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

  const templates = Effect.fn("SandboxProvisioner.templates")(function* (
    input: SandboxTemplatesInput,
  ) {
    const driver = findDriver(input.provider);
    if (driver.listTemplates === undefined)
      return { templates: [] } satisfies SandboxTemplatesResult;
    const config = yield* resolveConfig(driver).pipe(Effect.option);
    if (Option.isNone(config)) return { templates: [] } satisfies SandboxTemplatesResult;
    const listed = yield* onHttp(driver.listTemplates({ config: config.value }));
    return listed satisfies SandboxTemplatesResult;
  });

  const saveTemplate = Effect.fn("SandboxProvisioner.saveTemplate")(function* (
    input: SandboxSaveTemplateInput,
  ) {
    const record = yield* readRecord(input.environmentId);
    const driver = findDriver(record.provider);
    const { saveTemplate: save, stop: stopMachine } = driver;
    if (save === undefined || stopMachine === undefined) {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        detail: "This provider cannot save templates.",
      });
    }
    // The reset runs on the machine. Resuming here would spend a start nobody confirmed.
    if (record.state !== "running") {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        detail: "Only a running sandbox can be saved as a template. Resume it first.",
      });
    }
    const config = yield* resolveConfig(driver);
    // The provider refuses a save only after the reset would have run, so a plan that cannot save
    // is refused here first. Unknown limits let the save through, as with starts.
    const limits =
      driver.limits === undefined
        ? null
        : yield* onHttp(driver.limits({ config })).pipe(Effect.orElseSucceed(() => null));
    if (limits?.canSaveTemplates === false) {
      return yield* new SandboxProviderError({
        provider: record.provider,
        stage: "config",
        code: "templates_unavailable",
        detail: `Your ${driver.info.label} plan cannot save templates. Nothing on this sandbox changed.`,
      });
    }
    yield* onHttp(
      driver.execute({
        config,
        sandboxId: record.sandboxId,
        command: SCRUB_SCRIPT,
        timeoutSeconds: 120,
      }),
    );
    // From here T3's identity on the machine is gone, and resume refuses the different one it gets.
    const afterReset = (error: SandboxProviderError) =>
      new SandboxProviderError({
        provider: error.provider,
        stage: error.stage,
        detail: `${error.detail} T3 Code on this sandbox was already reset, so it cannot reconnect. Delete it.`,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
        cause: error,
      });
    yield* onHttp(stopMachine({ config, sandboxId: record.sandboxId })).pipe(
      Effect.mapError(afterReset),
    );
    yield* records
      .put({ ...record, state: "stopped", updatedAt: yield* nowIso })
      .pipe(Effect.orDie);
    const template = yield* onHttp(
      save({ config, sandboxId: record.sandboxId, name: input.name }),
    ).pipe(Effect.mapError(afterReset));
    yield* onHttp(driver.destroy({ config, sandboxId: record.sandboxId })).pipe(
      Effect.catchIf(
        (error) => error.code === "not_found",
        () => Effect.void,
      ),
      Effect.andThen(records.remove(record.environmentId).pipe(Effect.orDie)),
      // The template is saved either way; a sandbox that survives stays listed for a manual delete.
      Effect.catch((cause) =>
        Effect.logWarning("sandbox delete after saving a template failed", {
          environmentId: record.environmentId,
          sandboxId: record.sandboxId,
          cause,
        }),
      ),
    );
    return { template } satisfies SandboxSaveTemplateResult;
  });

  const deleteTemplate = Effect.fn("SandboxProvisioner.deleteTemplate")(function* (
    input: SandboxDeleteTemplateInput,
  ) {
    const driver = findDriver(input.provider);
    if (driver.deleteTemplate === undefined) {
      return yield* new SandboxProviderError({
        provider: input.provider,
        stage: "config",
        detail: "This provider cannot delete templates.",
      });
    }
    const config = yield* resolveConfig(driver);
    yield* onHttp(driver.deleteTemplate({ config, name: input.name }));
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
      const driver = findDriver(provider);
      const resolved = yield* resolveConfig(driver).pipe(Effect.option);
      if (Option.isNone(resolved)) continue;
      const config = resolved.value;
      configs.set(provider, config);
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
    templates,
    saveTemplate,
    deleteTemplate,
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
