import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Exit, Ref, Scope } from "effect";
import { WS_CHANNELS } from "@t3tools/contracts";

import { makeServerPushBus } from "./pushBus";

class MockWebSocket {
  static readonly OPEN = 1;

  readonly OPEN = MockWebSocket.OPEN;
  readyState = MockWebSocket.OPEN;
  readonly sent: string[] = [];
  private readonly waiters = new Set<() => void>();

  send(message: string) {
    this.sent.push(message);
    for (const waiter of this.waiters) {
      waiter();
    }
  }

  waitForSentCount(count: number): Promise<void> {
    if (this.sent.length >= count) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const check = () => {
        if (this.sent.length < count) {
          return;
        }
        this.waiters.delete(check);
        resolve();
      };

      this.waiters.add(check);
    });
  }
}

describe("makeServerPushBus", () => {
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
  });

  it("waits for the welcome push before a new client joins broadcast delivery", async () => {
    scope = await Effect.runPromise(Scope.make("sequential"));

    const client = new MockWebSocket();
    const { clients, pushBus } = await Effect.runPromise(
      Effect.gen(function* () {
        const clients = yield* Ref.make(new Set<WebSocket>());
        const pushBus = yield* makeServerPushBus({
          clients,
          logOutgoingPush: () => {},
        });

        return { clients, pushBus };
      }).pipe(Scope.provide(scope)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: [{ kind: "keybindings.malformed-config", message: "queued-before-connect" }],
          providers: [],
        });

        const delivered = yield* pushBus.publishClient(
          client as unknown as WebSocket,
          WS_CHANNELS.serverWelcome,
          {
            cwd: "/tmp/project",
            projectName: "project",
          },
        );
        expect(delivered).toBe(true);

        yield* Ref.update(clients, (current) => current.add(client as unknown as WebSocket));

        yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
          issues: [],
          providers: [],
        });
      }),
    );

    await client.waitForSentCount(2);

    const messages = client.sent.map(
      (message) => JSON.parse(message) as { channel: string; data: unknown },
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      type: "push",
      sequence: 2,
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd: "/tmp/project",
        projectName: "project",
      },
    });
    expect(messages[1]).toEqual({
      type: "push",
      sequence: 3,
      channel: WS_CHANNELS.serverConfigUpdated,
      data: {
        issues: [],
        providers: [],
      },
    });
  });
});
