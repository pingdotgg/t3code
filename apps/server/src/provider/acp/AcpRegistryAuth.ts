import {
  ProviderSetupError,
  type AcpRegistrySettings,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as AcpSchema from "effect-acp/compat";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { make as makeProviderAuthFlow, type ProviderAuthFlowContext } from "../ProviderAuthFlow.ts";
import { normalizeAcpRegistryAuthMethods, normalizeAcpRegistryWebUrl } from "./AcpRegistryProbe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "initialize" | "authenticate" | "start" | "handleElicitation" | "logout"
>;

/** ACP credentials stay in the agent's own store, using the same launch environment as chat. */
export const makeAcpRegistryAuth = Effect.fn("makeAcpRegistryAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: (authenticated: boolean) => Effect.Effect<void>;
  readonly makeRuntime?: (
    spawn: AcpSessionRuntime.AcpSpawnInput,
  ) => Effect.Effect<Runtime, ProviderSetupError, Scope.Scope>;
}) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const coordinator = yield* Effect.serviceOption(
    AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
  );
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  const resolve = catalog
    .resolve(options.settings, options.cwd, options.environment)
    .pipe(
      Effect.mapError((cause) =>
        failure("start", "Could not prepare the selected ACP agent.", cause),
      ),
    );
  const makeRuntime =
    options.makeRuntime ??
    ((spawn) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            spawn,
            cwd: options.cwd,
            authenticateOnAuthRequired: false,
            clientCapabilities: {
              auth: { terminal: Option.isSome(pty) },
              elicitation: { url: {} },
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "t3-code-provider-auth", version: "0.0.0" },
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Layer.succeed(Crypto.Crypto, crypto),
              ),
            ),
          ),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(context),
        );
      }).pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not start the selected ACP agent.", cause),
        ),
      ));

  let knownMethods:
    | { readonly version: string | null; readonly methods: ReadonlyArray<ProviderAuthMethod> }
    | undefined;
  const discoverMethods = Effect.scoped(
    Effect.gen(function* () {
      const inspected = yield* catalog
        .inspect(options.settings, options.environment)
        .pipe(
          Effect.mapError((cause) =>
            failure("methods", "Could not inspect the selected ACP agent.", cause),
          ),
        );
      if (inspected.status !== "ready")
        return yield* failure("methods", "Prepare this ACP agent before signing in.");
      // An unversioned command (a path override) can change in place, so only
      // registry versions reuse earlier discovery.
      if (inspected.version !== null && knownMethods?.version === inspected.version)
        return knownMethods.methods;
      const resolved = yield* resolve;
      const runtime = yield* makeRuntime(resolved.spawn);
      const initialized = yield* runtime
        .initialize()
        .pipe(
          Effect.mapError((cause) =>
            failure("methods", "Could not discover this agent's sign-in methods.", cause),
          ),
        );
      const advertised = normalizeAcpRegistryAuthMethods(initialized.authMethods)
        .filter(
          (method) => method.id.length <= 128 && (method.type !== "terminal" || Option.isSome(pty)),
        )
        .slice(0, 32)
        .map((method) => ({
          id: method.id,
          name: method.name,
          description: method.description,
          type: method.type === "env_var" ? ("credentials" as const) : method.type,
        }));
      knownMethods = { version: inspected.version, methods: advertised };
      return advertised;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(failure("methods", "The ACP agent did not advertise sign-in methods in time.")),
    }),
  );

  const methods = Option.isSome(coordinator)
    ? coordinator.value
        .runBackgroundProbe(options.settings.agentId, discoverMethods)
        .pipe(
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.succeed(result.value)
              : Effect.fail(
                  failure(
                    "methods",
                    "Sign-in discovery was interrupted by an active provider session. Try again.",
                  ),
                ),
          ),
        )
    : discoverMethods;

  const runTerminal = Effect.fnUntraced(function* (
    resolved: AcpRegistrySupport.ResolvedAcpRegistryAgent,
    method: Extract<AcpSchema.AuthMethod, { readonly type: "terminal" }>,
    context: ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty))
      return yield* failure(
        "start",
        "Interactive provider login is unavailable on this environment.",
      );
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: resolved.spawn.command,
        args: [...resolved.spawn.args, ...(method.args ?? [])],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: { ...options.environment, ...resolved.spawn.env, ...method.env },
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not open the provider sign-in terminal.", cause),
        ),
      );
    const detachData = process.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-16_384));
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {
          /* The login process may already have exited. */
        }
      }),
    );
    let transcript = "";
    let outputOffset = 0;
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) process.resize(response.size.cols, response.size.rows);
                  if (response.data) process.write(response.data);
                },
                catch: () =>
                  failure("respond", "The provider sign-in terminal is no longer available."),
              })
            : Effect.void,
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-16_384);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* Deferred.await(exited)) !== 0)
      return yield* failure("start", "The provider login command did not finish successfully.");
  });

  const authenticate = (methodId: string, context: ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      if (!options.settings.enabled)
        return yield* failure("start", "Enable this provider before signing in.");
      const login = Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* resolve;
          const runtimeScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
          const runtime = yield* makeRuntime(resolved.spawn).pipe(
            Effect.provideService(Scope.Scope, runtimeScope),
          );
          yield* runtime.handleElicitation((request) =>
            Effect.gen(function* () {
              if (
                request.mode !== "url" ||
                !("url" in request) ||
                !("elicitationId" in request) ||
                typeof request.url !== "string" ||
                typeof request.elicitationId !== "string"
              )
                return { action: "decline" } as const;
              const url = normalizeAcpRegistryWebUrl(request.url);
              const id = request.elicitationId.trim();
              if (!url || !id || id.length > 128) return { action: "decline" } as const;
              const consent = yield* Deferred.make<boolean>();
              yield* context.setInteraction(
                { type: "browser", id, url, requiresConsent: true },
                (response) =>
                  response.type === "browser"
                    ? Deferred.succeed(consent, response.action === "accept").pipe(Effect.asVoid)
                    : Effect.void,
              );
              return (yield* Deferred.await(consent))
                ? ({ action: "accept" } as const)
                : ({ action: "decline" } as const);
            }),
          );
          const initialized = yield* runtime
            .initialize()
            .pipe(
              Effect.mapError((cause) =>
                failure("start", "Could not initialize the selected ACP agent.", cause),
              ),
            );
          const method = initialized.authMethods?.find((method) => method.id === methodId);
          if (!method)
            return yield* failure("start", "The agent no longer advertises this sign-in method.");
          if (method.type === "terminal") {
            yield* Scope.close(runtimeScope, Exit.void);
            yield* runTerminal(resolved, method, context).pipe(Effect.scoped);
            // Terminal login is a separate invocation. Reconnect after it exits so
            // the ACP process reads the credentials its login command persisted.
            const verifiedRuntime = yield* makeRuntime(resolved.spawn);
            yield* context.verifying;
            yield* verifiedRuntime
              .start()
              .pipe(
                Effect.mapError((cause) =>
                  failure(
                    "verify",
                    "The provider could not create a session after terminal sign-in.",
                    cause,
                  ),
                ),
              );
          } else {
            if (method.type === undefined || method.type === "agent") {
              if (!runtime.authenticate)
                return yield* failure(
                  "start",
                  "This runtime does not support explicit ACP sign-in.",
                );
              yield* runtime
                .authenticate(methodId)
                .pipe(
                  Effect.mapError((cause) =>
                    failure("start", "The ACP agent could not complete sign-in.", cause),
                  ),
                );
            }
            // Legacy env_var methods use the secret-backed environment fields in
            // provider settings. Never send their ID to authenticate.
            yield* context.verifying;
            yield* runtime
              .start()
              .pipe(
                Effect.mapError((cause) =>
                  failure(
                    "verify",
                    "The provider could not create a session after sign-in.",
                    cause,
                  ),
                ),
              );
          }
        }),
      );
      yield* Option.isSome(coordinator)
        ? coordinator.value.withForegroundStartup(options.settings.agentId, login)
        : login;
      yield* options.onChanged(true);
    });
  const logout = Effect.scoped(
    Effect.gen(function* () {
      const resolved = yield* resolve;
      const runtime = yield* makeRuntime(resolved.spawn);
      yield* runtime.logout.pipe(
        Effect.mapError((cause) =>
          failure(
            "logout",
            "This ACP agent could not sign out. It may not advertise logout support.",
            cause,
          ),
        ),
      );
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(failure("logout", "The ACP agent did not finish signing out in time.")),
    }),
  );
  const signOut = (
    Option.isSome(coordinator)
      ? coordinator.value.withForegroundStartup(options.settings.agentId, logout)
      : logout
  ).pipe(Effect.andThen(options.onChanged(false)));
  return yield* makeProviderAuthFlow({
    instanceId: options.instanceId,
    // ACP doesn't advertise its credential scope. Conservatively treat all
    // instances of the same agent on this environment as sharing credentials.
    credentialBinding: { owner: "provider", key: `acp:${options.settings.agentId}` },
    methods,
    ...(options.settings.authMethodId ? { defaultMethodId: options.settings.authMethodId } : {}),
    authenticate,
    logout: signOut,
  });
});
