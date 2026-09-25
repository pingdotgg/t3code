import { Services } from "@distilled.cloud/hetzner";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Bundle from "../Bundle/Bundle.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Resource, type ResourceBinding } from "../Resource.ts";
import type { ServerHost } from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import type { Providers } from "./Providers.ts";
import type { Server } from "./Server.ts";
import { SshError, sshClientForServer } from "./Ssh.ts";
import {
  collectBindingState,
  createHetznerHostedSupport,
  createHetznerHostRuntimeContext,
  type HetznerBuildOptions,
  type HetznerHostRuntimeContext,
} from "./hosted.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Server(...)` and `Server(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface ServiceProps extends PlatformProps {
  /**
   * Server this Service runs on. Accepts a `Hetzner.Server` or an Effect
   * that produces one. Changing the Server replaces the Service.
   */
  server: Ref<Server>;
  /**
   * Module entrypoint bundled with rolldown and copied onto the Server
   * over SSH as a systemd unit.
   */
  main: string;
  /**
   * Port the hosted HTTP server listens on. Written to `PORT` and used
   * to build {@link Service} `url`.
   *
   * @default 3000
   */
  port?: number;
  /**
   * Named export to load from `main`.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Additional environment variables for the hosted process. Merged after
   * binding-injected `env`.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for `main`: rolldown `input`/`output` overrides
   * plus pure-annotation options (`pure`) and `install` for packages that
   * must ship as real `node_modules` (see {@link HetznerBuildOptions}).
   */
  build?: HetznerBuildOptions;
  /**
   * Extra host directories packed into the unit archive next to the
   * bundled entry (e.g. a website `clientDirectory` at `dist/`). Hashed
   * into `code.hash` so asset changes update the unit. Destination is
   * relative to the unit root (`/opt/<unit>/`).
   */
  extraFiles?: ReadonlyArray<{
    source: string;
    destination: string;
  }>;
}

export type Service = Resource<
  "Hetzner.Service",
  ServiceProps,
  {
    /** Numeric Hetzner Server ID the unit runs on. */
    serverId: number;
    /** Public IPv4 of the Server, if attached. */
    ipv4: string | undefined;
    /** Port the process listens on. */
    port: number;
    /** `http://<ipv4>:<port>` when the Server has a public IPv4. */
    url: string | undefined;
    /** systemd unit name (`<name>.service`). */
    unitName: string;
    /** Content hash of the bundled program. */
    code: {
      hash: string;
    };
  },
  ServiceBinding,
  Providers
>;

export const isService = (value: unknown): value is Service =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "Hetzner.Service";

export type ServiceServices = ServerHost;

export type ServiceShape = Main<ServiceServices>;

export type ServiceRuntimeContext = HetznerHostRuntimeContext;

