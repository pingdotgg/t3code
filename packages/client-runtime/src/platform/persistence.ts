import {
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
  type ServerConfig,
  type ThreadId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectionRegistration } from "../connection/catalog.ts";
import type { DeferredShellSnapshot } from "../state/shellPullRequests.ts";
import type { ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";

export class ConnectionPersistenceError extends Schema.TaggedError<ConnectionPersistenceError>()(
  "ConnectionPersistenceError",
  {
    operation: Schema.Literals([
      "list-targets",
      "list-disabled-targets",
      "register-connection",
      "set-connection-routes",
      "remove-connection",
      "set-connection-enabled",
      "load-shell",
      "save-shell",
      "load-thread",
      "save-thread",
      "remove-thread",
      "load-server-config",
      "save-server-config",
      "load-vcs-refs",
      "save-vcs-refs",
      "remove-vcs-refs",
      "clear-vcs-refs",
      "clear-environment",
    ]),
    message: Schema.String,
  },
) {}

export class ConnectionTargetStore extends Context.Service<
  ConnectionTargetStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ConnectionTarget>, ConnectionPersistenceError>;
    readonly listDisabled: Effect.Effect<ReadonlyArray<EnvironmentId>, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/ConnectionTargetStore") {}

export class ConnectionRegistrationStore extends Context.Service<
  ConnectionRegistrationStore,
  {
    /**
     * Records of routes missing from `routes` are dropped.
     */
    readonly register: (
      registration: ConnectionRegistration,
      routes: ReadonlyArray<PersistedConnectionTarget>,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * `routes` must not be empty.
     */
    readonly setRoutes: (
      environmentId: EnvironmentId,
      routes: ReadonlyArray<PersistedConnectionTarget>,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly setEnabled: (
      environmentId: EnvironmentId,
      enabled: boolean,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/platform/persistence/ConnectionRegistrationStore") {}

export class EnvironmentCacheStore extends Context.Service<
  EnvironmentCacheStore,
  {
    readonly loadShell: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<DeferredShellSnapshot>, ConnectionPersistenceError>;
    readonly saveShell: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationV2ShellSnapshot,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly loadThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<OrchestrationV2ThreadDetailSnapshot>,
      ConnectionPersistenceError
    >;
    readonly saveThread: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationV2ThreadDetailSnapshot,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly removeThread: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly loadServerConfig: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<ServerConfig>, ConnectionPersistenceError>;
    readonly saveServerConfig: (
      environmentId: EnvironmentId,
      config: ServerConfig,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * Query-specific lists are not cached because they are incomplete and unsafe
     * to present as a full picker.
     */
    readonly loadVcsRefs: (
      environmentId: EnvironmentId,
      cwd: string,
    ) => Effect.Effect<Option.Option<VcsListRefsResult>, ConnectionPersistenceError>;
    readonly saveVcsRefs: (
      environmentId: EnvironmentId,
      cwd: string,
      refs: VcsListRefsResult,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly removeVcsRefs: (
      environmentId: EnvironmentId,
      cwd: string,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * Git ref mutations are repository-wide, and linked worktrees may have
     * cached the same refs under different working-directory keys.
     */
    readonly clearVcsRefs: (
      environmentId: EnvironmentId,
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
