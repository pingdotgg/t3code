import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import {
  ActiveReceiptRuleSet,
  EmailIdentity,
  ReceiptRule,
  ReceiptRuleSet,
} from "@/AWS/SES";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as ses from "@distilled.cloud/aws/ses";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

// End-to-end email receiving: verified domain + MX -> SES inbound -> receipt
// rule -> S3. The loop is fully automatable (the SES sandbox allows sends both
// FROM and TO a verified domain identity, and receiving itself never requires
// verification), but Easy-DKIM detection takes minutes and the suite needs the
// standing Cloudflare test zone + Cloudflare credentials — so the test is
// env-gated per the speed doctrine. Run with:
//
//   AWS_TEST_SES_RECEIVING=1 bun run test test/AWS/SES/Receiving.smoke.test.ts --profile testing
const GATED = !process.env.AWS_TEST_SES_RECEIVING;

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
// SES receiving is regional; the testing profile deploys to us-west-2 (one of
// the receiving-supported regions).
const region = process.env.AWS_TEST_SES_RECEIVING_REGION ?? "us-west-2";

// Deterministic names — same on every run, disjoint from other suites.
const domain = `ses-rcv-e2e.${zoneName}`;
const recipient = `inbox@${domain}`;
const SUBJECT_MARKER = "alchemy-ses-receiving-e2e";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

const activeRuleSetName = ses
  .describeActiveReceiptRuleSet({})
  .pipe(Effect.map((response) => response.Metadata?.Name));

