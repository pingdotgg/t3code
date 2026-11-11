import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
} from "./serviceProtocol.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";

class FakeLauncherProcess {
  connected: boolean;
  readonly ipc: boolean;
  readonly env: Record<string, string | undefined>;
  readonly sent: ServiceLauncherChildMessage[] = [];
  readonly #listeners = new Map<string, Set<(...args: ReadonlyArray<unknown>) => void>>();

  constructor(context: unknown, connected = true, ipc = connected) {
    this.connected = connected;
    this.ipc = ipc;
    this.env = { [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) };
  }

  send = (message: ServiceLauncherChildMessage, callback?: (error: Error | null) => void) => {
    this.sent.push(message);
    callback?.(null);
    return true;
  };

  on = (event: "message" | "disconnect", listener: (...args: ReadonlyArray<unknown>) => void) => {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  };

  off = (event: "message" | "disconnect", listener: (...args: ReadonlyArray<unknown>) => void) => {
    this.#listeners.get(event)?.delete(listener);
  };

  emit(message: ServiceLauncherParentMessage) {
    for (const listener of this.#listeners.get("message") ?? []) listener(message);
  }

  disconnect() {
    this.connected = false;
    for (const listener of this.#listeners.get("disconnect") ?? []) listener();
  }
}

const makeClient = (host: FakeLauncherProcess, currentVersion: string) =>
  ServiceLauncherClient.make({ currentVersion }).pipe(
    Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, host),
    Effect.provideService(HostProcess.Environment, host.env),
  );

it.effect("waits for the launcher to durably commit the trial update ID", () =>
  Effect.gen(function* () {
    const pending = {
      id: "update-1",
      fromVersion: "1.0.0",
      targetVersion: "1.1.0",
      dbPath: "/tmp/state.sqlite",
      status: "pending" as const,
    };
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.1.0",
      update: pending,
    });
    const client = yield* makeClient(host, "1.1.0");
    const prepared = yield* Effect.forkChild(client.prepareTrial, { startImmediately: true });
    yield* Effect.yieldNow;
    expect(host.sent).toEqual([{ type: "prepared", updateId: "update-1" }]);

    const committed = {
      id: pending.id,
      fromVersion: pending.fromVersion,
      targetVersion: pending.targetVersion,
      status: "committed" as const,
    };
    host.emit({ type: "committed", updateId: committed.id });
    expect(yield* Fiber.join(prepared)).toEqual(committed);
  }),
);

it.effect("returns the launcher-generated ID only after update acceptance", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.0.0",
    });
    const client = yield* makeClient(host, "1.0.0");
    const requested = yield* Effect.forkChild(
      client.requestUpdate({ targetVersion: "1.1.0", dbPath: "/tmp/state.sqlite" }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    host.emit({
      type: "update-accepted",
      updateId: "launcher-id",
    });
    expect(yield* Fiber.join(requested)).toBe("launcher-id");
  }),
);

it.effect("preserves a launcher rejection as a distinct error", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.0.0",
    });
    const client = yield* makeClient(host, "1.0.0");
    const requested = yield* Effect.forkChild(
      client.requestUpdate({ targetVersion: "1.1.0", dbPath: "/tmp/state.sqlite" }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    host.emit({ type: "update-rejected", reason: "requires local update" });
    expect(yield* Fiber.join(requested).pipe(Effect.flip)).toMatchObject({
      _tag: "ServiceLauncherRejectedError",
      targetVersion: "1.1.0",
      reason: "requires local update",
    });
  }),
);

it.effect("stops the server when the launcher asks over IPC or disconnects", () =>
  Effect.gen(function* () {
    const context = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.0.0",
    };
    const host = new FakeLauncherProcess(context);
    const stopped = yield* Effect.forkChild(
      ServiceLauncherClient.awaitServiceLauncherStop({ currentVersion: "1.0.0" }).pipe(
        Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, host),
        Effect.provideService(HostProcess.Environment, host.env),
      ),
      { startImmediately: true },
    );
    host.emit({ type: "stop" });
    yield* Fiber.join(stopped);

    const crashedHost = new FakeLauncherProcess(context);
    const crashed = yield* Effect.forkChild(
      ServiceLauncherClient.awaitServiceLauncherStop({ currentVersion: "1.0.0" }).pipe(
        Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, crashedHost),
        Effect.provideService(HostProcess.Environment, crashedHost.env),
      ),
      { startImmediately: true },
    );
    crashedHost.disconnect();
    yield* Fiber.join(crashed);

    const preDisconnectedHost = new FakeLauncherProcess(context, false, true);
    yield* ServiceLauncherClient.awaitServiceLauncherStop({ currentVersion: "1.0.0" }).pipe(
      Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, preDisconnectedHost),
      Effect.provideService(HostProcess.Environment, preDisconnectedHost.env),
    );

    // Mirrors the default `ServiceLauncherHostProcess` reference: resolved while `process.connected`
    // is true, then IPC disconnects before `awaitServiceLauncherStop` or `requestUpdate` subscribes.
    let liveConnected = true;
    const getterBackedHost: (typeof ServiceLauncherClient.ServiceLauncherHostProcess)["Service"] = {
      get connected() {
        return liveConnected;
      },
      ipc: true,
      send: (_message: ServiceLauncherChildMessage, callback?: (error: Error | null) => void) => {
        callback?.(null);
        return false;
      },
      on: () => undefined,
      off: () => undefined,
    };
    const client = yield* ServiceLauncherClient.make({ currentVersion: "1.0.0" }).pipe(
      Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, getterBackedHost),
      Effect.provideService(HostProcess.Environment, {
        [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context),
      }),
    );
    liveConnected = false;
    yield* ServiceLauncherClient.awaitServiceLauncherStop({ currentVersion: "1.0.0" }).pipe(
      Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, getterBackedHost),
      Effect.provideService(HostProcess.Environment, {
        [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context),
      }),
    );
    expect(
      yield* client
        .requestUpdate({ targetVersion: "1.1.0", dbPath: "/tmp/state.sqlite" })
        .pipe(Effect.flip),
    ).toMatchObject({
      _tag: "ServiceLauncherClientError",
      operation: "disconnect",
    });
  }),
);

it.effect("rejects contradictory trial context instead of leaving activation closed", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.1.0",
      update: {
        id: "update-1",
        fromVersion: "1.0.0",
        targetVersion: "1.2.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    });
    const error = yield* makeClient(host, "1.1.0").pipe(Effect.flip);
    expect(error.message).toBe("The service launcher supplied invalid startup context.");
  }),
);

it.effect("ignores launcher context inherited without an IPC channel", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess(
      { protocol: SERVICE_LAUNCHER_PROTOCOL, childVersion: "1.0.0" },
      false,
    );
    const client = yield* makeClient(host, "1.1.0");
    const error = yield* client
      .requestUpdate({ targetVersion: "1.2.0", dbPath: "/tmp/state.sqlite" })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "ServiceLauncherClientError", operation: "unmanaged" });
    expect(host.sent).toEqual([]);
  }),
);
