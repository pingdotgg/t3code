import {
  type ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  type OrchestrationGetThreadMessagesPageResult,
  type OrchestrationReadModel,
  type ServerConfig,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";

import type { RemoteConnectionConfig } from "./connection";

const REQUEST_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 5_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const EMPTY_HEADERS: ReadonlyArray<readonly [string, string]> = [];
const textDecoder = new TextDecoder();

type RpcRequestId = string;

type RpcRequestMessage = {
  readonly _tag: "Request";
  readonly id: RpcRequestId;
  readonly tag: string;
  readonly payload: unknown;
  readonly headers: ReadonlyArray<readonly [string, string]>;
};

type RpcAckMessage = {
  readonly _tag: "Ack";
  readonly requestId: RpcRequestId;
};

type RpcPingMessage = {
  readonly _tag: "Ping";
};

type RpcPongMessage = {
  readonly _tag: "Pong";
};

type RpcChunkMessage = {
  readonly _tag: "Chunk";
  readonly requestId: RpcRequestId;
  readonly values: ReadonlyArray<unknown>;
};

type RpcExitMessage = {
  readonly _tag: "Exit";
  readonly requestId: RpcRequestId;
  readonly exit:
    | {
        readonly _tag: "Success";
        readonly value: unknown;
      }
    | {
        readonly _tag: "Failure";
        readonly cause: unknown;
      };
};

type RpcDefectMessage = {
  readonly _tag: "Defect";
  readonly defect: unknown;
};

type RpcInboundMessage =
  | RpcAckMessage
  | RpcChunkMessage
  | RpcDefectMessage
  | RpcExitMessage
  | RpcPingMessage
  | RpcPongMessage;

type PendingUnaryRequest = {
  readonly kind: "unary";
  readonly label: string;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

type PendingStreamRequest = {
  readonly kind: "stream";
  readonly label: string;
  readonly onChunk: (values: ReadonlyArray<unknown>) => void;
  readonly onExit: (error?: Error) => void;
};

type PendingRequest = PendingStreamRequest | PendingUnaryRequest;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

function extractRpcFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (Array.isArray(error)) {
    for (const entry of error) {
      const message = extractRpcFailureMessage(entry, "");
      if (message.length > 0) {
        return message;
      }
    }
    return fallback;
  }
  if (!isRecord(error)) {
    return fallback;
  }
  for (const key of ["message", "defect", "error", "reason"] as const) {
    const value = error[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  if ("cause" in error) {
    const message = extractRpcFailureMessage(error.cause, "");
    if (message.length > 0) {
      return message;
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return fallback;
  }
}

function toRpcError(error: unknown, fallback: string): Error {
  return new Error(extractRpcFailureMessage(error, fallback));
}

async function readWebSocketMessageData(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return textDecoder.decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return await data.text();
  }
  return String(data);
}

function parseRpcMessages(raw: string): ReadonlyArray<RpcInboundMessage> {
  const decoded = JSON.parse(raw);
  if (Array.isArray(decoded)) {
    return decoded as ReadonlyArray<RpcInboundMessage>;
  }
  return [decoded as RpcInboundMessage];
}

export type RemoteClientConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "disconnected";

export type RemoteClientEvent =
  | {
      readonly type: "status";
      readonly state: RemoteClientConnectionState;
      readonly error?: string;
    }
  | { readonly type: "snapshot"; readonly snapshot: OrchestrationReadModel }
  | { readonly type: "server-config"; readonly config: ServerConfig }
  | { readonly type: "domain-event"; readonly event: OrchestrationEvent };

export class RemoteClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private awaitingPong = false;
  private readonly listeners = new Set<(event: RemoteClientEvent) => void>();
  private readonly pendingRequests = new Map<RpcRequestId, PendingRequest>();
  private disposed = false;
  private bootstrapped = false;
  private bufferedDomainEvents: OrchestrationEvent[] = [];
  private requestCounter = 0n;
  private domainEventsRequestId: RpcRequestId | null = null;

  constructor(private readonly connection: RemoteConnectionConfig) {}

  addListener(listener: (event: RemoteClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): void {
    this.disposed = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.rejectPendingRequests(new Error("Reconnecting."));
    this.closeSocket();
    this.openWebSocket();
  }

  disconnect(): void {
    this.disposed = true;
    this.bootstrapped = false;
    this.bufferedDomainEvents = [];
    this.domainEventsRequestId = null;
    this.clearReconnectTimer();
    this.stopPingLoop();
    this.rejectPendingRequests(new Error("Remote connection closed."));
    this.closeSocket();
    this.emit({ type: "status", state: "idle" });
  }

  async refreshSnapshot(): Promise<OrchestrationReadModel> {
    return await this.request(
      ORCHESTRATION_WS_METHODS.getSnapshot,
      {},
      "Request timed out: getSnapshot",
    );
  }

  async getThreadMessagesPage(input: {
    readonly threadId: ThreadId;
    readonly offset: number;
    readonly limit: number;
  }): Promise<OrchestrationGetThreadMessagesPageResult> {
    return await this.request(
      ORCHESTRATION_WS_METHODS.getThreadMessagesPage,
      input,
      "Request timed out: getThreadMessagesPage",
    );
  }

  async refreshServerConfig(): Promise<ServerConfig> {
    return await this.request(
      WS_METHODS.serverGetConfig,
      {},
      "Request timed out: server.getConfig",
    );
  }

  async dispatchCommand(command: ClientOrchestrationCommand): Promise<void> {
    await this.request(
      ORCHESTRATION_WS_METHODS.dispatchCommand,
      command,
      "Request timed out: orchestration.dispatchCommand",
    );
  }

  private emit(event: RemoteClientEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener failures in the mobile client.
      }
    }
  }

  private openWebSocket(): void {
    if (this.disposed) {
      return;
    }

    this.emit({
      type: "status",
      state: this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
    });

    const socket = new WebSocket(this.connection.wsUrl);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.disposed || this.socket !== socket) {
        socket.close();
        return;
      }
      this.startPingLoop(socket);
      void this.startSession(socket);
    });

    socket.addEventListener("message", (event) => {
      void this.handleSocketMessage(socket, event.data);
    });

    socket.addEventListener("error", () => {
      // Close handles reconnect state and pending request cleanup.
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;

      this.stopPingLoop();
      this.bootstrapped = false;
      this.bufferedDomainEvents = [];
      this.domainEventsRequestId = null;
      this.rejectPendingRequests(
        new Error(
          event.reason.trim().length > 0
            ? event.reason
            : `Remote connection closed (${event.code}).`,
        ),
      );

      if (this.disposed) {
        this.emit({ type: "status", state: "idle" });
        return;
      }

      this.emit({
        type: "status",
        state: "disconnected",
        error:
          event.reason.trim().length > 0
            ? event.reason
            : event.code === 1000
              ? undefined
              : `Remote connection closed (${event.code}).`,
      });
      this.scheduleReconnect();
    });
  }

  private async startSession(socket: WebSocket): Promise<void> {
    this.bootstrapped = false;
    this.bufferedDomainEvents = [];
    this.domainEventsRequestId = null;

    this.subscribeToDomainEvents(socket);

    try {
      const [config, snapshot] = await Promise.all([
        this.requestWithSocket<ServerConfig>(
          socket,
          WS_METHODS.serverGetConfig,
          {},
          "server.getConfig",
        ),
        this.requestWithSocket<OrchestrationReadModel>(
          socket,
          ORCHESTRATION_WS_METHODS.getSnapshot,
          {},
          "orchestration.getSnapshot",
        ),
      ]);

      if (this.socket !== socket || this.disposed) {
        return;
      }

      const bufferedEvents = this.drainBufferedDomainEvents(snapshot.snapshotSequence);
      this.bootstrapped = true;
      this.reconnectAttempt = 0;
      this.emit({ type: "server-config", config });
      this.emit({ type: "snapshot", snapshot });
      for (const event of bufferedEvents) {
        this.emit({ type: "domain-event", event });
      }
      this.emit({ type: "status", state: "ready" });
    } catch (error) {
      if (this.socket !== socket || this.disposed) {
        return;
      }

      this.emit({
        type: "status",
        state: "disconnected",
        error: toMessage(error, "Failed to bootstrap remote connection."),
      });
      socket.close(1011, "Failed to bootstrap remote connection.");
    }
  }

  private subscribeToDomainEvents(socket: WebSocket): void {
    const requestId = this.createRequestId();
    this.domainEventsRequestId = requestId;
    this.pendingRequests.set(requestId, {
      kind: "stream",
      label: WS_METHODS.subscribeOrchestrationDomainEvents,
      onChunk: (values) => {
        for (const value of values) {
          const event = value as OrchestrationEvent;
          if (!this.bootstrapped) {
            this.bufferedDomainEvents.push(event);
            continue;
          }
          this.emit({ type: "domain-event", event });
        }
      },
      onExit: (error) => {
        if (this.domainEventsRequestId === requestId) {
          this.domainEventsRequestId = null;
        }
        if (this.socket !== socket || this.disposed) {
          return;
        }

        this.emit({
          type: "status",
          state: "disconnected",
          error: toMessage(error, "Remote event stream disconnected."),
        });
        socket.close(1011, "Remote event stream disconnected.");
      },
    });

    this.sendMessage(socket, {
      _tag: "Request",
      id: requestId,
      tag: WS_METHODS.subscribeOrchestrationDomainEvents,
      payload: {},
      headers: EMPTY_HEADERS,
    });
  }

  private async handleSocketMessage(socket: WebSocket, data: unknown): Promise<void> {
    if (this.socket !== socket || this.disposed) {
      return;
    }

    try {
      const raw = await readWebSocketMessageData(data);
      const messages = parseRpcMessages(raw);
      for (const message of messages) {
        if (this.socket !== socket || this.disposed) {
          return;
        }
        this.handleInboundMessage(socket, message);
      }
    } catch (error) {
      if (this.socket !== socket || this.disposed) {
        return;
      }

      this.emit({
        type: "status",
        state: "disconnected",
        error: toMessage(error, "Failed to decode remote message."),
      });
      socket.close(1003, "Failed to decode remote message.");
    }
  }

  private handleInboundMessage(socket: WebSocket, message: RpcInboundMessage): void {
    switch (message._tag) {
      case "Pong": {
        this.awaitingPong = false;
        return;
      }
      case "Ping": {
        this.sendMessage(socket, { _tag: "Pong" });
        return;
      }
      case "Ack": {
        return;
      }
      case "Defect": {
        const error = toRpcError(message.defect, "Remote protocol defect.");
        this.rejectPendingRequests(error);
        this.emit({ type: "status", state: "disconnected", error: error.message });
        socket.close(1011, error.message);
        return;
      }
      case "Chunk": {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending || pending.kind !== "stream") {
          return;
        }

        pending.onChunk(message.values);
        this.sendMessage(socket, {
          _tag: "Ack",
          requestId: message.requestId,
        });
        return;
      }
      case "Exit": {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) {
          return;
        }

        this.pendingRequests.delete(message.requestId);

        if (pending.kind === "unary") {
          clearTimeout(pending.timeout);
          if (message.exit._tag === "Success") {
            pending.resolve(message.exit.value);
          } else {
            pending.reject(
              toRpcError(message.exit.cause, `Remote request failed: ${pending.label}`),
            );
          }
          return;
        }

        pending.onExit(
          message.exit._tag === "Success"
            ? undefined
            : toRpcError(message.exit.cause, `Remote stream failed: ${pending.label}`),
        );
        return;
      }
    }
  }

  private drainBufferedDomainEvents(snapshotSequence: number): OrchestrationEvent[] {
    const bufferedEvents = this.bufferedDomainEvents.filter(
      (event) => event.sequence > snapshotSequence,
    );
    bufferedEvents.sort((left, right) => left.sequence - right.sequence);
    this.bufferedDomainEvents = [];
    return bufferedEvents;
  }

  private async request<T>(tag: string, payload: unknown, timeoutLabel: string): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Remote connection is not open yet.");
    }
    return await this.requestWithSocket<T>(socket, tag, payload, timeoutLabel);
  }

  private async requestWithSocket<T>(
    socket: WebSocket,
    tag: string,
    payload: unknown,
    timeoutLabel: string,
  ): Promise<T> {
    const requestId = this.createRequestId();

    return await new Promise<T>((resolve, reject) => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Remote connection is not open yet."));
        return;
      }

      const timeout = setTimeout(() => {
        if (!this.pendingRequests.has(requestId)) {
          return;
        }
        this.pendingRequests.delete(requestId);
        reject(new Error(timeoutLabel));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        kind: "unary",
        label: tag,
        timeout,
        resolve: (value) => resolve(value as T),
        reject,
      });

      try {
        this.sendMessage(socket, {
          _tag: "Request",
          id: requestId,
          tag,
          payload,
          headers: EMPTY_HEADERS,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(toRpcError(error, `Failed to send remote request: ${tag}`));
      }
    });
  }

  private createRequestId(): RpcRequestId {
    const requestId = this.requestCounter.toString();
    this.requestCounter += 1n;
    return requestId;
  }

  private sendMessage(
    socket: WebSocket,
    message: RpcAckMessage | RpcPingMessage | RpcPongMessage | RpcRequestMessage,
  ): void {
    socket.send(JSON.stringify(message));
  }

  private rejectPendingRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      this.pendingRequests.delete(requestId);
      if (pending.kind === "unary") {
        clearTimeout(pending.timeout);
        pending.reject(error);
        continue;
      }
      pending.onExit(error);
    }
  }

  private startPingLoop(socket: WebSocket): void {
    this.stopPingLoop();
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.stopPingLoop();
        return;
      }
      if (this.awaitingPong) {
        socket.close(1011, "Remote ping timed out.");
        return;
      }

      this.awaitingPong = true;
      this.sendMessage(socket, { _tag: "Ping" });
    }, PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.awaitingPong = false;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) {
      return;
    }

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ??
      RECONNECT_DELAYS_MS[0];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openWebSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close();
    }
  }
}
