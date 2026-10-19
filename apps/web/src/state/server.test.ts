import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId, type KeybindingRule, type ServerConfig } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { Atom, AtomRegistry } from "effect/reactivity";
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
  it("updates shortcuts from the first connected, configured environment without a primary", () => {
    const harness = makeHarness({});
    const aConfig = config(STALE);
    const bConfig = config(SWAPPED);
    const edited = config([{ key: "mod+n", command: "sidebar.toggle" }]);
    expect(harness.cmdN()).toBe("chat.new");

    // One mounted consumer follows config loading, edits, disconnects and reconnects.
    for (const [a, b, command] of [
      [environment("offline", aConfig), environment("connected", bConfig), "chat.newLocal"],
      [environment("connected", null), environment("connected", bConfig), "chat.newLocal"],
      [
        environment("connected", aConfig),
        environment("connected", bConfig),
        "chat.newWithoutProject",
      ],
      [environment("connected", edited), environment("connected", bConfig), "sidebar.toggle"],
      [environment("offline", edited), environment("connected", bConfig), "chat.newLocal"],
      [environment("offline", edited), environment("offline", bConfig), "chat.new"],
      [environment("reconnecting", edited), environment("offline", bConfig), "chat.new"],
      [
        environment("connected", aConfig),
        environment("offline", bConfig),
        "chat.newWithoutProject",
      ],
    ] as const) {
      harness.registry.set(
        harness.environmentsAtom,
        new Map([
          [A, a],
          [B, b],
        ]),
      );
      expect(harness.cmdN()).toBe(command);
    }
  });

  it("uses the primary config or defaults until the primary is removed", () => {
    const harness = makeHarness({
      environments: [[B, environment("connected", config(SWAPPED))]],
    });
    expect(harness.cmdN()).toBe("chat.newLocal");

    harness.registry.set(harness.primaryEnvironmentIdAtom, PRIMARY);
    expect(harness.cmdN()).toBe("chat.new");

    harness.registry.set(harness.primaryConfigAtom, config(STALE));
    expect(harness.cmdN()).toBe("chat.newWithoutProject");

    harness.registry.set(harness.primaryConfigAtom, null);
    expect(harness.cmdN()).toBe("chat.new");

    harness.registry.set(harness.primaryEnvironmentIdAtom, null);
    expect(harness.cmdN()).toBe("chat.newLocal");
  });

  it.each([false, true])(
    "preserves the bindings array through unrelated updates (primary: %s)",
    (hasPrimary) => {
      const selected = config(SWAPPED);
      const harness = makeHarness({
        primaryEnvironmentId: hasPrimary ? PRIMARY : null,
        primaryConfig: hasPrimary ? selected : null,
        environments: [
          [A, environment("connected", selected)],
          [B, environment("connected", config(STALE))],
        ],
      });
      expect(harness.cmdN()).toBe("chat.newLocal");
      const before = harness.keybindings();

      harness.registry.set(
        harness.environmentsAtom,
        new Map([
          [A, environment("connected", { ...selected, providers: [] })],
          [B, environment("connected", config([]))],
        ]),
      );
      expect(harness.keybindings()).toBe(before);

      if (hasPrimary) {
        harness.registry.set(harness.primaryConfigAtom, { ...selected, providers: [] });
        expect(harness.keybindings()).toBe(before);
      }
    },
  );
});
