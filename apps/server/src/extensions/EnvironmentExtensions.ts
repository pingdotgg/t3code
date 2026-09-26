import { makeBrowserLocalServersApiProvider } from "./browserLocalServersApi.ts";
import { makeBrowserSessionsApiProvider } from "./browserSessions/v1.ts";
import { makeBrowserFramesApiProvider } from "./browserFrames/v1.ts";
import { makeOrchestrationApiProviders } from "./orchestration/v1.ts";
import { makeWorkspaceChangesApiProvider } from "./workspaceChangesApi.ts";
import { makeWorkspaceSearchApiProvider } from "./workspaceSearchApi.ts";
import { makeWorkspaceTreeApiProvider } from "./workspaceTreeApi.ts";
import { ExtensionCatalogueChanges } from "./catalogueChanges.ts";
import { makeWorkspaceApiProvider } from "./workspaceApi.ts";
import {
  ExtensionInstallation,
  ExtensionOperationError,
  type ExtensionApiInvokeInput,
  type ExtensionAssetInput,
  type ExtensionApiSubscribeInput,
  type ExtensionApiDiscoverInput,
  type ExtensionApiSelection,
  type ExtensionInstallInput,
  type ExtensionManageInput,
  type ExtensionInvokeInput,
} from "@t3tools/contracts";
import {
  createExtensionRuntime,
  type HostApiRootAuthority,
  type Installation,
} from "@t3tools/extension-runtime";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import type { ToolDescriptor } from "@t3tools/extension-sdk/environment";
import {
  WORKSPACE_READ_TEXT,
  validateWorkspaceReadTextInput,
} from "@t3tools/extension-sdk/workspace";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { WorkspaceFileSystem } from "../workspace/WorkspaceFileSystem.ts";
import { makeExtensionScopeResolver } from "./scope.ts";
import { makeTerminalApiProvider } from "./terminalApi.ts";
import { makeTerminalControlApiProvider } from "./terminalControlApi.ts";
import { makeTerminalOutputApiProvider } from "./terminalOutputApi.ts";
import { makeTerminalOutputEventsApiProvider } from "./terminalOutputEventsApi.ts";
import { makeTextEditsApiProvider } from "./textEditsApi.ts";
import { makeWorkspaceResourcesApiProvider } from "./workspaceResourcesApi.ts";
import { makeResourcesLeaseApiProvider } from "./resourcesLeaseApi.ts";
import { makeVcsApiProviders } from "./vcsApi.ts";
import { makeVcsActionsApiProvider } from "./vcsActionsApi.ts";
import { makeVcsDiffApiProvider } from "./vcsDiffApi.ts";
import { makeComposerApiProviders } from "./composerApi.ts";
import { makePrsApiProvider } from "./prs/v1.ts";
import { makeProvidersStatusApiProvider } from "./providersStatusApi.ts";
import { makePrsWriteApiProvider } from "./prs/write.ts";
import { boundedWorkspaceText } from "./workspaceText.ts";
import { make as makeClientApiProviders } from "./ClientApiProviders.ts";
import { createUiClientApiProviders } from "./uiClientApis.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

type Runtime = Awaited<ReturnType<typeof createExtensionRuntime>>;
export interface InstalledTool {
  readonly installationId: string;
  readonly contentHash: string;
  readonly descriptor: ToolDescriptor;
}
const operationError = (operation: string, cause: unknown) =>
  new ExtensionOperationError({
    operation,
    detail: (cause instanceof Error ? cause.message : "Extension operation failed.").slice(0, 512),
  });
const installation = Schema.decodeUnknownSync(ExtensionInstallation);

/**
 * How the extension runtime starts workers. The npm bundle forks its sibling
 * `extension-worker.mjs`; the single-executable has neither that file nor a
 * Node to fork it with, so it runs its own hidden `__extension-worker`
 * subcommand. Unbundled source keeps the runtime's default worker script.
 */
export const extensionWorkerLaunch = (isExecutable: boolean, moduleUrl: string) =>
  isExecutable
    ? { workerCommand: ["__extension-worker"] }
    : moduleUrl.endsWith(".mjs")
      ? { workerUrl: new URL("./extension-worker.mjs", moduleUrl) }
      : {};

