import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  OrbitGatewayEnvironment,
  OrbitConversationRef,
} from "@t3tools/client-runtime/orbit-gateway";
import type { ScopedThreadRef } from "@t3tools/contracts";

export interface OrbitAgentNavigationPorts {
  readonly source: ScopedThreadRef;
  readonly isCurrent: () => boolean;
  readonly prepare: (target: OrbitConversationRef) => Promise<void>;
  readonly exists: (target: OrbitConversationRef) => Promise<boolean>;
  readonly handoff: (source: ScopedThreadRef, target: ScopedThreadRef) => void;
  readonly navigate: (target: ScopedThreadRef) => Promise<void>;
}

/** Only an explicit click calls this boundary; Orbit record ids never enter routing. */
export async function openOrbitAgentConversation(
  ref: OrbitConversationRef,
  ports: OrbitAgentNavigationPorts,
): Promise<void> {
  await ports.prepare(ref);
  if (!ports.isCurrent()) return;
  if (!(await ports.exists(ref))) throw new Error("This conversation is no longer available.");
  if (!ports.isCurrent()) return;
  const target: ScopedThreadRef = { environmentId: ref.environmentId, threadId: ref.threadId };
  if (scopedThreadKey(target) !== scopedThreadKey(ports.source))
    ports.handoff(ports.source, target);
  await ports.navigate(target);
}

export async function prepareOrbitConversationEnvironment(
  environmentId: string,
  ports: {
    known: () => boolean;
    environments:
      | (() => Promise<
          ReadonlyArray<
            Pick<OrbitGatewayEnvironment, "environmentId" | "powerState" | "registeredAt">
          >
        >)
      | null;
    connect: (
      environment: Pick<OrbitGatewayEnvironment, "environmentId" | "powerState" | "registeredAt">,
    ) => Promise<boolean>;
    enable: () => Promise<void>;
  },
): Promise<void> {
  const environment = (await ports.environments?.())?.find(
    (entry) => entry.environmentId === environmentId,
  );
  if (environment?.powerState === "stopped")
    throw new Error("This workspace is asleep. Wake it in Connections, then try again.");
  if (!ports.known()) {
    if (!environment)
      throw new Error("This environment is not paired or is no longer available in Orbit.");
    if (!(await ports.connect(environment)))
      throw new Error("Could not pair with this environment. Open Connections to reconnect it.");
  }
  await ports.enable();
}

export function copyTasksPanelWidth(
  sourceKey: string,
  targetKey: string,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): void {
  try {
    const value = storage.getItem(`t3code:preview-panel-width:${sourceKey}`);
    const key = `t3code:preview-panel-width:${targetKey}`;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* Navigation still works when browser storage is unavailable. */
  }
}
