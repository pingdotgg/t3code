import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId, type KeybindingRule, type ServerConfig } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand } from "../keybindings";
import { createShortcutKeybindingsAtom } from "./server";

const PRIMARY = EnvironmentId.make("primary");
const A = EnvironmentId.make("a");
const B = EnvironmentId.make("b");

// The reporter's swap: Cmd+N opens a local thread instead of a regular one.
const SWAPPED: KeybindingRule[] = [{ key: "mod+n", command: "chat.newLocal" }];
const STALE: KeybindingRule[] = [{ key: "mod+n", command: "chat.newWithoutProject" }];

function config(rules: readonly KeybindingRule[]) {
  return {
    keybindings: compileResolvedKeybindingsConfig(rules),
    providers: [],
  } as unknown as ServerConfig;
}

function environment(phase: EnvironmentConnectionPhase, serverConfig: ServerConfig | null) {
  return { connection: { phase, error: null, traceId: null }, serverConfig };
}

type Environment = ReturnType<typeof environment>;

function makeHarness(input: {
  primaryEnvironmentId?: EnvironmentId | null;
  primaryConfig?: ServerConfig | null;
  environments?: ReadonlyArray<readonly [EnvironmentId, Environment]>;
}) {
  const primaryEnvironmentIdAtom = Atom.make(input.primaryEnvironmentId ?? null);
  const primaryConfigAtom = Atom.make(input.primaryConfig ?? null);
  const environmentsAtom = Atom.make<ReadonlyMap<EnvironmentId, Environment>>(
    new Map(input.environments ?? []),
  );
  const keybindingsAtom = createShortcutKeybindingsAtom({
    primaryEnvironmentIdAtom,
    primaryConfigAtom,
    environmentsAtom,
  });
  const registry = AtomRegistry.make();
  registries.push(registry);
  // Keep the atom mounted, like the shortcut handlers do.
  registry.subscribe(keybindingsAtom, () => {});
  return {
    registry,
    primaryEnvironmentIdAtom,
    primaryConfigAtom,
    environmentsAtom,
    keybindings: () => registry.get(keybindingsAtom),
    /** The command Cmd+N runs on macOS. */
    cmdN: () =>
      resolveShortcutCommand(
        { key: "n", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        registry.get(keybindingsAtom),
        { platform: "MacIntel" },
      ),
  };
}

const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

describe("createShortcutKeybindingsAtom", () => {
  it("follows the primary environment when it has a config", () => {
    const harness = makeHarness({ primaryEnvironmentId: PRIMARY, primaryConfig: config(SWAPPED) });
    expect(harness.cmdN()).toBe("chat.newLocal");
  });

  it("keeps the defaults while the primary config is loading", () => {
    const harness = makeHarness({
      primaryEnvironmentId: PRIMARY,
      environments: [[B, environment("connected", config(SWAPPED))]],
    });
    expect(harness.cmdN()).toBe("chat.new");
  });

  it("follows the connected environment without a primary", () => {
    const harness = makeHarness({ environments: [[B, environment("connected", config(SWAPPED))]] });
    expect(harness.cmdN()).toBe("chat.newLocal");
  });

  it("skips an offline environment's cached config, as Settings does", () => {
    const harness = makeHarness({
      environments: [
        [A, environment("offline", config(STALE))],
        [B, environment("connected", config(SWAPPED))],
      ],
    });
    expect(harness.cmdN()).toBe("chat.newLocal");
  });

  it("keeps the defaults when no environment is connected", () => {
    const harness = makeHarness({
      environments: [[A, environment("offline", config(STALE))]],
    });
    expect(harness.cmdN()).toBe("chat.new");
  });

  it("follows edits to the connected environment's keybindings", () => {
    const harness = makeHarness({ environments: [[B, environment("connected", config([]))]] });
    expect(harness.cmdN()).toBe("chat.new");

    harness.registry.set(
      harness.environmentsAtom,
      new Map([[B, environment("connected", config(SWAPPED))]]),
    );
    expect(harness.cmdN()).toBe("chat.newLocal");
  });

  it("keeps the same bindings when an unrelated config update arrives", () => {
    const remote = config(SWAPPED);
    const harness = makeHarness({
      environments: [
        [A, environment("offline", config([]))],
        [B, environment("connected", remote)],
      ],
    });
    const before = harness.keybindings();

    // A provider status update on B and a reconnect attempt on A.
    harness.registry.set(
      harness.environmentsAtom,
      new Map([
        [A, environment("reconnecting", config([]))],
        [B, environment("connected", { ...remote, providers: [] })],
      ]),
    );
    expect(harness.keybindings()).toBe(before);
  });

  it("follows connection and primary changes without a reload", () => {
    const aConfig = config(STALE);
    const bConfig = config(SWAPPED);
    const harness = makeHarness({
      environments: [
        [A, environment("connected", aConfig)],
        [B, environment("connected", bConfig)],
      ],
    });
    const setEnvironments = (a: EnvironmentConnectionPhase, b: EnvironmentConnectionPhase) =>
      harness.registry.set(
        harness.environmentsAtom,
        new Map([
          [A, environment(a, aConfig)],
          [B, environment(b, bConfig)],
        ]),
      );

    // Both connected: the first in catalog order wins.
    expect(harness.cmdN()).toBe("chat.newWithoutProject");

    setEnvironments("offline", "connected");
    expect(harness.cmdN()).toBe("chat.newLocal");

    setEnvironments("offline", "offline");
    expect(harness.cmdN()).toBe("chat.new");

    // A primary appears while its config is loading; B is back but must not leak in.
    setEnvironments("offline", "connected");
    harness.registry.set(harness.primaryEnvironmentIdAtom, PRIMARY);
    expect(harness.cmdN()).toBe("chat.new");

    harness.registry.set(
      harness.primaryConfigAtom,
      config([{ key: "mod+n", command: "sidebar.toggle" }]),
    );
    expect(harness.cmdN()).toBe("sidebar.toggle");
  });
});
