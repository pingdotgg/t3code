import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../Tags.ts";
import type { Connection, ContainerRegistry } from "./Connection.ts";
import { applyObject, connectCluster } from "./internal/client.ts";
import { kindClusterConfig, kindConfigOf } from "./internal/kind.ts";
import type { Providers } from "./Providers.ts";

export interface LocalClusterProps extends KindClusterConfig {
  /**
   * Name of the kind cluster. Its kubeconfig context is `kind-<name>`.
   * Changing it replaces the cluster.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * Host port of the cluster's image registry, reachable from the deploying
   * machine as `localhost:<registryPort>`. Give each local cluster its own
   * port.
   * @default 5001
   */
  registryPort?: number;
  /**
   * The kind node image, which selects the Kubernetes version (e.g.
   * `kindest/node:v1.33.1`). A node's own `image` overrides it. Changing it
   * replaces the cluster.
   * @default kind's default node image
   */
  nodeImage?: string;
  /**
   * The kubeconfig file kind writes the cluster's context into. Changing it
   * replaces the cluster.
   * @default `$KUBECONFIG` or `~/.kube/config`
   */
  kubeconfig?: string;
}

/**
 * The fields of a [kind `Cluster` config](https://kind.sigs.k8s.io/docs/user/configuration/)
 * (`kind.x-k8s.io/v1alpha4`), accepted directly on `LocalCluster`. kind
 * can't reconfigure a running cluster, so changing any of them replaces the
 * cluster.
 */
export interface KindClusterConfig {
  /**
   * The cluster's nodes.
   * @default a single control-plane node
   */
  nodes?: KindNode[];
  /** Cluster networking. */
  networking?: KindNetworking;
  /** Kubernetes feature gates, e.g. `{ InPlacePodVerticalScaling: true }`. */
  featureGates?: Record<string, boolean>;
  /** API server `--runtime-config` entries, e.g. `{ "api/alpha": "false" }`. */
  runtimeConfig?: Record<string, string>;
  /** kubeadm config patches (YAML strategic-merge) applied to every node. */
  kubeadmConfigPatches?: string[];
  /** kubeadm config patches (RFC 6902 JSON patches) applied to every node. */
  kubeadmConfigPatchesJSON6902?: KindJsonPatch[];
  /**
   * containerd config patches (TOML). Alchemy appends its own for the image
   * registry.
   */
  containerdConfigPatches?: string[];
  /** containerd config patches (RFC 6902 JSON patches). */
  containerdConfigPatchesJSON6902?: string[];
}

/** A node in a kind cluster. */
export interface KindNode {
  /** Whether the node runs the control plane or only workloads. */
  role: "control-plane" | "worker";
  /** Node image for this node, overriding `nodeImage`. */
  image?: string;
  /** Kubernetes labels for the node. */
  labels?: Record<string, string>;
  /** Host ports forwarded to the node container. */
  extraPortMappings?: KindPortMapping[];
  /** Host paths mounted into the node container. */
  extraMounts?: KindMount[];
  /** kubeadm config patches (YAML strategic-merge) for this node. */
  kubeadmConfigPatches?: string[];
  /** kubeadm config patches (RFC 6902 JSON patches) for this node. */
  kubeadmConfigPatchesJSON6902?: KindJsonPatch[];
}

/** A host port forwarded to a kind node container. */
export interface KindPortMapping {
  /** Port on the node container, e.g. a NodePort or hostPort. */
  containerPort: number;
  /** Port on the host. */
  hostPort: number;
  /**
   * Host address to listen on.
   * @default "0.0.0.0"
   */
  listenAddress?: string;
  /** @default "TCP" */
  protocol?: "TCP" | "UDP" | "SCTP";
}

/** A host path mounted into a kind node container. */
export interface KindMount {
  /** Path on the host. */
  hostPath: string;
  /** Path in the node container. */
  containerPath: string;
  readOnly?: boolean;
  /** Relabel the mount for SELinux hosts. */
  selinuxRelabel?: boolean;
  propagation?: "None" | "HostToContainer" | "Bidirectional";
}

