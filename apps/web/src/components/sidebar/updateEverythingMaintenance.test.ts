import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import {
  isHostedMaintenanceReady,
  waitForHostedMaintenance,
  waitForHostedProviderWork,
  type HostedMaintenanceSnapshot,
  type HostedProviderWorkSnapshot,
} from "./updateEverythingMaintenance";

function machine(
  status: "running" | "queued" | "succeeded" | "idle",
  hostedByThisApp = true,
  environmentId = "primary",
) {
  return {
    environmentId: EnvironmentId.make(environmentId),
    hostedByThisApp,
    connected: true,
    sessionReady: true,
    providers: [
      {
        instanceId: ProviderInstanceId.make("codex"),
        updateState: { status, startedAt: null, finishedAt: null, message: null, output: null },
      },
    ],
  };
}

it.each([
  { ready: false, primaryEnvironmentId: null, localEnvironmentDisabled: false, machines: [] },
  {
    ready: false,
    primaryEnvironmentId: EnvironmentId.make("primary"),
    localEnvironmentDisabled: false,
    machines: [],
  },
  {
    ready: true,
    primaryEnvironmentId: null,
    localEnvironmentDisabled: true,
    machines: [machine("running", false)],
  },
  {
    ready: false,
    primaryEnvironmentId: null,
    localEnvironmentDisabled: true,
    machines: [{ ...machine("succeeded"), connected: false, sessionReady: false }],
  },
])("allows manual restart without observed hosted work: %j", async (snapshot) => {
  const registry = AtomRegistry.make();
  try {
    const source = Atom.make<HostedProviderWorkSnapshot>(snapshot);
    await expect(waitForHostedProviderWork(registry, source)).resolves.toBeUndefined();
  } finally {
    registry.dispose();
  }
});

it.each(["queued", "running"] as const)(
  "waits for disconnected %s work and every other hosted job before one manual install",
  async (status) => {
    const registry = AtomRegistry.make();
    try {
      const snapshot: HostedProviderWorkSnapshot = {
        ready: true,
        primaryEnvironmentId: EnvironmentId.make("primary"),
        localEnvironmentDisabled: false,
        machines: [{ ...machine(status), connected: false }, machine("queued", true, "wsl")],
      };
      const source = Atom.make(snapshot);
      const calls: string[] = [];
      const admitted = waitForHostedProviderWork(registry, source).then(
        () => calls.push("install"),
        () => calls.push("refused"),
      );
      await Promise.resolve();
      expect(calls).toEqual([]);
      registry.set(source, {
        ...snapshot,
        machines: [machine("succeeded"), machine("running", true, "wsl")],
      });
      await Promise.resolve();
      expect(calls).toEqual([]);
      registry.set(source, {
        ...snapshot,
        machines: [machine("succeeded"), machine("succeeded", true, "wsl")],
      });
      await admitted;
      registry.set(source, snapshot);
      await Promise.resolve();
      expect(calls).toEqual(["install"]);
    } finally {
      registry.dispose();
    }
  },
);

it.each([
  { ready: false, primaryEnvironmentId: null, localEnvironmentDisabled: true, machines: [] },
  { ready: true, primaryEnvironmentId: null, localEnvironmentDisabled: true, machines: [] },
  {
    ready: true,
    primaryEnvironmentId: EnvironmentId.make("primary"),
    localEnvironmentDisabled: false,
    machines: [{ ...machine("succeeded"), connected: false }],
  },
  {
    ready: true,
    primaryEnvironmentId: EnvironmentId.make("primary"),
    localEnvironmentDisabled: false,
    machines: [{ ...machine("succeeded"), sessionReady: false }],
  },
])("refuses manual install when observed busy work loses readiness: %j", async (lost) => {
  const registry = AtomRegistry.make();
  try {
    const source = Atom.make<HostedProviderWorkSnapshot>({
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [machine("running")],
    });
    const refused = expect(waitForHostedProviderWork(registry, source)).rejects.toThrow(
      "A local connection is not ready",
    );
    registry.set(source, lost);
    await refused;
  } finally {
    registry.dispose();
  }
});

it.each(["machine", "provider", "state", "idle"] as const)(
  "refuses manual install when a busy %s disappears from a ready catalog",
  async (missing) => {
    const registry = AtomRegistry.make();
    try {
      const snapshot: HostedProviderWorkSnapshot = {
        ready: true,
        primaryEnvironmentId: EnvironmentId.make("primary"),
        localEnvironmentDisabled: false,
        machines: [machine("running"), machine("succeeded", true, "wsl")],
      };
      const source = Atom.make(snapshot);
      const refused = expect(waitForHostedProviderWork(registry, source)).rejects.toThrow(
        "A local connection is not ready",
      );
      const lost: HostedProviderWorkSnapshot["machines"][number] = {
        ...machine("succeeded"),
        providers:
          missing === "provider"
            ? []
            : missing === "state"
              ? [{ instanceId: ProviderInstanceId.make("codex") }]
              : machine("idle").providers,
      };
      const remaining = machine("succeeded", true, "wsl");
      registry.set(source, {
        ...snapshot,
        machines: missing === "machine" ? [remaining] : [lost, remaining],
      });
      await refused;
    } finally {
      registry.dispose();
    }
  },
);

