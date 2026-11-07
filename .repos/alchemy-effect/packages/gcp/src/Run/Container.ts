import { Credentials } from "@distilled.cloud/gcp/Credentials";
import type * as Bundle from "alchemy/Bundle/Bundle";
import type { PackageInstall } from "alchemy/Bundle/InstalledPackages";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import { type ServerHost } from "alchemy/Runtime/Process";
import type { ExtraFile } from "alchemy/Util/extraFiles";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { destroyHostImageRepository, makeImageSource } from "../ArtifactRegistry/ImageSource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { GcpHostBinding, GcpIamGrant } from "../Host.ts";
import { createGcpHostRuntimeContext, type GcpHostRuntimeContext } from "../HostContext.ts";
import { alchemyRuntimeEnv, makeGcpBootstrap, mergeContainerEnv } from "../HostRuntime.ts";
import type { Providers } from "../Providers.ts";
import type { ContainerSpec, Probe } from "./Service.ts";

const DEFAULT_PORT = 3000;
const MAX_NAME_LENGTH = 49;

/** Env var a sidecar's program listens on (Cloud Run sets `PORT` only on the ingress container). */
export const CONTAINER_PORT_ENV = "ALCHEMY_HTTP_PORT";

/**
 * A container a host binds as a sidecar: its resolved spec, the IAM its
 * bindings need on the revision's service account, and the sidecars it
 * binds in turn.
 */
export type BoundContainer = {
  spec: ContainerSpec;
  iam: GcpIamGrant[];
  sidecars: BoundContainer[];
};

export type ContainerProps = PlatformProps &
  Omit<ContainerSpec, "image" | "env" | "ports"> & {
    /**
     * Container image. Required unless `main` is set, in which case
     * Alchemy builds and pushes the image.
     */
    image?: string;
    /**
     * Port the container listens on. A `main` program serves HTTP and
     * bound RPC on it; bound callers reach it on `localhost`.
     * @default 3000
     */
    port?: number;
    /**
     * Region of the Artifact Registry repository a `main` image is pushed
     * to.
     * @default the stack's GCP region
     */
    location?: string;
    /**
     * Module entrypoint for an Effect-native container (typically
     * `import.meta.url`). Alchemy bundles the program and builds its image.
     */
    main?: string;
    /**
     * Named export to load from `main`.
     * @default "default"
     */
    handler?: string;
    /**
     * Environment variables. Merged after binding-injected `env`.
     */
    env?: Record<string, any>;
    /** Bundler configuration for `main`. */
    build?: Bundle.BundleConfig & { install?: PackageInstall };
    /** Host files or directories baked into the image next to `main`. */
    extraFiles?: ReadonlyArray<ExtraFile>;
  };

export type Container = Resource<
  "GCP.Run.Container",
  ContainerProps,
  {
    /** Container name in the revision (DNS_LABEL). */
    name: string;
    /** Image the container runs. */
    image: string;
    /** Port the container listens on. */
    port: number | undefined;
    /** The container's spec, as a host adds it to its revision. */
    spec: ContainerSpec;
    /** IAM roles the container's bindings need on the revision's service account. */
    iam: GcpIamGrant[];
    /** Sidecars this container binds, which join the same revision. */
    sidecars: BoundContainer[];
    /** Project id. */
    project: string;
    /** Region of the image repository. */
    location: string;
    /** Artifact Registry repository a `main` image is pushed to. */
    repository: string | undefined;
    /** Hash of the bundled `main` program (Effect-native only). */
    codeHash: string | undefined;
  },
  GcpHostBinding,
  Providers
>;

export type ContainerRuntimeContext = GcpHostRuntimeContext;
export type ContainerServices = Credentials | GcpEnvironment | ServerHost;
export type ContainerShape = Main<ContainerServices>;

