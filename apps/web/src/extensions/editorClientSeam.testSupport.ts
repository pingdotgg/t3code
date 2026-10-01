// @effect-diagnostics deterministicKeys:off - these tags match the server's real services.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import {
  EnvironmentId,
  type ClientProviderServerFrame,
  type ClientProvidersRespondInput,
} from "@t3tools/contracts";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ApiInvocation } from "@t3tools/extension-sdk/capabilities";
import { CLIENT_PROVIDER_DESCRIPTORS } from "./clientProviders";
import type { ClientLocalProvider } from "./clientProviderTypes";

// Load the actual server code without making web's typecheck follow server sources.
const fromRepo = <Module>(path: string): Promise<Module> =>
  import(/* @vite-ignore */ new URL(path, import.meta.url).pathname);

class ServerEnvironment extends Context.Service<
  ServerEnvironment,
  { readonly getEnvironmentId: Effect.Effect<EnvironmentId> }
>()("t3/environment/ServerEnvironment") {}

interface Seam {
  connect(
    socket: { connectionId: string; sessionId: string; announcedOrigin: { surface: string } },
    input: { providers: { id: string; version: string }[] },
  ): Effect.Effect<Stream.Stream<ClientProviderServerFrame>, Error>;
  respond(connectionId: string, input: ClientProvidersRespondInput): Effect.Effect<void, Error>;
}
class ClientApiProviders extends Context.Service<ClientApiProviders, Seam>()(
  "t3/extensions/ClientApiProviders",
) {}

const { layer } = await fromRepo<{
  layer: Layer.Layer<ClientApiProviders, never, ServerEnvironment>;
}>("../../../server/src/extensions/ClientApiProviders.ts");
const { createUiClientApiProviders } = await fromRepo<{
  createUiClientApiProviders: (deps: {
    environmentId: string;
    clientApiProviders: Seam;
    authorizeGrant: () => Promise<boolean>;
    resolveThreadProject: () => Promise<string>;
    readThreadAgentSessions: () => Promise<readonly never[]>;
  }) => readonly {
    providerId: string;
    invoke(
      method: string,
      input: Json,
      context: ViewContext,
      signal: AbortSignal,
      metadata: unknown,
    ): Promise<Json>;
  }[];
}>("../../../server/src/extensions/uiClientApis.ts");

/** Real registration, schema-validating server seam and UI gate; only socket I/O is in process. */
export async function editorClientSeam(
  environmentId: EnvironmentId,
  client: ClientLocalProvider,
  descriptors: readonly { id: string; version: string }[] = CLIENT_PROVIDER_DESCRIPTORS,
) {
  const runtime = ManagedRuntime.make(
    layer.pipe(
      Layer.provide(
        Layer.succeed(ServerEnvironment, { getEnvironmentId: Effect.succeed(environmentId) }),
      ),
    ),
  );
  const controller = new AbortController();
  try {
    const seam = await runtime.runPromise(ClientApiProviders);
    const frames = await runtime.runPromise(
      seam.connect(
        {
          connectionId: "editor-connection",
          sessionId: "editor-session",
          announcedOrigin: { surface: "web" },
        },
        { providers: [...descriptors] },
      ),
    );
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    runtime.runFork(
      frames.pipe(
        Stream.runForEach((frame) => {
          if (frame.type === "registered") return Effect.sync(registered);
          if (frame.type !== "invoke") return Effect.void;
          return Effect.promise(async () => {
            const value = await client.invoke({
              method: frame.method,
              input: frame.input,
              context: frame.context as ViewContext,
              caller: frame.caller,
              signal: controller.signal,
            });
            await runtime.runPromise(
              seam.respond("editor-connection", { requestId: frame.requestId, ok: true, value }),
            );
          });
        }),
      ),
    );
    await ready;
    const editor = createUiClientApiProviders({
      environmentId,
      clientApiProviders: seam,
      authorizeGrant: async () => true,
      resolveThreadProject: async () => "p",
      readThreadAgentSessions: async () => [],
    }).find(({ providerId }) => providerId === "host.ui.editor")!;
    let resolveOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      resolveOpened = resolve;
    });
    return {
      opened,
      invoke: async (request: ApiInvocation, signal: AbortSignal) => {
        const value = await editor.invoke(request.method, request.input, request.context, signal, {
          callId: "editor-call",
          rootCallerId: "t3.files",
          callerId: "t3.files",
          providerId: "host.ui.editor",
          providerGeneration: 1,
          callerGenerations: [
            { pluginId: "t3.files", contentHash: "h", installationGeneration: 1 },
          ],
          principal: {
            kind: "environment-session",
            id: "editor-session",
            environmentId,
            scopes: [],
          },
          clientConnectionId: "editor-connection",
        });
        if (request.method === "openPath") resolveOpened();
        return value;
      },
      async dispose() {
        controller.abort();
        await runtime.dispose();
      },
    };
  } catch (error) {
    controller.abort();
    await runtime.dispose();
    throw error;
  }
}