it("allows a standalone restart when a ready catalog has no hosted connections", async () => {
  const registry = AtomRegistry.make();
  try {
    const snapshot = {
      ready: true,
      primaryEnvironmentId: null,
      localEnvironmentDisabled: true,
      machines: [machine("running", false)],
    };
    const source = Atom.make<HostedMaintenanceSnapshot>(snapshot);
    await expect(waitForHostedMaintenance(registry, source)).resolves.toBeUndefined();
    expect(isHostedMaintenanceReady(snapshot)).toBe(true);
    registry.set(source, { ...snapshot, machines: [] });
    await expect(waitForHostedMaintenance(registry, source)).resolves.toBeUndefined();
    expect(isHostedMaintenanceReady(registry.get(source))).toBe(true);
  } finally {
    registry.dispose();
  }
});

it("refuses a restart before the catalog is ready or a known hosted connection is ready", async () => {
  const registry = AtomRegistry.make();
  try {
    for (const snapshot of [
      { ready: false, machines: [], primaryEnvironmentId: null, localEnvironmentDisabled: true },
      { ready: true, primaryEnvironmentId: null, localEnvironmentDisabled: false, machines: [] },
      {
        ready: true,
        primaryEnvironmentId: EnvironmentId.make("primary"),
        localEnvironmentDisabled: true,
        machines: [],
      },
      {
        ready: true,
        primaryEnvironmentId: EnvironmentId.make("primary"),
        localEnvironmentDisabled: false,
        machines: [{ ...machine("succeeded"), connected: false }],
      },
      {
        ready: true,
        primaryEnvironmentId: EnvironmentId.make("primary"),
        localEnvironmentDisabled: false,
        machines: [{ ...machine("succeeded"), sessionReady: false }],
      },
    ]) {
      const source = Atom.make<HostedMaintenanceSnapshot>(snapshot);
      await expect(waitForHostedMaintenance(registry, source)).rejects.toThrow(
        "A local connection is not ready",
      );
      expect(isHostedMaintenanceReady(registry.get(source))).toBe(false);
    }
  } finally {
    registry.dispose();
  }
});

it("waits for all hosted provider work, including WSL work queued while the first install finishes", async () => {
  const registry = AtomRegistry.make();
  try {
    const source = Atom.make<HostedMaintenanceSnapshot>({
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [machine("running"), machine("succeeded"), machine("running", false)],
    });
    const calls: string[] = [];
    const admitted = waitForHostedMaintenance(registry, source).then(() => {
      calls.push("install");
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    registry.set(source, {
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [machine("succeeded"), machine("queued"), machine("running", false)],
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    registry.set(source, {
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [machine("succeeded"), machine("running"), machine("running", false)],
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    registry.set(source, {
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [machine("succeeded"), machine("succeeded"), machine("running", false)],
    });
    await admitted;
    expect(calls).toEqual(["install"]);
  } finally {
    registry.dispose();
  }
});

it("checks maintenance that starts while a plain restart is being prepared", async () => {
  const registry = AtomRegistry.make();
  try {
    const source = Atom.make<HostedMaintenanceSnapshot>({
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [machine("succeeded")],
    });
    let finishPreparation!: () => void;
    const prepared = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const calls: string[] = [];
    const restart = (async () => {
      await prepared;
      await waitForHostedMaintenance(registry, source);
      calls.push("install");
    })();
    registry.set(source, {
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [machine("queued")],
    });
    finishPreparation();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);
    registry.set(source, {
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [machine("succeeded")],
    });
    await restart;
    expect(calls).toEqual(["install"]);
  } finally {
    registry.dispose();
  }
});

it("refuses install if a hosted connection loses readiness during maintenance", async () => {
  const registry = AtomRegistry.make();
  try {
    const source = Atom.make<HostedMaintenanceSnapshot>({
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [machine("running")],
    });
    const admitted = waitForHostedMaintenance(registry, source);
    const refused = expect(admitted).rejects.toThrow("A local connection is not ready");
    registry.set(source, {
      ready: true,
      primaryEnvironmentId: EnvironmentId.make("primary"),
      localEnvironmentDisabled: false,
      machines: [{ ...machine("running"), connected: false }],
    });
    await refused;
  } finally {
    registry.dispose();
  }
});
