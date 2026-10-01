/**
 * This file contains the worker entrypoints for the registry proxy.
 * The actual entrypoint is built dynamically in RegistryProxy.buildWorkerModules
 * so that we can bake in the initial registry state and export one
 * makeExternalDurableObject() per Durable Object class.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  resolvedTargetKey,
  type ResolvedTarget,
  type ResolvedTargetMap,
  type Subscriber,
} from "./RegistryTypes.shared.ts";

interface Env {
  REGISTRY_DEBUG_PORT: Env.WorkerdDebugPortConnector;
}

declare namespace Env {
  /**
   * Represents the workerd debug port's ability to open connections to other
   * workerd instances by address. Mirrors the Cap'n Proto RPC interface exposed
   * by the workerd debug port.
   *
   * @see https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c++
   */
  interface WorkerdDebugPortConnector {
    connect(address: string): WorkerdDebugPortClient;
  }

  /**
   * A connected debug port client that can resolve service entrypoints and
   * Durable Object actors on a remote workerd instance.
   */
  interface WorkerdDebugPortClient {
    getEntrypoint(
      service: string,
      entrypoint?: string,
      props?: Record<string, unknown>,
    ): Fetcher;
    getActor(service: string, entrypoint: string, actorId: string): Fetcher;
  }
}

/**
 * The target map is a map of subscriber keys to resolved targets.
 * It is stored at the top level so it can be accessed synchronously
 * across all the worker entrypoints.
 */
export namespace Target {
  let value: ResolvedTargetMap = {};

  export function set(newValue: ResolvedTargetMap): void {
    value = newValue;
  }

  export interface Resolver {
    resolve(): Fetcher | undefined;
  }

  /**
   * Constructs a cached target resolver for a subscriber.
   * This reuses the same fetcher if the debug port address hasn't changed.
   * The `toFetcher` function should use the debug port binding to create a fetcher for the target service.
   */
  export function makeResolver<T extends Subscriber>(
    subscriber: T,
    toFetcher: (target: ResolvedTarget<T>) => Fetcher,
  ): Resolver {
    const key = resolvedTargetKey(subscriber);
    let fetcher: Fetcher | undefined;
    let debugPortAddress: string | undefined;
    return {
      resolve: () => {
        const target = value[key] as ResolvedTarget<T> | undefined;
        if (!target) {
          fetcher = undefined;
          debugPortAddress = undefined;
          return undefined;
        }
        if (fetcher && debugPortAddress === target.debugPortAddress) {
          return fetcher;
        }
        fetcher = toFetcher(target);
        debugPortAddress = target.debugPortAddress;
        return fetcher;
      },
    };
  }
}

const HANDLER_RESERVED_KEYS = new Set<string>([
  "alarm",
  "connect",
  "self",
  "tail",
  "tailStream",
  "test",
  "trace",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
]);

/**
 * Creates a Durable Object subclass that proxies all method calls and fetch requests
 * to a Durable Object running in a separate workerd instance.
 * This is a factory function because we need a separate one for each Durable Object class.
 */
export function makeExternalDurableObject(
  subscriber: Subscriber.DurableObject,
): typeof DurableObject<Env> {
  return class extends DurableObject<Env> {
    private resolver: Target.Resolver;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);

      this.resolver = Target.makeResolver(subscriber, (service) =>
        env.REGISTRY_DEBUG_PORT.connect(service.debugPortAddress).getActor(
          service.service,
          subscriber.className,
          this.ctx.id.toString(),
        ),
      );

      return new Proxy(this, {
        get: (_, prop) => {
          if (Reflect.has(this, prop)) {
            return Reflect.get(this, prop);
          }
          const fetcher = this.resolver.resolve();
          // Return a function-that-throws rather than throwing immediately:
          // workerd probes DO properties (fetch, alarm, etc.) via the get
          // trap, and throwing here would crash those internal checks.
          if (!fetcher) {
            return () => {
              throw new Error(this.notFoundMessage());
            };
          }
          return Reflect.get(fetcher, prop);
        },
      });
    }

    fetch(request: Request): Response | Promise<Response> {
      const fetcher = this.resolver.resolve();
      if (!fetcher) {
        return new Response(this.notFoundMessage(), { status: 503 });
      }
      return fetcher.fetch(request);
    }

    private notFoundMessage() {
      return `Durable Object "${subscriber.className}" defined in worker "${subscriber.scriptName}" not found. Make sure the worker is running locally and exports the class.`;
    }
  };
}

/**
 * Forwards queue consumer requests to the queue broker in the consuming worker.
 */
