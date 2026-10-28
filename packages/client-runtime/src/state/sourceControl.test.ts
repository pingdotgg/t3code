import { SourceControlProviderKind, type SourceControlProviderAuth } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { verifiedSourceControlAccounts } from "./sourceControl.ts";

const provider = (auth: SourceControlProviderAuth) => ({
  kind: SourceControlProviderKind.make("github"),
  label: "GitHub",
  status: "available" as const,
  version: Option.none(),
  installHint: "Install gh",
  detail: Option.none(),
  auth,
});

describe("verifiedSourceControlAccounts", () => {
  it("keeps the effective login and each host's active signed-in account only", () => {
    const accounts = verifiedSourceControlAccounts({
      versionControlSystems: [],
      sourceControlProviders: [
        provider({
          status: "authenticated",
          account: Option.some("EtanHey"),
          host: Option.some("github.com"),
          detail: Option.none(),
          accounts: [
            { host: "github.com", account: "EtanHey", active: true, authenticated: true },
            { host: "github.com", account: "alt", active: false, authenticated: true },
            { host: "ghe.example.com", account: "etan", active: true, authenticated: true },
            { host: "ghe.other.com", account: "expired", active: true, authenticated: false },
          ],
        }),
        provider({
          status: "unknown",
          account: Option.some("unverified"),
          host: Option.some("gitlab.com"),
          detail: Option.none(),
        }),
      ],
    });
    expect(accounts).toEqual([
      { host: "github.com", account: "EtanHey" },
      { host: "github.com", account: "EtanHey" },
      { host: "ghe.example.com", account: "etan" },
    ]);
  });
});
