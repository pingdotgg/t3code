import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { testName } from "../../names.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Account collection (pattern b): Gateway rules live under
// `/accounts/{id}/gateway/rules`. Deploy one rule, then resolve the provider
// with the typed `Provider.findProvider` helper and assert `list()` returns
// the exhaustively-paginated set hydrated into the exact `read` Attributes
// shape (so the deployed rule's id is present).
test.provider(
  "list enumerates the deployed Gateway rule",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const rule = yield* stack.deploy(
        Cloudflare.Gateway.Rule("ListRule", {
          name: testName("alchemy-zt-rule-list"),
          action: "block",
          filters: ["dns"],
          traffic: 'any(dns.domains[*] == "list-test.alchemy-test.example")',
          enabled: true,
        }),
      );

      expect(rule.ruleId).toBeTruthy();
      expect(rule.accountId).toEqual(accountId);

      const provider = yield* Provider.findProvider(Cloudflare.Gateway.Rule);
      const all = yield* provider.list();

      // The deployed rule appears in the exhaustively-paginated result, and the
      // hydrated element matches the `read` Attributes shape exactly.
      const found = all.find((r) => r.ruleId === rule.ruleId);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(accountId);
      expect(found?.action).toEqual("block");
      expect(found?.name).toEqual(testName("alchemy-zt-rule-list"));

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:gateway", "live"] },
);
