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
  it("keeps only the authenticated effective login when CLI accounts are overridden", () => {
    const accounts = verifiedSourceControlAccounts({
      versionControlSystems: [],
      sourceControlProviders: [
        provider({
          status: "authenticated",
          account: Option.some("EtanHey"),
          host: Option.some("github.com"),
          detail: Option.none(),
          accounts: [
            { host: "github.com", account: "personal", active: true, authenticated: true },
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
    expect(accounts).toEqual([{ host: "github.com", account: "EtanHey" }]);
  });
});
