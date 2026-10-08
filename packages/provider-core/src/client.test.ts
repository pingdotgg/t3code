import { ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { defineProviderClient, makeProviderClientRegistry } from "./client.ts";

const settingsSchema = Schema.Struct({ binaryPath: Schema.String });

describe("makeProviderClientRegistry", () => {
  it("looks definitions up by driver kind and keeps unknown drivers undefined", () => {
    const codex = defineProviderClient({
      driverKind: ProviderDriverKind.make("codex"),
      label: "Codex",
      settingsSchema,
    });
    const registry = makeProviderClientRegistry([codex]);

    expect(registry.get(ProviderDriverKind.make("codex"))).toBe(codex);
    expect(registry.get(ProviderDriverKind.make("forkDriver"))).toBeUndefined();
    expect(registry.get(undefined)).toBeUndefined();
  });

  it("rejects two definitions for one driver kind", () => {
    const definition = defineProviderClient({
      driverKind: ProviderDriverKind.make("codex"),
      label: "Codex",
      settingsSchema,
    });

    expect(() => makeProviderClientRegistry([definition, definition])).toThrow(
      "Provider driver 'codex' is defined more than once.",
    );
  });
});
