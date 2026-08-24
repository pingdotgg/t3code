import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import AppIntegrationsTestFunctionLive, {
  AppIntegrationsTestFunction,
} from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AppIntegrationsBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

const getJson = <T>(pathname: string) =>
  HttpClient.get(`${baseUrl}${pathname}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new Error(`unexpected status ${response.status}`)),
    ),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as T),
    // First requests after deploy can hit IAM-propagation AccessDenied
    // surfaced as a 500 by the fixture's orDie — bounded retry.
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

const postJson = <T>(pathname: string) =>
  HttpClient.post(`${baseUrl}${pathname}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new Error(`unexpected status ${response.status}`)),
    ),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as T),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

describe("AppIntegrations Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AppIntegrationsTestFunction;
        }).pipe(Effect.provide(AppIntegrationsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/applications`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("ListApplications", () => {
    test.provider("lists the fixture application", () =>
      Effect.gen(function* () {
        const body = yield* getJson<{
          self: string;
          applications: { Id?: string }[];
        }>("/applications");
        expect(Array.isArray(body.applications)).toBe(true);
        expect(body.applications.map((a) => a.Id)).toContain(body.self);
      }),
    );
  });

  describe("ListApplicationAssociations", () => {
    test.provider("lists the application's associations (empty)", () =>
      Effect.gen(function* () {
        const body = yield* getJson<{ associations: unknown[] }>(
          "/application-associations",
        );
        // Nothing associates with the fixture application — the call
        // succeeding with an array proves the binding + IAM grant.
        expect(Array.isArray(body.associations)).toBe(true);
      }),
    );
  });

  describe("ListDataIntegrations", () => {
    test.provider("lists the fixture data integration", () =>
      Effect.gen(function* () {
        const body = yield* getJson<{
          self: string;
          dataIntegrations: { Name?: string; Arn?: string }[];
        }>("/data-integrations");
        expect(Array.isArray(body.dataIntegrations)).toBe(true);
        // The list API returns Arn/Name summaries; resolve self (an id) via
        // distilled to compare by name.
        const observed = yield* appintegrations.getDataIntegration({
          Identifier: body.self,
        });
        expect(body.dataIntegrations.map((d) => d.Name)).toContain(
          observed.Name,
        );
      }),
    );
  });

  describe("ListDataIntegrationAssociations", () => {
    test.provider("lists the data integration's associations (empty)", () =>
      Effect.gen(function* () {
        const body = yield* getJson<{ associations: unknown[] }>(
          "/data-integration-associations",
        );
        expect(Array.isArray(body.associations)).toBe(true);
      }),
    );
  });

  describe("CreateDataIntegrationAssociation / UpdateDataIntegrationAssociation", () => {
    // AppIntegrations attaches a service-managed resource-based policy to
    // DataIntegrations that explicitly denies association creation to
    // principals other than approved client services — Amazon Connect /
    // Amazon Q create the associations when the integration is configured
    // there. The ungated probe asserts the typed AccessDeniedException whose
    // message names the exact action AND the resolved data-integration ARN,
    // proving the binding wiring, the IAM grant path, and the identifier
    // injection end-to-end. Run the full lifecycle on an entitled principal
    // with AWS_TEST_APPINTEGRATIONS_ASSOCIATIONS=1.
    test.provider.skipIf(!!process.env.AWS_TEST_APPINTEGRATIONS_ASSOCIATIONS)(
      "probe: the service's resource policy denies association creation",
      () =>
        Effect.gen(function* () {
          const body = yield* postJson<{
            created: string;
            message?: string;
            associationId?: string;
            updated: string;
          }>("/data-integration-associations").pipe(
            Effect.repeat({
              // Transient IAM-propagation denials lack the "explicit deny"
              // clause — retry (bounded) until the authoritative denial (or
              // an unexpected success) is observed.
              schedule: Schedule.spaced("5 seconds"),
              until: (b): boolean =>
                b.created === "ok" ||
                (b.message ?? "").includes("explicit deny"),
              times: 8,
            }),
          );
          expect(body.created).toBe("AccessDeniedException");
          expect(body.message).toContain(
            "app-integrations:CreateDataIntegrationAssociation on resource: arn:aws:app-integrations",
          );
          expect(body.message).toContain(":data-integration/");
          expect(body.message).toContain(
            "explicit deny in a resource-based policy",
          );
        }),
    );

    test.provider.skipIf(!process.env.AWS_TEST_APPINTEGRATIONS_ASSOCIATIONS)(
      "creates an association and reruns its on-demand job",
      () =>
        Effect.gen(function* () {
          const body = yield* postJson<{
            created: string;
            message?: string;
            associationId?: string;
            updated: string;
          }>("/data-integration-associations").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (b): boolean => b.created === "ok" && b.updated === "ok",
              times: 10,
            }),
          );
          expect(body, JSON.stringify(body)).toMatchObject({
            created: "ok",
            updated: "ok",
          });
          expect(body.associationId).toBeTruthy();

          // The association is now visible through the list binding.
          const listed = yield* getJson<{
            associations: { DataIntegrationAssociationArn?: string }[];
          }>("/data-integration-associations");
          expect(
            listed.associations.map((a) =>
              a.DataIntegrationAssociationArn?.split("/").at(-1),
            ),
          ).toContain(body.associationId);
        }),
    );
  });

  describe("ListEventIntegrations", () => {
    test.provider("lists the fixture event integration", () =>
      Effect.gen(function* () {
        const body = yield* getJson<{
          self: string;
          eventIntegrations: { Name?: string }[];
        }>("/event-integrations");
        expect(Array.isArray(body.eventIntegrations)).toBe(true);
        expect(body.eventIntegrations.map((e) => e.Name)).toContain(body.self);
      }),
    );
  });

  describe("ListEventIntegrationAssociations", () => {
    test.provider("lists the event integration's associations (empty)", () =>
      Effect.gen(function* () {
        const body = yield* getJson<{ associations: unknown[] }>(
          "/event-integration-associations",
        );
        expect(Array.isArray(body.associations)).toBe(true);
      }),
    );
  });

  describe("consumeIntegrationEvents", () => {
    test.provider("creates the EventIntegration for the event source", () =>
      Effect.gen(function* () {
        // The fixture's event source created an EventIntegration on the
        // default bus — verify it out-of-band via distilled.
        const body = yield* getJson<{ self: string }>("/event-integrations");
        const observed = yield* appintegrations.getEventIntegration({
          Name: body.self,
        });
        expect(observed.EventBridgeBus).toBe("default");
        expect(observed.EventFilter?.Source).toBe(
          "aws.partner/examplepartner.com/alchemy-bindings",
        );
      }),
    );
  });
});
