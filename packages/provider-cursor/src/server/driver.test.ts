// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { CursorDriver } from "./driver.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as CursorKeychain from "./CursorKeychain.ts";
import * as CursorCredentialStore from "./credentialStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { Cursor } from "./sdk.ts";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(CursorSdk.layer),
  Layer.provideMerge(
    Layer.mock(CursorAgentSdk.CursorAgentSdkRunner)({
      open: () => Effect.die("Maintenance resolution must not open a Cursor session"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(CursorKeychain.CursorKeychain, {
      accessToken: Effect.die("The driver test must not read the Keychain"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Cursor must not make an HTTP request")),
    ),
  ),
);

it.layer(layerTest)("CursorDriver", (it) => {
  it.effect("reads matching CLI limits after signing in through T3", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("cursor-browser-limits");
      const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(instanceId);
      yield* Effect.promise(() =>
        credentials.store.save({
          version: 1,
          backendUrl: "https://api2.cursor.sh",
          apiKey: "instance-browser-key",
          createdAtMs: 0,
        }),
      );
      const me = vi.spyOn(Cursor, "me").mockResolvedValue({
        apiKeyName: "T3 Code",
        createdAt: "2026-01-01T00:00:00.000Z",
        userEmail: "cursor@example.com",
      });
      const models = vi.spyOn(Cursor.models, "list").mockResolvedValue([]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          me.mockRestore();
          models.mockRestore();
        }),
      );
      const settings = yield* TestProviderHost.TestProviderHostSettings;
      yield* Effect.addFinalizer(() => settings.set(DEFAULT_SERVER_SETTINGS));
      yield* settings.set({
        ...DEFAULT_SERVER_SETTINGS,
        cursorKeychainUsageEnabled: true,
      });
      const requests: string[] = [];
      const instance = yield* CursorDriver.create({
        instanceId,
        displayName: "Personal Cursor",
        enabled: true,
        environment: [
          { name: "CURSOR_API_KEY", value: "", sensitive: true },
          { name: "CURSOR_AUTH_TOKEN", value: "", sensitive: true },
          { name: "AGENT_CLI_CREDENTIAL_STORE", value: "default", sensitive: false },
        ],
        config: CursorDriver.defaultConfig(),
      }).pipe(
        Effect.provideService(CursorKeychain.CursorKeychain, {
          accessToken: Effect.succeed("cli-token"),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push(request.url);
            expect(request.headers.authorization).toBe("Bearer cli-token");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/GetMe")
                    ? { email: " CURSOR@example.com " }
                    : { planUsage: { autoPercentUsed: 42, apiPercentUsed: 75 } },
                ),
              ),
            );
          }),
        ),
      );
      const snapshot = yield* instance.snapshot.refresh;
      expect(snapshot.auth.email).toBe("cursor@example.com");
      expect(snapshot.usageLimits?.windows.map((window) => window.usedPercent)).toEqual([75, 42]);
      expect(requests.map((url) => url.split("/").at(-1))).toEqual([
        "GetMe",
        "GetCurrentPeriodUsage",
      ]);
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin"), Effect.scoped),
  );

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
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
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
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
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
