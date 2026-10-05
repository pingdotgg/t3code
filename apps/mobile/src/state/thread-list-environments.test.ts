import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createThreadListEnvironmentsAtom } from "./thread-list-environments";

const ID = EnvironmentId.make("one");
const OTHER_ID = EnvironmentId.make("two");
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const config = {
  providers: [provider],
  environment: { capabilities: {}, platform: { machine: "laptop" } },
  settings: {},
} as unknown as ServerConfig;

function harness() {
  const registry = AtomRegistry.make();
  const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
    new Map([
      [ID, config],
      [OTHER_ID, config],
    ]),
  );
  const list = createThreadListEnvironmentsAtom(configs);
  let sourceNotifications = 0;
  let listNotifications = 0;
  registry.subscribe(configs, () => sourceNotifications++);
  registry.subscribe(list, () => listNotifications++);
  registry.get(list);
  sourceNotifications = 0;
  listNotifications = 0;
  return {
    registry,
    configs,
    list,
    read: () => registry.get(list),
    write: (next: ServerConfig) =>
      registry.set(
        configs,
        new Map([
          [ID, next],
          [OTHER_ID, config],
        ]),
      ),
    notifications: () => ({ source: sourceNotifications, list: listNotifications }),
  };
}

describe("thread list environment projection", () => {
  it("keeps navigation stable while freshness, catalog and workspace updates reach full-config consumers", () => {
    const h = harness();
    try {
      const initial = h.read();
      const changed: ServerConfig = {
        ...config,
        providers: [
          {
            ...provider,
            checkedAt: "2026-09-02T00:00:00.000Z",
            usageLimits: { checkedAt: "2026-09-02T00:00:00.000Z", windows: [] },
            models: [{ slug: "new-model", name: "New model", isCustom: false, capabilities: null }],
            workspaceSnapshots: [
              {
                cwd: "/repo",
                checkedAt: "2026-09-02T00:00:00.000Z",
                slashCommands: [],
                skills: [],
              },
            ],
          },
        ],
      };
      h.write(changed);
      expect(h.read()).toBe(initial);
      expect(h.registry.get(h.configs).get(ID)?.providers[0]?.usageLimits?.checkedAt).toBe(
        "2026-09-02T00:00:00.000Z",
      );
      expect(h.notifications()).toEqual({ source: 1, list: 0 });
    } finally {
      h.registry.dispose();
    }
  });

  it.each([
    ["threadSettlement", "settlementEnvironmentIds"],
    ["threadSnooze", "snoozeEnvironmentIds"],
    ["threadPinning", "pinningEnvironmentIds"],
    ["threadPinReorder", "pinReorderEnvironmentIds"],
    ["threadActiveReorder", "activeReorderEnvironmentIds"],
    ["threadTitleRegeneration", "titleRegenerationEnvironmentIds"],
  ] as const)("tracks enabling and removing %s", (capability, collection) => {
    const h = harness();
    try {
      h.write({
        ...config,
        environment: {
          ...config.environment,
          capabilities: { ...config.environment.capabilities, [capability]: true },
        },
      });
      expect([...h.read()[collection]]).toEqual([ID]);
      h.write({
        ...config,
        environment: {
          ...config.environment,
          capabilities: { ...config.environment.capabilities, [capability]: false },
        },
      });
      expect(h.read()[collection].size).toBe(0);
      const disabled = h.read();
      h.write(config);
      expect(h.read()).toBe(disabled);
      expect(h.notifications().list).toBe(2);
    } finally {
      h.registry.dispose();
    }
  });

  it.each([
    ["instanceId", ProviderInstanceId.make("other")],
    ["driver", ProviderDriverKind.make("claudeAgent")],
    ["displayName", "Work account"],
    ["accentColor", "#123456"],
    ["iconUrl", "https://example.test/icon.png"],
  ] as const)(
    "updates and restores provider %s without changing another environment's providers",
    (key, value) => {
      const h = harness();
      try {
        const otherProviders = h.read().providersByEnvironmentId.get(OTHER_ID);
        h.write({ ...config, providers: [{ ...provider, [key]: value }] });
        expect(h.read().providersByEnvironmentId.get(ID)?.[0]?.[key]).toBe(value);
        expect(h.read().providersByEnvironmentId.get(OTHER_ID)).toBe(otherProviders);
        h.write(config);
        expect(h.read().providersByEnvironmentId.get(ID)?.[0]?.[key]).toBe(provider[key]);
        expect(h.notifications().list).toBe(2);
      } finally {
        h.registry.dispose();
      }
    },
  );

  it("tracks provider membership and order in both directions", () => {
    const h = harness();
    try {
      const second = { ...provider, instanceId: ProviderInstanceId.make("work") };
      h.write({ ...config, providers: [provider, second] });
      expect(
        h
          .read()
          .providersByEnvironmentId.get(ID)
          ?.map((p) => p.instanceId),
      ).toEqual(["codex", "work"]);
      h.write({ ...config, providers: [second, provider] });
      expect(
        h
          .read()
          .providersByEnvironmentId.get(ID)
          ?.map((p) => p.instanceId),
      ).toEqual(["work", "codex"]);
      h.write({ ...config, providers: [] });
      expect(h.read().providersByEnvironmentId.get(ID)).toEqual([]);
      h.write(config);
      expect(
        h
          .read()
          .providersByEnvironmentId.get(ID)
          ?.map((p) => p.instanceId),
      ).toEqual(["codex"]);
      expect(h.notifications().list).toBe(4);
    } finally {
      h.registry.dispose();
    }
  });

  it("restores detected machine kind after removing an override", () => {
    const h = harness();
    try {
      expect(h.read().machineByEnvironmentId.get(ID)).toBe("laptop");
      h.write({ ...config, settings: { ...config.settings, environmentIcon: "server" } });
      expect(h.read().machineByEnvironmentId.get(ID)).toBe("server");
      h.write(config);
      expect(h.read().machineByEnvironmentId.get(ID)).toBe("laptop");
      const detected = h.read();
      h.write({ ...config, settings: { ...config.settings, environmentIcon: "laptop" } });
      expect(h.read()).toBe(detected);
    } finally {
      h.registry.dispose();
    }
  });

  it("removes forgotten environments and repopulates them after reconnect", () => {
    const h = harness();
    try {
      h.registry.set(h.configs, new Map());
      expect(h.read().providersByEnvironmentId.size).toBe(0);
      expect(h.read().machineByEnvironmentId.size).toBe(0);
      h.write(config);
      expect([...h.read().providersByEnvironmentId.keys()]).toEqual([ID, OTHER_ID]);
      expect(h.notifications().list).toBe(2);
    } finally {
      h.registry.dispose();
    }
  });
});