/**
 * An Effect program hosted on a Hetzner Cloud Server as a systemd unit.
 *
 * N Services can share one Server. Each Service is bundled with rolldown,
 * copied over SSH, and restarted as its own unit. Bind
 * `Hetzner.MountVolume` inside the impl to attach a Volume and mount it
 * at a path — the same `(volume, server, path)` from two Services is one
 * attach and one mount.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#servers
 *
 * ### Hosting a Service
 * **Example:** HTTP server on a Server
 * ```typescript
 * const server = yield* Hetzner.Server("box", {
 *   serverType: "cpx12",
 *   image: "ubuntu-24.04",
 *   location: "nbg1",
 * });
 *
 * export default class Api extends Hetzner.Service<Api>()(
 *   "Api",
 *   { server, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.json({ ok: true })),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Volumes
 * **Example:** Mount a Volume
 * ```typescript
 * const mount = yield* Hetzner.MountVolume(volume, { path: "/data" });
 * // write/read files under mount.path inside the hosted process
 * ```
 *
 * @resource
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  ServiceRuntimeContext
> = Platform("Hetzner.Service", {
  createRuntimeContext: createHetznerHostRuntimeContext("Hetzner.Service"),
  // `{ server: Box }` at module scope is an Effect. Yield it here so the
  // Server is registered and `news.server` is resolved attributes at
  // reconcile (same DX as `yield* Server(...)` inside Effect.gen).
  transformProps: (_id, props) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) return props;
      const server = Effect.isEffect(props.server)
        ? yield* props.server as Effect.Effect<Server, never, Providers>
        : props.server;
      return { ...props, server };
    }),
});

export class ServiceError extends Data.TaggedError("Hetzner.ServiceError")<{
  message: string;
}> {}

const DEFAULT_PORT = 3000;

const serverIdOf = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serverId?: unknown; id?: unknown };
  if (typeof rec.serverId === "number") return rec.serverId;
  if (typeof rec.id === "number") return rec.id;
  return undefined;
};

const ipv4Of = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { ipv4?: unknown };
  return typeof rec.ipv4 === "string" ? rec.ipv4 : undefined;
};

const unwrapKey = (
  value: Redacted.Redacted<string> | string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : Redacted.value(value);
};

const privateKeyOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  return unwrapKey(
    (value as { privateKey?: Redacted.Redacted<string> | string }).privateKey,
  );
};

const createUnitName = (id: string, existing?: string) =>
  existing !== undefined
    ? Effect.succeed(existing)
    : createPhysicalName({
        id,
        maxLength: 64,
        lowercase: true,
      }).pipe(Effect.map((name) => name.replaceAll(/[^a-z0-9-]/g, "-")));

const serviceUrl = (ipv4: string | undefined, port: number) =>
  ipv4 !== undefined ? `http://${ipv4}:${port}` : undefined;

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const hosted = createHetznerHostedSupport({
        stackName: stack.name,
        stage: stack.stage,
        virtualEntryPlugin,
      });

      const openSession = (news: ServiceProps) =>
        sshClientForServer(news.server as Server, {
          privateKey: privateKeyOf(news.server),
        });

      return Service.Provider.of({
        stables: ["serverId", "unitName"],
        // systemd units have no Hetzner list API. Nuke deletes the
        // Server they live on; empty list is the documented shape for
        // parent-keyed resources (Provider.list).
        nuke: { dependsOn: ["Hetzner.Server"] },
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news)) return undefined;
          const nextServer = serverIdOf(news.server);
          if (
            output !== undefined &&
            nextServer !== undefined &&
            output.serverId !== nextServer
          ) {
            return { action: "replace" } as const;
          }
          if (output !== undefined && news.main) {
            const { hash } = yield* hosted.bundleProgram(id, news);
            if (hash !== output.code.hash) {
              return { action: "update" } as const;
            }
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output === undefined) return undefined;
          const serverId =
            output.serverId ??
            (olds !== undefined ? serverIdOf(olds.server) : undefined);
          if (serverId === undefined) return undefined;
          const live = yield* Services.servers.getServer({ id: serverId }).pipe(
            Effect.map(({ server }) => server),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (live === undefined) return undefined;
          return {
            ...output,
            serverId: live.id,
            ipv4: live.public_net.ipv4?.ip,
            url: serviceUrl(live.public_net.ipv4?.ip, output.port),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
          const serverId = serverIdOf(news.server);
          if (serverId === undefined) {
            return yield* new ServiceError({
              message: "Service requires a resolved Server",
            });
          }
          const ipv4 = ipv4Of(news.server);
          if (ipv4 === undefined) {
            return yield* new ServiceError({
              message: "Service requires the Server to have a public IPv4",
            });
          }
          const port = news.port ?? DEFAULT_PORT;
          const unitName = yield* createUnitName(id, output?.unitName);
          const { env: bindingEnv, volumes } = collectBindingState(
            bindings as ResourceBinding<ServiceBinding>[],
          );
          const env = {
            ...bindingEnv,
            ...hosted.alchemyEnv,
            ...(news.port !== undefined ? { PORT: String(news.port) } : {}),
            ...news.env,
          };

          const { archive, hash, entryRel } = yield* hosted.bundleProgram(
            id,
            news,
          );

          const ssh = yield* openSession(news);
          yield* Effect.ensuring(
            Effect.gen(function* () {
              yield* hosted.waitForSsh(ssh);
              // Attach (no automount) then mkdir+mount+fstab. The same
              // (volume, server, path) from two Services is one attach
              // and one mount — both steps are independently idempotent.
              yield* hosted.attachAndMount({
                ssh,
                serverId,
                volumes,
              });
              yield* hosted.deployUnit({
                ssh,
                unitName,
                archive,
                env,
                entryRel,
              });
            }),
            ssh.close,
          );

          return {
            serverId,
            ipv4,
            port,
            url: serviceUrl(ipv4, port),
            unitName,
            code: { hash },
          };
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          const ssh = yield* openSession(olds).pipe(
            Effect.catchTag("Hetzner.SshError", () =>
              Effect.succeed(undefined),
            ),
          );
          if (ssh === undefined) return;
          yield* Effect.ensuring(
            hosted.removeUnit({ ssh, unitName: output.unitName }),
            ssh.close,
          );
        }),
      });
    }),
  );
