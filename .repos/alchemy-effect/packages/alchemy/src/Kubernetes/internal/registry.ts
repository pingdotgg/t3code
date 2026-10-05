/**
 * Image publishing for connections that declare a
 * {@link Connection.registry}: `main` programs and `context` Dockerfiles are
 * built on the deploying machine and pushed to `<server>/<name>:<hash>`,
 * where the cluster's nodes pull them. Used when the cluster's platform
 * adapter has no managed registry of its own (EKS pushes to ECR instead).
 */
import * as Effect from "effect/Effect";
import type { RegistryCredentials } from "../../Docker/Docker.ts";
import {
  makeContainerImageSource,
  type ImageRegistryTarget,
} from "../../Docker/ImageSource.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { RegistryState, WorkloadImageSource } from "../ClusterAdapter.ts";
import type { ContainerRegistry } from "../Connection.ts";

/** Docker credentials for a registry, or `undefined` to use `docker login`. */
const credentialsOf = (
  registry: ContainerRegistry,
): RegistryCredentials | undefined =>
  registry.username !== undefined && registry.password !== undefined
    ? {
        // Docker keys credentials by host; `server` may carry a namespace.
        server: registry.server.split("/")[0]!,
        username: registry.username,
        password: registry.password,
      }
    : undefined;

const trimServer = (server: string) => server.replace(/\/+$/, "");

export const makeConnectionRegistry = Effect.gen(function* () {
  const images = yield* makeContainerImageSource;

  const resolve = Effect.fn(function* (options: {
    id: string;
    registry: ContainerRegistry;
    source: WorkloadImageSource;
    platform: string;
    port?: number | undefined;
    isExternal?: boolean | undefined;
    bootstrap: (importPath: string) => string;
    state: Record<string, unknown> | undefined;
    session: { note: (message: string) => Effect.Effect<void> };
  }) {
    const server = trimServer(options.registry.server);
    // Keep the repository stable across updates; a changed `server` starts
    // a new one.
    const repository =
      options.state?.kind === "registry" &&
      options.state.server === server &&
      typeof options.state.repository === "string"
        ? options.state.repository
        : `${server}/${yield* createPhysicalName({
            id: options.id,
            maxLength: 96,
            lowercase: true,
          })}`;
    const target: ImageRegistryTarget = {
      repositoryUri: Effect.succeed(repository),
      // Generic registries have no cheap existence probe; resolve only runs
      // when the workload changes, and the local build cache makes a
      // rebuild of unchanged content fast.
      hasTag: () => Effect.succeed(false),
      credentials: Effect.succeed(credentialsOf(options.registry)),
    };
    const resolved = yield* images.resolve(
      {
        id: options.id,
        source: options.source,
        platform: options.platform,
        port: options.port,
        isExternal: options.isExternal,
        bootstrap: options.bootstrap,
        session: options.session,
      },
      target,
    );
    return {
      imageUri: resolved.imageUri,
      codeHash: resolved.codeHash,
      state: {
        kind: "registry" as const,
        server,
        repository,
      } satisfies RegistryState,
    };
  });

  const hash = (options: {
    source: WorkloadImageSource;
    platform: string;
    port?: number | undefined;
    isExternal?: boolean | undefined;
    bootstrap: (importPath: string) => string;
  }) =>
    images.hash({
      source: options.source,
      platform: options.platform,
      port: options.port,
      isExternal: options.isExternal,
      bootstrap: options.bootstrap,
    });

  return { resolve, hash };
});

/** The publisher returned by {@link makeConnectionRegistry}. */
export interface ConnectionRegistry extends Effect.Success<
  typeof makeConnectionRegistry
> {}