/**
 * A container that runs next to a Cloud Run service's main container, in
 * the same instance. Bind it from the service with
 * {@link bindContainer} (typed RPC and `fetch`) or {@link bindPort} (a raw
 * port): binding adds it to the service's revision and holds the service
 * back until the container passes its startup probe.
 *
 * Give it `main` and an Effect implementation to run your own program —
 * Alchemy bundles it into its own image — or just an `image`.
 *
 * ### Declaring a Container
 * **Example:** An Effect-native container with RPC methods
 * ```typescript
 * export default class Worker extends GCP.Run.Container<Worker>()(
 *   "Worker",
 *   {
 *     main: import.meta.url,
 *     port: 3000,
 *     startupProbe: { httpGet: { path: "/health" } },
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       greet: (name: string) => Effect.succeed(`hello ${name}`),
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** An image
 * ```typescript
 * export const Cache = GCP.Run.Container("Cache", {
 *   image: "docker.io/library/redis:7",
 *   port: 6379,
 *   startupProbe: { tcpSocket: {} },
 * });
 * ```
 *
 * ### Using bindings
 * **Example:** Bindings inside a Container
 * ```typescript
 * export default class Worker extends GCP.Run.Container<Worker>()(
 *   "Worker",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const publish = yield* GCP.PubSub.Publish(Tweets);
 *     return {
 *       post: (text: string) =>
 *         publish({ body: { messages: [{ data: btoa(text) }] } }),
 *     };
 *   }).pipe(Effect.provide(GCP.PubSub.PublishHttp)),
 * ) {}
 * ```
 * The binding's env lands on this container. Its IAM roles go to the
 * service account of the revision the container joins.
 *
 * @resource
 * @category Run
 */
export const Container: Platform<
  Container,
  ContainerServices,
  ContainerShape,
  ContainerRuntimeContext
> = Platform("GCP.Run.Container", {
  createRuntimeContext: createGcpHostRuntimeContext("GCP.Run.Container", {
    rpc: true,
  }) as (id: string) => ContainerRuntimeContext,
});

/** A Container declares neither `image` nor `main`. */
export class ContainerImageMissing extends Data.TaggedError("GCP.Run.ContainerImageMissing")<{
  id: string;
}> {
  override get message() {
    return `GCP.Run.Container ${this.id} needs an image or main`;
  }
}

const lastSegment = (value: string) => {
  const parts = value.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || value;
};

const normalizeLocation = (location: string | undefined, defaultLocation: string) =>
  lastSegment(location ?? defaultLocation).toLowerCase();

const dnsLabel = (name: string, fallback: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  return next.length > 0 ? next : fallback;
};

/** Point a probe that names no port at the container's port; sidecars expose no `ports`. */
const withPort = (probe: Probe | undefined, port: number | undefined): Probe | undefined => {
  if (probe === undefined || port === undefined) return probe;
  return {
    ...probe,
    httpGet: probe.httpGet && { ...probe.httpGet, port: probe.httpGet.port ?? port },
    tcpSocket: probe.tcpSocket && { ...probe.tcpSocket, port: probe.tcpSocket.port ?? port },
    grpc: probe.grpc && { ...probe.grpc, port: probe.grpc.port ?? port },
  };
};

const sourceOf = (news: ContainerProps, main: string) => ({
  main,
  handler: news.handler ?? "default",
  build: news.build,
  extraFiles: news.extraFiles,
  install: news.build?.install,
});

const bootstrapFor = (news: ContainerProps) =>
  makeGcpBootstrap("CloudRun", news.handler ?? "default");

const repositoryFor = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: MAX_NAME_LENGTH, lowercase: true });
  return `${dnsLabel(name, "container")}-src`;
});

/** Containers bound by this container's own bindings, flattened. */
export const boundContainersOf = (
  bindings: readonly ResourceBinding<GcpHostBinding>[],
): BoundContainer[] =>
  flattenContainers(bindings.flatMap((binding) => binding.data?.containers ?? []));