export class ExternalQueueConsumer extends WorkerEntrypoint<
  Env,
  Subscriber.QueueConsumer
> {
  private target = Target.makeResolver(this.ctx.props, (service) =>
    this.env.REGISTRY_DEBUG_PORT.connect(
      service.debugPortAddress,
    ).getEntrypoint(service.service),
  );

  async fetch(request: Request): Promise<Response> {
    const fetcher = this.target.resolve();
    if (!fetcher) {
      console.warn(
        `[registry] No consumer registered for queue "${this.ctx.props.queueName}". Accepting and dropping message.`,
      );
      // Drain the request body before responding: workerd's queue client
      // does not settle the producer's `send()` promise until the request
      // body has been consumed, so responding without reading it would
      // leave `send()` pending forever.
      await request.arrayBuffer();
      return Response.json({
        metadata: {
          metrics: {
            backlogCount: 0,
            backlogBytes: 0,
            oldestMessageTimestamp: 0,
          },
        },
      });
    }
    return fetcher.fetch(request);
  }
}

export class ExternalService extends WorkerEntrypoint<Env, Subscriber.Worker> {
  // This is used to route fetch requests via the full middleware chain,
  // while RPC requests hit the user worker directly.
  private fetchTarget: Target.Resolver;
  private rpcTarget: Target.Resolver;

  constructor(ctx: ExecutionContext<Subscriber.Worker>, env: Env) {
    super(ctx, env);

    this.fetchTarget = Target.makeResolver(ctx.props, (service) =>
      env.REGISTRY_DEBUG_PORT.connect(service.debugPortAddress).getEntrypoint(
        service.fetchService,
        ctx.props?.entrypoint,
        ctx.props?.props,
      ),
    );
    this.rpcTarget = Target.makeResolver(ctx.props, (service) =>
      env.REGISTRY_DEBUG_PORT.connect(service.debugPortAddress).getEntrypoint(
        service.rpcService,
        ctx.props?.entrypoint,
        ctx.props?.props,
      ),
    );

    return new Proxy(this, {
      get: (_, prop) => {
        if (Reflect.has(this, prop)) {
          return Reflect.get(this, prop);
        }
        if (typeof prop === "string" && HANDLER_RESERVED_KEYS.has(prop)) {
          return undefined;
        }
        const fetcher = this.rpcTarget.resolve();
        if (!fetcher) {
          throw new Error(this.notFoundMessage());
        }
        return Reflect.get(fetcher, prop);
      },
    });
  }

  fetch(request: Request): Promise<Response> | Response {
    const fetcher = this.fetchTarget.resolve();
    if (!fetcher) {
      return new Response(this.notFoundMessage(), { status: 503 });
    }
    return fetcher.fetch(request);
  }

