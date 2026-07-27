import * as AWS from "@/AWS";
import { AccountAlias } from "@/AWS/IAM/AccountAlias.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (account singleton): an AWS account has at most one
// alias, so `list()` returns a one-element array (the single alias) or `[]`.
//
// Setting/deleting the account alias is account-wide and disruptive — it would
// clobber whatever alias the account already has — so this is an UNGATED probe
// that only observes: it calls `list()` and asserts a well-formed result
// (length 0 or 1, with the full `{ accountAlias }` Attributes shape when set).
test.provider("list enumerates the account alias singleton", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(AccountAlias);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeLessThanOrEqual(1);
    for (const item of all) {
      expect(typeof item.accountAlias).toBe("string");
      expect(item.accountAlias.length).toBeGreaterThan(0);
    }
  }),
);
