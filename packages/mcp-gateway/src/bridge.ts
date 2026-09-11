import * as NodeCrypto from "node:crypto";

import { WebSocketServer, type WebSocket } from "ws";

import { GATEWAY_SCOPE_VALUES, parseGatewayStatusSnapshot } from "./port.ts";
import type {
  GatewayProfile,
  GatewayRuntimeEvent,
  GatewayRuntimePort,
  GatewayScope,
  GatewayStatusSnapshot,
} from "./port.ts";

export type GatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;

export type GatewayBridgeStartupResult =
  | { readonly status: "running" }
  | {
      readonly status: "degraded";
      readonly code: "address_in_use" | "listen_failed";
      readonly port: number;
      readonly message: string;
    };

const GATEWAY_SCOPES = new Set<GatewayScope>(GATEWAY_SCOPE_VALUES);

function parseGrants(value: unknown): GatewayGrants {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Gateway grants must be an object keyed by environment id.");
  }
  const grants: Record<string, ReadonlyArray<GatewayScope>> = Object.create(null);
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

function parseProfiles(value: unknown): ReadonlyArray<GatewayProfile> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Gateway profiles must be an array.");
  return value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("Invalid gateway profile.");
    }
    const profile = candidate as Record<string, unknown>;
    const modelSelection = profile.modelSelection;
    if (
      typeof profile.name !== "string" ||
      profile.name.trim() === "" ||
      typeof modelSelection !== "object" ||
      modelSelection === null ||
      Array.isArray(modelSelection) ||
      typeof (modelSelection as Record<string, unknown>).instanceId !== "string" ||
      typeof (modelSelection as Record<string, unknown>).model !== "string" ||
      (profile.runtimeMode !== "approval-required" &&
        profile.runtimeMode !== "auto-accept-edits" &&
        profile.runtimeMode !== "auto" &&
        profile.runtimeMode !== "full-access" &&
        profile.runtimeMode !== "read-only") ||
      (profile.interactionMode !== "default" && profile.interactionMode !== "plan")
    ) {
      throw new Error(`Invalid gateway profile ${String(profile.name ?? "")}.`);
    }
    return { ...candidate, name: profile.name.trim() } as GatewayProfile;
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
  readonly getEventCursor?: (environmentId: string) => number;
  readonly onEvent?: (event: GatewayRuntimeEvent) => void;
  readonly getStatusSnapshot?: (grants: GatewayGrants) => GatewayStatusSnapshot;
  readonly onStatusChange?: (listener: () => void) => () => void;
  /** Separate MCP sessions never participate in T3 runtime authentication or replacement. */
  readonly onMcpConnection?: (socket: WebSocket) => void;
}): {
  readonly port: GatewayRuntimePort;
  readonly getGrants: () => GatewayGrants;
  readonly getProfiles: () => ReadonlyArray<GatewayProfile>;
  readonly getHealth: () => {
    readonly bridge: "connected" | "disconnected" | "degraded";
    readonly degradedReasons: ReadonlyArray<string>;
  };
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
  let startupStatus: GatewayBridgeStartupResult | { readonly status: "starting" } = {
    status: "starting",
  };
  const ready = new Promise<GatewayBridgeStartupResult>((resolve) => {
    server.once("listening", () => {
      startupStatus = { status: "running" };
      resolve(startupStatus);
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      startupStatus = {
        status: "degraded",
        code: error.code === "EADDRINUSE" ? "address_in_use" : "listen_failed",
        port: input.port,
        message: error.message,
      };
      resolve(startupStatus);
    });
  });
  // WebSocketServer reports listen failures through EventEmitter. Keep an error listener
  // installed after startup so a degraded companion cannot terminate its host process.
  server.on("error", () => undefined);
  let client: WebSocket | null = null;
  let latestAuthenticatedGeneration = 0;
  let grants = input.initialGrants ?? {};
  let profiles: ReadonlyArray<GatewayProfile> = [];
  let supportsStatusSnapshots = false;
  let statusNotificationQueued = false;
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

  const rejectPending = (message: string) => {
    for (const request of pending.values()) {
      clearRequestTimeout(request);
      request.reject(new Error(message));
    }
    pending.clear();
  };

  const sendStatusSnapshot = (requestId?: string) => {
    if (
      client === null ||
      client.readyState !== client.OPEN ||
      !supportsStatusSnapshots ||
      input.getStatusSnapshot === undefined
    )
      return;
    const snapshot = parseGatewayStatusSnapshot(input.getStatusSnapshot(grants));
    if (snapshot === undefined) return;
    client.send(
      JSON.stringify({
        type: "status.snapshot",
        ...(requestId === undefined ? {} : { requestId }),
        snapshot,
      }),
    );
  };

  const unsubscribeStatus = input.onStatusChange?.(() => {
    if (statusNotificationQueued) return;
    statusNotificationQueued = true;
    queueMicrotask(() => {
      statusNotificationQueued = false;
      sendStatusSnapshot();
    });
  });

  server.on("connection", (socket, request) => {
    if (request.url === "/mcp") {
      if (input.onMcpConnection !== undefined) input.onMcpConnection(socket);
      else socket.close(1008, "This gateway does not support shared MCP sessions.");
      return;
    }
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
          const nextProfiles = parseProfiles(response.profiles);
          if (client !== null && client !== socket) {
            rejectPending("T3 gateway client was replaced.");
            client.close(1012, "Replaced by a newly configured T3 client runtime.");
          }
          grants = nextGrants;
          profiles = nextProfiles;
          const capabilities = response.capabilities;
          supportsStatusSnapshots =
            typeof capabilities === "object" &&
            capabilities !== null &&
            !Array.isArray(capabilities) &&
            (capabilities as Record<string, unknown>).statusSnapshots === true;
          client = socket;
          configured = true;
          authenticationSignal.removeEventListener("abort", onAuthenticationTimeout);
          const cursors = Object.fromEntries(
            Object.keys(nextGrants).map((environmentId) => [
              environmentId,
              input.getEventCursor?.(environmentId) ?? 0,
            ]),
          );
          socket.send(JSON.stringify({ type: "configured", cursors }));
          sendStatusSnapshot();
          return;
        }
        if (response.type === "status.request") {
          if (
            client !== socket ||
            !configured ||
            !supportsStatusSnapshots ||
            typeof response.requestId !== "string" ||
            response.requestId.length === 0 ||
            response.requestId.length > 200
          ) {
            return;
          }
          sendStatusSnapshot(response.requestId);
          return;
        }
        if (response.type === "event") {
          if (client !== socket || !configured) return;
          const event = response.event;
          if (typeof event !== "object" || event === null || Array.isArray(event)) return;
          const runtimeEvent = event as Record<string, unknown>;
          if (
            typeof runtimeEvent.environmentId !== "string" ||
            grants[runtimeEvent.environmentId]?.includes("read") !== true ||
            typeof runtimeEvent.eventId !== "string" ||
            !Number.isInteger(runtimeEvent.sequence) ||
            typeof runtimeEvent.type !== "string" ||
            typeof runtimeEvent.occurredAt !== "string"
          ) {
            // A partial grant excludes an environment from forwarding; receiving
            // an excluded event is ignored rather than disconnecting the bridge.
            return;
          }
          input.onEvent?.(runtimeEvent as unknown as GatewayRuntimeEvent);
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
      supportsStatusSnapshots = false;
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
    getHealth: () => {
      if (startupStatus.status === "degraded") {
        return { bridge: "degraded" as const, degradedReasons: [startupStatus.message] };
      }
      if (
        startupStatus.status === "running" &&
        client !== null &&
        client.readyState === client.OPEN
      ) {
        return { bridge: "connected" as const, degradedReasons: [] };
      }
      return {
        bridge: "disconnected" as const,
        degradedReasons: [
          startupStatus.status === "starting"
            ? "Gateway bridge is still starting."
            : "No configured T3 client is connected to the gateway bridge.",
        ],
      };
    },
    ready,
    port: {
      openAgents: (environmentId) => invoke("openAgents", [environmentId]),
      handoffThread: (input) => invoke("handoffThread", [input]),
      settleThread: (environmentId, threadId) => invoke("settleThread", [environmentId, threadId]),
      unsettleThread: (environmentId, threadId) =>
        invoke("unsettleThread", [environmentId, threadId]),
      createProfile: (environmentId, profile) => invoke("createProfile", [environmentId, profile]),
      updateProfile: (environmentId, profileId, patch) =>
        invoke("updateProfile", [environmentId, profileId, patch]),
      deleteProfile: (environmentId, profileId) =>
        invoke("deleteProfile", [environmentId, profileId]),
      replicateProfiles: (environmentId, profiles) =>
        invoke("replicateProfiles", [environmentId, profiles]),
      openThread: (environmentId, threadId) => invoke("openThread", [environmentId, threadId]),
      listEnvironments: () => invoke("listEnvironments", []),
      getEnvironmentStatus: (environmentId) => invoke("getEnvironmentStatus", [environmentId]),
      listProfiles: (environmentId) => invoke("listProfiles", [environmentId]),
      resolveProfileModelSelection: (environmentId, profile) =>
        invoke("resolveProfileModelSelection", [environmentId, profile]),
      listProjects: (environmentId) => invoke("listProjects", [environmentId]),
      listThreads: (environmentId) => invoke("listThreads", [environmentId]),
      getThread: (environmentId, threadId) => invoke("getThread", [environmentId, threadId]),
      hasThreadMessage: (environmentId, threadId, messageId) =>
        invoke("hasThreadMessage", [environmentId, threadId, messageId]),
      createAssetUrl: (environmentId, resource) =>
        invoke("createAssetUrl", [environmentId, resource]),
      getPullRequest: (environmentId, ref) => invoke("getPullRequest", [environmentId, ref]),
      getPullRequestActivity: (environmentId, ref) =>
        invoke("getPullRequestActivity", [environmentId, ref]),
      getCommandReceipts: (environmentId, commandIds) =>
        invoke("getCommandReceipts", [environmentId, commandIds]),
      createThread: (request) => invoke("createThread", [request]),
      sendMessage: (request) => invoke("sendMessage", [request]),
      controlThread: (request) => invoke("controlThread", [request]),
      respondToApprovals: (request) => invoke("respondToApprovals", [request]),
      respondToApproval: (request) => invoke("respondToApproval", [request]),
      executeOperation: (request) => invoke("executeOperation", [request]),
    },
    close: () =>
      new Promise((resolve, reject) => {
        unsubscribeStatus?.();
        rejectPending("Gateway stopped.");
        for (const socket of server.clients) socket.terminate();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
