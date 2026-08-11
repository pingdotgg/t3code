import {
  Cause,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Scope,
  Stream,
} from "effect";
import { RpcClient } from "effect/unstable/rpc";

import { ClientTracingLive } from "../observability/clientTracing";
import { clearAllTrackedRpcRequests } from "./requestLatencyState";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolClient,
  type WsRpcProtocolSocketUrlProvider,
} from "./protocol";
import { isTransportConnectionErrorMessage } from "./transportError";
import { recordWsDiagnostic } from "./wsDiagnostics";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
  readonly onResubscribe?: () => void;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
// A parked stream retries on this ceiling even while the socket stays healthy.
const MAX_PARKED_SUBSCRIPTION_RETRY_DELAY_MS = 30_000;
// Spread concurrent parks so many failed streams do not wake in lockstep.
const PARKED_BACKOFF_JITTER_RATIO = 0.25;
const NOOP: () => void = () => undefined;

interface TransportSession {
  readonly clientPromise: Promise<WsRpcProtocolClient>;
  readonly clientScope: Scope.Closeable;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
}

interface StreamSubscriptionHandle {
  /** Tear the current stream down and re-subscribe on the active session. */
  readonly restart: () => void;
  /** Release a subscription parked while waiting for the next reconnect. */
  readonly wake: () => void;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class WsTransport {
  private readonly url: WsRpcProtocolSocketUrlProvider;
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private readonly streamSubscriptions = new Set<StreamSubscriptionHandle>();
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private reconnectChain: Promise<void> = Promise.resolve();
  private nextSessionId = 0;
  private activeSessionId = 0;
  private session: TransportSession;

  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    this.url = url;
    this.lifecycleHandlers = lifecycleHandlers;
    this.session = this.createSession();
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    _options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.session;
    const client = await session.clientPromise;
    return await session.runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.session;
    const client = await session.clientPromise;
    await session.runtime.runPromise(
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
    let hasReceivedValue = false;
    let restartRequested = false;
    let parkedAttempt = 0;
    let wakeParkedLoop: (() => void) | null = null;
    // Fixed per subscription so retries grow smoothly without re-rolling jitter.
    const parkedJitterFactor = Math.random();
    const retryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS),
    );
    let cancelCurrentStream: () => void = NOOP;

    const wake = () => {
      const resume = wakeParkedLoop;
      wakeParkedLoop = null;
      resume?.();
    };
    const subscription: StreamSubscriptionHandle = {
      restart: () => {
        if (!active) {
          return;
        }
        restartRequested = true;
        wake();
        cancelCurrentStream();
      },
      wake,
    };
    this.streamSubscriptions.add(subscription);

