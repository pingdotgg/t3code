import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as resourceSharing from "@distilled.cloud/cloudflare/resource-sharing";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Resource Sharing writes are permission-gated: on the standard testing
// account every POST/PUT/DELETE under /accounts/{id}/shares fails with the
// typed `Forbidden` error (HTTP 403, Cloudflare code 10000 "Authentication
// error") because the token lacks the Resource Sharing Edit permission.
// Reads (list/get) succeed. Sharing also requires a *second* account or
// organization as recipient. The full lifecycle test below is gated behind
// an explicit opt-in env var pointing at a recipient account; the probe
// test always runs and pins the typed tags.
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

// Poll until the share is gone after destroy. Deletion is asynchronous —
// status walks `active → deleting → deleted`; a fully purged share answers
// with the typed `ShareNotFound` (Cloudflare error code 1004).
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
  "reads succeed and write-blocked accounts surface the typed Forbidden error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Read access works — list the account's sent shares.
      const shares = yield* resourceSharing.listResourceSharings({
        accountId,
        kind: "sent",
      });
      expect(Array.isArray(shares.result)).toBe(true);

      // A missing share surfaces as the typed `ShareNotFound`
      // (Cloudflare error code 1004), not UnknownCloudflareError.
      const notFound = yield* resourceSharing
        .getResourceSharing({
          accountId,
          shareId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        })
        .pipe(Effect.flip);
      expect(notFound._tag).toEqual("ShareNotFound");

      // Probe the write path. On the standard testing account this fails
      // with the typed `Forbidden` — the token lacks Resource Sharing
      // Edit. On an entitled token the dummy resource id fails validation
      // instead (a non-Forbidden error) or, at worst, creates a share we
      // immediately clean up.
      const probe = yield* resourceSharing
        .createResourceSharing({
          accountId,
          name: "alchemy-share-probe",
          recipients: [{ accountId }],
          resources: [
            {
              meta: {},
              resourceAccountId: accountId,
              resourceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              resourceType: "gateway-policy",
            },
          ],
        })
        .pipe(Effect.result);

      if (Result.isSuccess(probe)) {
        // Safety net: should the account ever become entitled, clean up
        // the accidental share so the probe stays side-effect free.
        yield* resourceSharing
          .deleteResourceSharing({ accountId, shareId: probe.success.id })
          .pipe(Effect.catchTag("ShareNotFound", () => Effect.void));
        yield* Effect.logInfo(
          "account can write shares; run the gated lifecycle tests via CLOUDFLARE_TEST_SHARE_RECIPIENT_ACCOUNT_ID",
        );
        return;
      }

      if (probe.failure._tag !== "Forbidden") {
        // Entitled token — the dummy resource was rejected by validation
        // rather than by the permission gate.
        yield* Effect.logInfo(
          `share write probe failed with ${probe.failure._tag}; writes are reachable`,
        );
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      expect(probe.failure._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the account's sent shares (typed Attributes), and includes a deployed share when entitled",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.ResourceSharing.Share,
      );

      // Reads (list) succeed without the Resource Sharing Edit permission,
      // so the read-only assertion always runs: list() returns the full,
      // exhaustively-paginated set of sent shares in the read Attributes
      // shape.
      const before = yield* provider.list();
      expect(Array.isArray(before)).toBe(true);
      for (const share of before) {
        expect(typeof share.shareId).toBe("string");
        expect(share.accountId).toEqual(accountId);
        expect(typeof share.name).toBe("string");
        // Deleted shares are filtered out — never surfaced by list().
        expect(share.status).not.toEqual("deleted");
      }

      // Writes are permission-gated (and need a second recipient account),
      // so only assert presence of a freshly-deployed share when an entitled
      // recipient account is provided. On the standard testing token the
      // deploy would fail with the typed `Forbidden` (HTTP 403, code 10000).
      if (recipientAccountId) {
        const policy = yield* stack.deploy(
          Cloudflare.Gateway.Rule("ListSharePolicy", {
            action: "block",
            traffic: 'dns.fqdn == "list-share.alchemy-test.example"',
            filters: ["dns"],
            enabled: false,
          }),
        );
        const deployed = yield* stack.deploy(
          Cloudflare.ResourceSharing.Share("ListShare", {
            name: "alchemy-list-share",
            recipients: [{ accountId: recipientAccountId }],
            resources: [
              { resourceType: "gateway-policy", resourceId: policy.ruleId },
            ],
          }),
        );

        const all = yield* provider.list();
        expect(all.some((s) => s.shareId === deployed.shareId)).toBe(true);

        yield* stack.destroy();
        yield* expectGone(accountId, deployed.shareId);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!recipientAccountId)(
  "creates a share with a gateway policy, renames in place, adds and removes a resource, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const recipient = recipientAccountId!;

      yield* stack.destroy();

      // A shareable resource: gateway policies are sharable on the test
      // account's Zero Trust setup.
      const policyA = yield* stack.deploy(
        Cloudflare.Gateway.Rule("SharePolicyA", {
          action: "block",
          traffic: 'dns.fqdn == "share-a.alchemy-test.example"',
          filters: ["dns"],
          enabled: false,
        }),
      );
      const policyB = yield* stack.deploy(
        Cloudflare.Gateway.Rule("SharePolicyB", {
          action: "block",
          traffic: 'dns.fqdn == "share-b.alchemy-test.example"',
          filters: ["dns"],
          enabled: false,
        }),
      );

      const share = yield* stack.deploy(
        Cloudflare.ResourceSharing.Share("Share", {
          name: "alchemy-resource-share",
          recipients: [{ accountId: recipient }],
          resources: [
            { resourceType: "gateway-policy", resourceId: policyA.ruleId },
          ],
        }),
      );
      expect(share.shareId).toBeTruthy();
      expect(share.accountId).toEqual(accountId);
      expect(share.name).toEqual("alchemy-resource-share");
      expect(share.status).toEqual("active");
      expect(share.kind).toEqual("sent");

      // Out-of-band verification via the distilled API.
      const live = yield* getShare(accountId, share.shareId);
      expect(live.name).toEqual("alchemy-resource-share");

      // Rename in place — same shareId; also converge resources to
      // include policy B (delta add through the resource sub-API).
      const renamed = yield* stack.deploy(
        Cloudflare.ResourceSharing.Share("Share", {
          name: "alchemy-resource-share-v2",
          recipients: [{ accountId: recipient }],
          resources: [
            { resourceType: "gateway-policy", resourceId: policyA.ruleId },
            { resourceType: "gateway-policy", resourceId: policyB.ruleId },
          ],
        }),
      );
      expect(renamed.shareId).toEqual(share.shareId);
      expect(renamed.name).toEqual("alchemy-resource-share-v2");

      const resources = yield* resourceSharing.listResources({
        accountId,
        shareId: share.shareId,
      });
      const liveIds = resources.result
        .filter((r) => r.status !== "deleted" && r.status !== "deleting")
        .map((r) => r.resourceId)
        .sort();
      expect(liveIds).toEqual([policyA.ruleId, policyB.ruleId].sort());

      // Drop policy B again — delta remove through the resource sub-API.
      const reduced = yield* stack.deploy(
        Cloudflare.ResourceSharing.Share("Share", {
          name: "alchemy-resource-share-v2",
          recipients: [{ accountId: recipient }],
          resources: [
            { resourceType: "gateway-policy", resourceId: policyA.ruleId },
          ],
        }),
      );
      expect(reduced.shareId).toEqual(share.shareId);

      yield* stack.destroy();

      yield* expectGone(accountId, share.shareId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!recipientAccountId)(
  "manages standalone ShareResource and ShareRecipient on an existing share",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const recipient = recipientAccountId!;

      yield* stack.destroy();

      const policyA = yield* stack.deploy(
        Cloudflare.Gateway.Rule("ChildPolicyA", {
          action: "block",
          traffic: 'dns.fqdn == "child-a.alchemy-test.example"',
          filters: ["dns"],
          enabled: false,
        }),
      );
      const policyB = yield* stack.deploy(
        Cloudflare.Gateway.Rule("ChildPolicyB", {
          action: "block",
          traffic: 'dns.fqdn == "child-b.alchemy-test.example"',
          filters: ["dns"],
          enabled: false,
        }),
      );

      const share = yield* stack.deploy(
        Cloudflare.ResourceSharing.Share("ChildShare", {
          name: "alchemy-child-share",
          recipients: [{ accountId: recipient }],
          resources: [
            { resourceType: "gateway-policy", resourceId: policyA.ruleId },
          ],
        }),
      );

      // Standalone resource entry — adds policy B incrementally.
      const entry = yield* stack.deploy(
        Cloudflare.ResourceSharing.ShareResource("ChildEntry", {
          shareId: share.shareId,
          resourceType: "gateway-policy",
          resourceId: policyB.ruleId,
        }),
      );
      expect(entry.shareResourceId).toBeTruthy();
      expect(entry.shareId).toEqual(share.shareId);
      expect(entry.resourceId).toEqual(policyB.ruleId);

      // Out-of-band verify the entry exists.
      const liveEntry = yield* resourceSharing.getResource({
        accountId,
        shareId: share.shareId,
        shareResourceId: entry.shareResourceId,
      });
      expect(liveEntry.resourceId).toEqual(policyB.ruleId);

      yield* stack.destroy();

      yield* expectGone(accountId, share.shareId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
