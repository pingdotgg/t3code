import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SimpleDBTestFunctionLive, { SimpleDBTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SimpleDBBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling so we don't fail the whole suite on a slow init.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// full-suite parallel load — a cold re-init or a throttled SimpleDB call the
// handler's `Effect.orDie` surfaces as a 500. Retry 5xx a few times; genuine
// 4xx/assertion failures are returned immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) =>
        e._tag === "TransientUpstream" || e._tag === "HttpClientError",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

// Response bodies cross the HTTP wire, so they are opaque JSON to the test.
// Widen to `unknown` so call sites narrow with a single explicit cast.
const asUnknown = Effect.map((body: unknown) => body);

const postJson = (path: string, body: unknown) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}${path}`),
      body,
    ),
  ).pipe(
    Effect.flatMap((r) => r.json),
    asUnknown,
  );

const deleteJson = (path: string, body: unknown) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.delete(`${baseUrl}${path}`),
      body,
    ),
  ).pipe(
    Effect.flatMap((r) => r.json),
    asUnknown,
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
    asUnknown,
  );

interface Attribute {
  Name: string;
  Value: string;
}

interface Item {
  Name: string;
  Attributes?: Attribute[];
}

describe("SimpleDB Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "SimpleDB test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SimpleDB test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SimpleDBTestFunction;
        }).pipe(Effect.provide(SimpleDBTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/metadata`;

      yield* Effect.logInfo(
        `SimpleDB test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SimpleDB test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 60_000 });

  describe("PutAttributes", () => {
    test.provider("puts attributes on an item", (_stack) =>
      Effect.gen(function* () {
        const response = yield* postJson("/put", {
          item: "put-test#1",
          attributes: [{ name: "color", value: "blue" }],
        });
        expect(response).toHaveProperty("success", true);
      }),
    );
  });

  describe("GetAttributes", () => {
    test.provider("round-trips put then get", (_stack) =>
      Effect.gen(function* () {
        yield* postJson("/put", {
          item: "get-test#1",
          attributes: [
            { name: "color", value: "green" },
            { name: "size", value: "large" },
          ],
        });

        const response = (yield* getJson(
          `/get?item=${encodeURIComponent("get-test#1")}`,
        )) as { attributes: Attribute[] };

        const byName = Object.fromEntries(
          response.attributes.map((a) => [a.Name, a.Value]),
        );
        expect(byName).toMatchObject({ color: "green", size: "large" });
      }),
    );

    test.provider("returns no attributes for a missing item", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(
          `/get?item=${encodeURIComponent("missing-item#404")}`,
        )) as { attributes: Attribute[] };
        expect(response.attributes).toEqual([]);
      }),
    );
  });

  describe("Select", () => {
    test.provider("selects items with a where clause", (_stack) =>
      Effect.gen(function* () {
        yield* postJson("/put", {
          item: "select-test#1",
          attributes: [{ name: "kind", value: "select-target" }],
        });

        const response = (yield* getJson(
          `/select?where=${encodeURIComponent("kind = 'select-target'")}`,
        )) as { items: Item[] };

        expect(response.items.map((i) => i.Name)).toContain("select-test#1");
        const item = response.items.find((i) => i.Name === "select-test#1")!;
        expect(item.Attributes).toContainEqual({
          Name: "kind",
          Value: "select-target",
        });
      }),
    );
  });

  describe("BatchPutAttributes", () => {
    test.provider("puts attributes on multiple items at once", (_stack) =>
      Effect.gen(function* () {
        const response = yield* postJson("/batch-put", {
          items: [
            {
              item: "batch-test#1",
              attributes: [{ name: "batch", value: "one" }],
            },
            {
              item: "batch-test#2",
              attributes: [{ name: "batch", value: "two" }],
            },
          ],
        });
        expect(response).toHaveProperty("success", true);

        const first = (yield* getJson(
          `/get?item=${encodeURIComponent("batch-test#1")}`,
        )) as { attributes: Attribute[] };
        expect(first.attributes).toContainEqual({
          Name: "batch",
          Value: "one",
        });
        const second = (yield* getJson(
          `/get?item=${encodeURIComponent("batch-test#2")}`,
        )) as { attributes: Attribute[] };
        expect(second.attributes).toContainEqual({
          Name: "batch",
          Value: "two",
        });
      }),
    );
  });

  describe("DeleteAttributes", () => {
    test.provider("deletes a whole item", (_stack) =>
      Effect.gen(function* () {
        yield* postJson("/put", {
          item: "delete-test#1",
          attributes: [{ name: "doomed", value: "yes" }],
        });

        const response = yield* deleteJson("/delete", {
          item: "delete-test#1",
        });
        expect(response).toHaveProperty("success", true);

        const after = (yield* getJson(
          `/get?item=${encodeURIComponent("delete-test#1")}`,
        )) as { attributes: Attribute[] };
        expect(after.attributes).toEqual([]);
      }),
    );

    test.provider("deletes a single attribute", (_stack) =>
      Effect.gen(function* () {
        yield* postJson("/put", {
          item: "delete-test#2",
          attributes: [
            { name: "keep", value: "me" },
            { name: "drop", value: "me" },
          ],
        });

        yield* deleteJson("/delete", {
          item: "delete-test#2",
          attributes: ["drop"],
        });

        const after = (yield* getJson(
          `/get?item=${encodeURIComponent("delete-test#2")}`,
        )) as { attributes: Attribute[] };
        expect(after.attributes).toContainEqual({ Name: "keep", Value: "me" });
        expect(after.attributes.map((a) => a.Name)).not.toContain("drop");
      }),
    );
  });

  describe("BatchDeleteAttributes", () => {
    test.provider("deletes multiple items at once", (_stack) =>
      Effect.gen(function* () {
        yield* postJson("/batch-put", {
          items: [
            {
              item: "batch-delete#1",
              attributes: [{ name: "x", value: "1" }],
            },
            {
              item: "batch-delete#2",
              attributes: [{ name: "x", value: "2" }],
            },
          ],
        });

        const response = yield* postJson("/batch-delete", {
          items: ["batch-delete#1", "batch-delete#2"],
        });
        expect(response).toHaveProperty("success", true);

        const first = (yield* getJson(
          `/get?item=${encodeURIComponent("batch-delete#1")}`,
        )) as { attributes: Attribute[] };
        expect(first.attributes).toEqual([]);
        const second = (yield* getJson(
          `/get?item=${encodeURIComponent("batch-delete#2")}`,
        )) as { attributes: Attribute[] };
        expect(second.attributes).toEqual([]);
      }),
    );
  });

  describe("ListDomains", () => {
    test.provider("lists the fixture's domain", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/domains")) as {
          domainNames: string[];
        };
        expect(
          response.domainNames.some((name) => name.includes("BindingsDomain")),
        ).toBe(true);
      }),
    );
  });

  describe("DomainMetadata", () => {
    test.provider("returns domain metadata", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/metadata")) as {
          itemCount?: number;
        };
        expect(typeof response.itemCount).toBe("number");
      }),
    );
  });
});
