import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";
import { LOCATION } from "../src/resources.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// Both services are built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

const TRIGGER_PATH = "/__alchemy/eventarc/ordercreated";

// Kept outside the handle so teardown can verify even after a failed test.
let deployed:
  | { project: string; auditorService: string; databaseName: string }
  | undefined;

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-eventarc-firestore", () => {
  const stack = beforeAll(
    deploy(Stack).pipe(
      Effect.tap((outputs) =>
        Effect.sync(() => {
          deployed = outputs;
        }),
      ),
    ),
    { timeout: 900_000 },
  );

  /** The example's trigger, found by its delivery path and target service. */
  const findTrigger = (project: string, auditor: string) =>
    eventarc
      .listProjectsLocationsTriggers({
        parent: `projects/${project}/locations/${LOCATION}`,
      })
      .pipe(
        Effect.map((page) =>
          (page.triggers ?? []).find(
            (trigger) =>
              trigger.destination?.cloudRun?.path === TRIGGER_PATH &&
              trigger.destination.cloudRun.service === auditor,
          ),
        ),
        Effect.orDie,
        Effect.provide(GcpHttp),
      );

  // Destroy, then prove the trigger and the database are actually gone.
  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      yield* destroy(Stack);
      if (deployed === undefined) return;
      const { project, auditorService, databaseName } = deployed;

      expect(yield* findTrigger(project, auditorService)).toBeUndefined();

      const database = yield* firestore
        .getProjectsDatabases({ name: databaseName })
        .pipe(
          Effect.map((db) => db.name),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(database).toBeUndefined();
    }),
    { timeout: 600_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  const createOrder = (baseUrl: string, item: string, quantity: number) =>
    HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/orders`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ item, quantity }),
      ),
    );

  /**
   * A fresh deploy's project-level Firestore grant can take several minutes
   * to propagate, and not to every IAM backend at once; until it has, the
   * API answers 500 (Forbidden from Firestore).
   */
  const createOrderWhenGranted = (
    baseUrl: string,
    item: string,
    quantity: number,
  ) =>
    createOrder(baseUrl, item, quantity).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (response) => response.status !== 500,
        times: 42,
      }),
    );

  /** The auditor's `audit/{id}` entry, polled every 10s up to `times`. */
  const auditOf = (databaseName: string, id: string, times: number) =>
    firestore
      .getProjectsDatabasesDocuments({
        name: `${databaseName}/documents/audit/${id}`,
      })
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "NotFound",
          schedule: Schedule.spaced("10 seconds"),
          times,
        }),
        Effect.provide(GcpHttp),
      );

  test(
    "the trigger watches created orders in the named database",
    Effect.gen(function* () {
      const { project, auditorService, databaseId } = yield* stack;
      const trigger = yield* findTrigger(project, auditorService);
      expect(trigger?.name).toEqual(expect.any(String));

      const filters = Object.fromEntries(
        (trigger?.eventFilters ?? []).map((filter) => [
          filter.attribute,
          { value: filter.value, operator: filter.operator },
        ]),
      );
      expect(filters.type?.value).toEqual(
        "google.cloud.firestore.document.v1.created",
      );
      expect(filters.database?.value).toEqual(databaseId);
      expect(filters.document).toEqual({
        value: "orders/{id}",
        operator: "match-path-pattern",
      });
    }),
    { timeout: 120_000 },
  );

  test(
    "rejects an order without an item",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const res = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/orders`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ quantity: 1 }),
        ),
      );
      expect(res.status).toBe(400);
    }),
    { timeout: 120_000 },
  );

  test(
    "every created order gets an audit entry from the change event",
    Effect.gen(function* () {
      const { url, databaseName } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      // Eventarc can take a couple of minutes after the trigger reports
      // healthy before it starts routing events, and a Firestore event
      // emitted before then is never delivered. Probe with throwaway orders
      // until one is audited; after that, every order must be.
      yield* Effect.gen(function* () {
        const probe = yield* createOrderWhenGranted(baseUrl, "probe", 1);
        const { id } = (yield* probe.json) as { id: string };
        return yield* auditOf(databaseName, id, 6);
      }).pipe(Effect.retry({ times: 6 }), Effect.orDie);

      const first = yield* createOrderWhenGranted(baseUrl, "widget", 2);
      expect(first.status).toBe(201);
      const second = yield* createOrderWhenGranted(baseUrl, "gadget", 1);
      expect(second.status).toBe(201);

      const ids = [
        ((yield* first.json) as { id: string }).id,
        ((yield* second.json) as { id: string }).id,
      ];

      for (const id of ids) {
        // The order is a real Firestore document.
        const order = yield* firestore
          .getProjectsDatabasesDocuments({
            name: `${databaseName}/documents/orders/${id}`,
          })
          .pipe(Effect.orDie, Effect.provide(GcpHttp));
        expect(order.fields?.item?.stringValue).toBeDefined();

        // A failed delivery (e.g. the auditor's grant still propagating) is
        // redelivered with backoff, so give each audit a few minutes.
        const audit = yield* auditOf(databaseName, id, 30).pipe(Effect.orDie);
        expect(audit.fields?.order?.stringValue).toEqual(`orders/${id}`);
        expect(audit.fields?.eventType?.stringValue).toEqual(
          "google.cloud.firestore.document.v1.created",
        );
        // The protobuf payload reached the handler as bytes.
        expect(
          Number(audit.fields?.payloadBytes?.integerValue ?? 0),
        ).toBeGreaterThan(0);
      }
    }),
    { timeout: 900_000 },
  );
});
