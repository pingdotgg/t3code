import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { readShellThreadInventory } from "./shellInventory.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const thread = (id: string) => ({ ...v2ThreadShell, id: ThreadId.make(id) });

describe("readShellThreadInventory", () => {
  it.effect("reads the socket's full snapshot when HTTP refuses, and closes that stream", () =>
    Effect.gen(function* () {
      const inputs: unknown[] = [];
      let closed = 0;
      const items: OrchestrationV2ShellStreamItem[] = [
        {
          kind: "snapshot",
          snapshot: {
            ...v2ShellSnapshot,
            threads: [thread("recent"), thread("older-settled"), thread("idle-child")],
          },
        },
        { kind: "synchronized" },
      ];
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: unknown) => {
          inputs.push(input);
          // A live subscription never ends on its own: the read must close it.
          return Stream.concat(Stream.fromIterable(items), Stream.never).pipe(
            Stream.ensuring(Effect.sync(() => (closed += 1))),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const session = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        inboundFrames: Effect.succeed(0),
        closed: Effect.never,
      } as unknown as RpcSession.RpcSession;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      let httpReads = 0;
      const threads = yield* readShellThreadInventory().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        // The HTTP shell route refused: the loader answers none, as for a 401 or 404.
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, {
          load: () => Effect.sync(() => (httpReads += 1)).pipe(Effect.as(Option.none())),
        }),
      );
      expect(httpReads).toBe(1);
      expect(threads?.map((row) => row.id)).toEqual(["recent", "older-settled", "idle-child"]);
      expect(inputs).toEqual([{}]);
      expect(closed).toBe(1);
    }),
  );
});
