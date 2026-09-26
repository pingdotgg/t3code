import { EnvironmentId, ProjectId, type ClientProviderServerFrame } from "@t3tools/contracts";
import type { HostApiRootAuthority } from "@t3tools/extension-runtime";
import { createExtensionRuntime } from "@t3tools/extension-runtime";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProcessRunner from "../processRunner.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ClientApiProviders, layer as clientApiProvidersLayer } from "./ClientApiProviders.ts";
import { createUiClientApiProviders } from "./uiClientApis.ts";

const ENV = "env-a";

const testLayer = Layer.mergeAll(
  clientApiProvidersLayer.pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(ENV)),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)),
);

const context: ViewContext = {
  client: "web",
  workspaceRevision: JSON.stringify(["/workspace", null]),
  resource: {
    namespace: "example.ui-theme-session",
    id: "view",
    environmentId: EnvironmentId.make(ENV),
    projectId: ProjectId.make("project-a"),
  },
};

const root: HostApiRootAuthority = {
  principal: {
    kind: "environment-session",
    id: "session-a",
    environmentId: ENV,
    scopes: ["orchestration:read"],
  },
  allowWrite: true,
  revalidate: () => {},
};

/**
 * Packed install proof: a real `t3-extension build` package installs into the
 * runtime, and its re-exposed `applySessionTheme`/`getState` methods drive the
 * public `t3.ui/theme` contract through the real adapter, the real
 * `ClientApiProviders` connect stream, and a connected client provider.
 */
