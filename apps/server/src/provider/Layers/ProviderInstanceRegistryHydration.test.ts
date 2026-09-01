import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const claudedId = ProviderInstanceId.make("clauded");
const dodexId = ProviderInstanceId.make("dodex");

it("adds Clauded and Dodex aliases only when requested", () => {
  const settings = DEFAULT_SERVER_SETTINGS;
  const withoutAliases = deriveProviderInstanceConfigMap(settings);
  assert.equal(withoutAliases[claudedId], undefined);
  assert.equal(withoutAliases[dodexId], undefined);

  const withAliases = deriveProviderInstanceConfigMap(settings, {
    includeHarnessAliases: true,
  });
  assert.deepEqual(withAliases[claudedId], {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Clauded",
    config: { binaryPath: "clauded", homePath: "~/.clauded" },
  });
  assert.deepEqual(withAliases[dodexId], {
    driver: ProviderDriverKind.make("codex"),
    displayName: "Dodex",
    config: { binaryPath: "dodex", homePath: "~/.dodex" },
  });
});

it("preserves explicit alias configuration", () => {
  const explicitClauded = {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "My Clauded",
    enabled: false,
    config: { binaryPath: "/custom/clauded", homePath: "/custom/home" },
  } as const;
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      clauded: explicitClauded,
    },
  };
  const map = deriveProviderInstanceConfigMap(settings, { includeHarnessAliases: true });
  assert.deepEqual(map[claudedId], explicitClauded);
  assert.deepEqual(map[dodexId]?.config, { binaryPath: "dodex", homePath: "~/.dodex" });
});