/** Cluster networking settings for kind. */
export interface KindNetworking {
  ipFamily?: "ipv4" | "ipv6" | "dual";
  /**
   * Host port of the API server.
   * @default a random port
   */
  apiServerPort?: number;
  /**
   * Host address the API server listens on.
   * @default "127.0.0.1"
   */
  apiServerAddress?: string;
  /** Pod network CIDR. */
  podSubnet?: string;
  /** Service network CIDR. */
  serviceSubnet?: string;
  /** Skip kind's default CNI so you can install your own. */
  disableDefaultCNI?: boolean;
  kubeProxyMode?: "iptables" | "ipvs" | "nftables" | "none";
  /** DNS search domains for nodes. */
  dnsSearch?: string[];
}

/** An RFC 6902 JSON patch targeting a kubeadm config object. */
export interface KindJsonPatch {
  group: string;
  version: string;
  kind: string;
  /** The JSON patch document, as YAML or JSON. */
  patch: string;
}

export interface LocalCluster extends Resource<
  "Kubernetes.LocalCluster",
  LocalClusterProps,
  {
    /** The kind cluster name. */
    name: string;
    /** The kubeconfig context of the cluster (`kind-<name>`). */
    context: string;
    /** The kubeconfig file holding the context, if not the default. */
    kubeconfig: string | undefined;
    /** The cluster's image registry (`localhost:<registryPort>`). */
    registry: ContainerRegistry;
    /** Name of the registry's Docker container. */
    registryContainer: string;
    /** CPU architecture of the cluster's nodes (the Docker host's). */
    architecture: "amd64" | "arm64";
    /**
     * Connection for `Kubernetes.*` resources, including the registry and
     * node architecture. Pass the whole resource as their `cluster`.
     */
    connection: Connection;
  },
  {},
  Providers
> {}

/**
 * A Kubernetes cluster on your machine, for trying Alchemy's Kubernetes
 * resources and developing against them without a hosted cluster.
 *
 * `LocalCluster` runs a [kind](https://kind.sigs.k8s.io) cluster in Docker
 * together with a local image registry wired into the cluster's nodes, so
 * workloads built from a `main` Effect program or a `context` Dockerfile
 * work the same way they do on a hosted cluster with a registry. Pass the
 * resource as the `cluster` of any `Kubernetes.*` resource.
 *
 * Requires Docker and the `kind` CLI on the deploying machine (set
 * `KIND_BIN` to use a specific binary). The cluster's kubeconfig context,
 * `kind-<name>`, works with `kubectl`.
 *
 * ### Creating a Local Cluster
 * **Example:** Cluster and a Deployment
 * ```typescript
 * const cluster = yield* Kubernetes.LocalCluster("Cluster", {
 *   name: "alchemy",
 * });
 *
 * const web = yield* Kubernetes.Deployment("Web", {
 *   cluster,
 *   image: "ghcr.io/stefanprodan/podinfo:6.15.0",
 *   port: 9898,
 *   serviceType: "ClusterIP",
 * });
 * ```
 *
 * ### Effect Programs
 * **Example:** Run an Effect program as a Job
 * ```typescript
 * const cluster = yield* Kubernetes.LocalCluster("Cluster", {
 *   name: "alchemy",
 * });
 *
 * const hello = yield* Kubernetes.Job(
 *   "Hello",
 *   { cluster, main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {
 *       run: Effect.log("hello from a Job"),
 *     };
 *   }),
 * );
 * ```
 *
 * ### Kind Configuration
 * **Example:** Forward a host port to a NodePort
 * ```typescript
 * const cluster = yield* Kubernetes.LocalCluster("Cluster", {
 *   name: "alchemy",
 *   nodes: [
 *     {
 *       role: "control-plane",
 *       extraPortMappings: [{ containerPort: 30080, hostPort: 8080 }],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Registry Port
 * **Example:** Two local clusters
 * ```typescript
 * const blue = yield* Kubernetes.LocalCluster("Blue", { name: "blue" });
 * const green = yield* Kubernetes.LocalCluster("Green", {
 *   name: "green",
 *   registryPort: 5002,
 * });
 * ```
 *
 * @resource
 * @product LocalCluster
 */
