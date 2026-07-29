import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Resource Sharing writes are permission-gated and require a *second* account
// or organization as recipient. On the standard testing account every write
// under /accounts/{id}/shares fails with the typed `Forbidden` error, but the
// read path (list shares + list recipients per share) succeeds. The deploy
// test is therefore gated behind an env var pointing at a recipient account;
// the read-only `list()` assertion always runs.
const recipientAccountId =
  process.env.CLOUDFLARE_TEST_SHARE_RECIPIENT_ACCOUNT_ID;

test.provider(
  "list() enumerates share recipients across the account's sent shares",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Parent fan-out: list() enumerates the account's sent shares and then
      // every recipient within each share. On a write-blocked account there
      // may be zero shares — the result is still a well-typed array.
      const provider = yield* Provider.findProvider(
        Cloudflare.ResourceSharing.ShareRecipient,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const r of all) {
        expect(typeof r.recipientId).toBe("string");
        expect(typeof r.shareId).toBe("string");
        expect(typeof r.recipientAccountId).toBe("string");
        expect(r.associationStatus).not.toEqual("disassociated");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!recipientAccountId)(
  "list() includes a freshly deployed ShareRecipient",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const recipient = recipientAccountId!;

      yield* stack.destroy();

      const policy = yield* stack.deploy(
        Cloudflare.Gateway.Rule("RecipientListPolicy", {
          action: "block",
          traffic: 'dns.fqdn == "recipient-list.alchemy-test.example"',
          filters: ["dns"],
          enabled: false,
        }),
      );

      const share = yield* stack.deploy(
        Cloudflare.ResourceSharing.Share("RecipientListShare", {
          name: "alchemy-recipient-list-share",
          recipients: [],
          resources: [
            { resourceType: "gateway-policy", resourceId: policy.ruleId },
          ],
        }),
      );

      const deployed = yield* stack.deploy(
        Cloudflare.ResourceSharing.ShareRecipient("RecipientListEntry", {
          shareId: share.shareId,
          accountId: recipient,
        }),
      );
      expect(deployed.recipientId).toBeTruthy();
      expect(deployed.accountId).toEqual(accountId);

      const provider = yield* Provider.findProvider(
        Cloudflare.ResourceSharing.ShareRecipient,
      );
      const all = yield* provider.list();

      expect(all.some((r) => r.recipientId === deployed.recipientId)).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
