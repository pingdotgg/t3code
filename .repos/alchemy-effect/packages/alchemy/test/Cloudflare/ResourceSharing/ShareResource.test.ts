import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as resourceSharing from "@distilled.cloud/cloudflare/resource-sharing";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Resource Sharing writes are permission-gated: on the standard testing
// account every POST/PUT/DELETE under /accounts/{id}/shares fails with the
// typed `Forbidden` error (HTTP 403, Cloudflare code 10000). Reads
// (list/get) succeed. Sharing also requires a *second* account/organization
// as recipient. The deploy half of the list test is gated behind an explicit
// opt-in env var pointing at a recipient account; the read-only list
// assertion always runs.
const recipientAccountId =
  process.env.CLOUDFLARE_TEST_SHARE_RECIPIENT_ACCOUNT_ID;

const getShare = (accountId: string, shareId: string) =>
  resourceSharing.getResourceSharing({ accountId, shareId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// Poll until the share is gone after destroy — deletion is asynchronous
// (`active → deleting → deleted`); a fully purged share answers with the
// typed `ShareNotFound` (Cloudflare error code 1004).
const expectGone = (accountId: string, shareId: string) =>
  getShare(accountId, shareId).pipe(
    Effect.flatMap((share) =>
      share.status === "deleting" || share.status === "deleted"
        ? Effect.void
        : Effect.fail({ _tag: "ShareNotDeleted" } as const),
    ),
    Effect.catchTag("ShareNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ShareNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "list enumerates share resources across the account's sent shares (typed Attributes), and includes a deployed entry when entitled",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.ResourceSharing.ShareResource,
      );

      // Reads (list) succeed without the Resource Sharing Edit permission, so
      // the read-only assertion always runs: list() fans out over every sent
      // share and returns the exhaustively-paginated resource entries in the
      // read Attributes shape. On a non-entitled account with no sent shares
      // this is a well-typed `[]`.
      const before = yield* provider.list();
      expect(Array.isArray(before)).toBe(true);
      for (const entry of before) {
        expect(typeof entry.shareResourceId).toBe("string");
        expect(entry.accountId).toEqual(accountId);
        expect(typeof entry.shareId).toBe("string");
        expect(typeof entry.resourceId).toBe("string");
        // Deleted / deleting entries are filtered out — never surfaced.
        expect(entry.status).not.toEqual("deleted");
        expect(entry.status).not.toEqual("deleting");
      }

      // Writes are permission-gated (and need a second recipient account), so
      // only assert presence of a freshly-deployed entry when an entitled
      // recipient account is provided. On the standard testing token the
      // deploy would fail with the typed `Forbidden` (HTTP 403, code 10000).
      if (recipientAccountId) {
        const policyA = yield* stack.deploy(
          Cloudflare.Gateway.Rule("ListEntryPolicyA", {
            action: "block",
            traffic: 'dns.fqdn == "list-entry-a.alchemy-test.example"',
            filters: ["dns"],
            enabled: false,
          }),
        );
        const policyB = yield* stack.deploy(
          Cloudflare.Gateway.Rule("ListEntryPolicyB", {
            action: "block",
            traffic: 'dns.fqdn == "list-entry-b.alchemy-test.example"',
            filters: ["dns"],
            enabled: false,
          }),
        );

        const share = yield* stack.deploy(
          Cloudflare.ResourceSharing.Share("ListEntryShare", {
            name: "alchemy-list-entry-share",
            recipients: [{ accountId: recipientAccountId }],
            resources: [
              { resourceType: "gateway-policy", resourceId: policyA.ruleId },
            ],
          }),
        );

        const entry = yield* stack.deploy(
          Cloudflare.ResourceSharing.ShareResource("ListEntry", {
            shareId: share.shareId,
            resourceType: "gateway-policy",
            resourceId: policyB.ruleId,
          }),
        );

        const all = yield* provider.list();
        expect(
          all.some((e) => e.shareResourceId === entry.shareResourceId),
        ).toBe(true);
        // The deployed entry surfaces in the read Attributes shape.
        const found = all.find(
          (e) => e.shareResourceId === entry.shareResourceId,
        )!;
        expect(found.shareId).toEqual(share.shareId);
        expect(found.resourceId).toEqual(policyB.ruleId);

        yield* stack.destroy();
        yield* expectGone(accountId, share.shareId);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
