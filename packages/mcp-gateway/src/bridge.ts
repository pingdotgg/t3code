import * as NodeCrypto from "node:crypto";

import { WebSocketServer, type WebSocket } from "ws";

import type { GatewayProfile, GatewayRuntimePort, GatewayScope } from "./port.ts";

export type GatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;

export type GatewayBridgeStartupResult =
  | { readonly status: "running" }
  | {
      readonly status: "degraded";
      readonly code: "address_in_use" | "listen_failed";
      readonly port: number;
      readonly message: string;
    };

const GATEWAY_SCOPES = new Set<GatewayScope>(["read", "create", "send"]);

function parseGrants(value: unknown): GatewayGrants {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Gateway grants must be an object keyed by environment id.");
  }
  const grants: Record<string, ReadonlyArray<GatewayScope>> = {};
  for (const [environmentId, candidate] of Object.entries(value)) {
    if (
      environmentId.trim() === "" ||
      !Array.isArray(candidate) ||
      candidate.length === 0 ||
      candidate.some(
        (scope) => typeof scope !== "string" || !GATEWAY_SCOPES.has(scope as GatewayScope),
      )
    ) {
      throw new Error(`Invalid gateway grants for environment ${environmentId}.`);
    }
    grants[environmentId] = [...new Set(candidate)] as ReadonlyArray<GatewayScope>;
  }
  return grants;
}

const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const RUNTIME_MODES = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);

function parseProfiles(value: unknown): ReadonlyArray<GatewayProfile> {
  if (!Array.isArray(value)) throw new Error("Gateway profiles must be an array.");
  const names = new Set<string>();
  return value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("Gateway profile must be an object.");
    }
    const profile = candidate as Record<string, unknown>;
    for (const key of [
      "name",
      "environmentId",
      "providerLabel",
      "modelLabel",
      "instanceId",
      "model",
    ]) {
      if (typeof profile[key] !== "string" || (profile[key] as string).trim() === "") {
        throw new Error(`Gateway profile ${key} must be a non-empty string.`);
      }
    }
    if (names.has(profile.name as string)) throw new Error("Gateway profile names must be unique.");
    names.add(profile.name as string);
    if (
      profile.reasoningEffort !== undefined &&
      (typeof profile.reasoningEffort !== "string" ||
        !REASONING_EFFORTS.has(profile.reasoningEffort))
    ) {
      throw new Error("Gateway profile reasoning effort is invalid.");
    }
    if (typeof profile.runtimeMode !== "string" || !RUNTIME_MODES.has(profile.runtimeMode)) {
      throw new Error("Gateway profile runtime mode is invalid.");
    }
    if (profile.interactionMode !== "default" && profile.interactionMode !== "plan") {
      throw new Error("Gateway profile interaction mode is invalid.");
    }
    return profile as unknown as GatewayProfile;
  });
}

interface PendingRequest {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutSignal: AbortSignal;
  readonly onTimeout: () => void;
}

function clearRequestTimeout(request: PendingRequest): void {
  request.timeoutSignal.removeEventListener("abort", request.onTimeout);
}

function proof(token: string, value: string): string {
  return NodeCrypto.createHmac("sha256", token).update(value).digest("hex");
}

function valuesMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    NodeCrypto.timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function createBridgeRuntimePort(input: {
  readonly port: number;
  readonly token: string;
  readonly host?: string;
  readonly requestTimeoutMs?: number;
  readonly authenticationTimeoutMs?: number;
  readonly initialGrants?: GatewayGrants;
  readonly initialProfiles?: ReadonlyArray<GatewayProfile>;
}): {
  readonly port: GatewayRuntimePort;
  readonly getGrants: () => GatewayGrants;
  readonly getProfiles: () => ReadonlyArray<GatewayProfile>;
  readonly ready: Promise<GatewayBridgeStartupResult>;
  readonly close: () => Promise<void>;
} {
  if (input.token.length < 16)
    throw new Error("The gateway bridge token must contain at least 16 characters.");
  const server = new WebSocketServer({
    host: input.host ?? "127.0.0.1",
    port: input.port,
    maxPayload: 1024 * 1024,
  });
  const ready = new Promise<GatewayBridgeStartupResult>((resolve) => {
    server.once("listening", () => resolve({ status: "running" }));
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve({
        status: "degraded",
        code: error.code === "EADDRINUSE" ? "address_in_use" : "listen_failed",
        port: input.port,
        message: error.message,
      }),
    );
  });
  // WebSocketServer reports listen failures through EventEmitter. Keep an error listener
  // installed after startup so a degraded companion cannot terminate its host process.
  server.on("error", () => undefined);
  let client: WebSocket | null = null;
  let latestAuthenticatedGeneration = 0;
  let grants = input.initialGrants ?? {};
  let profiles = input.initialProfiles ?? [];
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

  const rejectPending = (message: string) => {
    for (const request of pending.values()) {
      clearRequestTimeout(request);
      request.reject(new Error(message));
    }
    pending.clear();
  };

  server.on("connection", (socket) => {
    let authenticated = false;
    let configured = false;
    let authenticationGeneration = 0;
    const nonce = NodeCrypto.randomBytes(32).toString("hex");
    const authenticationSignal = AbortSignal.timeout(input.authenticationTimeoutMs ?? 5_000);
    const onAuthenticationTimeout = () => {
      if (!configured) socket.close(1008, "Gateway bridge authentication timed out.");
    };
    authenticationSignal.addEventListener("abort", onAuthenticationTimeout, { once: true });
    socket.send(JSON.stringify({ type: "challenge", nonce }));

    socket.on("message", (raw) => {
      try {
        const response = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!authenticated) {
          const expectedClientProof = proof(input.token, `client:${nonce}`);
          if (
            response.type !== "authenticate" ||
            typeof response.proof !== "string" ||
            !valuesMatch(response.proof, expectedClientProof)
          ) {
            socket.close(1008, "Gateway bridge authentication failed.");
            return;
          }
          authenticated = true;
          authenticationGeneration = ++latestAuthenticatedGeneration;
          socket.send(
            JSON.stringify({ type: "authenticated", proof: proof(input.token, `server:${nonce}`) }),
          );
          return;
        }
        if (response.type === "configure") {
          if (authenticationGeneration !== latestAuthenticatedGeneration) {
            socket.close(1008, "Gateway bridge connection was superseded.");
            return;
          }
          const nextGrants = parseGrants(response.grants);
          const nextProfiles = parseProfiles(response.profiles ?? []);
          if (client !== null && client !== socket) {
            rejectPending("T3 gateway client was replaced.");
            client.close(1012, "Replaced by a newly configured T3 client runtime.");
          }
          grants = nextGrants;
          profiles = nextProfiles;
          client = socket;
          configured = true;
          authenticationSignal.removeEventListener("abort", onAuthenticationTimeout);
          return;
        }
        if (client !== socket) return;
        if (typeof response.id !== "number") return;
        const request = pending.get(response.id);
        if (request === undefined) return;
        pending.delete(response.id);
        clearRequestTimeout(request);
        if (typeof response.error !== "string") request.resolve(response.result);
        else request.reject(new Error(response.error));
      } catch {
        socket.close(
          1008,
          authenticated
            ? "Gateway bridge configuration or response was invalid."
            : "Gateway bridge authentication failed.",
        );
      }
    });
    socket.on("close", () => {
      authenticationSignal.removeEventListener("abort", onAuthenticationTimeout);
      if (client !== socket) return;
      client = null;
      rejectPending("T3 gateway client disconnected.");
    });
  });

  const invoke = (method: keyof GatewayRuntimePort, args: ReadonlyArray<unknown>): Promise<any> => {
    if (client === null || client.readyState !== client.OPEN) {
      return Promise.reject(
        new Error("No configured T3 client is connected to the gateway bridge."),
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeoutSignal = AbortSignal.timeout(input.requestTimeoutMs ?? 30_000);
      const onTimeout = () => {
        pending.delete(id);
        reject(new Error(`Gateway bridge request ${id} timed out.`));
      };
      timeoutSignal.addEventListener("abort", onTimeout, { once: true });
      pending.set(id, { resolve, reject, timeoutSignal, onTimeout });
      client?.send(JSON.stringify({ id, method, args }));
    });
  };

  return {
    getGrants: () => grants,
    getProfiles: () => profiles,
    ready,
    port: {
      listEnvironments: () => invoke("listEnvironments", []),
      getEnvironmentStatus: (environmentId) => invoke("getEnvironmentStatus", [environmentId]),
      listProjects: (environmentId) => invoke("listProjects", [environmentId]),
      listThreads: (environmentId) => invoke("listThreads", [environmentId]),
      getThread: (environmentId, threadId) => invoke("getThread", [environmentId, threadId]),
      createThread: (request) => invoke("createThread", [request]),
      sendMessage: (request) => invoke("sendMessage", [request]),
    },
    close: () =>
      new Promise((resolve, reject) => {
        rejectPending("Gateway stopped.");
        client?.close(1001, "Gateway stopped.");
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
