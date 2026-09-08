import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Docker, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";

export interface ContextProps {
  /**
   * Context name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Human-readable description displayed in `docker context ls`. */
  description?: string;
  /**
   * Docker endpoint spec, for example `host=ssh://user@host`.
   *
   * Connection metadata only — never credentials. SSH endpoints
   * authenticate with keys/agent (Docker rejects passwords in the URL), and
   * TLS endpoints reference cert/key material by file path
   * (`host=tcp://...,ca=...,cert=...,key=...`), not by value. Docker itself
   * stores this spec in plaintext under `~/.docker/contexts`.
   */
  docker?: string;
}

export interface Context extends Resource<
  "Docker.Context",
  ContextProps,
  {
    /** Docker context name (contexts are identified by name). */
    id: string;
    /** Docker context name. */
    name: string;
    /** Human-readable description. */
    description: string;
    /** Docker endpoint the context targets. */
    docker?: string;
  },
  never,
  Providers
> {}

/**
 * A named Docker CLI context — a pointer to a Docker engine (local socket,
 * SSH host, or TCP endpoint) that other Docker resources deploy through.
 *
 * Pass the context (or its name) to any Docker resource's `context` prop to
 * run that resource's operations against the referenced engine instead of the
 * default one. Changing the endpoint updates the context in place; renaming
 * it, or clearing a previously-set endpoint, replaces it.
 *
 *
 * ### Creating Contexts
 * **Example:** Remote engine over SSH
 * ```typescript
 * const vps = yield* Docker.Context("vps", {
 *   docker: "host=ssh://deploy@example.com",
 *   description: "production swarm manager",
 * });
 * ```
 *
 * ### Using a Context
 * **Example:** Deploy resources through the context
 * ```typescript
 * const vps = yield* Docker.Context("vps", {
 *   docker: "host=ssh://deploy@example.com",
 * });
 * const network = yield* Docker.Network("app-net", {
 *   context: vps,
 *   driver: "overlay",
 * });
 * const app = yield* Docker.Service("app", {
 *   context: vps,
 *   image: "nginx:alpine",
 *   networks: [network.name],
 * });
 * ```
 *
 * **Example:** Local development vs production
 * ```typescript
 * const dev = yield* Alchemy.ALCHEMY_DEV;
 * const context = yield* Docker.Context("target", {
 *   name: dev ? "local" : "vps",
 *   docker: dev ? undefined : "host=ssh://deploy@example.com",
 * });
 * ```
 *
 * @resource
 */
export const Context = Resource<Context>("Docker.Context");

export const ContextProvider = () =>
  Provider.effect(
    Context,
    Effect.gen(function* () {
      const docker = yield* Docker;

      const inspect = (nameOrId: string) =>
        docker.context
          .inspect(nameOrId)
          .pipe(
            Effect.catchReason(
              "PlatformError",
              "NotFound",
              () => Effect.undefined,
            ),
          );

      return Context.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const name = yield* dockerPhysicalName(id, olds, instanceId);
          const live = yield* inspect(name);
          if (!live) return undefined;
          const attrs = toContextAttributes(live);
          if (output) return attrs;
          return attrs;
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, olds }) {
          if (!isResolved(news)) return undefined;

          const oldDesired = yield* normalizeDesired(id, olds, instanceId);
          const newDesired = yield* normalizeDesired(id, news, instanceId);

          if (oldDesired.name !== newDesired.name) {
            return { action: "replace" as const, deleteFirst: true };
          }

          // `docker context update` can set docker host, but cannot reliably
          // clear it once set. Recreate when transitioning to no docker.
          if (oldDesired.docker && !newDesired.docker) {
            return { action: "replace" as const, deleteFirst: true };
          }

          if (!Equal.equals(oldDesired, newDesired)) {
            return { action: "update" as const };
          }

          return { action: "noop" as const };
        }),
        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          olds,
          output,
        }) {
          const desired = yield* normalizeDesired(id, news, instanceId);

          if (output && olds) {
            const oldDesired = yield* normalizeDesired(id, olds, instanceId);
            if (deepEqual(oldDesired, desired)) {
              const current = yield* inspect(output.id);
              if (current) {
                return toContextAttributes(current);
              }
            }
          }

          const existing = output
            ? yield* inspect(output.id)
            : yield* inspect(desired.name);

          if (!existing) {
            const createArgs = {
              name: desired.name,
              ...(desired.docker ? { docker: desired.docker } : {}),
              ...(desired.description.length > 0
                ? { description: desired.description }
                : {}),
            };
            yield* docker.context.create(createArgs);
            return toContextAttributes(
              yield* docker.context.inspect(desired.name),
            );
          }

          const current = toContextAttributes(existing);
          const needsUpdate =
            current.description !== desired.description ||
            current.docker !== desired.docker;

          if (needsUpdate) {
            yield* docker.context.update({
              name: desired.name,
              ...(desired.docker ? { docker: desired.docker } : {}),
              description: desired.description,
            });
          }

          return toContextAttributes(
            yield* docker.context.inspect(desired.name),
          );
        }),
        delete: Effect.fn(({ output }) =>
          docker.context.remove(output.id, true).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
            Effect.as(undefined),
          ),
        ),
      });
    }),
  );

const normalizeDesired = (
  id: string,
  props: ContextProps,
  instanceId: string,
) =>
  dockerPhysicalName(id, props, instanceId).pipe(
    Effect.map((name) => ({
      name,
      description: normalizeDescription(props.description),
      docker: normalizeDocker(props.docker),
    })),
  );

const normalizeDescription = (description: string | undefined): string =>
  description?.trim() ?? "";

const normalizeDocker = (docker: string | undefined): string | undefined => {
  const value = docker?.trim();
  return value && value.length > 0 ? value : undefined;
};

const toContextAttributes = (
  context: Docker.Context,
): Context["Attributes"] => ({
  id: context.Name,
  name: context.Name,
  description: context.Metadata?.Description ?? "",
  docker: context.Endpoints?.docker,
});
