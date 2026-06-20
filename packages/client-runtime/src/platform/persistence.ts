import {
  EnvironmentId,
  type OrchestrationThread,
  type OrchestrationShellSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectionRegistration } from "../connection/catalog.ts";
import {
  type ConnectionStorageOperation,
  ConnectionStorageOperationError,
  type ConnectionTarget,
  type ConnectionTransientError,
} from "../connection/model.ts";

const isConnectionStorageOperationError = Schema.is(ConnectionStorageOperationError);

export class ConnectionPersistenceError extends Schema.TaggedErrorClass<ConnectionPersistenceError>()(
  "ConnectionPersistenceError",
  {
    operation: Schema.Literals([
      "list-targets",
      "register-connection",
      "remove-connection",
      "load-shell",
      "save-shell",
      "load-thread",
      "save-thread",
      "remove-thread",
      "clear-environment",
    ]),
    stage: Schema.Literals([
      "resolve",
      "read",
      "parse",
      "decode",
      "encode",
      "migrate",
      "write",
      "remove",
    ]),
    resource: Schema.Literals([
      "connection-catalog",
      "shell-cache",
      "legacy-shell-cache",
      "thread-cache",
    ]),
    environmentId: Schema.optionalKey(EnvironmentId),
    threadId: Schema.optionalKey(ThreadId),
    cause: Schema.Defect(),
  },
) {
  static fromStorageFailure(input: {
    readonly operation: ConnectionPersistenceError["operation"];
    readonly fallbackStage: ConnectionPersistenceError["stage"];
    readonly resource: ConnectionPersistenceError["resource"];
    readonly environmentId?: EnvironmentId;
    readonly threadId?: ThreadId;
    readonly cause: ConnectionTransientError;
  }) {
    const { cause, fallbackStage, ...attributes } = input;
    const storageCause = cause.cause;
    const stage = isConnectionStorageOperationError(storageCause)
      ? ConnectionPersistenceError.storageOperationStage(storageCause.operation)
      : fallbackStage;

    return new ConnectionPersistenceError({
      ...attributes,
      stage,
      cause,
    });
  }

  private static storageOperationStage(
    operation: ConnectionStorageOperation,
  ): ConnectionPersistenceError["stage"] {
    switch (operation) {
      case "open":
        return "resolve";
      case "read":
      case "load":
        return "read";
      case "decode":
        return "decode";
      case "encode":
        return "encode";
      case "migrate":
        return "migrate";
      case "write":
      case "save":
        return "write";
      case "delete":
      case "remove":
        return "remove";
    }
  }

  override get message(): string {
    const environment =
      this.environmentId === undefined ? "" : ` for environment ${this.environmentId}`;
    const thread = this.threadId === undefined ? "" : ` and thread ${this.threadId}`;
    return `Could not ${this.operation.replaceAll("-", " ")}: ${this.resource.replaceAll("-", " ")} ${this.stage} failed${environment}${thread}.`;
  }
}

export class ConnectionTargetStore extends Context.Service<
  ConnectionTargetStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ConnectionTarget>, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/ConnectionTargetStore") {}

export class ConnectionRegistrationStore extends Context.Service<
  ConnectionRegistrationStore,
  {
    readonly register: (
      registration: ConnectionRegistration,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly remove: (target: ConnectionTarget) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/ConnectionRegistrationStore") {}

export class EnvironmentCacheStore extends Context.Service<
  EnvironmentCacheStore,
  {
    readonly loadShell: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<OrchestrationShellSnapshot>, ConnectionPersistenceError>;
    readonly saveShell: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationShellSnapshot,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly loadThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<OrchestrationThread>, ConnectionPersistenceError>;
    readonly saveThread: (
      environmentId: EnvironmentId,
      thread: OrchestrationThread,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly removeThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly clear: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/EnvironmentCacheStore") {}

export class EnvironmentOwnedDataCleanup extends Context.Reference<{
  readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void>;
}>("@t3tools/client-runtime/platform/persistence/EnvironmentOwnedDataCleanup", {
  defaultValue: () => ({
    clear: () => Effect.void,
  }),
}) {}