// Mutates the account-singleton active receipt rule set: exclusive, and the
// previously active set (if any) is captured and restored.
test.provider.skipIf(GATED)(
  "end-to-end receive: MX -> SES inbound -> receipt rule -> S3 object",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const { Account } = yield* sts.getCallerIdentity({});
      const bucketName = `alchemy-ses-rcv-e2e-${Account}`;
      const captured = yield* activeRuleSetName;

      yield* Effect.gen(function* () {
        yield* stack.destroy();

        yield* stack.deploy(
          Effect.gen(function* () {
            // Domain identity; Easy DKIM CNAMEs published to the test zone
            // verify it for the sandbox send below. Receiving itself does not
            // require verification.
            const identity = yield* EmailIdentity("RcvIdentity", {
              emailIdentity: domain,
            });
            const dkim = (index: number) =>
              Output.all(identity.dkimTokens).pipe(
                Output.map(([tokens]) => tokens[index]!),
              );
            // DNS records carry no ownership tags, so adopt-by-name is the
            // standing-zone convention (see DnsRecord.test.ts) — it also
            // converges over records orphaned by an interrupted run.
            for (const index of [0, 1, 2]) {
              yield* Cloudflare.DNS.Record(`Dkim${index}`, {
                zoneId,
                name: dkim(index).pipe(
                  Output.map((token) => `${token}._domainkey.${domain}`),
                ),
                type: "CNAME",
                content: dkim(index).pipe(
                  Output.map((token) => `${token}.dkim.amazonses.com`),
                ),
                ttl: 60,
              }).pipe(adopt(true));
            }

            // Route the subdomain's mail to SES inbound.
            yield* Cloudflare.DNS.Record("Mx", {
              zoneId,
              name: domain,
              type: "MX",
              content: `inbound-smtp.${region}.amazonaws.com`,
              priority: 10,
              ttl: 60,
            }).pipe(adopt(true));

            // Inbound bucket. SES receiving writes via the bucket policy (no
            // IAM role involved), so the policy must grant ses.amazonaws.com
            // before the receipt rule below validates it.
            const bucket = yield* AWS.S3.Bucket("RcvBucket", {
              bucketName,
              forceDestroy: true,
              policy: [
                {
                  Sid: "AllowSESPuts",
                  Effect: "Allow",
                  Principal: { Service: "ses.amazonaws.com" },
                  Action: ["s3:PutObject"],
                  Resource: `arn:aws:s3:::${bucketName}/*`,
                  Condition: {
                    StringEquals: { "aws:SourceAccount": Account! },
                  },
                },
              ],
            });

            const ruleSet = yield* ReceiptRuleSet("RcvSet", {});
            yield* ReceiptRule("RcvRule", {
              ruleSetName: ruleSet.ruleSetName,
              recipients: [domain],
              scanEnabled: true,
              actions: [
                {
                  S3Action: {
                    // Reference the output (not the literal) so the rule
                    // deploys after the bucket + policy exist — SES validates
                    // the grant at createReceiptRule time.
                    BucketName: bucket.bucketName,
                    ObjectKeyPrefix: "inbound/",
                  },
                },
              ],
            });
            yield* ActiveReceiptRuleSet("RcvActive", {
              ruleSetName: ruleSet.ruleSetName,
            });
          }),
        );

        // Wait for Easy DKIM detection (SES polls the published CNAMEs;
        // typically 1-3 minutes with Cloudflare's fast propagation).
        const verified = yield* sesv2
          .getEmailIdentity({ EmailIdentity: domain })
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (identity): boolean =>
                identity.DkimAttributes?.Status === "SUCCESS",
              times: 48,
            }),
          );
        expect(verified.DkimAttributes?.Status).toBe("SUCCESS");

        // The first delivery attempt can hard-bounce while SES inbound is
        // still propagating the freshly activated rule set — and a hard
        // bounce auto-adds the recipient to the ACCOUNT-level suppression
        // list, silently swallowing every later send (the entry outlives
        // stack.destroy(), so it would poison reruns too). Clear it before
        // each attempt and re-send in bounded rounds until the marked
        // message lands.
        const unsuppress = sesv2
          .deleteSuppressedDestination({ EmailAddress: recipient })
          .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

        // A bounced first attempt also routes the MAILER-DAEMON bounce back
        // through the rule into the bucket, so match the marker subject in
        // the raw message rather than counting objects.
        const findMarked = Effect.gen(function* () {
          const listing = yield* s3.listObjectsV2({
            Bucket: bucketName,
            Prefix: "inbound/",
          });
          const keys = (listing.Contents ?? [])
            .map((object) => object.Key!)
            .filter((key) => !key.includes("AMAZON_SES_SETUP_NOTIFICATION"));
          for (const key of keys) {
            const raw = yield* s3
              .getObject({ Bucket: bucketName, Key: key })
              .pipe(
                Effect.flatMap((object) =>
                  Stream.mkString(Stream.decodeText(object.Body!)),
                ),
              );
            if (raw.includes(`Subject: ${SUBJECT_MARKER}`)) return raw;
          }
          return undefined;
        });

        const attemptDelivery = Effect.gen(function* () {
          yield* unsuppress;
          // Sandbox allows both legs because the domain identity is now
          // verified; verification propagates eventually, so retry the typed
          // MessageRejected briefly.
          yield* sesv2
            .sendEmail({
              FromEmailAddress: `sender@${domain}`,
              Destination: { ToAddresses: [recipient] },
              Content: {
                Simple: {
                  Subject: { Data: SUBJECT_MARKER },
                  Body: {
                    Text: { Data: "Round trip through SES email receiving." },
                  },
                },
              },
            })
            .pipe(
              Effect.retry({
                while: (error) => error._tag === "MessageRejected",
                schedule: Schedule.max([
                  Schedule.spaced("5 seconds"),
                  Schedule.recurs(12),
                ]),
              }),
            );
          return yield* findMarked.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (raw): boolean => raw !== undefined,
              times: 12,
            }),
          );
        });

        const raw = yield* attemptDelivery.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (found): boolean => found !== undefined,
            times: 4,
          }),
        );
        expect(raw).toBeDefined();
        expect(raw).toContain(`Subject: ${SUBJECT_MARKER}`);
        expect(raw).toContain(`To: ${recipient}`);

        yield* stack.destroy();
      }).pipe(
        Effect.ensuring(
          Effect.all([
            captured
              ? ses
                  .setActiveReceiptRuleSet({ RuleSetName: captured })
                  .pipe(Effect.ignore)
              : Effect.void,
            // Leave the account suppression list the way we found it.
            sesv2
              .deleteSuppressedDestination({ EmailAddress: recipient })
              .pipe(Effect.ignore),
          ]),
        ),
      );
    }),
  { timeout: 900_000, exclusive: true },
);
