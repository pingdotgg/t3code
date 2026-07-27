import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Connection } from "./Connection.ts";
import type { RepositoryLink } from "./RepositoryLink.ts";
import type { SyncConfiguration } from "./SyncConfiguration.ts";

/**
 * Shared HTTP scaffolding for the CodeConnections runtime bindings.
 *
 * Every capability follows the same shape — resolve the distilled
 * operation, register an IAM policy statement on the binding host, and
 * return a runtime callable. The only variation is the operation, the IAM
 * action(s), and the identifier(s) injected from the bound resource:
 * a {@link Connection}'s ARN, a {@link RepositoryLink}'s ID, or a
 * {@link SyncConfiguration}'s (resource name, sync type) identity.
 *
 * NOT exported from `index.ts`.
 */

/**
 * Build the impl Effect for a connection-scoped operation: the runtime
 * callable injects the bound {@link Connection}'s ARN as `ConnectionArn`
 * and the deploy-time half grants `actions` on the connection ARN.
 */
export const makeConnectionScopedHttpBinding = <
  I extends { ConnectionArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CodeConnections.GetConnection`. */
  tag: string;
  /** The distilled operation; `ConnectionArn` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the connection ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (connection: Connection) {
      const ConnectionArn = yield* connection.connectionArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${connection}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${connection.connectionArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${connection.LogicalId})`)(function* (
        request?: Omit<I, "ConnectionArn">,
      ) {
        return yield* op({
          ...request,
          ConnectionArn: yield* ConnectionArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a repository-link-scoped operation: the runtime
 * callable injects the bound {@link RepositoryLink}'s ID as
 * `RepositoryLinkId` and the deploy-time half grants `actions` on the
 * repository link ARN.
 */
export const makeRepositoryLinkScopedHttpBinding = <
  I extends { RepositoryLinkId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag. */
  tag: string;
  /** The distilled operation; `RepositoryLinkId` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the repository link ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (repositoryLink: RepositoryLink) {
      const RepositoryLinkId = yield* repositoryLink.repositoryLinkId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${repositoryLink}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${repositoryLink.repositoryLinkArn}`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${repositoryLink.LogicalId})`)(
        function* (request: Omit<I, "RepositoryLinkId">) {
          return yield* op({
            ...request,
            RepositoryLinkId: yield* RepositoryLinkId,
          } as I);
        },
      );
    });
  });

/**
 * Build the impl Effect for a sync-configuration-scoped operation: the
 * runtime callable injects the bound {@link SyncConfiguration}'s
 * `ResourceName` + `SyncType` identity. Sync operations are not
 * resource-scoped in IAM (sync configurations have no ARN), so the
 * deploy-time half grants `actions` on `*`.
 */
export const makeSyncConfigurationScopedHttpBinding = <
  I extends { ResourceName: string; SyncType: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag. */
  tag: string;
  /** The distilled operation; `ResourceName` + `SyncType` are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (syncConfiguration: SyncConfiguration) {
      const ResourceName = yield* syncConfiguration.resourceName;
      const SyncType = yield* syncConfiguration.syncType;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${syncConfiguration}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${syncConfiguration.LogicalId})`)(
        function* (request?: Omit<I, "ResourceName" | "SyncType">) {
          return yield* op({
            ...request,
            ResourceName: yield* ResourceName,
            SyncType: yield* SyncType,
          } as I);
        },
      );
    });
  });

/**
 * Build the impl Effect for an account-level operation (no target
 * resource). The deploy-time half grants `actions` on `*`.
 */
export const makeCodeConnectionsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.CodeConnections.ListConnections`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
