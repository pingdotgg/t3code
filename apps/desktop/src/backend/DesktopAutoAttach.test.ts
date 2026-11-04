import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { DesktopBackendConfiguration } from "./DesktopBackendConfiguration.ts";
import type { DesktopBackendInstance, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";
import * as DesktopAutoAttach from "./DesktopAutoAttach.ts";

describe("DesktopAutoAttach", () => {
  it.effect("returns false when server-runtime.json does not exist", () =>
    Effect.gen(function* () {
      const stateDir = "/tmp/t3-state-missing";
      let attached = false;
      const mockPrimary = {
        attachExternal: () =>
          Effect.sync(() => {
            attached = true;
          }),
      } as unknown as DesktopBackendInstance;

      const mockConfiguration = {
        setBootstrapSecret: () => Effect.void,
      } as unknown as DesktopBackendConfiguration["Service"];

      const testLayer = Layer.mergeAll(
        FileSystem.layerNoop({}),
        Path.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no network")),
        ),
      );

      const result = yield* DesktopAutoAttach.tryAutoAttachToRunningServer({
        stateDir,
        backendCwd: "/repo",
        primary: mockPrimary,
        configuration: mockConfiguration,
      }).pipe(Effect.provide(testLayer));

      assert.isFalse(result);
      assert.isFalse(attached);
    }),
  );

  it.effect("returns false when process in server-runtime.json is dead", () =>
    Effect.gen(function* () {
      const stateDir = "/tmp/t3-state-dead";
      const runtimeContent = JSON.stringify({
        version: 1,
        pid: 999999999, // A non-existent PID
        origin: "http://127.0.0.1:4545",
        port: 4545,
        startedAt: "2026-01-01T00:00:00.000Z",
      });

      let attached = false;
      const mockPrimary = {
        attachExternal: () =>
          Effect.sync(() => {
            attached = true;
          }),
      } as unknown as DesktopBackendInstance;

      const mockConfiguration = {
        setBootstrapSecret: () => Effect.void,
      } as unknown as DesktopBackendConfiguration["Service"];

      const fsLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          exists: () => Effect.succeed(true),
          readFileString: () => Effect.succeed(runtimeContent),
        } as unknown as FileSystem.FileSystem),
      );

      const testLayer = Layer.mergeAll(
        fsLayer,
        Path.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no network")),
        ),
      );

      const result = yield* DesktopAutoAttach.tryAutoAttachToRunningServer({
        stateDir,
        backendCwd: "/repo",
        primary: mockPrimary,
        configuration: mockConfiguration,
      }).pipe(Effect.provide(testLayer));

      assert.isFalse(result);
      assert.isFalse(attached);
    }),
  );

  it.effect("returns false when server-runtime.json has no bootstrap credentials", () =>
    Effect.gen(function* () {
      const runtimeContent = JSON.stringify({
        version: 1,
        pid: process.pid,
        origin: "http://127.0.0.1:4545",
        port: 4545,
        startedAt: "2026-01-01T00:00:00.000Z",
      });

      let attached = false;
      const mockPrimary = {
        attachExternal: () =>
          Effect.sync(() => {
            attached = true;
          }),
      } as unknown as DesktopBackendInstance;

      const mockConfiguration = {
        setBootstrapSecret: () => Effect.void,
      } as unknown as DesktopBackendConfiguration["Service"];

      const fsLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          exists: () => Effect.succeed(true),
          readFileString: () => Effect.succeed(runtimeContent),
        } as unknown as FileSystem.FileSystem),
      );

      const testLayer = Layer.mergeAll(
        fsLayer,
        Path.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no network")),
        ),
      );

      const result = yield* DesktopAutoAttach.tryAutoAttachToRunningServer({
        stateDir: "/tmp/t3-state-no-credentials",
        backendCwd: "/repo",
        primary: mockPrimary,
        configuration: mockConfiguration,
      }).pipe(Effect.provide(testLayer));

      assert.isFalse(result);
      assert.isFalse(attached);
    }),
  );

  it.effect("returns false when server-runtime.json has an invalid origin", () =>
    Effect.gen(function* () {
      const runtimeContent = JSON.stringify({
        version: 1,
        pid: process.pid,
        origin: "not-a-url",
        port: 4545,
        startedAt: "2026-01-01T00:00:00.000Z",
      });

      let attached = false;
      const mockPrimary = {
        attachExternal: () =>
          Effect.sync(() => {
            attached = true;
          }),
      } as unknown as DesktopBackendInstance;

      const mockConfiguration = {
        setBootstrapSecret: () => Effect.void,
      } as unknown as DesktopBackendConfiguration["Service"];

      const fsLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          exists: () => Effect.succeed(true),
          readFileString: () => Effect.succeed(runtimeContent),
        } as unknown as FileSystem.FileSystem),
      );

      const testLayer = Layer.mergeAll(
        fsLayer,
        Path.layer,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no network")),
        ),
      );

      const result = yield* DesktopAutoAttach.tryAutoAttachToRunningServer({
        stateDir: "/tmp/t3-state-invalid",
        backendCwd: "/repo",
        primary: mockPrimary,
        configuration: mockConfiguration,
      }).pipe(Effect.provide(testLayer));

      assert.isFalse(result);
      assert.isFalse(attached);
    }),
  );

  it.effect("successfully auto-attaches to live server and updates bootstrap credentials", () =>
    Effect.gen(function* () {
      const stateDir = "/tmp/t3-state-live";
      const currentPid = process.pid; // Guarantee a live PID
      const testSecret = "deadbeef00112233445566778899aabb";
      const runtimeContent = JSON.stringify({
        version: 1,
        pid: currentPid,
        origin: "http://127.0.0.1:4545",
        port: 4545,
        host: "127.0.0.1",
        startedAt: "2026-01-01T00:00:00.000Z",
        desktopBootstrapSecret: testSecret,
      });

      const attachedConfigRef = Ref.makeUnsafe<DesktopBackendStartConfig | null>(null);
      const attachedPidRef = Ref.makeUnsafe<number | null>(null);
      const updatedSecretRef = Ref.makeUnsafe<string | null>(null);

      const mockPrimary = {
        attachExternal: (config: DesktopBackendStartConfig, pid: Option.Option<number>) =>
          Effect.gen(function* () {
            yield* Ref.set(attachedConfigRef, config);
            yield* Ref.set(attachedPidRef, Option.getOrNull(pid));
          }),
      } as unknown as DesktopBackendInstance;

      const mockConfiguration = {
        setBootstrapSecret: (secret: string) => Ref.set(updatedSecretRef, secret),
      } as unknown as DesktopBackendConfiguration["Service"];

      const fsLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          exists: () => Effect.succeed(true),
          readFileString: () => Effect.succeed(runtimeContent),
        } as unknown as FileSystem.FileSystem),
      );

      // Mock HTTP client responding 200 OK
      const mockHttpClient = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 }))),
      );

      const testLayer = Layer.mergeAll(
        fsLayer,
        Path.layer,
        Layer.succeed(HttpClient.HttpClient, mockHttpClient),
      );

      const result = yield* DesktopAutoAttach.tryAutoAttachToRunningServer({
        stateDir,
        backendCwd: "/repo",
        primary: mockPrimary,
        configuration: mockConfiguration,
      }).pipe(Effect.provide(testLayer));

      assert.isTrue(result);

      const attachedConfig = yield* Ref.get(attachedConfigRef);
      assert.isNotNull(attachedConfig);
      assert.strictEqual(attachedConfig?.httpBaseUrl.origin, "http://127.0.0.1:4545");
      assert.strictEqual(attachedConfig?.bootstrap.desktopBootstrapSecret, testSecret);

      const attachedPid = yield* Ref.get(attachedPidRef);
      assert.strictEqual(attachedPid, currentPid);

      const updatedSecret = yield* Ref.get(updatedSecretRef);
      assert.strictEqual(updatedSecret, testSecret);
    }),
  );
});
