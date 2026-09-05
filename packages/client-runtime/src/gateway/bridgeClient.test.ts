import { describe, expect, it, vi } from "@effect/vitest";

import { connectGatewayBridge, type GatewayBridgeSocket } from "./bridgeClient.ts";

async function proof(token: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
import type { GatewayRuntimePort } from "./port.ts";

class FakeSocket implements GatewayBridgeSocket {
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<
    string,
    Array<(event: { readonly data?: string }) => void>
  >();

  addEventListener(type: string, listener: (event: { readonly data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    const event = data === undefined ? {} : { data };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const unusedPort = {
  listEnvironments: vi.fn(async () => []),
} as unknown as GatewayRuntimePort;

describe("gateway bridge client", () => {
  it("does not execute runtime operations before mutual authentication", async () => {
    const socket = new FakeSocket();
    const bridge = connectGatewayBridge({
      port: unusedPort,
      token: "test-token-123456789",
      url: "ws://127.0.0.1:47631",
      createSocket: () => socket,
    });

    socket.emit("message", JSON.stringify({ id: 1, method: "listEnvironments", args: [] }));
    await vi.waitFor(() => expect(socket.closed).toBe(true));

    expect(unusedPort.listEnvironments).not.toHaveBeenCalled();
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      id: -1,
      error: "Gateway bridge is not authenticated.",
    });
    bridge.stop();
  });

  it("sends exact persisted environment grants only after mutual authentication", async () => {
    const socket = new FakeSocket();
    const token = "test-token-123456789";
    const grants = {
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"] as const,
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"] as const,
    };
    const profiles = [
      {
        name: "Andy",
        environmentId: "a534b83f-a352-44d8-aedc-c4230c179390",
        providerLabel: "OpenCode",
        modelLabel: "GLM 5.3",
        instanceId: "opencode",
        model: "glm-5.3",
        reasoningEffort: "medium",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ] as const;
    const onState = vi.fn();
    const bridge = connectGatewayBridge({
      port: unusedPort,
      token,
      grants,
      profiles,
      url: "ws://127.0.0.1:47631",
      createSocket: () => socket,
      onState,
    });
    const nonce = "a".repeat(64);

    socket.emit("message", JSON.stringify({ type: "challenge", nonce }));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent.map((message) => JSON.parse(message))).not.toContainEqual({
      type: "configure",
      grants,
      profiles,
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "authenticated",
        proof: await proof(token, `server:${nonce}`),
      }),
    );

    await vi.waitFor(() =>
      expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
        type: "configure",
        grants,
        profiles,
      }),
    );
    expect(onState).toHaveBeenCalledWith("running");
    bridge.stop();
  });
});