export const LocalCluster = Resource<LocalCluster>("Kubernetes.LocalCluster");

export class LocalClusterError extends Data.TaggedError(
  "Kubernetes.LocalClusterError",
)<{ message: string }> {}

const KindBin = Config.String("KIND_BIN").pipe(
  Effect.orElseSucceed(() => "kind"),
);
const DockerBin = Config.String("DOCKER_BIN").pipe(
  Effect.orElseSucceed(() => "docker"),
);

const REGISTRY_IMAGE = "registry:3";
const DEFAULT_REGISTRY_PORT = 5001;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const toArchitecture = (arch: string): "amd64" | "arm64" =>
  /^(arm64|aarch64)$/i.test(arch.trim()) ? "arm64" : "amd64";

const sanitizeName = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/^-+|-+$/g, "");

interface RegistryInspect {
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> | null };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostPort?: string }> | null> | null;
  };
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

export const LocalClusterProvider = () =>
  Provider.effect(
    LocalCluster,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** Run a CLI, returning its exit code and output. */
      const run = (bin: string, args: string[], stdin?: string) =>
        ChildProcess.make(bin, args, {
          stdin:
            stdin === undefined
              ? "ignore"
              : Stream.succeed(new TextEncoder().encode(stdin)),
          stdout: "pipe",
          stderr: "pipe",
          detached: false,
          extendEnv: true,
        }).pipe(
          spawner.spawn,
          Effect.flatMap((child) =>
            Effect.all(
              {
                exitCode: child.exitCode,
                stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
                stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
              },
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map((result): CommandResult => ({
            exitCode: Number(result.exitCode),
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
          })),
          Effect.scoped,
          // A spawn failure (almost always ENOENT) means the CLI itself is
          // missing — a machine-setup problem, not a resource error.
          Effect.catchCause((cause) =>
            Effect.die(
              new Error(
                `Failed to run '${bin}': ${String(cause)}. ` +
                  "Kubernetes.LocalCluster needs Docker and the kind CLI " +
                  "(https://kind.sigs.k8s.io/docs/user/quick-start/#installation). " +
                  "Set KIND_BIN or DOCKER_BIN to use specific binaries.",
              ),
            ),
          ),
        );

      /** Run a CLI and fail with its stderr on a non-zero exit. */
      const exec = Effect.fn(function* (
        bin: string,
        args: string[],
        stdin?: string,
      ) {
        const result = yield* run(bin, args, stdin);
        if (result.exitCode !== 0) {
          return yield* new LocalClusterError({
            message: `${bin} ${args.join(" ")} exited with code ${result.exitCode}: ${result.stderr}`,
          });
        }
        return result;
      });

      const kind = Effect.fn(function* (args: string[]) {
        return yield* exec(yield* KindBin, args);
      });
      const docker = Effect.fn(function* (args: string[], stdin?: string) {
        return yield* exec(yield* DockerBin, args, stdin);
      });

      const kubeconfigArgs = (kubeconfig: string | undefined) =>
        kubeconfig !== undefined ? ["--kubeconfig", kubeconfig] : [];

      const clusterName = (
        id: string,
        props: LocalClusterProps | undefined,
        output: LocalCluster["Attributes"] | undefined,
      ) =>
        output?.name !== undefined
          ? Effect.succeed(output.name)
          : props?.name !== undefined
            ? Effect.succeed(sanitizeName(props.name))
            : createPhysicalName({ id, maxLength: 40, lowercase: true }).pipe(
                Effect.map(sanitizeName),
              );

      const clusterExists = Effect.fn(function* (name: string) {
        const { stdout } = yield* kind(["get", "clusters"]);
        return stdout.split(/\r?\n/).some((line) => line.trim() === name);
      });

      const inspectRegistry = Effect.fn(function* (container: string) {
        const result = yield* run(yield* DockerBin, [
          "container",
          "inspect",
          container,
        ]);
        if (result.exitCode !== 0) return undefined;
        const [info] = JSON.parse(result.stdout) as RegistryInspect[];
        return info;
      });

      const registryHostPort = (info: RegistryInspect | undefined) => {
        const binding = info?.HostConfig?.PortBindings?.["5000/tcp"]?.[0];
        return binding?.HostPort !== undefined
          ? Number(binding.HostPort)
          : undefined;
      };

      const hostArchitecture = Effect.gen(function* () {
        const { stdout } = yield* docker([
          "version",
          "--format",
          "{{.Server.Arch}}",
        ]);
        return toArchitecture(stdout);
      });

      const toAttributes = (options: {
        name: string;
        kubeconfig: string | undefined;
        registryPort: number;
        architecture: "amd64" | "arm64";
      }): LocalCluster["Attributes"] => {
        const context = `kind-${options.name}`;
        const registry = { server: `localhost:${options.registryPort}` };
        return {
          name: options.name,
          context,
          kubeconfig: options.kubeconfig,
          registry,
          registryContainer: `${options.name}-registry`,
          architecture: options.architecture,
          connection: {
            auth: {
              kind: "kubeconfig",
              path: options.kubeconfig,
              context,
            },
            registry,
            architecture: options.architecture,
          },
        };
      };

      /** Ensure the kind cluster exists and its context is in the kubeconfig. */
      const ensureCluster = Effect.fn(function* (options: {
        name: string;
        nodeImage: string | undefined;
        kubeconfig: string | undefined;
        config: KindClusterConfig;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        if (!(yield* clusterExists(options.name))) {
          yield* options.session.note(
            `Creating kind cluster ${options.name} (about 30 seconds)...`,
          );
          const dir = yield* fs.makeTempDirectory({
            prefix: "alchemy-kind-",
          });
          const configFile = path.join(dir, "kind.yaml");
          yield* fs.writeFileString(
            configFile,
            JSON.stringify(kindClusterConfig(options.config), null, 2),
          );
          yield* kind([
            "create",
            "cluster",
            "--name",
            options.name,
            "--config",
            configFile,
            "--wait",
            "120s",
            ...(options.nodeImage !== undefined
              ? ["--image", options.nodeImage]
              : []),
            ...kubeconfigArgs(options.kubeconfig),
          ]).pipe(
            // A concurrent create of the same cluster is a race, not a failure.
            Effect.catchTag("Kubernetes.LocalClusterError", (error) =>
              /already exist/i.test(error.message)
                ? Effect.void
                : Effect.fail(error),
            ),
          );
          yield* fs.remove(dir, { recursive: true });
        }
        // Restore the context if it was removed from the kubeconfig.
        yield* kind([
          "export",
          "kubeconfig",
          "--name",
          options.name,
          ...kubeconfigArgs(options.kubeconfig),
        ]);
      });

      /**
       * Ensure the registry container runs on the desired port, sits on the
       * `kind` network, and every node's containerd resolves
       * `localhost:<port>` to it.
       */
      const ensureRegistry = Effect.fn(function* (options: {
        id: string;
        name: string;
        registryPort: number;
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const container = `${options.name}-registry`;
        let info = yield* inspectRegistry(container);
        if (
          info !== undefined &&
          registryHostPort(info) !== options.registryPort
        ) {
          yield* docker(["container", "rm", "--force", container]);
          info = undefined;
        }
        if (info === undefined) {
          yield* options.session.note(
            `Starting image registry on localhost:${options.registryPort}...`,
          );
          const labels = yield* createInternalTags(options.id);
          yield* docker([
            "container",
            "run",
            "--detach",
            "--restart=always",
            "--publish",
            `127.0.0.1:${options.registryPort}:5000`,
            "--network",
            "bridge",
            "--name",
            container,
            ...Object.entries(labels).flatMap(([key, value]) => [
              "--label",
              `${key}=${value}`,
            ]),
            REGISTRY_IMAGE,
          ]);
          info = yield* inspectRegistry(container);
        } else if (info.State?.Running !== true) {
          yield* docker(["container", "start", container]);
        }
        if (info?.NetworkSettings?.Networks?.kind === undefined) {
          yield* docker(["network", "connect", "kind", container]).pipe(
            Effect.catchTag("Kubernetes.LocalClusterError", (error) =>
              /already exists/i.test(error.message)
                ? Effect.void
                : Effect.fail(error),
            ),
          );
        }

        // containerd on each node: pull `localhost:<port>/…` from the
        // registry container over the kind network.
        const registryDir = `/etc/containerd/certs.d/localhost:${options.registryPort}`;
        const { stdout } = yield* kind([
          "get",
          "nodes",
          "--name",
          options.name,
        ]);
        const nodes = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        yield* Effect.forEach(
          nodes,
          (node) =>
            Effect.gen(function* () {
              yield* docker(["exec", node, "mkdir", "-p", registryDir]);
              yield* docker(
                [
                  "exec",
                  "-i",
                  node,
                  "cp",
                  "/dev/stdin",
                  `${registryDir}/hosts.toml`,
                ],
                `[host."http://${container}:5000"]\n`,
              );
            }),
          { concurrency: "unbounded" },
        );
      });

      return {
        stables: ["name", "context", "kubeconfig", "registryContainer"],
        list: () => Effect.succeed([] as LocalCluster["Attributes"][]),
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return;
          const oldName = yield* clusterName(id, olds, output);
          const newName = yield* clusterName(id, news, undefined);
          if (
            (news.name !== undefined && oldName !== newName) ||
            olds?.nodeImage !== news.nodeImage ||
            olds?.kubeconfig !== news.kubeconfig ||
            !deepEqual(kindConfigOf(olds ?? {}), kindConfigOf(news), {
              stripNullish: true,
            })
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = yield* clusterName(id, olds, output);
          if (!(yield* clusterExists(name))) return undefined;
          const registryInfo = yield* inspectRegistry(`${name}-registry`);
          const attrs = toAttributes({
            name,
            kubeconfig: output?.kubeconfig ?? olds?.kubeconfig,
            registryPort:
              registryHostPort(registryInfo) ??
              olds?.registryPort ??
              DEFAULT_REGISTRY_PORT,
            architecture: yield* hostArchitecture,
          });
          if (output) return attrs;
          // kind clusters carry no ownership marker; the registry container
          // we start next to them does. Anything else is foreign.
          const owned = yield* hasAlchemyTags(
            id,
            registryInfo?.Config?.Labels ?? undefined,
          );
          return owned ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* clusterName(id, news, output);
          const registryPort = news.registryPort ?? DEFAULT_REGISTRY_PORT;
          yield* ensureCluster({
            name,
            nodeImage: news.nodeImage,
            kubeconfig: news.kubeconfig,
            config: kindConfigOf(news),
            session,
          });
          yield* ensureRegistry({ id, name, registryPort, session });
          const attrs = toAttributes({
            name,
            kubeconfig: news.kubeconfig,
            registryPort,
            architecture: yield* hostArchitecture,
          });

          // Advertise the registry to in-cluster tooling (KEP-1755).
          const transport = yield* connectCluster(attrs.connection);
          yield* applyObject({
            transport,
            object: {
              apiVersion: "v1",
              kind: "ConfigMap",
              metadata: {
                name: "local-registry-hosting",
                namespace: "kube-public",
              },
              data: {
                "localRegistryHosting.v1": `host: "${attrs.registry.server}"\nhelp: "https://kind.sigs.k8s.io/docs/user/local-registry/"\n`,
              },
            },
          });
          yield* session.note(
            `kind cluster ${name} ready (context ${attrs.context}, registry ${attrs.registry.server})`,
          );
          return attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          // Both commands are idempotent: kind ignores a missing cluster.
          yield* kind([
            "delete",
            "cluster",
            "--name",
            output.name,
            ...kubeconfigArgs(output.kubeconfig),
          ]);
          yield* run(yield* DockerBin, [
            "container",
            "rm",
            "--force",
            output.registryContainer,
          ]);
        }),
      };
    }),
  );