/** These containers and every sidecar they bind, once each by name. */
export const flattenContainers = (containers: readonly BoundContainer[]): BoundContainer[] => {
  const seen = new Map<string, BoundContainer>();
  const visit = (container: BoundContainer) => {
    const name = container.spec.name ?? "";
    if (seen.has(name)) return;
    seen.set(name, container);
    for (const sidecar of container.sidecars ?? []) visit(sidecar);
  };
  for (const container of containers) visit(container);
  return [...seen.values()];
};

/**
 * A `GCP.Run.Container` listed in a revision template reaches the
 * provider as its attributes (the engine resolves resource references in
 * props).
 */
export const isContainerAttributes = (value: unknown): value is Container["Attributes"] =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { spec?: unknown }).spec === "object" &&
  Array.isArray((value as { iam?: unknown }).iam) &&
  Array.isArray((value as { sidecars?: unknown }).sidecars);

/** Names of the containers bound directly by these bindings. */
export const directContainerNames = (bindings: readonly ResourceBinding<GcpHostBinding>[]) => [
  ...new Set(
    bindings.flatMap((binding) =>
      (binding.data?.containers ?? []).map((container) => container.spec.name ?? ""),
    ),
  ),
];

export const ContainerProvider = () =>
  Provider.succeed(Container, {
    stables: ["name", "project", "location", "repository"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // A code-only change leaves the props untouched; hash the bundle.
      if (output !== undefined && news.main !== undefined) {
        const images = yield* makeImageSource;
        const hash = yield* images.hash({
          source: sourceOf(news, news.main),
          port: news.port ?? DEFAULT_PORT,
          isExternal: news.isExternal,
          bootstrap: bootstrapFor(news),
        });
        if (hash !== undefined && hash !== output.codeHash) {
          return { action: "update" as const };
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      return output;
    }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location, env.region);
      const name = output?.name ?? dnsLabel(news.name ?? id, "container");
      const hostBindings = bindings as ResourceBinding<GcpHostBinding>[];
      const port = news.port ?? (news.main !== undefined ? DEFAULT_PORT : undefined);

      let image = news.image;
      let codeHash: string | undefined;
      let repository: string | undefined;
      const runtimeEnv: Record<string, unknown> = {};
      if (news.main !== undefined) {
        repository = output?.repository ?? (yield* repositoryFor(id));
        const images = yield* makeImageSource;
        const resolved = yield* images.resolve({
          id,
          source: sourceOf(news, news.main),
          repositoryName: repository,
          location,
          port: port ?? DEFAULT_PORT,
          isExternal: news.isExternal,
          bootstrap: bootstrapFor(news),
          session,
        });
        image = resolved.imageUri;
        codeHash = resolved.codeHash;
        Object.assign(runtimeEnv, yield* alchemyRuntimeEnv, {
          [CONTAINER_PORT_ENV]: String(port ?? DEFAULT_PORT),
        });
      }
      if (image === undefined) {
        return yield* new ContainerImageMissing({ id });
      }

      const bindingEnv = Object.assign(
        {},
        ...hostBindings.map((binding) => binding.data?.env ?? {}),
      ) as Record<string, unknown>;
      const dependsOn = [
        ...new Set([...(news.dependsOn ?? []), ...directContainerNames(hostBindings)]),
      ];
      const spec: ContainerSpec = {
        name,
        command: news.command,
        args: news.args,
        workingDir: news.workingDir,
        resources: news.resources,
        volumeMounts: news.volumeMounts,
        image,
        env: mergeContainerEnv(undefined, bindingEnv, runtimeEnv, news.env),
        startupProbe: withPort(news.startupProbe, port),
        livenessProbe: withPort(news.livenessProbe, port),
        dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      };

      return {
        name,
        image,
        port,
        spec,
        iam: hostBindings.flatMap((binding) => (binding.data?.iam ?? []) as GcpIamGrant[]),
        sidecars: boundContainersOf(hostBindings),
        project: env.project,
        location,
        repository,
        codeHash,
      };
    }),

    delete: Effect.fn(function* ({ id, output }) {
      if (output.repository !== undefined) {
        yield* destroyHostImageRepository(id, output, output.repository);
      }
    }),
  });
