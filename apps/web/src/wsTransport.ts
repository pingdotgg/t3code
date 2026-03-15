import { Data, Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { WsRpcGroup } from "@t3tools/contracts";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const makeWsRpcClient = RpcClient.make(WsRpcGroup);

type RpcClientFactory = typeof makeWsRpcClient;
type WsRpcClient = RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
type WsRpcClientMethods = Record<string, (payload: unknown) => unknown>;

interface SubscribeOptions {
  readonly retryDelayMs?: number;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = 250;

class WsTransportStreamMethodError extends Data.TaggedError("WsTransportStreamMethodError")<{
  readonly method: string;
}> {}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(fallback);
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function resolveWebSocketUrl(url?: string): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const rawUrl =
    url ??
    (bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`);

  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.pathname === "/" || parsedUrl.pathname.length === 0) {
    parsedUrl.pathname = "/ws";
  }
  return parsedUrl.toString();
}

export class WsTransport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<WsRpcClient>;
  private disposed = false;

  constructor(url?: string) {
    const resolvedUrl = resolveWebSocketUrl(url);
    const runtimeLayer = RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(resolvedUrl).pipe(
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
          ),
          RpcSerialization.layerJson,
        ),
      ),
    );

    this.runtime = ManagedRuntime.make(runtimeLayer);
    this.clientScope = Effect.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(Scope.provide(this.clientScope)(makeWsRpcClient));
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }
    if (typeof method !== "string" || method.length === 0) {
      throw new Error("Request method is required");
    }

    try {
      const client = await this.clientPromise;
      const handler = (client as WsRpcClientMethods)[method];
      if (typeof handler !== "function") {
        throw new Error(`Unknown RPC method: ${method}`);
      }
      return (await Effect.runPromise(
        Effect.suspend(() => handler(params ?? {}) as Effect.Effect<T>),
      )) as T;
    } catch (error) {
      throw asError(error, `Request failed: ${method}`);
    }
  }

  subscribe<T>(
    method: string,
    params: unknown,
    listener: (value: T) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    const retryDelayMs = options?.retryDelayMs ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS;
    const cancel = Effect.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) => {
          const handler = (client as WsRpcClientMethods)[method];
          if (typeof handler !== "function") {
            return Effect.fail(new WsTransportStreamMethodError({ method }));
          }
          return Stream.runForEach(handler(params ?? {}) as Stream.Stream<T, never>, (value) =>
            Effect.sync(() => {
              if (!active) {
                return;
              }
              try {
                listener(value);
              } catch {
                // Swallow listener errors so the stream stays live.
              }
            }),
          );
        }),
        Effect.catch((error) => {
          if (!active || this.disposed) {
            return Effect.interrupt;
          }
          return Effect.sync(() => {
            console.warn("WebSocket RPC subscription disconnected", {
              method,
              error: formatErrorMessage(error),
            });
          }).pipe(Effect.andThen(Effect.sleep(`${retryDelayMs} millis`)));
        }),
        Effect.forever,
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void Effect.runPromise(Scope.close(this.clientScope, Exit.void));
    void this.runtime.dispose();
  }
}
