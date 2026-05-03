import {
  EnvironmentId,
  SandboxId,
  type ExecutionEnvironmentDescriptor,
  type SandboxDescriptor,
  type SandboxResourceSpec,
  type SandboxRuntimeProviderConfig,
  type SandboxServiceDescriptor,
} from "@t3tools/contracts";
import {
  buildSandboxName,
  buildSandboxTags,
  normalizeSandboxServiceRequests,
  sandboxErrorFromUnknown,
  type SandboxMaterializationResult,
  type SandboxMaterializeTaskRuntimeInput,
  type SandboxProvider,
} from "@t3tools/sandbox";
import { Effect } from "effect";
import {
  ModalClient,
  NotFoundError,
  Probe,
  type Image,
  type Sandbox,
  type SandboxCreateParams,
} from "modal";

export interface ModalSandboxRuntimeConfig {
  readonly appName: string;
  readonly imageTag: string;
  readonly runtimePort: number;
  readonly command: ReadonlyArray<string>;
  readonly workdir: string;
  readonly environment?: string | undefined;
  readonly timeoutMs: number;
  readonly idleTimeoutMs: number;
}

export interface ModalSandboxClient {
  readonly createOrReconnectSandbox: (input: {
    readonly appName: string;
    readonly imageTag: string;
    readonly sandboxName: string;
    readonly environment?: string | undefined;
    readonly secretNames?: ReadonlyArray<string> | undefined;
    readonly imageDockerfileCommands?: ReadonlyArray<string> | undefined;
    readonly params: SandboxCreateParams;
    readonly tags: Record<string, string>;
  }) => Promise<{
    readonly sandboxId: string;
    readonly runtimeEndpointUrl?: string;
  }>;
}

const DEFAULT_MODAL_APP_NAME = "t3-task-runtime";
const DEFAULT_MODAL_IMAGE_TAG = "oven/bun:1.3.10";
const DEFAULT_RUNTIME_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_WORKDIR = "/workspace/t3code";
const DEFAULT_COMMAND = [
  "sh",
  "-lc",
  "node /app/apps/server/dist/bin.mjs serve --host 0.0.0.0 --port ${T3_RUNTIME_PORT:-8787} --base-dir ${T3CODE_HOME:-/var/lib/t3code} --no-browser ${T3_RUNTIME_WORKSPACE:-/workspace/t3code}",
] as const;

function splitCommand(value: string | undefined): ReadonlyArray<string> | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return ["sh", "-lc", value.trim()];
}

