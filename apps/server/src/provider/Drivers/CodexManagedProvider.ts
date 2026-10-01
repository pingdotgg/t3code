import { ProviderDriverKind, TextGenerationError, type CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { chatGptModels } from "../CodexChatGptModels.ts";
import { makeCodexManagedRuntime } from "../CodexManagedRuntime.ts";
import { ProviderDriverError } from "../Errors.ts";
import { createCodexAdapterV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
} from "../CodexProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { type ProviderDriverCreateInput, type ProviderInstance } from "../ProviderDriver.ts";
import { codexContinuationIdentity } from "./CodexHomeLayout.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { HttpClient } from "effect/http";
const DRIVER = ProviderDriverKind.make("codex");

export const makeManagedCodexProvider = Effect.fn("makeManagedCodexProvider")(function* (
  input: ProviderDriverCreateInput<CodexSettings>,
) {
  const { instanceId, enabled, displayName, accentColor, config } = input;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* ServerSettingsService;
  const runtime = yield* makeCodexManagedRuntime({
    instanceId,
    enabled,
    config,
    environment: mergeProviderInstanceEnvironment(input.environment),
  });
  const continuationIdentity = codexContinuationIdentity(runtime.homeLayout);
  const stamp = withInstanceIdentity({
    instanceId,
    driverKind: DRIVER,
    displayName,
    accentColor,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const setup = { canAuthenticate: true, canInstall: true };
  const runtimePaths = {
    homePath: runtime.homeLayout.sharedHomePath,
    shadowHomePath: runtime.homeLayout.mode === "authOverlay" ? runtime.homePath : null,
  };
  // The instance envelope owns `enabled`; managed config never carries it.
  const pending = makePendingCodexProvider({ ...config, enabled, customModels: [] }).pipe(
    Effect.map((draft) =>
      stamp({
        ...draft,
        models: [],
        setup,
        runtimePaths,
      }),
    ),
  );
  const check = Effect.gen(function* () {
    const base = yield* pending;
    if (!enabled) return base;
    const executable = yield* runtime.installation.resolve().pipe(Effect.option);
    if (Option.isNone(executable))
      return {
        ...base,
        installed: false,
        models: [],
        message: "Set up Codex to get started.",
        auth: { status: "unauthenticated" as const },
      };
    const saved = yield* runtime.auth.read.pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(saved) && !saved.value.scopes.includes("chatgpt.tokens.use.direct"))
      return {
        ...base,
        installed: true,
        version: executable.value.version,
        models: [],
        message:
          "Signed in with ChatGPT, but token sharing is disabled. Sign in again and enable token sharing, or use another provider.",
        auth: {
          status: "unauthenticated" as const,
          label: "ChatGPT",
          ...(saved.value.email?.trim() ? { email: saved.value.email.trim() } : {}),
        },
      };
    if (Option.isNone(saved))
      return {
        ...base,
        installed: true,
        version: executable.value.version,
        models: [],
        message: "Sign in with ChatGPT to use Codex.",
        auth: { status: "unauthenticated" as const },
      };
    const usageLimits = {
      checkedAt: base.checkedAt,
      windows: [],
      unavailable: {
        reason: "unsupported" as const,
        message:
          "ChatGPT tracks subscription usage across connected apps. Open Usage settings with the account you connected to Codex.",
      },
      externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
    };
    const managedAuth = {
      subscriptionSharing: true,
      profileId: saved.value.clientId,
      status: "authenticated" as const,
      type: "chatgpt",
      label: "ChatGPT",
      ...(saved.value.email?.trim() ? { email: saved.value.email.trim() } : {}),
    };
    return yield* runtime.auth.controller.withAccess!(runtime.resolve).pipe(
      Effect.flatMap((effective) =>
        Effect.gen(function* () {
          const draft = yield* checkCodexProviderStatus(
            effective.config,
            undefined,
            effective.environment,
            managedAuth,
          );
          const models = yield* chatGptModels(
            effective.environment.ACCESS_TOKEN!,
            draft.models,
          ).pipe(Effect.provideService(HttpClient.HttpClient, http));
          return { ...draft, models };
        }),
      ),
      Effect.map((draft) =>
        stamp({
          ...draft,
          auth: managedAuth,
          version: draft.version ?? executable.value.version,
          usageLimits,
          models: draft.models.map((model) => ({
            ...model,
            ...(model.capabilities
              ? {
                  capabilities: {
                    ...model.capabilities,
                    optionDescriptors: (model.capabilities.optionDescriptors ?? []).filter(
                      (option) => option.id !== "serviceTier",
                    ),
                  },
                }
              : {}),
          })),
          setup,
          runtimePaths,
          ...(draft.slashCommands
            ? {
                slashCommands: draft.slashCommands.filter((command) => command.name !== "feedback"),
              }
            : {}),
        }),
      ),
      Effect.catch(() =>
        runtime.auth.read.pipe(
          Effect.orElseSucceed(() => Option.none()),
          Effect.map((current) => ({
            ...base,
            installed: true,
            version: executable.value.version,
            models: [],
            auth: {
              status:
                Option.isSome(current) && current.value.scopes.includes("chatgpt.tokens.use.direct")
                  ? ("authenticated" as const)
                  : ("unauthenticated" as const),
              label: "ChatGPT",
              ...(Option.isSome(current) &&
              current.value.scopes.includes("chatgpt.tokens.use.direct")
                ? { subscriptionSharing: true, profileId: current.value.clientId }
                : {}),
              ...(Option.isSome(current) && current.value.email?.trim()
                ? { email: current.value.email.trim() }
                : {}),
            },
            ...(Option.isSome(current) && current.value.scopes.includes("chatgpt.tokens.use.direct")
              ? { usageLimits }
              : {}),
            message: "Could not check Codex right now. Retry, or reconnect in provider settings.",
          })),
        ),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed({ provider: DRIVER, packageName: null, update: null }),
    getSettings: settings.getSettings,
    streamSettings: settings.streamChanges,
    haveSettingsChanged: () => false,
    initialSnapshot: () => pending,
    checkProvider: check,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Could not prepare managed Codex.",
          cause,
        }),
    ),
  );
  yield* runtime.auth.controller.subscribe("managed-codex-snapshot").pipe(
    // Disconnect also publishes idle when a saved account has no active sign-in flow.
    Stream.filter((state) => ["idle", "succeeded", "failed", "cancelled"].includes(state.phase)),
    // Sign-out closes the scope of an in-flight probe, which fails that refresh
    // with an interrupt. Keep listening so the sign-out's own idle still refreshes.
    Stream.runForEach(() => snapshot.refresh.pipe(Effect.ignoreCause({ log: true }))),
    Effect.forkScoped,
  );
  const resolveRuntime = runtime.auth.controller.withAccess!(runtime.resolve);
  // Launch settings resolve per session from the signed-in token. The registry
  // already wraps openSession in withAccess, so resolve without re-entering it.
  const orchestrationAdapter = yield* createCodexAdapterV2(input, {
    onUsageLimits: (update) => snapshot.applyUsageLimits(update),
    resolveRuntime: runtime.resolve,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Failed to build Codex orchestration adapter.",
          cause,
        }),
    ),
  );
  const nativeGeneration = yield* makeCodexTextGeneration(
    config,
    undefined,
    snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
    resolveRuntime,
  );
  const protect = <A>(operation: string, effect: Effect.Effect<A, TextGenerationError>) =>
    runtime.auth.controller.withAccess!(effect).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "detail" in cause ? cause.detail : "Codex text generation failed.",
          }),
      ),
    );
  const textGeneration: ProviderInstance["textGeneration"] = {
    generateCommitMessage: (value) =>
      protect("generateCommitMessage", nativeGeneration.generateCommitMessage(value)),
    generatePrContent: (value) =>
      protect("generatePrContent", nativeGeneration.generatePrContent(value)),
    generateBranchName: (value) =>
      protect("generateBranchName", nativeGeneration.generateBranchName(value)),
    generateThreadTitle: (value) =>
      protect("generateThreadTitle", nativeGeneration.generateThreadTitle(value)),
  };
  return {
    instanceId,
    driverKind: DRIVER,
    continuationIdentity,
    displayName,
    accentColor,
    enabled,
    snapshot,
    orchestrationAdapter,
    textGeneration,
    auth: runtime.auth.controller,
    snapshotForCwd: (cwd: string) =>
      enabled
        ? resolveRuntime.pipe(
            Effect.flatMap((effective) =>
              probeCodexSkillsForCwd({
                binaryPath: effective.config.binaryPath,
                homePath: effective.config.homePath,
                launchArgs: effective.config.launchArgs,
                cwd,
                environment: effective.environment,
              }),
            ),
            Effect.flatMap((skills) =>
              snapshot.getSnapshot.pipe(Effect.map((draft) => ({ ...draft, skills }))),
            ),
            Effect.scoped,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.catch(() => snapshot.getSnapshot),
          )
        : snapshot.getSnapshot,
  } satisfies ProviderInstance;
});
