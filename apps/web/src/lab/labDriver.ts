// The lab's only fake layer: client-runtime's ConnectionDriver, swapped (vite.lab.config.ts) for the
// in-process environment of the render tests (test/fakeEnvironment.ts). Each environment gets its
// own view of that one shared session: the primary keeps the threads no remote hosts
// (src/lab/environments.ts); a remote sees only its own threads and names its own machine.
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ConnectionDriver } from "../../../../packages/client-runtime/src/connection/driver.ts";
import { ENVIRONMENT_ID, fakeDriver } from "../../test/fakeEnvironment";
import { labRemoteEnvironment, labThreadHost, type LabRemoteEnvironment } from "./environments";

export * from "../../../../packages/client-runtime/src/connection/driver.ts";

type Session = Effect.Success<ReturnType<typeof fakeDriver.connect>>["session"];
type Item = Record<string, any>;

const configFor = (config: any, remote: LabRemoteEnvironment | null) =>
  remote === null
    ? config
    : {
        ...config,
        environment: {
          ...config.environment,
          environmentId: remote.id,
          label: remote.label,
          platform: { ...config.environment.platform, os: remote.os, arch: remote.arch },
        },
        settings: { ...config.settings, environmentIcon: remote.kind },
      };

function sessionFor(session: Session, remote: LabRemoteEnvironment | null): Session {
  const environmentId = remote?.id ?? ENVIRONMENT_ID;
  const hosts = (threadId: string) => labThreadHost(threadId, ENVIRONMENT_ID) === environmentId;
  const shell = (item: Item): Item => {
    if (item.kind !== "snapshot") return item;
    const threads = item.snapshot.threads.filter((thread: Item) => hosts(thread.id));
    const used = new Set(threads.map((thread: Item) => thread.projectId));
    return {
      ...item,
      snapshot: {
        ...item.snapshot,
        threads,
        projects: item.snapshot.projects.filter((project: Item) => used.has(project.id)),
      },
    };
  };
  const config = (item: Item): Item =>
    item.type === "snapshot" ? { ...item, config: configFor(item.config, remote) } : item;
  const handlers: Record<string, (input: never) => unknown> = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
      Stream.map((session.client as any)[ORCHESTRATION_V2_WS_METHODS.subscribeShell](input), shell),
    [WS_METHODS.subscribeServerConfig]: (input) =>
      Stream.map((session.client as any)[WS_METHODS.subscribeServerConfig](input), config),
  };
  return {
    ...session,
    client: new Proxy(session.client, {
      get: (target, method: string) => handlers[method] ?? Reflect.get(target, method),
    }),
    initialConfig: Effect.map(session.initialConfig, (value) => configFor(value, remote) as never),
    subscribeServerConfig: () => Stream.map(session.subscribeServerConfig(), config) as never,
  };
}

const labDriver = {
  ...fakeDriver,
  connect: (entry: Parameters<typeof fakeDriver.connect>[0]) =>
    Effect.map(fakeDriver.connect(entry), (lease) => {
      const remote = labRemoteEnvironment(entry.target.environmentId);
      return {
        ...lease,
        prepared: {
          ...lease.prepared,
          environmentId: remote?.id ?? lease.prepared.environmentId,
          label: remote?.label ?? lease.prepared.label,
        },
        session: sessionFor(lease.session, remote),
      };
    }),
};

export const layer = Layer.succeed(ConnectionDriver, labDriver as never);