    // Parks the loop instead of abandoning the subscription, so a one-off
    // server-side stream failure cannot leave the UI permanently stale. The park
    // is bounded by backoff as well as the next reconnect, because a healthy
    // socket produces no reconnect to wake it. Jitter desynchronizes concurrent
    // parks that would otherwise retry on the same 30s ceiling.
    const nextParkedBackoffMs = () => {
      parkedAttempt += 1;
      const baseMs = Math.min(
        retryDelayMs * 2 ** (parkedAttempt - 1),
        MAX_PARKED_SUBSCRIPTION_RETRY_DELAY_MS,
      );
      const jitterMs = Math.floor(baseMs * PARKED_BACKOFF_JITTER_RATIO * parkedJitterFactor);
      return baseMs + jitterMs;
    };
    const awaitRestartOrDelay = (delayMs: number) =>
      new Promise<void>((resolve) => {
        if (!active || this.disposed || restartRequested) {
          resolve();
          return;
        }
        const timeoutId = setTimeout(() => {
          wakeParkedLoop = null;
          resolve();
        }, delayMs);
        wakeParkedLoop = () => {
          clearTimeout(timeoutId);
          resolve();
        };
      });

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }

        restartRequested = false;
        const session = this.session;
        try {
          if (hasReceivedValue) {
            try {
              options?.onResubscribe?.();
            } catch {
              // Swallow reconnect hook errors so the stream can recover.
            }
          }

          const runningStream = this.runStreamOnSession(
            session,
            connect,
            listener,
            () => active,
            () => {
              this.hasReportedTransportDisconnect = false;
              hasReceivedValue = true;
              parkedAttempt = 0;
            },
          );
          cancelCurrentStream = runningStream.cancel;
          await runningStream.completed;
          cancelCurrentStream = NOOP;
        } catch (error) {
          cancelCurrentStream = NOOP;
          if (!active || this.disposed) {
            return;
          }

          if (restartRequested || session !== this.session) {
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (!isTransportConnectionErrorMessage(formattedError)) {
            const retryInMs = nextParkedBackoffMs();
            recordWsDiagnostic("stream-parked", { error: formattedError, retryInMs });
            await awaitRestartOrDelay(retryInMs);
            continue;
          }

          if (!this.hasReportedTransportDisconnect) {
            recordWsDiagnostic("stream-retry", { error: formattedError });
          }
          this.hasReportedTransportDisconnect = true;
          await sleep(retryDelayMs);
        }
      }
    })();

    return () => {
      active = false;
      this.streamSubscriptions.delete(subscription);
      wake();
      cancelCurrentStream();
    };
  }

  async reconnect() {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const reconnectOperation = this.reconnectChain.then(async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }

      clearAllTrackedRpcRequests();
      const previousSession = this.session;
      this.session = this.createSession();
      // New sessions start at connectCount 0, so onProtocolConnected will not
      // restart on their first open. Wake parked loops and tear down streams
      // still attached to the previous session before it closes.
      this.restartStreamSubscriptions();
      await this.closeSession(previousSession);
    });

    this.reconnectChain = reconnectOperation.catch(() => undefined);
    await reconnectOperation;
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const subscription of this.streamSubscriptions) {
      subscription.wake();
    }
    this.streamSubscriptions.clear();
    await this.closeSession(this.session);
  }

  private closeSession(session: TransportSession) {
    return session.runtime.runPromise(Scope.close(session.clientScope, Exit.void)).finally(() => {
      session.runtime.dispose();
    });
  }

  private createSession(): TransportSession {
    const sessionId = this.nextSessionId + 1;
    this.nextSessionId = sessionId;
    this.activeSessionId = sessionId;
    let connectCount = 0;
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        createWsRpcProtocolLayer(this.url, {
          ...this.lifecycleHandlers,
          isActive: () => !this.disposed && this.activeSessionId === sessionId,
          onProtocolConnected: () => {
            connectCount += 1;
            this.lifecycleHandlers?.onProtocolConnected?.();
            // The first connect carries the requests the loops already sent.
            // Every later one replaced a socket whose server-side streams were
            // torn down without failing the client fibers.
            if (connectCount > 1) {
              this.restartStreamSubscriptions();
            }
          },
        }),
        ClientTracingLive,
      ),
    );
    const clientScope = runtime.runSync(Scope.make());
    return {
      runtime,
      clientScope,
      clientPromise: runtime.runPromise(Scope.provide(clientScope)(makeWsRpcProtocolClient)),
    };
  }

  private restartStreamSubscriptions(): void {
    if (this.disposed) {
      return;
    }
    recordWsDiagnostic("streams-restarted", { subscriptions: this.streamSubscriptions.size });
    for (const subscription of this.streamSubscriptions) {
      subscription.restart();
    }
  }

  private runStreamOnSession<TValue>(
    session: TransportSession,
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    isActive: () => boolean,
    markValueReceived: () => void,
  ): {
    readonly cancel: () => void;
    readonly completed: Promise<void>;
  } {
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    const cancel = session.runtime.runCallback(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!isActive()) {
                return;
              }

              markValueReceived();
              try {
                listener(value);
              } catch {
                // Swallow listener errors so the stream stays live.
              }
            }),
          ),
        ),
      ),
      {
        onExit: (exit) => {
          if (Exit.isSuccess(exit)) {
            resolveCompleted();
            return;
          }

          rejectCompleted(Cause.squash(exit.cause));
        },
      },
    );

    return {
      cancel,
      completed,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
