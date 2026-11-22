// Extra fake environments, so threads can live on another machine and the sidebar shows the
// machine icon. Plain data: the lab driver (labDriver.ts) imports it, so it must not reach the app.
// registerEnvironments.ts saves each one in the app's connection registry.
import { EnvironmentId, type EnvironmentMachineKind } from "@t3tools/contracts";

export interface LabRemoteEnvironment {
  readonly id: EnvironmentId;
  readonly label: string;
  /** The machine icon the sidebar shows for threads here. */
  readonly kind: EnvironmentMachineKind;
  readonly os: "darwin" | "linux";
  readonly arch: "arm64" | "x64";
  /** Ids of the lab threads this environment hosts; every other thread stays on the primary. */
  readonly threadIds: ReadonlyArray<string>;
}

export const LAB_REMOTE_ENVIRONMENTS: ReadonlyArray<LabRemoteEnvironment> = [
  {
    id: EnvironmentId.make("environment-macbook"),
    label: "MacBook Pro",
    kind: "laptop",
    os: "darwin",
    arch: "arm64",
    threadIds: ["heroicons-lucide", "orbit-task-delivery", "orbit-workers"],
  },
  {
    id: EnvironmentId.make("environment-linux-vm"),
    label: "Linux VM",
    kind: "server",
    os: "linux",
    arch: "x64",
    threadIds: ["ingress-node", "stalled-threads", "dlf-backlog"],
  },
];

export const labRemoteEnvironment = (environmentId: string) =>
  LAB_REMOTE_ENVIRONMENTS.find((environment) => environment.id === environmentId) ?? null;

/** The environment that hosts a lab thread, as an id; the primary when no remote lists it. */
export const labThreadHost = (threadId: string, primaryId: EnvironmentId): EnvironmentId =>
  LAB_REMOTE_ENVIRONMENTS.find((environment) => environment.threadIds.includes(threadId))?.id ??
  primaryId;
