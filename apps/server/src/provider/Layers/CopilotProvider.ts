import type {
  CopilotSettings,
  ServerProvider,
  ServerProviderAuthStatus,
  ServerProviderState,
} from "@t3tools/contracts";
import { CopilotClient, type CopilotClientOptions } from "@github/copilot-sdk";
import { Data, Effect, Equal, Layer, Result, Stream } from "effect";
import { COPILOT_BUILT_IN_MODELS } from "@t3tools/shared/copilot";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  providerModelsFromSettings,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { CopilotProvider } from "../Services/CopilotProvider";
import { ServerSettingsError, ServerSettingsService } from "../../serverSettings";
import { resolveCopilotRuntimeConfig } from "./copilotSdk";

const PROVIDER = "copilot" as const;
class CopilotProviderProbeError extends Data.TaggedError("CopilotProviderProbeError")<{
  cause: unknown;
}> {}
class CopilotProviderCommandMissingError extends Data.TaggedError(
  "CopilotProviderCommandMissingError",
)<{
  cause: unknown;
}> {}
class CopilotProviderTimeoutError extends Data.TaggedError("CopilotProviderTimeoutError") {}
const COPILOT_PROVIDER_TIMEOUT_CODE = "COPILOT_PROVIDER_TIMEOUT";
const COPILOT_PROVIDER_TIMEOUT_MESSAGE =
  "GitHub Copilot CLI health check timed out while starting the SDK client.";

const toProbeError = (cause: unknown): CopilotProviderProbeError =>
  new CopilotProviderProbeError({ cause });
const toCommandMissingError = (cause: unknown): CopilotProviderCommandMissingError =>
  new CopilotProviderCommandMissingError({ cause });
const toTimeoutError = (): CopilotProviderTimeoutError => new CopilotProviderTimeoutError();

const isCopilotProviderProbeTimeoutError = (cause: unknown): cause is Error & { code: string } =>
  cause instanceof Error && "code" in cause && cause.code === COPILOT_PROVIDER_TIMEOUT_CODE;

interface CopilotProviderStatusClientHandle {
  start(): Promise<void>;
  getStatus(): Promise<{ readonly version?: string | null } | undefined>;
  getAuthStatus(): Promise<
    | {
        readonly isAuthenticated?: boolean;
        readonly statusMessage?: string;
      }
    | undefined
  >;
  stop(): Promise<ReadonlyArray<Error>>;
}

export interface CheckCopilotProviderStatusOptions {
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotProviderStatusClientHandle;
  readonly timeoutMs?: number;
}

export const makeCheckCopilotProviderStatus = (options?: CheckCopilotProviderStatusOptions) =>
  Effect.fn("checkCopilotProviderStatus")(function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ServerSettingsService
  > {
    const copilotSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.copilot),
    );
    const checkedAt = new Date().toISOString();
    const models = providerModelsFromSettings(
      COPILOT_BUILT_IN_MODELS,
      PROVIDER,
      copilotSettings.customModels,
    );

    if (!copilotSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          authStatus: "unknown",
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
      });
    }

    const { clientOptions } = resolveCopilotRuntimeConfig(copilotSettings, undefined);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const probe = yield* Effect.result(
      Effect.tryPromise({
        try: async () => {
          const client =
            options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions);

          try {
            return await Promise.race([
              (async () => {
                await client.start();
                const [status, authStatus] = await Promise.all([
                  client.getStatus(),
                  client.getAuthStatus().catch(() => undefined),
                ]);
                return { status, authStatus };
              })(),
              new Promise<never>((_, reject) => {
                setTimeout(() => {
                  reject(
                    Object.assign(new Error(COPILOT_PROVIDER_TIMEOUT_MESSAGE), {
                      code: COPILOT_PROVIDER_TIMEOUT_CODE,
                    }),
                  );
                }, timeoutMs);
              }),
            ]);
          } finally {
            await client.stop().catch(() => undefined);
          }
        },
        catch: (cause) =>
          isCopilotProviderProbeTimeoutError(cause)
            ? toTimeoutError()
            : isCommandMissingCause(cause)
              ? toCommandMissingError(cause)
              : toProbeError(cause),
      }),
    );

    if (Result.isFailure(probe)) {
      const error = probe.failure;
      if (
        error instanceof CopilotProviderTimeoutError ||
        (error instanceof CopilotProviderProbeError &&
          isCopilotProviderProbeTimeoutError(error.cause))
      ) {
        return buildServerProvider({
          provider: PROVIDER,
          enabled: true,
          checkedAt,
          models,
          probe: {
            installed: true,
            version: null,
            status: "error",
            authStatus: "unknown",
            message: COPILOT_PROVIDER_TIMEOUT_MESSAGE,
          },
        });
      }
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: !(error instanceof CopilotProviderCommandMissingError),
          version: null,
          status: "error",
          authStatus: "unknown",
          message:
            error instanceof CopilotProviderCommandMissingError
              ? "GitHub Copilot CLI is not installed or could not be resolved."
              : `Failed to start GitHub Copilot CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    const authStatus: ServerProviderAuthStatus =
      probe.success.authStatus?.isAuthenticated === true
        ? "authenticated"
        : probe.success.authStatus?.isAuthenticated === false
          ? "unauthenticated"
          : "unknown";
    const status: Exclude<ServerProviderState, "disabled"> =
      authStatus === "unauthenticated" ? "error" : authStatus === "unknown" ? "warning" : "ready";

    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: probe.success.status?.version ?? null,
        status,
        authStatus,
        ...(probe.success.authStatus?.statusMessage
          ? { message: probe.success.authStatus.statusMessage }
          : probe.success.status?.version
            ? { message: `GitHub Copilot CLI ${probe.success.status.version}` }
            : {}),
      },
    });
  });

export const checkCopilotProviderStatus = makeCheckCopilotProviderStatus();

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;

    const checkProvider = checkCopilotProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
    );

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
