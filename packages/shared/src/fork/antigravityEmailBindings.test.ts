import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitAccounts } from "../usageLimits.ts";

const antigravity = ProviderDriverKind.make("antigravity");
const checkedAt = "2026-09-03T11:00:00.000Z";
const window = {
  id: "gemini-weekly",
  kind: "weekly",
  label: "Gemini · Weekly",
  usedPercent: 20,
  windowDurationMins: 7 * 24 * 60,
} as const;
const limits = (identity: { credentialFingerprint?: string; credentialEmail?: string }) => ({
  checkedAt,
  windows: [window],
  ...identity,
});

type Reader =
  | {
      readonly kind: "native";
      readonly env: string;
      readonly name: string;
      readonly fp: string;
      readonly email?: string;
    }
  | {
      readonly kind: "hub";
      readonly env: string;
      readonly name: string;
      readonly fp?: string;
      readonly email?: string;
    };

const paired = (env: string, name: string, fp: string, email: string): Reader => ({
  kind: "native",
  env,
  name,
  fp,
  email,
});
const fingerprintOnly = (env: string, name: string, fp: string): Reader => ({
  kind: "native",
  env,
  name,
  fp,
});
const answeringHub = (env: string, name: string, fp: string): Reader => ({
  kind: "hub",
  env,
  name,
  fp,
});
const withholdingHub = (env: string, name: string, email: string): Reader => ({
  kind: "hub",
  env,
  name,
  email,
});

function accountsOf(readers: readonly Reader[]) {
  const presentations = new Map<
    EnvironmentId,
    {
      entry: { target: { label: string } };
      serverConfig: {
        providers: ServerProvider[];
        usageLimitSources: Array<{
          id: UsageLimitSourceId;
          kind: "cliproxy";
          label: string;
          checkedAt: string;
          accounts: UsageLimitSourceAccount[];
        }>;
      };
    }
  >();
  for (const reader of readers) {
    const environmentId = EnvironmentId.make(reader.env);
    const presentation = presentations.get(environmentId) ?? {
      entry: { target: { label: reader.env } },
      serverConfig: {
        providers: [],
        usageLimitSources: [
          {
            id: UsageLimitSourceId.make("hub"),
            kind: "cliproxy",
            label: "hub",
            checkedAt,
            accounts: [],
          },
        ],
      },
    };
    presentations.set(environmentId, presentation);
    if (reader.kind === "native") {
      presentation.serverConfig.providers.push({
        instanceId: ProviderInstanceId.make(reader.name),
        driver: antigravity,
        displayName: reader.name,
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt,
        models: [],
        slashCommands: [],
        skills: [],
        usageLimits: limits({
          credentialFingerprint: reader.fp,
          ...(reader.email ? { credentialEmail: reader.email } : {}),
        }),
      });
    } else {
      presentation.serverConfig.usageLimitSources[0]!.accounts.push({
        id: reader.name,
        driver: antigravity,
        ...(reader.email ? { label: reader.name, email: reader.email } : {}),
        usageLimits: limits(reader.fp ? { credentialFingerprint: reader.fp } : {}),
      });
    }
  }
  return collectLimitAccounts(presentations)
    .map((account) => `${account.displayName}${account.email ? ` <${account.email}>` : ""}`)
    .toSorted();
}

describe("Antigravity accounts identified by a Google fingerprint and e-mail pair", () => {
  it.each([
    {
      name: "a current login and a hub that withholds userinfo",
      readers: [
        paired("env-a", "local", "google-x", "x@example.com"),
        withholdingHub("env-a", "g1", "X@example.com"),
      ],
      accounts: ["g1 <X@example.com>"],
    },
    {
      name: "a current login, an older login, an answering hub and a withholding hub",
      readers: [
        paired("env-a", "local", "google-x", "x@example.com"),
        fingerprintOnly("env-b", "remote", "google-x"),
        answeringHub("env-b", "proxy", "google-x"),
        withholdingHub("env-a", "g1", "x@example.com"),
      ],
      accounts: ["g1 <x@example.com>"],
    },
    {
      name: "two Google accounts, each read every way",
      readers: [
        paired("env-a", "local-x", "google-x", "x@example.com"),
        paired("env-a", "local-y", "google-y", "y@example.com"),
        fingerprintOnly("env-b", "remote-x", "google-x"),
        fingerprintOnly("env-b", "remote-y", "google-y"),
        withholdingHub("env-a", "gx", "x@example.com"),
        withholdingHub("env-a", "gy", "y@example.com"),
      ],
      accounts: ["gx <x@example.com>", "gy <y@example.com>"],
    },
    {
      name: "one Google account whose e-mail changed between two machines",
      readers: [
        paired("env-a", "local", "google-x", "old@example.com"),
        paired("env-b", "local", "google-x", "new@example.com"),
      ],
      accounts: ["local"],
    },
    {
      name: "two fingerprints claiming one e-mail keep apart, and so does the hub listing it",
      readers: [
        paired("env-a", "local-x", "google-x", "same@example.com"),
        paired("env-b", "remote-y", "google-y", "same@example.com"),
        withholdingHub("env-a", "g1", "same@example.com"),
      ],
      accounts: ["g1 <same@example.com>", "local-x", "remote-y"],
    },
    {
      name: "an older login and a withholding hub, with no reader that knows both names",
      readers: [
        fingerprintOnly("env-a", "local", "google-x"),
        withholdingHub("env-a", "g1", "x@example.com"),
      ],
      accounts: ["g1 <x@example.com>", "local"],
    },
  ])("$name", ({ readers, accounts }) => {
    expect(accountsOf(readers)).toEqual(accounts);
    expect(accountsOf(readers.toReversed())).toEqual(accounts);
  });

  it("leaves other drivers keyed by e-mail first", () => {
    const opencode = ProviderDriverKind.make("opencode");
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("env-a"),
          {
            entry: { target: { label: "env-a" } },
            serverConfig: {
              providers: [
                {
                  instanceId: ProviderInstanceId.make("opencode"),
                  driver: opencode,
                  enabled: true,
                  installed: true,
                  version: null,
                  status: "ready",
                  auth: { status: "authenticated", email: "same@example.com" },
                  checkedAt,
                  models: [],
                  slashCommands: [],
                  skills: [],
                  usageLimits: limits({
                    credentialFingerprint: "key-a",
                    credentialEmail: "same@example.com",
                  }),
                },
              ],
              usageLimitSources: [
                {
                  id: UsageLimitSourceId.make("hub"),
                  kind: "cliproxy",
                  label: "hub",
                  checkedAt,
                  accounts: [
                    {
                      id: "go",
                      driver: opencode,
                      email: "same@example.com",
                      usageLimits: limits({}),
                    },
                  ],
                },
              ],
            },
          },
        ],
      ]),
    );
    expect(accounts).toHaveLength(1);
  });
});
