import { ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { secretProviderUses } from "./SecretsSettings.logic";

const personal = (reference: string) => ({ provider: "personal", reference });
const work = { provider: "work", reference: "op://Work/token" };

const settings = Schema.decodeSync(ServerSettings)({
  providerInstances: {
    antigravity_work: {
      driver: "antigravity",
      displayName: "Antigravity Work",
      environment: [
        { name: "API_TOKEN", value: "", secret: personal("op://a/env") },
        { name: "OTHER_TOKEN", value: "", secret: work },
      ],
    },
    codex_plain: {
      driver: "codex",
      environment: [{ name: "CODEX_TOKEN", value: "", secret: personal("op://c/env") }],
    },
  },
  sourceControlHosts: {
    github: { tokens: { "github.com": personal("op://gh"), "ghe.acme.test": work } },
  },
  usageLimitSources: {
    hub: { kind: "cliproxy", url: "https://hub.test", managementKey: personal("op://hub") },
  },
  easDeviceHosts: [
    { kind: "eas", id: "eas", label: "EAS Simulator", accessToken: personal("op://expo") },
  ],
  cloudSpeechCredentials: { openai: personal("op://voice"), xai: "" },
});

it.each([
  [
    "personal",
    [
      "Antigravity Work · API_TOKEN",
      "Codex · CODEX_TOKEN",
      "GitHub · github.com",
      "https://hub.test · Management Key",
      "EAS Simulator · Access Token",
      "Voice · OpenAI",
    ],
  ],
  ["work", ["Antigravity Work · OTHER_TOKEN", "GitHub · ghe.acme.test"]],
  ["unused", []],
])("lists what reads from secret provider %s", (providerId, uses) => {
  expect(secretProviderUses(settings, providerId).map((use) => use.label)).toEqual(uses);
});
