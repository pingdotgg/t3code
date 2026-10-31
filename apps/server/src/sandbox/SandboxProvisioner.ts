import {
  type SandboxCreateInput,
  type SandboxCreateResult,
  type SandboxDeleteInput,
  SandboxProviderError,
  type SandboxProviderInfo,
  type SandboxProviderKind,
  type SandboxProvidersResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import type { SandboxProviderDriver } from "./SandboxProvider.ts";
import { SANDBOX_PROVIDER_DRIVERS } from "./providers/index.ts";

const INSTALL_SCRIPT = `set -eu
export PATH="$HOME/.local/bin:$PATH"
if ! command -v t3 >/dev/null 2>&1; then
  curl -fsSL https://t3.codes/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
if ! command -v t3 >/dev/null 2>&1; then
  echo "The t3 CLI did not install." >&2
  exit 1
fi
if ! curl -fsS http://127.0.0.1:3773/.well-known/t3/environment >/dev/null 2>&1; then
  nohup t3 serve --host 0.0.0.0 --port 3773 >"$HOME/.t3/sandbox-server.log" 2>&1 &
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

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
  }
>()("t3/sandbox/SandboxProvisioner") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
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
                detail: cause.message,
              }),
          ),
        );
      return provided;
    }
    const saved = (yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new SandboxProviderError({ provider, stage: "config", detail: cause.message }),
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

    const sandbox = yield* onHttp(
      driver.create({
        config,
        name: label,
        size,
        ttlMinutes: input.ttlMinutes,
      }),
    );

    const stopOnFailure = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
      onHttp(effect).pipe(
        Effect.tapError(() =>
          onHttp(driver.destroy({ config, sandboxId: sandbox.id })).pipe(Effect.ignore),
        ),
      );

    const httpBaseUrl = yield* onHttp(
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
        command: INSTALL_SCRIPT,
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

    return {
      provider: input.provider,
      sandboxId: sandbox.id,
      label,
      httpBaseUrl,
      pairingCode,
    } satisfies SandboxCreateResult;
  });

  const remove = Effect.fn("SandboxProvisioner.delete")(function* (input: SandboxDeleteInput) {
    const driver = findDriver(input.provider);
    const apiKey = yield* resolveApiKey(input.provider, undefined);
    yield* onHttp(driver.destroy({ config: { apiKey }, sandboxId: input.sandboxId }));
  });

  return SandboxProvisioner.of({
    providers,
    create,
    delete: remove,
  });
});

export const layer = Layer.effect(SandboxProvisioner, make);