  // Separate connection for scheduled: the debug port's EventDispatcher
  // doesn't support runScheduled/runAlarm/queue, so we forward via HTTP.
  async scheduled(controller: ScheduledController) {
    const fetcher = this.fetchTarget.resolve();
    if (!fetcher) {
      throw new Error(this.notFoundMessage());
    }
    const params = new URLSearchParams();
    if (controller.cron) {
      params.set("cron", controller.cron);
    }
    if (controller.scheduledTime) {
      params.set("time", String(controller.scheduledTime));
    }
    const response = await fetcher.fetch(
      `http://localhost/cdn-cgi/handler/scheduled?${params}`,
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Scheduled handler returned HTTP ${response.status}: ${body}`,
      );
    }
  }

  async tail(events: Array<TraceItem>) {
    const fetcher = this.fetchTarget.resolve();
    if (!fetcher) {
      console.warn(
        `[registry] Failed to forward tail events to "${this.ctx.props.scriptName}": worker not found`,
      );
      return;
    }
    // Filter out tail events to prevent infinite recursion (the remote tail() call would itself produce a tail event).
    const filtered = events.filter(
      (item) =>
        !(
          item.event &&
          "rpcMethod" in item.event &&
          item.event.rpcMethod === "tail"
        ),
    );
    const serializedEvents = JSON.parse(
      JSON.stringify(filtered, ExternalService.tailEventsReplacer),
      ExternalService.tailEventsReviver,
    );
    // @ts-expect-error tail() is not in the `Fetcher` type but it's a valid RPC call
    return await fetcher.tail(serializedEvents);
  }

  /**
   * Forwards a streaming tail session to the remote worker via RPC.
   *
   * workerd invokes `tailStream()` with the invocation's `onset` event and
   * expects back a handler that receives every subsequent event of the
   * session. We call the remote worker's `tailStream()` over the debug port;
   * the handler it returns comes back as an RPC stub (a callable function
   * stub, or an object whose per-event-type members are stubs), which stays
   * alive for the duration of this invocation — exactly the lifetime of the
   * streaming session. Each event is round-tripped through JSON (preserving
   * Dates/BigInts) because `TailEvent`s are host objects that cannot be
   * serialized over RPC directly.
   *
   * Unlike `tail()` above there is no recursion filter: a streaming `onset`
   * for a JS RPC invocation carries no method name (`info` is just
   * `{ type: "jsrpc" }`), so the remote `tailStream()` call cannot be told
   * apart from any other RPC invocation. Mutually-tailing workers should use
   * plain `tails` if they need the recursion guard.
   */
  async tailStream(
    event: TailStream.TailEvent<TailStream.Onset>,
  ): Promise<TailStream.TailEventHandler> {
    // workerd requires a handler back (returning nothing is a config error on
    // the consumer), so drop the rest of the session with a no-op when the
    // remote worker is missing or declines the session.
    const drop: TailStream.TailEventHandler = () => {};
    const fetcher = this.fetchTarget.resolve();
    if (!fetcher) {
      console.warn(
        `[registry] Failed to forward streaming tail session to "${this.ctx.props.scriptName}": worker not found`,
      );
      return drop;
    }
    const serialize = (tailEvent: unknown) =>
      JSON.parse(
        JSON.stringify(tailEvent, ExternalService.tailEventsReplacer),
        ExternalService.tailEventsReviver,
      );
    const remote: TailStream.TailEventHandlerType | undefined =
      // @ts-expect-error tailStream() is not in the `Fetcher` type but it's a valid RPC call
      await fetcher.tailStream(serialize(event));
    if (!remote) {
      return drop;
    }
    return async (tailEvent) => {
      const serialized = serialize(tailEvent);
      if (typeof remote === "function") {
        return remote(serialized);
      }
      const handler = (remote as Record<string, unknown>)[tailEvent.event.type];
      if (typeof handler === "function") {
        return handler(serialized);
      }
    };
  }

  private notFoundMessage() {
    return `Worker "${this.ctx.props.scriptName}" not found. Make sure the worker is running locally.`;
  }

  private static SERIALIZED_DATE = "___serialized_date___";
  private static SERIALIZED_BIGINT = "___serialized_bigint___";

  private static tailEventsReplacer(_: string, value: any) {
    if (value instanceof Date) {
      return { [ExternalService.SERIALIZED_DATE]: value.toISOString() };
    } else if (typeof value === "bigint") {
      return { [ExternalService.SERIALIZED_BIGINT]: value.toString() };
    }
    return value;
  }

  private static tailEventsReviver(_: string, value: any) {
    if (value && typeof value === "object") {
      if (ExternalService.SERIALIZED_DATE in value) {
        return new Date(value[ExternalService.SERIALIZED_DATE]);
      } else if (ExternalService.SERIALIZED_BIGINT in value) {
        return BigInt(value[ExternalService.SERIALIZED_BIGINT]);
      }
    }
    return value;
  }
}

/**
 * Forwards a workflow binding to the workflow engine in the owner worker.
 */
export class ExternalWorkflow extends WorkerEntrypoint<
  Env,
  Subscriber.Workflow
> {
  private target: Target.Resolver;

  constructor(ctx: ExecutionContext<Subscriber.Workflow>, env: Env) {
    super(ctx, env);
    this.target = Target.makeResolver(ctx.props, (service) =>
      env.REGISTRY_DEBUG_PORT.connect(service.debugPortAddress).getEntrypoint(
        service.service,
        "WorkflowBinding",
      ),
    );

    return new Proxy(this, {
      get: (_, prop) => {
        if (Reflect.has(this, prop)) {
          return Reflect.get(this, prop);
        }
        if (typeof prop === "string" && HANDLER_RESERVED_KEYS.has(prop)) {
          return undefined;
        }
        const fetcher = this.target.resolve();
        if (!fetcher) {
          throw new Error(this.notFoundMessage());
        }
        return Reflect.get(fetcher, prop);
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const fetcher = this.target.resolve();
    if (!fetcher) {
      return new Response(this.notFoundMessage(), { status: 503 });
    }
    return fetcher.fetch(request);
  }

  private notFoundMessage() {
    return `Workflow "${this.ctx.props.workflowName}" defined in worker "${this.ctx.props.scriptName}" not found. Make sure the worker is running locally and exports the workflow.`;
  }
}