function parseDockerfileCommands(value: string | undefined): ReadonlyArray<string> | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveRuntimeConfig(input: {
  readonly environment?: string | undefined;
  readonly resources?: SandboxResourceSpec | undefined;
  readonly providerConfig?: SandboxRuntimeProviderConfig | undefined;
}): ModalSandboxRuntimeConfig {
  const environment = input.environment ?? process.env.MODAL_ENVIRONMENT;
  return {
    appName:
      input.providerConfig?.appName ?? process.env.T3_MODAL_APP_NAME ?? DEFAULT_MODAL_APP_NAME,
    imageTag:
      input.providerConfig?.imageTag ?? process.env.T3_MODAL_IMAGE_TAG ?? DEFAULT_MODAL_IMAGE_TAG,
    runtimePort: positiveOrDefault(input.providerConfig?.runtimePort, DEFAULT_RUNTIME_PORT),
    command:
      splitCommand(process.env.T3_MODAL_RUNTIME_COMMAND) ??
      input.providerConfig?.bootstrapCommandRef?.split(" ") ??
      DEFAULT_COMMAND,
    workdir: process.env.T3_MODAL_WORKDIR ?? DEFAULT_WORKDIR,
    ...(environment !== undefined ? { environment } : {}),
    timeoutMs: positiveOrDefault(input.resources?.timeoutMs, DEFAULT_TIMEOUT_MS),
    idleTimeoutMs: positiveOrDefault(input.resources?.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
  };
}

function toSandboxCreateParams(input: {
  readonly config: ModalSandboxRuntimeConfig;
  readonly resources?: SandboxResourceSpec | undefined;
}): SandboxCreateParams {
  const sharedSecret = process.env.T3_EXECUTION_BRIDGE_SHARED_SECRET?.trim();
  return {
    command: [...input.config.command],
    workdir: input.config.workdir,
    env: {
      T3_RUNTIME_PORT: String(input.config.runtimePort),
      ...(sharedSecret ? { T3_EXECUTION_BRIDGE_SHARED_SECRET: sharedSecret } : {}),
    },
    encryptedPorts: [input.config.runtimePort],
    readinessProbe: Probe.withTcp(input.config.runtimePort),
    timeoutMs: input.config.timeoutMs,
    idleTimeoutMs: input.config.idleTimeoutMs,
    ...(input.resources?.cpu !== undefined ? { cpu: input.resources.cpu } : {}),
    ...(input.resources?.cpuLimit !== undefined ? { cpuLimit: input.resources.cpuLimit } : {}),
    ...(input.resources?.memoryMiB !== undefined ? { memoryMiB: input.resources.memoryMiB } : {}),
    ...(input.resources?.memoryLimitMiB !== undefined
      ? { memoryLimitMiB: input.resources.memoryLimitMiB }
      : {}),
    ...(input.resources?.gpu !== undefined ? { gpu: input.resources.gpu } : {}),
    ...(input.resources?.regions !== undefined ? { regions: [...input.resources.regions] } : {}),
  };
}

function buildEnvironmentDescriptor(input: {
  readonly sandboxId: SandboxId;
  readonly sandboxName: string;
}): ExecutionEnvironmentDescriptor {
  return {
    environmentId: EnvironmentId.make(`modal:${input.sandboxId}`),
    label: `Modal Sandbox ${input.sandboxName}`,
    platform: {
      os: "linux",
      arch: "x64",
    },
    serverVersion: "modal-sandbox",
    capabilities: {
      repositoryIdentity: true,
    },
  };
}

function buildServiceDescriptors(input: {
  readonly materialization: SandboxMaterializeTaskRuntimeInput;
  readonly endpointUrl?: string | undefined;
  readonly runtimePort: number;
}): ReadonlyArray<SandboxServiceDescriptor> {
  return normalizeSandboxServiceRequests(input.materialization.services).map((request) => {
    const isRuntime = request.kind === "t3-runtime";
    const descriptor: {
      serviceId: SandboxServiceDescriptor["serviceId"];
      kind: SandboxServiceDescriptor["kind"];
      status: SandboxServiceDescriptor["status"];
      label?: string;
      endpointUrl?: string;
      endpoints?: SandboxServiceDescriptor["endpoints"];
      metadata?: Record<string, unknown>;
    } = {
      serviceId: request.serviceId,
      kind: request.kind,
      status: isRuntime && input.endpointUrl === undefined ? "degraded" : "ready",
    };
    if (request.label !== undefined) {
      descriptor.label = request.label;
    }
    if (input.endpointUrl !== undefined && isRuntime) {
      descriptor.endpointUrl = input.endpointUrl;
      descriptor.endpoints = [
        {
          url: input.endpointUrl,
          protocol: "https",
          accessMode: "server",
          auth: {
            kind: "bridge-shared-secret",
            credentialRef: "T3_EXECUTION_BRIDGE_SHARED_SECRET",
          },
        },
      ];
    }
    if (isRuntime || request.metadata !== undefined) {
      descriptor.metadata = request.metadata ?? {};
      if (isRuntime) {
        descriptor.metadata.runtimePort = input.runtimePort;
      }
    }
    return descriptor;
  });
}

export class ModalSdkSandboxClient implements ModalSandboxClient {
  async createOrReconnectSandbox(input: {
    readonly appName: string;
    readonly imageTag: string;
    readonly sandboxName: string;
    readonly environment?: string | undefined;
    readonly secretNames?: ReadonlyArray<string> | undefined;
    readonly imageDockerfileCommands?: ReadonlyArray<string> | undefined;
    readonly params: SandboxCreateParams;
    readonly tags: Record<string, string>;
  }) {
    const modal = new ModalClient(input.environment ? { environment: input.environment } : {});
    let sandbox: Sandbox | undefined;
    try {
      sandbox = await modal.sandboxes.fromName(
        input.appName,
        input.sandboxName,
        input.environment !== undefined ? { environment: input.environment } : undefined,
      );
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }

    if (sandbox === undefined) {
      const app = await modal.apps.fromName(input.appName, {
        createIfMissing: true,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });
      const baseImage: Image = modal.images.fromRegistry(input.imageTag);
      const buildCommands =
        input.imageDockerfileCommands ??
        parseDockerfileCommands(process.env.T3_MODAL_IMAGE_DOCKERFILE_COMMANDS_JSON);
      const image =
        buildCommands !== undefined ? baseImage.dockerfileCommands([...buildCommands]) : baseImage;
      const secrets =
        input.secretNames !== undefined
          ? await Promise.all(input.secretNames.map((name) => modal.secrets.fromName(name)))
          : undefined;
      sandbox = await modal.sandboxes.create(app, image, {
        ...input.params,
        name: input.sandboxName,
        ...(secrets !== undefined ? { secrets } : {}),
      });
    }

    await sandbox.setTags(input.tags);
    await sandbox.waitUntilReady(input.params.timeoutMs);
    const runtimePort = input.params.encryptedPorts?.[0];
    const tunnels = runtimePort !== undefined ? await sandbox.tunnels(input.params.timeoutMs) : {};
    const runtimeEndpointUrl = runtimePort !== undefined ? tunnels[runtimePort]?.url : undefined;
    sandbox.detach();
    modal.close();
    return {
      sandboxId: sandbox.sandboxId,
      ...(runtimeEndpointUrl !== undefined ? { runtimeEndpointUrl } : {}),
    };
  }
}

export function makeModalSandboxProvider(
  client: ModalSandboxClient = new ModalSdkSandboxClient(),
): SandboxProvider {
  return {
    providerKind: "modal",
    materializeTaskRuntime(input) {
      return Effect.tryPromise({
        try: async () => {
          const config = resolveRuntimeConfig({
            environment: input.environment,
            resources: input.resources,
            providerConfig: input.providerConfig,
          });
          const sandboxName = buildSandboxName({
            providerKind: "modal",
            taskId: `${input.taskId}-${input.workSessionId}`,
            title: input.title,
          });
          const tags = buildSandboxTags({
            providerKind: "modal",
            taskId: input.taskId,
            workSessionId: input.workSessionId,
            ...(input.project.projectKey !== undefined
              ? { projectKey: input.project.projectKey }
              : {}),
            ...(config.environment !== undefined ? { environment: config.environment } : {}),
          });
          const params = toSandboxCreateParams({
            config,
            resources: input.resources,
          });
          const created = await client.createOrReconnectSandbox({
            appName: config.appName,
            imageTag: config.imageTag,
            sandboxName,
            ...(config.environment !== undefined ? { environment: config.environment } : {}),
            ...(input.providerConfig?.allowedSecretNames !== undefined
              ? { secretNames: input.providerConfig.allowedSecretNames }
              : {}),
            ...(input.providerConfig?.imageDockerfileCommands !== undefined
              ? { imageDockerfileCommands: input.providerConfig.imageDockerfileCommands }
              : {}),
            params,
            tags,
          });
          const sandboxId = SandboxId.make(`modal:${created.sandboxId}`);
          const timestamp = new Date().toISOString();
          const services = buildServiceDescriptors({
            materialization: input,
            endpointUrl: created.runtimeEndpointUrl,
            runtimePort: config.runtimePort,
          });
          const environment = buildEnvironmentDescriptor({ sandboxId, sandboxName });
          const sandbox: SandboxDescriptor = {
            sandboxId,
            providerKind: "modal",
            providerRef: {
              providerKind: "modal",
              externalId: created.sandboxId,
              appName: config.appName,
              name: sandboxName,
              ...(config.environment !== undefined ? { environment: config.environment } : {}),
            },
            status: created.runtimeEndpointUrl === undefined ? "starting" : "ready",
            taskId: input.taskId,
            workSessionId: input.workSessionId,
            project: {
              repoName: input.project.repoName,
              workspaceRoot: input.project.workspaceRoot,
              defaultBranch: input.project.defaultBranch,
              ...(input.project.projectKey !== undefined
                ? { projectKey: input.project.projectKey }
                : {}),
            },
            resources: input.resources ?? {},
            ...(config.environment !== undefined ? { environment: config.environment } : {}),
            services,
            artifacts: [],
            idempotencyKey: input.idempotencyKey,
            createdAt: timestamp,
            updatedAt: timestamp,
          };

          return {
            sandbox,
            environment,
            services,
          } satisfies SandboxMaterializationResult;
        },
        catch: (error) =>
          sandboxErrorFromUnknown(error, {
            operation: "materialize",
            providerKind: "modal",
          }),
      });
    },
    reconnect(input) {
      return Effect.fail(
        sandboxErrorFromUnknown(new Error("Modal Sandbox reconnect is not wired yet."), {
          operation: "reconnect",
          providerKind: "modal",
          sandboxId: input.sandboxId,
        }),
      );
    },
    getStatus(input) {
      return Effect.fail(
        sandboxErrorFromUnknown(new Error("Modal Sandbox status lookup is not wired yet."), {
          operation: "status",
          providerKind: "modal",
          sandboxId: input.sandboxId,
        }),
      );
    },
    archive(input) {
      return Effect.fail(
        sandboxErrorFromUnknown(new Error("Modal Sandbox archival is not wired yet."), {
          operation: "archive",
          providerKind: "modal",
          sandboxId: input.sandboxId,
        }),
      );
    },
    terminate(input) {
      return Effect.fail(
        sandboxErrorFromUnknown(new Error("Modal Sandbox termination is not wired yet."), {
          operation: "terminate",
          providerKind: "modal",
          sandboxId: input.sandboxId,
        }),
      );
    },
  };
}
