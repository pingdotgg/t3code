import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Alchemy";
import * as contacts from "@distilled.cloud/aws/ssm-contacts";
import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

import ContactsBindingsFunctionLive, {
  ContactsBindingsFunction,
} from "./bindings-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error union carries the
// tags the runtime bindings depend on. On an account that has not onboarded
// Incident Manager every ssm-contacts call fails with the synthetic
// `IncidentManagerNotOnboarded` tag (patched from the overloaded
// ValidationException "Account not found for the request"); once onboarded,
// a missing engagement/rotation/channel is a plain
// `ResourceNotFoundException`.
test.provider(
  "describeEngagement on a nonexistent engagement fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        contacts.describeEngagement({
          EngagementId: `arn:aws:ssm-contacts:${region}:${accountId}:engagement/alchemy-nonexistent-probe/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect([
        "ResourceNotFoundException",
        "IncidentManagerNotOnboarded",
      ]).toContain(error._tag);
    }),
);

test.provider(
  "listRotationShifts on a nonexistent rotation fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        contacts.listRotationShifts({
          RotationId: `arn:aws:ssm-contacts:${region}:${accountId}:rotation/alchemy-nonexistent-probe`,
          EndTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      );
      // AWS reports an unresolvable rotation ARN as a ValidationException
      // ("Invalid value provided - Invalid resource Arn ...") rather than a
      // ResourceNotFoundException — typed as InvalidRotationArn.
      expect([
        "ResourceNotFoundException",
        "IncidentManagerNotOnboarded",
        "InvalidRotationArn",
      ]).toContain(error._tag);
    }),
);

test.provider(
  "sendActivationCode on a nonexistent channel fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        contacts.sendActivationCode({
          ContactChannelId: `arn:aws:ssm-contacts:${region}:${accountId}:contact-channel/alchemy-nonexistent-probe/11111111-1111-1111-1111-111111111111`,
        }),
      );
      expect([
        "ResourceNotFoundException",
        "IncidentManagerNotOnboarded",
      ]).toContain(error._tag);
    }),
);

// The bindings fixture needs the account-wide Incident Manager replication
// set. AWS deprecated CreateReplicationSet on Nov 7, 2025, so only accounts
// that were already onboarded can run the fixture — return the replication
// set ARN, or `undefined` when the account cannot be onboarded.
const ensureReplicationSet = Effect.gen(function* () {
  const listed = yield* incidents.listReplicationSets({});
  let arn = listed.replicationSetArns[0];
  if (arn === undefined) {
    const { region } = yield* AWSEnvironment.current;
    const created = yield* Effect.result(
      incidents.createReplicationSet({ regions: { [region]: {} } }),
    );
    if (Result.isFailure(created)) {
      expect(created.failure._tag).toBe("UnsupportedOperationException");
      return undefined;
    }
    arn = created.success.arn;
  }
  const status = yield* incidents.getReplicationSet({ arn }).pipe(
    Effect.map((r) => r.replicationSet.status),
    Effect.repeat({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(60),
      ]),
      until: (status): boolean =>
        status !== "CREATING" && status !== "UPDATING",
    }),
  );
  expect(status).toBe("ACTIVE");
  return arn;
});

// The runtime-binding fixture needs real contacts, which need the
// account-wide Incident Manager replication set — gated like the resource
// lifecycle test (AWS deprecated CreateReplicationSet on Nov 7, 2025, so
// only already-onboarded accounts can run this).
test.provider.skipIf(!process.env.AWS_TEST_INCIDENT_MANAGER)(
  "bindings fixture: engagements, pages, rotation shifts, and overrides",
  (stack) =>
    Effect.gen(function* () {
      const replicationSetArn = yield* ensureReplicationSet;
      if (replicationSetArn === undefined) {
        yield* Effect.logInfo(
          "CreateReplicationSet is deprecated (Nov 7, 2025) and this account is not onboarded to Incident Manager — skipping the SSM Contacts bindings fixture",
        );
        return;
      }
      yield* stack.destroy();

      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ContactsBindingsFunction;
        }).pipe(Effect.provide(ContactsBindingsFunctionLive)),
      );
      expect(attrs.functionUrl).toBeTruthy();
      const baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const client = yield* HttpClient.HttpClient;
      const getJson = (path: string) =>
        client
          .get(`${baseUrl}${path}`)
          .pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? response.json
                : Effect.flatMap(response.text, (body) =>
                    Effect.fail(
                      new Error(`GET ${path} -> ${response.status}: ${body}`),
                    ),
                  ),
            ),
          );

      // Lambda URL cold-start + IAM propagation on the fresh policy.
      const bindings = (yield* getJson("/bindings").pipe(
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential("2 seconds"),
            Schedule.recurs(30),
          ]),
        }),
      )) as { bound: string[] };
      expect(bindings.bound).toHaveLength(19);

      const shifts = (yield* getJson("/shifts")) as {
        shifts: number;
        previewShifts: number;
      };
      expect(shifts.previewShifts).toBeGreaterThanOrEqual(0);

      const override = (yield* getJson("/override")) as {
        overrideId: string;
        newContactIds: string[];
        listed: number;
      };
      expect(override.overrideId).toBeTruthy();
      expect(override.listed).toBeGreaterThanOrEqual(1);

      const engage = (yield* getJson("/engage")) as {
        engagementArn: string;
        subject: string;
        pages: number;
      };
      expect(engage.engagementArn).toContain(":engagement/");
      expect(engage.subject).toBe("alchemy bindings fixture engagement");

      const pages = (yield* getJson("/pages")) as {
        engagements: number;
        pages: number;
      };
      expect(pages.engagements).toBeGreaterThanOrEqual(1);

      const channel = (yield* getJson("/channel")) as { ok: boolean };
      expect(channel.ok).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);