it.effect(
  "installed packed consumer drives t3.ui/theme over a live client connection and loses write on grant revoke",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const built = yield* runner.run({
        command: "node",
        args: [
          path.resolve("../../packages/extension-sdk/bin/t3-extension.mjs"),
          "build",
          path.resolve("../../packages/extension-sdk/examples/ui-theme-session"),
        ],
      });
      expect(built.code, built.stderr).toBe(0);

      const clientApiProviders = yield* ClientApiProviders;
      // The fake web client: a minimal t3.client/theme provider holding a
      // stored preference plus the writer-tagged session overlay.
      const applied: { writer?: string; preference?: unknown; target?: unknown } = {};
      const state: { overlay: { theme: string; writer: string } | null } = { overlay: null };
      const stream = yield* clientApiProviders.connect(
        {
          connectionId: "conn-x",
          sessionId: "session-a",
          announcedOrigin: { surface: "web" },
        },
        { providers: [{ id: "t3.client/theme", version: "1.0.0" }] },
      );
      const driver = yield* stream.pipe(
        Stream.runForEach((frame: ClientProviderServerFrame) =>
          Effect.gen(function* () {
            if (frame.type !== "invoke") return;
            if (frame.apiId !== "t3.client/theme") {
              yield* clientApiProviders.respond("conn-x", {
                requestId: frame.requestId,
                ok: false,
                error: { code: "client-provider-unavailable", message: "unknown api" },
              });
              return;
            }
            const input = frame.input as {
              target: unknown;
              writer: string;
              preference?: { mode: string; theme?: string; clear?: boolean };
            };
            if (frame.method === "applyPreference") {
              applied.writer = input.writer;
              applied.preference = input.preference;
              applied.target = input.target;
              state.overlay = input.preference?.clear
                ? null
                : { theme: input.preference?.theme ?? "system", writer: input.writer };
              yield* clientApiProviders.respond("conn-x", {
                requestId: frame.requestId,
                ok: true,
                value: { applied: true },
              });
            } else if (frame.method === "getState") {
              yield* clientApiProviders.respond("conn-x", {
                requestId: frame.requestId,
                ok: true,
                value: {
                  theme: "system",
                  resolvedTheme: "light",
                  systemDark: false,
                  followSystem: true,
                  appearanceMode: "system",
                  themeHalves: null,
                  effectiveTheme: state.overlay
                    ? {
                        kind: "session-overlay",
                        theme: state.overlay.theme,
                        writer: state.overlay.writer,
                      }
                    : { kind: "stored", theme: "system" },
                  sessionOverlay: state.overlay,
                },
              });
            }
          }),
        ),
        Effect.forkChild,
      );
      try {
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "ui-theme-install-" });
        const rootDir = yield* fs.realPath(temp);
        const runtime = yield* Effect.promise(() =>
          createExtensionRuntime({
            rootDir,
            environmentId: ENV,
            services: [],
            apiProviders: createUiClientApiProviders({
              environmentId: ENV,
              clientApiProviders,
              authorizeGrant: () => Promise.resolve(true),
            }),
            authorize: (installation, grant, invokeContext) =>
              installation.grants.capabilities.includes(grant) &&
              installation.grants.projectIds.includes(invokeContext.resource.projectId ?? ""),
          }),
        );
        try {
          const installed = yield* Effect.promise(() =>
            runtime.install(
              path.resolve("../../packages/extension-sdk/examples/ui-theme-session/.t3-extension"),
              {
                capabilities: ["t3.ui/theme.read", "t3.ui/theme.write"],
                projectIds: ["project-a"],
              },
            ),
          );
          const signal = new AbortController().signal;
          // The environment session's client stamps its own connection id on
          // the call; the extension forwards it to t3.ui/theme.setPreference.
          const appliedResult = (yield* Effect.promise(() =>
            runtime.invokeApi(
              installed.id,
              installed.contentHash,
              {
                id: "example.ui-theme-session/theme",
                versionRange: "^1.0.0",
                method: "applySessionTheme",
                input: { theme: "ocean", clientConnectionId: "conn-x" },
                context,
                clientConnectionId: "conn-x",
              },
              signal,
              root,
            ),
          )) as { applied: boolean };
          expect(appliedResult.applied).toBe(true);
          // The adapter stamped the verified caller as the writer and the
          // self-proof target — never a raw connection selector.
          expect(applied.writer).toBe("example.ui-theme-session");
          expect(applied.target).toEqual({ kind: "self" });
          expect(applied.preference).toEqual({ mode: "session", theme: "ocean" });

          const stateResult = (yield* Effect.promise(() =>
            runtime.invokeApi(
              installed.id,
              installed.contentHash,
              {
                id: "example.ui-theme-session/theme",
                versionRange: "^1.0.0",
                method: "getState",
                input: { clientConnectionId: "conn-x" },
                context,
                clientConnectionId: "conn-x",
              },
              signal,
              root,
            ),
          )) as Json;
          expect((stateResult as { effectiveTheme: unknown }).effectiveTheme).toEqual({
            kind: "session-overlay",
            theme: "ocean",
            writer: "example.ui-theme-session",
          });

          // Revoking the write grant closes the door in both directions.
          yield* Effect.promise(() =>
            runtime.updateGrants(installed.id, {
              capabilities: ["t3.ui/theme.read"],
              projectIds: ["project-a"],
            }),
          );
          yield* Effect.promise(() =>
            expect(
              runtime.invokeApi(
                installed.id,
                installed.contentHash,
                {
                  id: "example.ui-theme-session/theme",
                  versionRange: "^1.0.0",
                  method: "applySessionTheme",
                  input: { theme: "ember", clientConnectionId: "conn-x" },
                  context,
                  clientConnectionId: "conn-x",
                },
                signal,
                root,
              ),
            ).rejects.toThrow(/grant|denied|authorized|permission/i),
          );
          // The read path still resolves after the revoke.
          const afterRevoke = (yield* Effect.promise(() =>
            runtime.invokeApi(
              installed.id,
              installed.contentHash,
              {
                id: "example.ui-theme-session/theme",
                versionRange: "^1.0.0",
                method: "getState",
                input: { clientConnectionId: "conn-x" },
                context,
                clientConnectionId: "conn-x",
              },
              signal,
              root,
            ),
          )) as Json;
          expect((afterRevoke as { effectiveTheme: { theme: string } }).effectiveTheme.theme).toBe(
            "ocean",
          );
        } finally {
          yield* Effect.promise(() => runtime.dispose());
        }
      } finally {
        yield* Fiber.interrupt(driver);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
