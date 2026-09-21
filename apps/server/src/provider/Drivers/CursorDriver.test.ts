// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CursorDriver } from "./CursorDriver.ts";
import { CursorAgentSdkRunner } from "../../orchestration-v2/Adapters/CursorAgentSdk.ts";
import { layer as idAllocatorLayer } from "../../orchestration-v2/IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import { Cursor } from "../cursorSdk.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-cursor-driver-copy-command-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(idAllocatorLayer),
  Layer.provideMerge(
    Layer.mock(CursorAgentSdkRunner)({
      open: () => Effect.die("Maintenance resolution must not open a Cursor session"),
    }),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Cursor must not make an HTTP request")),
    ),
  ),
);

it.layer(testLayer)("CursorDriver", (it) => {
  it.effect(
    "persists browser credentials, uses them for chat, and closes the SDK session on logout",
    () =>
      Effect.gen(function* () {
        const login = vi.spyOn(Cursor.auth, "login").mockImplementation(async (options) => {
          options?.onLoginUrl?.("https://cursor.com/loginDeepControl?challenge=test-only");
          await options?.store?.save({
            version: 1,
            backendUrl: "https://api2.cursor.sh",
            apiKey: "instance-browser-key",
            createdAtMs: 0,
            apiKeyExpiresAtMs: 4_000_000_000_000,
            email: "cursor@example.com",
          });
          return { apiKey: "instance-browser-key", apiKeyExpiresAtMs: 4_000_000_000_000 };
        });
        const me = vi.spyOn(Cursor, "me").mockResolvedValue({
          apiKeyName: "T3 Code",
          createdAt: "2026-01-01T00:00:00.000Z",
          userEmail: "cursor@example.com",
        });
        const models = vi
          .spyOn(Cursor.models, "list")
          .mockResolvedValue([{ id: "auto", displayName: "Auto" }]);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            login.mockRestore();
            me.mockRestore();
            models.mockRestore();
          }),
        );
        const input = {
          instanceId: ProviderInstanceId.make("cursor-browser-persisted"),
          displayName: "Personal Cursor",
          enabled: true,
          environment: [{ name: "CURSOR_API_KEY", value: "", sensitive: true }],
          config: CursorDriver.defaultConfig(),
        };
        const openedKeys: Array<string | undefined> = [];
        let closed = 0;
        const instance = yield* CursorDriver.create(input).pipe(
          Effect.provideService(CursorAgentSdkRunner, {
            assertComplete: Effect.void,
            open: (request) =>
              Effect.sync(() => {
                openedKeys.push(request.options.apiKey);
                return {
                  agentId: "browser-auth-agent",
                  listMessages: Effect.succeed([]),
                  send: () => Effect.die("This test only opens a session"),
                  close: Effect.sync(() => {
                    closed += 1;
                  }),
                };
              }),
          }),
        );
        expect((yield* instance.snapshot.refresh).auth.status).toBe("unauthenticated");
        yield* instance.auth!.start("client");
        yield* instance.auth!.subscribe("client").pipe(
          Stream.filter((state) => state.phase === "succeeded"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(me).toHaveBeenCalledWith({ apiKey: "instance-browser-key" });
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({
          status: "ready",
          auth: {
            status: "authenticated",
            type: "browser",
            canLogout: true,
            email: "cursor@example.com",
          },
          setup: { canAuthenticate: true, canInstall: false },
        });
        const threadId = ThreadId.make("cursor-browser-thread");
        const modelSelection = { instanceId: input.instanceId, model: "auto" };
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-browser-session"),
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        expect(openedKeys).toEqual(["instance-browser-key"]);
        expect(closed).toBe(0);
        const recreated = yield* CursorDriver.create(input);
        expect((yield* recreated.snapshot.refresh).auth.status).toBe("authenticated");
        yield* instance.auth!.logout(Effect.void);
        expect(closed).toBe(1);
        expect((yield* instance.snapshot.getSnapshot).auth.status).toBe("unauthenticated");
        expect((yield* recreated.snapshot.refresh).auth.status).toBe("unauthenticated");
        expect(
          (yield* Effect.exit(runtime.ensureThread({ threadId, modelSelection, runtimePolicy })))
            ._tag,
        ).toBe("Failure");
        expect(openedKeys).toEqual(["instance-browser-key"]);
        expect(closed).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps the bundled SDK manual-only without probing or updating cursor-agent", () =>
    Effect.gen(function* () {
      const instance = yield* CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor-sdk"),
        displayName: "Cursor test",
        enabled: false,
        environment: [],
        config: CursorDriver.defaultConfig(),
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
      expect((yield* instance.snapshot.refresh).status).toBe("disabled");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("SDK maintenance must not spawn a process")),
      ),
      Effect.scoped,
    ),
  );
});
