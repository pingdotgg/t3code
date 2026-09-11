import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";

import type {
  GatewayProfile,
  GatewayRuntimeEventSource,
  GatewayRuntimePort,
  GatewayScope,
  GatewayStatusSnapshot,
} from "./port.ts";
import { parseGatewayStatusSnapshot } from "./port.ts";

export type GatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;

export type GatewayBridgeState = "connecting" | "running" | "degraded" | "disabled";

type GatewayBridgeEvent = { readonly data?: string };
type GatewayBridgeEventType = "open" | "close" | "error" | "message";

export interface GatewayBridgeSocket {
  readonly readyState: number;
  readonly OPEN: number;
  addEventListener(
    type: GatewayBridgeEventType,
    listener: (event: GatewayBridgeEvent) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

const METHODS = new Set<keyof GatewayRuntimePort>([
  "openThread",
  "openAgents",
  "handoffThread",
  "settleThread",
  "unsettleThread",
  "createProfile",
  "updateProfile",
  "deleteProfile",
  "replicateProfiles",
  "listEnvironments",
  "getEnvironmentStatus",
  "listProfiles",
  "resolveProfileModelSelection",
  "listProjects",
  "listThreads",
  "getThread",
  "hasThreadMessage",
  "createAssetUrl",
  "getPullRequest",
  "getPullRequestActivity",
  "getCommandReceipts",
  "createThread",
  "sendMessage",
  "controlThread",
  "respondToApprovals",
  "respondToApproval",
  "executeOperation",
]);

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

export function connectGatewayBridge(input: {
  readonly port: GatewayRuntimePort;
  readonly events?: GatewayRuntimeEventSource;
  readonly grants?: GatewayGrants;
  readonly profiles?: ReadonlyArray<GatewayProfile>;
  readonly url: string;
  readonly token: string;
  readonly createSocket?: (url: string) => GatewayBridgeSocket;
  readonly onState?: (state: GatewayBridgeState) => void;
  readonly onStatusSnapshot?: (snapshot: GatewayStatusSnapshot | null) => void;
  readonly reconnectDelayMs?: number;
}) {
  let socket: GatewayBridgeSocket | null = null;
  let reconnectFiber: Fiber.Fiber<void, never> | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let stopped = false;
  let statusRequestId = 0;
  let configured = false;

  const connect = () => {
    if (stopped) return;
    configured = false;
    input.onStatusSnapshot?.(null);
    input.onState?.("connecting");
    const next =
      input.createSocket?.(input.url) ?? (new WebSocket(input.url) as GatewayBridgeSocket);
    let authenticated = false;
    let expectedServerProof: string | null = null;
    socket = next;
    next.addEventListener("error", () => {
      if (socket === next && !stopped) {
        configured = false;
        input.onStatusSnapshot?.(null);
        input.onState?.("degraded");
      }
    });
    next.addEventListener("close", () => {
      if (socket !== next || stopped) return;
      socket = null;
      configured = false;
      input.onStatusSnapshot?.(null);
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      input.onState?.("degraded");
      reconnectFiber = Effect.runFork(
        Effect.sleep(input.reconnectDelayMs ?? 1_000).pipe(Effect.tap(() => Effect.sync(connect))),
      );
    });
    next.addEventListener("message", (event) => {
      if (socket !== next || stopped || typeof event.data !== "string") return;
      const data = event.data;
      void (async () => {
        let requestId = -1;
        try {
          const message = JSON.parse(data) as unknown;
          if (typeof message !== "object" || message === null || Array.isArray(message)) {
            throw new Error("Invalid gateway bridge request.");
          }
          const candidate = message as Record<string, unknown>;
          if (candidate.type === "challenge") {
            if (
              authenticated ||
              typeof candidate.nonce !== "string" ||
              !/^[a-f\d]{64}$/u.test(candidate.nonce)
            ) {
              throw new Error("Invalid gateway bridge challenge.");
            }
            expectedServerProof = await proof(input.token, `server:${candidate.nonce}`);
            next.send(
              JSON.stringify({
                type: "authenticate",
                proof: await proof(input.token, `client:${candidate.nonce}`),
              }),
            );
            return;
          }
          if (candidate.type === "authenticated") {
            if (
              expectedServerProof === null ||
              typeof candidate.proof !== "string" ||
              candidate.proof !== expectedServerProof
            ) {
              throw new Error("Gateway bridge server authentication failed.");
            }
            authenticated = true;
            expectedServerProof = null;
            configured = false;
            input.onStatusSnapshot?.(null);
            next.send(
              JSON.stringify({
                type: "configure",
                grants: input.grants ?? {},
                profiles: input.profiles ?? [],
                capabilities: { statusSnapshots: true },
              }),
            );
            return;
          }
          if (candidate.type === "configured") {
            if (
              !authenticated ||
              typeof candidate.cursors !== "object" ||
              candidate.cursors === null ||
              Array.isArray(candidate.cursors)
            ) {
              throw new Error("Invalid gateway bridge cursor configuration.");
            }
            const environmentIds = Object.entries(input.grants ?? {})
              .filter(([, scopes]) => scopes.includes("read"))
              .map(([environmentId]) => environmentId);
            const rawCursors = candidate.cursors as Record<string, unknown>;
            const afterSequenceByEnvironment: Record<string, number> = {};
            for (const environmentId of environmentIds) {
              const cursor = rawCursors[environmentId];
              if (!Number.isInteger(cursor) || (cursor as number) < 0) {
                throw new Error(`Invalid gateway bridge cursor for environment ${environmentId}.`);
              }
              afterSequenceByEnvironment[environmentId] = cursor as number;
            }
            const allowedEnvironmentIds = new Set(environmentIds);
            unsubscribeEvents?.();
            unsubscribeEvents =
              input.events?.subscribe(
                (runtimeEvent) => {
                  if (
                    allowedEnvironmentIds.has(runtimeEvent.environmentId) &&
                    socket === next &&
                    next.readyState === next.OPEN
                  ) {
                    next.send(JSON.stringify({ type: "event", event: runtimeEvent }));
                  }
                },
                { environmentIds, afterSequenceByEnvironment },
              ) ?? null;
            configured = true;
            input.onState?.("running");
            return;
          }
          if (candidate.type === "status.snapshot") {
            if (!authenticated || !configured) {
              throw new Error("Gateway bridge status arrived before configuration.");
            }
            const snapshot = parseGatewayStatusSnapshot(candidate.snapshot);
            if (snapshot !== undefined) input.onStatusSnapshot?.(snapshot);
            return;
          }
          if (!authenticated) throw new Error("Gateway bridge is not authenticated.");
          if (
            typeof candidate.id !== "number" ||
            !Number.isInteger(candidate.id) ||
            typeof candidate.method !== "string" ||
            !METHODS.has(candidate.method as keyof GatewayRuntimePort) ||
            !Array.isArray(candidate.args)
          ) {
            throw new Error("Invalid gateway bridge request.");
          }
          requestId = candidate.id;
          const methodName = candidate.method as keyof GatewayRuntimePort;
          const method = input.port[methodName] as (...args: ReadonlyArray<any>) => Promise<any>;
          const result = await method(...candidate.args);
          next.send(JSON.stringify({ id: requestId, result }));
        } catch (error) {
          next.send(
            JSON.stringify({
              id: requestId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          if (!configured) {
            input.onStatusSnapshot?.(null);
            input.onState?.("degraded");
            next.close();
          }
        }
      })();
    });
  };

  connect();
  return {
    requestStatus: (): boolean => {
      const active = socket;
      if (active === null || !configured || active.readyState !== active.OPEN) return false;
      active.send(
        JSON.stringify({ type: "status.request", requestId: `status-${++statusRequestId}` }),
      );
      return true;
    },
    stop: () => {
      stopped = true;
      configured = false;
      input.onStatusSnapshot?.(null);
      reconnectFiber?.interruptUnsafe();
      reconnectFiber = null;
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      const active = socket;
      socket = null;
      active?.close();
      input.onState?.("disabled");
    },
  };
}
