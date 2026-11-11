/** Keys that should be ignored during RPC property access */
export const IGNORED_KEYS = ["self"] as const;

/** Available methods for `WorkerEntrypoint` class */
export const WORKER_ENTRYPOINT_KEYS = [
  "connect",
  "email",
  "fetch",
  "queue",
  "tail",
  "tailStream",
  "test",
  "trace",
  "scheduled",
] as const;

/** Available methods for `DurableObject` class */
export const DURABLE_OBJECT_KEYS = [
  "alarm",
  "connect",
  "fetch",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
] as const;

/** Available methods for `WorkflowEntrypoint` classes */
export const WORKFLOW_ENTRYPOINT_KEYS = ["run"] as const;
