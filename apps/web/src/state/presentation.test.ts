import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createEnvironmentServerConfigFlagAtoms } from "./presentation";

const A = EnvironmentId.make("a");
const B = EnvironmentId.make("b");
const config = (issues: boolean, serverVersion = "1") =>
  ({ environment: { capabilities: { issues }, serverVersion } }) as EnvironmentServerConfig;

describe("createEnvironmentServerConfigFlagAtoms", () => {
  it("notifies a row only when its own environment's flag changes", () => {
    const configs = Atom.make<ReadonlyMap<EnvironmentId, EnvironmentServerConfig>>(
      new Map([[B, config(false)]]),
    );
    const flags = createEnvironmentServerConfigFlagAtoms(configs);
    const registry = AtomRegistry.make();
    const notified: string[] = [];
    const stopPresence = registry.subscribe(flags.hasServerConfigAtom(A), (value) =>
      notified.push(`presence:${value}`),
    );
    const stopIssues = registry.subscribe(flags.issuesSupportedAtom(A), (value) =>
      notified.push(`issues:${value}`),
    );
    try {
      expect(registry.get(flags.hasServerConfigAtom(A))).toBe(false);
      expect(registry.get(flags.issuesSupportedAtom(A))).toBe(false);

      registry.set(configs, new Map([[B, config(true, "2")]]));
      expect(notified).toEqual([]);

      registry.set(
        configs,
        new Map([
          [A, config(false)],
          [B, config(true, "2")],
        ]),
      );
      expect(notified).toEqual(["presence:true"]);

      registry.set(
        configs,
        new Map([
          [A, config(false)],
          [B, config(false, "3")],
        ]),
      );
      expect(notified).toEqual(["presence:true"]);

      registry.set(
        configs,
        new Map([
          [A, config(true)],
          [B, config(false, "3")],
        ]),
      );
      expect(notified).toEqual(["presence:true", "issues:true"]);
    } finally {
      stopPresence();
      stopIssues();
      registry.dispose();
    }
  });
});
