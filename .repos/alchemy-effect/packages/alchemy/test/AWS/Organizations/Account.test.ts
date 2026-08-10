import * as AWS from "@/AWS";
import { Account } from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Organizations APIs require the caller to be the MANAGEMENT account of an AWS
// Organization, and creating member accounts is slow + irreversible. So this is
// a read-only `list()` test: resolve the typed provider, call `list()`, and
// assert it returns a well-typed `Attributes[]` (the same shape `read`
// produces).
//
// `list()` catches `AWSOrganizationsNotInUseException` and returns `[]` when the
// testing account is not an organization management account, so this passes on a
// standalone account too. When run against a management account
// (`AWS_TEST_ORG_MANAGEMENT=1`) it additionally asserts at least one account
// (the management account itself) appears.
test.provider("list enumerates organization accounts", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Account);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const account of all) {
      expect(typeof account.accountId).toBe("string");
      expect(typeof account.accountArn).toBe("string");
      expect(account.tags).toBeDefined();
    }

    if (process.env.AWS_TEST_ORG_MANAGEMENT) {
      expect(all.length).toBeGreaterThan(0);
    }
  }),
);