export const make = Effect.fn("EnvironmentExtensions.make")(function* (
  factory: typeof createExtensionRuntime = createExtensionRuntime,
) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const isExecutable = yield* HostProcessIsExecutable;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const projects = yield* ProjectionProjectRepository;
  const threads = yield* ProjectionThreadRepository;
  const workspace = yield* WorkspaceFileSystem;
  const browserLocalServersApi = yield* makeBrowserLocalServersApiProvider();
  const browserSessionsApi = yield* makeBrowserSessionsApiProvider();
  const browserFramesApi = yield* makeBrowserFramesApiProvider();
  const workspaceApi = yield* makeWorkspaceApiProvider();
  const workspaceTreeApi = yield* makeWorkspaceTreeApiProvider();
  const workspaceSearchApi = yield* makeWorkspaceSearchApiProvider();
  const workspaceChangesApi = yield* makeWorkspaceChangesApiProvider();
  const terminalApi = yield* makeTerminalApiProvider();
  const terminalOutputApi = yield* makeTerminalOutputApiProvider();
  const terminalOutputEventsApi = yield* makeTerminalOutputEventsApiProvider();
  const terminalControlApi = yield* makeTerminalControlApiProvider();
  const textEditsApi = yield* makeTextEditsApiProvider();
  const workspaceResourcesApi = yield* makeWorkspaceResourcesApiProvider();
  const vcsApis = yield* makeVcsApiProviders();
  const vcsDiffApi = yield* makeVcsDiffApiProvider();
  // Built inside this service so the client-provider registry is shared by
  // the WS handlers (via this service's `clientApiProviders` field) and the
  // `t3.ui/*` adapters without adding a new layer dependency anywhere.
  const clientApiProviders = yield* makeClientApiProviders.pipe(
    Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
  );
  const composerApis = yield* makeComposerApiProviders({ environmentId, clientApiProviders });
  const orchestrationApis = yield* makeOrchestrationApiProviders();
  const prsApi = yield* makePrsApiProvider();
  const providersStatusApi = yield* makeProvidersStatusApiProvider();
  const catalogueChanges = yield* ExtensionCatalogueChanges;
  const resolve = makeExtensionScopeResolver({ environmentId, projects, threads });
  const authorize = async (entry: Installation, capability: string, context: ViewContext) => {
    if (
      !entry.enabled ||
      !entry.grants.capabilities.includes(capability) ||
      !context.resource.projectId ||
      !entry.grants.projectIds.includes(context.resource.projectId)
    )
      return false;
    return Effect.runPromise(
      resolve(context).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      ),
    );
  };
  // Late-bound: the runtime is created below with the providers that call this.
  let extensionRuntime: Runtime | undefined;
  const resourcesLeaseApi = yield* makeResourcesLeaseApiProvider(
    async (callerId, grant, context) => {
      const entry = extensionRuntime?.list().find((item) => item.id === callerId);
      return entry !== undefined && (await authorize(entry, grant, context));
    },
  );
  const uiApis = createUiClientApiProviders({
    environmentId,
    clientApiProviders,
    authorizeGrant: async (installationId, grant, context) => {
      const entry = extensionRuntime?.list().find((item) => item.id === installationId);
      return entry !== undefined && (await authorize(entry, grant, context));
    },
  });
  // Same late-bound caller-chain grant check as the lease provider —
  // publishRepository and the composite's pr phase ask for `t3.prs/write`
  // dynamically, which `requiredGrants` cannot express.
  const vcsActionsApi = yield* makeVcsActionsApiProvider(async (callerId, grant, context) => {
    const entry = extensionRuntime?.list().find((item) => item.id === callerId);
    return entry !== undefined && (await authorize(entry, grant, context));
  });
  const prsWriteApi = yield* makePrsWriteApiProvider();
  const read = Effect.fn("EnvironmentExtensions.readWorkspace")(function* (
    input: unknown,
    context: ViewContext,
  ) {
    const safe = yield* Effect.try({
      try: () => validateWorkspaceReadTextInput(input),
      catch: (cause) => operationError("workspace.read", cause),
    });
    const scope = yield* resolve(context);
    const result = yield* workspace
      .readFile({ cwd: scope.cwd, relativePath: safe.relativePath })
      .pipe(
        Effect.mapError(() =>
          operationError(
            "workspace.read",
            new Error("Workspace file cannot be read within the granted project."),
          ),
        ),
      );
    yield* resolve(scope.context);
    return yield* Effect.try({
      try: () => boundedWorkspaceText(result),
      catch: (cause) => operationError("workspace.read", cause),
    });
  });
  let initializationError: ExtensionOperationError | undefined;
  const runtime = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        factory({
          rootDir: path.join(config.stateDir, "extensions"),
          environmentId,
          ...extensionWorkerLaunch(isExecutable, import.meta.url),
          apiProviders: [
            browserLocalServersApi,
            browserSessionsApi,
            browserFramesApi,
            workspaceApi,
            workspaceTreeApi,
            workspaceSearchApi,
            workspaceChangesApi,
            textEditsApi,
            workspaceResourcesApi,
            terminalApi,
            terminalOutputApi,
            terminalOutputEventsApi,
            terminalControlApi,
            ...vcsApis,
            vcsActionsApi,
            vcsDiffApi,
            ...orchestrationApis,
            prsApi,
            providersStatusApi,
            prsWriteApi,
            resourcesLeaseApi,
            ...composerApis,
            ...uiApis,
          ],
          onCatalogueChanged: () => Effect.runSync(catalogueChanges.publish),
          auditApi: (event) => {
            Effect.runSync(Effect.logInfo("Extension API invocation", { ...event }));
          },
          // The resolver's tagged ExtensionOperationError must reach the
          // caller — a stale workspace revision is not an authority denial.
          // The broker only sees boolean false as a generic scope change.
          validateApiScope: (context) => Effect.runPromise(resolve(context).pipe(Effect.as(true))),
          services: [
            {
              capability: WORKSPACE_READ_TEXT,
              invoke: (input, context, signal) =>
                Effect.runPromise(read(input, context), { signal }),
            },
          ],
          authorize,
          timeoutMs: 15000,
        }),
      catch: (cause) => operationError("initialize", cause),
    }),
    (runtime) =>
      Effect.tryPromise({
        try: () => runtime.dispose(),
        catch: (cause) => operationError("dispose", cause),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Extension runtime cleanup failed", { detail: error.detail }),
        ),
      ),
  ).pipe(
    Effect.catch((error) => {
      initializationError = error;
      return Effect.logWarning("Extension runtime unavailable; core server remains active", {
        detail: error.detail,
      }).pipe(Effect.as(undefined));
    }),
  );
  extensionRuntime = runtime;
  if (!runtime) {
    const unavailable = Effect.fail(
      initializationError ??
        operationError("initialize", new Error("Extension runtime unavailable.")),
    );
    return {
      clientApiProviders,
      catalogue: unavailable,
      list: unavailable,
      invokeApi: (_input: ExtensionApiInvokeInput) => unavailable,
      subscribeApi: (_input: ExtensionApiSubscribeInput) => Stream.fromEffect(unavailable),
      discoverApis: (_input: ExtensionApiDiscoverInput) => unavailable,
      selectApi: (_input: ExtensionApiSelection) => unavailable,
      install: (_input: ExtensionInstallInput) => unavailable,
      manage: (_input: ExtensionManageInput) => unavailable,
      asset: (_input: ExtensionAssetInput) => unavailable,
      client: (_id: string, _hash: string) => unavailable,
      invoke: (_input: ExtensionInvokeInput) => unavailable,
      contextForThread: (_threadId: string, _environmentId: string) => unavailable,
      tools: (_context: ViewContext) => unavailable,
    };
  }
  const promise = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => operationError(operation, cause) });
  const list = Effect.try({
    try: () => runtime.list().map((entry) => installation(entry)),
    catch: (cause) => operationError("list", cause),
  });
  const verifyClient = (id: string, expectedContentHash: string) => {
    const entry = runtime.list().find((item) => item.id === id);
    if (!entry?.enabled || entry.contentHash !== expectedContentHash)
      throw new Error("Extension client is unavailable or its installed content changed.");
  };
  return {
    clientApiProviders,
    catalogue: Effect.sync(() => runtime.catalogue()),
    subscribeApi: (input: ExtensionApiSubscribeInput, root?: HostApiRootAuthority) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const scope = yield* resolve(input.request.context);
          const controller = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          const frames = runtime.subscribeApi(
            input.installationId,
            input.expectedContentHash,
            {
              id: input.request.id,
              name: input.request.name,
              input: input.request.input,
              versionRange: input.request.versionRange,
              context: scope.context,
              ...(input.request.expectedGeneration === undefined
                ? {}
                : { expectedGeneration: input.request.expectedGeneration }),
              ...(input.request.cursor === undefined ? {} : { cursor: input.request.cursor }),
              ...(input.request.clientConnectionId === undefined
                ? {}
                : { clientConnectionId: input.request.clientConnectionId }),
            },
            controller.signal,
            root,
          );
          return Stream.fromAsyncIterable(frames, (cause) =>
            operationError("api.subscribe", cause),
          ).pipe(Stream.mapEffect((frame) => resolve(scope.context).pipe(Effect.as(frame))));
        }),
      ),
    invokeApi: Effect.fn("EnvironmentExtensions.invokeApi")(function* (
      input: ExtensionApiInvokeInput,
      root?: HostApiRootAuthority,
    ) {
      const scope = yield* resolve(input.request.context);
      const result = yield* promise("api.invoke", (signal) =>
        runtime.invokeApi(
          input.installationId,
          input.expectedContentHash,
          {
            id: input.request.id,
            method: input.request.method,
            input: input.request.input,
            versionRange: input.request.versionRange,
            context: scope.context,
            ...(input.request.expectedGeneration !== undefined
              ? { expectedGeneration: input.request.expectedGeneration }
              : {}),
            ...(input.request.requestId !== undefined
              ? { requestId: input.request.requestId }
              : {}),
            ...(input.request.clientConnectionId !== undefined
              ? { clientConnectionId: input.request.clientConnectionId }
              : {}),
          },
          signal,
          root,
        ),
      );
      yield* resolve(scope.context);
      return yield* decodeJson(result).pipe(
        Effect.mapError((cause) => operationError("api.invoke", cause)),
      );
    }),
    discoverApis: Effect.fn("EnvironmentExtensions.discoverApis")(function* (
      input: ExtensionApiDiscoverInput,
    ) {
      const scope = yield* resolve(input.context);
      const apis = yield* promise("api.discover", (signal) =>
        runtime.discoverApis(
          input.installationId,
          input.expectedContentHash,
          scope.context,
          signal,
        ),
      );
      yield* resolve(scope.context);
      return apis;
    }),
    selectApi: (input: ExtensionApiSelection) =>
      promise("api.select", () => runtime.selectApi(input)),
    list,
    install: (input: ExtensionInstallInput) =>
      promise("install", async () => {
        if (input.trusted !== true) throw new Error("Trusted-code confirmation is required.");
        return installation(
          await runtime.install(input.sourceDir, {
            capabilities: input.capabilities,
            projectIds: input.projectIds,
          }),
        );
      }),
    manage: (input: ExtensionManageInput) =>
      promise("manage", async () => {
        if (input.action === "grants") {
          if (!input.grants) throw new Error("Permission changes require the complete grant set.");
          return installation(await runtime.updateGrants(input.id, input.grants));
        }
        if (input.action === "remove") {
          await runtime.remove(input.id);
          return null;
        }
        if (input.action === "update") {
          if (input.trusted !== true || !input.sourceDir)
            throw new Error("Update requires a source directory and trusted-code confirmation.");
          return installation(await runtime.update(input.id, input.sourceDir));
        }
        return installation(await runtime[input.action](input.id));
      }),
    asset: (input: ExtensionAssetInput) =>
      promise("asset", async (signal) => {
        verifyClient(input.id, input.expectedContentHash);
        const result = await runtime.readAsset(
          input.id,
          input.expectedContentHash,
          input.path,
          signal,
        );
        verifyClient(input.id, input.expectedContentHash);
        return result.bytes;
      }),
    client: (id: string, expectedContentHash: string) =>
      promise("client", async () => {
        verifyClient(id, expectedContentHash);
        const result = await runtime.readClient(id);
        verifyClient(id, expectedContentHash);
        if (result.contentHash !== expectedContentHash)
          throw new Error("Extension client content changed.");
        return result;
      }),
    invoke: Effect.fn("EnvironmentExtensions.invoke")(function* (input: ExtensionInvokeInput) {
      const scope = yield* resolve(input.context);
      const result = yield* promise("invoke", (signal) =>
        runtime.invoke(input.toolId, input.input, scope.context, signal, input.expectedContentHash),
      );
      yield* resolve(scope.context);
      return yield* decodeJson(result).pipe(
        Effect.mapError((cause) => operationError("invoke", cause)),
      );
    }),
    contextForThread: Effect.fn("EnvironmentExtensions.contextForThread")(function* (
      threadId: string,
      invokedEnvironmentId: string,
    ) {
      return (yield* resolve(
        {
          resource: {
            namespace: "t3.extensions",
            id: threadId,
            environmentId: invokedEnvironmentId,
            threadId,
          },
          client: "mcp",
        },
        true,
      )).context;
    }),
    tools: Effect.fn("EnvironmentExtensions.tools")(function* (context: ViewContext) {
      const scope = yield* resolve(context);
      const projectId = scope.context.resource.projectId;
      return yield* Effect.try({
        try: () =>
          runtime
            .list()
            .filter(
              (entry) =>
                entry.enabled &&
                projectId !== undefined &&
                entry.grants.projectIds.includes(projectId),
            )
            .flatMap((entry) =>
              entry.package.tools
                .filter(
                  (tool) =>
                    tool.readOnly &&
                    tool.capabilities.every(
                      (capability) =>
                        capability === WORKSPACE_READ_TEXT &&
                        entry.grants.capabilities.includes(capability),
                    ),
                )
                .map((descriptor) => ({
                  installationId: entry.id,
                  contentHash: entry.contentHash,
                  descriptor,
                })),
            ),
        catch: (cause) => operationError("tools", cause),
      });
    }),
  };
});

export class EnvironmentExtensions extends Context.Service<
  EnvironmentExtensions,
  Effect.Success<ReturnType<typeof make>>
>()("t3/extensions/EnvironmentExtensions") {}
export const layer = Layer.effect(EnvironmentExtensions, make());
export type ExtensionRuntime = Runtime;
