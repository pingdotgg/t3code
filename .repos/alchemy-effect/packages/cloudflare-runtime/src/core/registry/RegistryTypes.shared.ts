export type Subscriber =
  | Subscriber.Worker
  | Subscriber.DurableObject
  | Subscriber.QueueConsumer
  | Subscriber.Workflow;

export declare namespace Subscriber {
  export interface Worker {
    readonly kind: "worker";
    readonly scriptName: string;
    readonly entrypoint?: string;
    readonly props?: Record<string, unknown>;
  }
  export interface DurableObject {
    readonly kind: "durable-object";
    readonly scriptName: string;
    readonly className: string;
    readonly uniqueKey: string;
  }
  export interface QueueConsumer {
    readonly kind: "queue-consumer";
    readonly queueName: string;
  }
  export interface Workflow {
    readonly kind: "workflow";
    readonly scriptName: string;
    readonly workflowName: string;
  }
}

export interface RegistryEntry {
  readonly scriptName: string;
  readonly debugPortAddress: string;
  /**
   * Identifies the workerd process behind `debugPortAddress`. A process restarted
   * after a crash reuses the address, so only this tells subscribers to reconnect.
   * Absent in entries written by older runtimes.
   */
  readonly instanceId?: string;
  readonly services: [RegistryEntry.Worker, ...Array<RegistryEntry.Service>];
}

export declare namespace RegistryEntry {
  export interface Worker {
    readonly kind: "worker";
    readonly fetchService: string;
    readonly rpcService: string;
  }
  export interface DurableObject {
    readonly kind: "durable-object";
    readonly className: string;
    readonly uniqueKey: string;
    readonly service: string;
  }
  export interface QueueConsumer {
    readonly kind: "queue-consumer";
    readonly queueName: string;
    readonly service: string;
  }
  export interface Workflow {
    readonly kind: "workflow";
    readonly workflowName: string;
    readonly service: string;
  }
  export type Service = Worker | DurableObject | QueueConsumer | Workflow;
}

export interface ResolvedTargetMap {
  [key: string]: ResolvedTarget;
}

export type ResolvedTarget<T extends Subscriber = Subscriber> = Extract<
  RegistryEntry.Service,
  { kind: T["kind"] }
> & {
  readonly scriptName: string;
  readonly debugPortAddress: string;
  readonly instanceId?: string;
};

export const resolvedTargetKey = (entry: ResolvedTarget | Subscriber) => {
  switch (entry.kind) {
    case "worker":
      return `worker:${entry.scriptName}` as const;
    case "durable-object":
      return `durable-object:${entry.scriptName}:${entry.className}` as const;
    case "queue-consumer":
      return `queue-consumer:${entry.queueName}` as const;
    case "workflow":
      return `workflow:${entry.scriptName}:${entry.workflowName}` as const;
  }
};

/**
 * Header carrying the per-instance credential for registry pushes to the
 * registry proxy (Miniflare's `MF-Dev-Registry-Secret`). The credential lives
 * only in the owning process and the proxy's private binding; it is never
 * written to registry files.
 */
export const HEADER_REGISTRY_UPDATE_SECRET = "Alchemy-Runtime-Registry-Update-Secret";
