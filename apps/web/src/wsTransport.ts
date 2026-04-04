import { Duration, Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";

import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsRpcProtocolClient,
} from "./rpc/protocol";
import { RpcClient } from "effect/unstable/rpc";
import { ClientTracingLive, configureClientTracing } from "./observability/clientTracing";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class WsTransport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<WsRpcProtocolClient>;
  private readonly tracingReady: Promise<void>;
  private disposed = false;

  constructor(url?: string) {
    this.tracingReady = configureClientTracing();
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(createWsRpcProtocolLayer(url), ClientTracingLive),
    );
    this.clientScope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(
      Scope.provide(this.clientScope)(makeWsRpcProtocolClient),
    );
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    _options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    await this.tracingReady;
    const client = await this.clientPromise;
    return await this.runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    await this.tracingReady;
    const client = await this.clientPromise;
    await this.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value);
          } catch {
            // Swallow listener errors so the stream can finish cleanly.
          }
        }),
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    const retryDelayMs = options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS;
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.tracingReady).pipe(
        Effect.flatMap(() => Effect.promise(() => this.clientPromise)),
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
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
          ),
        ),
        Effect.catch((error) => {
          if (!active || this.disposed) {
            return Effect.interrupt;
          }
          return Effect.sync(() => {
            console.warn("WebSocket RPC subscription disconnected", {
              error: formatErrorMessage(error),
            });
          }).pipe(Effect.andThen(Effect.sleep(retryDelayMs)));
        }),
        Effect.forever,
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void)).finally(() => {
      this.runtime.dispose();
    });
  }
}
