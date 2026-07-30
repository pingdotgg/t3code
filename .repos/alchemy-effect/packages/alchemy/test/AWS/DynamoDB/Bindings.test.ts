import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import DynamoDBTestFunctionLive, { DynamoDBTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DynamoDBBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take
// well over 60s on a fresh deploy under parallel-suite load — observed
// up to ~90s when S3 throttling delays the Lambda code upload too.
// Budget ~150s of readiness polling so we don't fail the whole suite on
// a slow init.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
const sourceTableId = "TestTable";

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// full-suite parallel load — a cold re-init, or a throttled/eventually-
// consistent DynamoDB call that the handler's `Effect.orDie` surfaces as a 500
// with a non-JSON ("Internal Server Error") body. Those are not assertion
// failures: retry the request a few times before surfacing it. A genuine
// 4xx/assertion failure is returned immediately (only 5xx is retried).
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
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

describe("DynamoDB Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "DynamoDB test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DynamoDB test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DynamoDBTestFunction;
        }).pipe(Effect.provide(DynamoDBTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/scan`;

      yield* Effect.logInfo(
        `DynamoDB test setup: function URL ready (${functionUrl})`,
      );
      yield* Effect.logInfo(
        `DynamoDB test setup: probing readiness at ${readinessUrl} (20s budget)`,
      );

      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tap(() =>
          Effect.logInfo("DynamoDB test setup: fixture responded successfully"),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `DynamoDB test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 60_000 });

  describe("PutItem", () => {
    test.provider("puts an item into the table", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "put-test#1", sk: "item", data: "test data" },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect(response).toHaveProperty("success", true);
      }),
    );
  });

  describe("GetItem", () => {
    test.provider("gets an existing item from the table", (_stack) =>
      Effect.gen(function* () {
        yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "get-test#1", sk: "item", data: "get test data" },
          ),
        );

        const response = yield* HttpClient.get(
          `${baseUrl}/get?pk=${encodeURIComponent("get-test#1")}&sk=item`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect(response).toHaveProperty("item");
        expect((response as any).item.pk.S).toBe("get-test#1");
        expect((response as any).item.sk.S).toBe("item");
        expect((response as any).item.data.S).toBe("get test data");
      }),
    );

    test.provider("returns undefined for non-existent item", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(
          `${baseUrl}/get?pk=${encodeURIComponent("non-existent")}&sk=item`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect((response as any).item).toBeUndefined();
      }),
    );
  });

  describe("DescribeTable", () => {
    test.provider("describes the bound table", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(
          `${baseUrl}/describe-table`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect((response as any).table.TableName).toBeTruthy();
        expect((response as any).table.KeySchema).toEqual([
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ]);
      }),
    );
  });

  describe("DescribeTimeToLive", () => {
    test.provider("describes table ttl configuration", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(`${baseUrl}/describe-ttl`).pipe(
          Effect.flatMap((r) => r.json),
        );

        expect(response).toHaveProperty("timeToLiveDescription");
      }),
    );
  });

  describe("BatchWriteItem", () => {
    test.provider("writes multiple items through the bound table", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/batch-write`),
            {
              RequestItems: {
                [sourceTableId]: [
                  {
                    PutRequest: {
                      Item: {
                        pk: { S: "batch-write#1" },
                        sk: { S: "item" },
                        data: { S: "first item" },
                      },
                    },
                  },
                  {
                    PutRequest: {
                      Item: {
                        pk: { S: "batch-write#2" },
                        sk: { S: "item" },
                        data: { S: "second item" },
                      },
                    },
                  },
                ],
              },
            },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect(Object.keys((response as any).unprocessedItems)).toHaveLength(0);
      }),
    );
  });

  describe("BatchGetItem", () => {
    test.provider("reads multiple items through the bound table", (_stack) =>
      Effect.gen(function* () {
        yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/batch-write`),
            {
              RequestItems: {
                [sourceTableId]: [
                  {
                    PutRequest: {
                      Item: {
                        pk: { S: "batch-get#1" },
                        sk: { S: "item" },
                        data: { S: "first item" },
                      },
                    },
                  },
                  {
                    PutRequest: {
                      Item: {
                        pk: { S: "batch-get#2" },
                        sk: { S: "item" },
                        data: { S: "second item" },
                      },
                    },
                  },
                ],
              },
            },
          ),
        );

        const response = yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/batch-get`),
            {
              RequestItems: {
                [sourceTableId]: {
                  Keys: [
                    { pk: { S: "batch-get#1" }, sk: { S: "item" } },
                    { pk: { S: "batch-get#2" }, sk: { S: "item" } },
                  ],
                },
              },
            },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        const items = Object.values((response as any).responses).flat();
        expect(items).toHaveLength(2);
      }),
    );
  });

  describe("UpdateTimeToLive", () => {
    test.provider("updates table ttl configuration", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/update-ttl`),
            { attributeName: "expiresAt", enabled: true },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect((response as any).timeToLiveSpecification).toEqual({
          AttributeName: "expiresAt",
          Enabled: true,
        });
      }),
    );
  });

  describe("ExecuteStatement", () => {
    test.provider(
      "executes a PartiQL statement against the bound table",
      (_stack) =>
        Effect.gen(function* () {
          yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/put`),
              { pk: "statement#1", sk: "item", data: "statement data" },
            ),
          );

          const response = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/execute-statement`),
              { pk: "statement#1", sk: "item" },
            ),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).items).toHaveLength(1);
          expect((response as any).items[0].data.S).toBe("statement data");
        }),
    );
  });

  describe("BatchExecuteStatement", () => {
    test.provider(
      "executes PartiQL statements against the bound table",
      (_stack) =>
        Effect.gen(function* () {
          yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/batch-write`),
              {
                RequestItems: {
                  [sourceTableId]: [
                    {
                      PutRequest: {
                        Item: {
                          pk: { S: "batch-statement#1" },
                          sk: { S: "item" },
                          data: { S: "first item" },
                        },
                      },
                    },
                    {
                      PutRequest: {
                        Item: {
                          pk: { S: "batch-statement#2" },
                          sk: { S: "item" },
                          data: { S: "second item" },
                        },
                      },
                    },
                  ],
                },
              },
            ),
          );

          const response = yield* fetchUntil(
            send(
              HttpClientRequest.bodyJsonUnsafe(
                HttpClientRequest.post(`${baseUrl}/batch-execute-statement`),
                {
                  first: { pk: "batch-statement#1", sk: "item" },
                  second: { pk: "batch-statement#2", sk: "item" },
                },
              ),
            ).pipe(Effect.flatMap((r) => r.json)),
            (body) =>
              Array.isArray(body?.responses) && body.responses.length === 2,
          );

          expect((response as any).responses).toHaveLength(2);
        }),
    );
  });

  describe("ExecuteTransaction", () => {
    test.provider(
      "executes a PartiQL transaction against the table",
      (_stack) =>
        Effect.gen(function* () {
          yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/put`),
              { pk: "tx#1", sk: "item1", data: "first" },
            ),
          );
          yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/put`),
              { pk: "tx#1", sk: "item2", data: "second" },
            ),
          );

          const response = yield* fetchUntil(
            send(HttpClientRequest.post(`${baseUrl}/execute-transaction`)).pipe(
              Effect.flatMap((r) => r.json),
            ),
            (body) =>
              Array.isArray(body?.responses) && body.responses.length === 2,
          );

          expect((response as any).responses).toHaveLength(2);
        }),
    );
  });

  describe("TransactWriteItems", () => {
    test.provider(
      "writes items transactionally through the bound table",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/transact-write`),
              {
                TransactItems: [
                  {
                    Put: {
                      Table: sourceTableId,
                      Item: {
                        pk: { S: "transact-write#1" },
                        sk: { S: "item" },
                        data: { S: "first item" },
                      },
                    },
                  },
                  {
                    Put: {
                      Table: sourceTableId,
                      Item: {
                        pk: { S: "transact-write#2" },
                        sk: { S: "item" },
                        data: { S: "second item" },
                      },
                    },
                  },
                ],
              },
            ),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).success).toBe(true);
        }),
    );
  });

  describe("TransactGetItems", () => {
    test.provider(
      "reads items transactionally through the bound table",
      (_stack) =>
        Effect.gen(function* () {
          yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/transact-write`),
              {
                TransactItems: [
                  {
                    Put: {
                      Table: sourceTableId,
                      Item: {
                        pk: { S: "transact-get#1" },
                        sk: { S: "item" },
                        data: { S: "first item" },
                      },
                    },
                  },
                  {
                    Put: {
                      Table: sourceTableId,
                      Item: {
                        pk: { S: "transact-get#2" },
                        sk: { S: "item" },
                        data: { S: "second item" },
                      },
                    },
                  },
                ],
              },
            ),
          );

          const response = yield* fetchUntil(
            send(
              HttpClientRequest.bodyJsonUnsafe(
                HttpClientRequest.post(`${baseUrl}/transact-get`),
                {
                  TransactItems: [
                    {
                      Get: {
                        Table: sourceTableId,
                        Key: {
                          pk: { S: "transact-get#1" },
                          sk: { S: "item" },
                        },
                      },
                    },
                    {
                      Get: {
                        Table: sourceTableId,
                        Key: {
                          pk: { S: "transact-get#2" },
                          sk: { S: "item" },
                        },
                      },
                    },
                  ],
                },
              ),
            ).pipe(Effect.flatMap((r) => r.json)),
            (body) =>
              Array.isArray(body?.responses) && body.responses.length === 2,
          );

          expect((response as any).responses).toHaveLength(2);
        }),
    );
  });

  describe("UpdateItem", () => {
    test.provider("updates an existing item", (_stack) =>
      Effect.gen(function* () {
        yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "update-test#1", sk: "item", data: "original" },
          ),
        );

        const response = yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/update`),
            { pk: "update-test#1", sk: "item", data: "updated" },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect(response).toHaveProperty("success", true);
        expect((response as any).attributes.data.S).toBe("updated");

        const getResponse = yield* HttpClient.get(
          `${baseUrl}/get?pk=${encodeURIComponent("update-test#1")}&sk=item`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect((getResponse as any).item.data.S).toBe("updated");
      }),
    );
  });

  describe("DeleteItem", () => {
    test.provider("deletes an existing item", (_stack) =>
      Effect.gen(function* () {
        yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "delete-test#1", sk: "item", data: "to delete" },
          ),
        );

        const response = yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.delete(`${baseUrl}/delete`),
            { pk: "delete-test#1", sk: "item" },
          ),
        ).pipe(Effect.flatMap((r) => r.json));

        expect(response).toHaveProperty("success", true);

        const getResponse = yield* HttpClient.get(
          `${baseUrl}/get?pk=${encodeURIComponent("delete-test#1")}&sk=item`,
        ).pipe(Effect.flatMap((r) => r.json));

        expect((getResponse as any).item).toBeUndefined();
      }),
    );
  });

  describe("Query", () => {
    test.provider("queries items by partition key", (_stack) =>
      Effect.gen(function* () {
        yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "query-test#1", sk: "item1", data: "first" },
          ),
        );
        yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "query-test#1", sk: "item2", data: "second" },
          ),
        );

        // DynamoDB Query is eventually consistent by default, so a
        // brand-new PutItem may not appear in the immediately-following
        // Query. Poll briefly until both items are visible.
        const response = yield* Effect.gen(function* () {
          const r = yield* HttpClient.get(
            `${baseUrl}/query?pk=${encodeURIComponent("query-test#1")}`,
          ).pipe(Effect.flatMap((r) => r.json));
          if ((r as any).count !== 2) {
            return yield* Effect.fail(new QueryNotConsistent());
          }
          return r;
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "QueryNotConsistent",
            schedule: Schedule.max([
              Schedule.fixed("500 millis"),
              Schedule.recurs(20),
            ]),
          }),
        );

        expect((response as any).count).toBe(2);
        expect((response as any).items.length).toBe(2);
      }),
    );
  });

  describe("ListTables", () => {
    test.provider("lists the deployed table", (_stack) =>
      Effect.gen(function* () {
        // DescribeTable can momentarily return an empty body on a freshly
        // provisioned table; poll until the table description is populated.
        const described = yield* fetchUntil(
          HttpClient.get(`${baseUrl}/describe-table`).pipe(
            Effect.flatMap((r) => r.json),
          ),
          (body) => Boolean(body?.table?.TableName),
        );

        // ListTables is eventually consistent and a new table can lag its
        // appearance in the account-wide listing by a few seconds.
        const response = yield* fetchUntil(
          HttpClient.get(`${baseUrl}/list-tables`).pipe(
            Effect.flatMap((r) => r.json),
          ),
          (body) =>
            Array.isArray(body?.tableNames) &&
            body.tableNames.includes((described as any).table.TableName),
        );

        expect((response as any).tableNames).toContain(
          (described as any).table.TableName,
        );
      }),
    );
  });

  describe("ListTagsOfResource", () => {
    test.provider("lists alchemy ownership tags for the table", (_stack) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(`${baseUrl}/list-tags`).pipe(
          Effect.flatMap((r) => r.json),
        );

        const keys = ((response as any).tags ?? []).map((tag: any) => tag.Key);
        expect(keys).toContain("alchemy::stack");
        expect(keys).toContain("alchemy::stage");
        expect(keys).toContain("alchemy::id");
      }),
    );
  });

  describe("RestoreTableToPointInTime", () => {
    test.provider(
      "returns a structured error when point-in-time recovery is unavailable",
      (_stack) =>
        Effect.gen(function* () {
          // The route always returns a structured `{ ok, ... }` body; a
          // missing `ok` means the request hit a not-yet-ready instance, so
          // poll until the binding produces its structured result.
          const response = yield* fetchUntil(
            send(
              HttpClientRequest.bodyJsonUnsafe(
                HttpClientRequest.post(`${baseUrl}/restore-table`),
                {},
              ),
            ).pipe(Effect.flatMap((r) => r.json)),
            (body) => typeof body?.ok === "boolean",
          );

          expect((response as any).ok).toBe(false);
          expect([
            "PointInTimeRecoveryUnavailableException",
            "TableAlreadyExistsException",
          ]).toContain((response as any).error);
        }),
    );
  });

  describe("Scan", () => {
    test.provider("scans all items in the table", (_stack) =>
      Effect.gen(function* () {
        yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/put`),
            { pk: "scan-test#1", sk: "item", data: "scan data" },
          ),
        );

        const response = yield* HttpClient.get(`${baseUrl}/scan`).pipe(
          Effect.flatMap((r) => r.json),
        );

        expect((response as any).count).toBeGreaterThanOrEqual(1);
        expect((response as any).items.length).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  describe("Backups", () => {
    test.provider(
      "creates, describes, lists, restore-conflicts, and deletes a backup",
      (_stack) =>
        Effect.gen(function* () {
          const created = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/create-backup`),
              { name: "bindings-test-backup" },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            backupArn?: string;
            status?: string;
          };
          expect(created.backupArn).toBeTruthy();
          const backupArn = created.backupArn!;

          yield* Effect.gen(function* () {
            // Wait for the on-demand backup to become AVAILABLE (it is
            // CREATING for a few seconds on an empty table).
            const described = yield* fetchUntil<{ status?: string }>(
              HttpClient.get(
                `${baseUrl}/describe-backup?arn=${encodeURIComponent(backupArn)}`,
              ).pipe(Effect.flatMap((r) => r.json)),
              (body) => body?.status === "AVAILABLE",
            );
            expect(described.status).toBe("AVAILABLE");

            const listed = (yield* HttpClient.get(
              `${baseUrl}/list-backups`,
            ).pipe(Effect.flatMap((r) => r.json))) as {
              backupArns: string[];
            };
            expect(listed.backupArns).toContain(backupArn);

            // Restoring into the already-deployed target table conflicts —
            // proves the RestoreTableFromBackup binding round-trips with a
            // typed error and never creates an unmanaged table.
            const restored = (yield* send(
              HttpClientRequest.bodyJsonUnsafe(
                HttpClientRequest.post(`${baseUrl}/restore-from-backup`),
                { arn: backupArn },
              ),
            ).pipe(Effect.flatMap((r) => r.json))) as {
              ok: boolean;
              error?: string;
            };
            expect(restored.ok).toBe(false);
            expect(restored.error).toBe("TableAlreadyExistsException");
          }).pipe(
            // Always delete the backup, even if an assertion above failed —
            // zero orphans.
            Effect.ensuring(
              send(
                HttpClientRequest.bodyJsonUnsafe(
                  HttpClientRequest.delete(`${baseUrl}/delete-backup`),
                  { arn: backupArn },
                ),
              ).pipe(Effect.ignore),
            ),
          );

          // The delete in `ensuring` already ran; verify it took effect (the
          // backup drops out of ListBackups, allowing for eventual
          // consistency).
          const afterDelete = yield* fetchUntil<{ backupArns: string[] }>(
            HttpClient.get(`${baseUrl}/list-backups`).pipe(
              Effect.flatMap((r) => r.json),
            ),
            (body) =>
              Array.isArray(body?.backupArns) &&
              !body.backupArns.includes(backupArn),
          );
          expect(afterDelete.backupArns).not.toContain(backupArn);
        }),
      { timeout: 120_000 },
    );
  });

  describe("DescribeContinuousBackups", () => {
    test.provider("reads the continuous backups / PITR status", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* HttpClient.get(
          `${baseUrl}/describe-continuous-backups`,
        ).pipe(Effect.flatMap((r) => r.json))) as {
          continuousBackupsStatus?: string;
          pitrStatus?: string;
        };

        expect(response.continuousBackupsStatus).toBe("ENABLED");
        // The fixture table does not enable PITR.
        expect(response.pitrStatus).toBe("DISABLED");
      }),
    );
  });

  describe("Exports", () => {
    test.provider(
      "surfaces a typed error when PITR is unavailable and lists exports",
      (_stack) =>
        Effect.gen(function* () {
          // PITR is disabled on the fixture table, so starting an export
          // fails fast with the typed tag (and never writes to the bucket).
          const exported = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/export-table`),
              {},
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            ok: boolean;
            error?: string;
          };
          expect(exported.ok).toBe(false);
          expect(exported.error).toBe(
            "PointInTimeRecoveryUnavailableException",
          );

          const listed = (yield* HttpClient.get(`${baseUrl}/list-exports`).pipe(
            Effect.flatMap((r) => r.json),
          )) as { exportArns: string[] };
          expect(Array.isArray(listed.exportArns)).toBe(true);
          expect(listed.exportArns).toHaveLength(0);
        }),
      { timeout: 120_000 },
    );

    test.provider("DescribeExport returns a typed not-found error", (_stack) =>
      Effect.gen(function* () {
        const described = (yield* HttpClient.get(
          `${baseUrl}/describe-table`,
        ).pipe(Effect.flatMap((r) => r.json))) as {
          table: { TableArn: string };
        };
        const exportArn = `${described.table.TableArn}/export/01700000000000-00000000`;

        const response = (yield* HttpClient.get(
          `${baseUrl}/describe-export?arn=${encodeURIComponent(exportArn)}`,
        ).pipe(Effect.flatMap((r) => r.json))) as {
          ok: boolean;
          error?: string;
        };
        expect(response.ok).toBe(false);
        expect(response.error).toBe("ExportNotFoundException");
      }),
    );
  });
});

class QueryNotConsistent extends Data.TaggedError("QueryNotConsistent") {}

// A request hit a Lambda instance that hadn't fully converged yet (cold
// secondary instance, IAM propagation lag, control-plane eventual
// consistency), so the bound call returned a not-yet-populated shape. Retry.
class BindingNotConsistent extends Data.TaggedError("BindingNotConsistent") {}

// Poll an HTTP-driven binding call until its parsed body satisfies `ready`.
// Control-plane reads (ListTables/DescribeTable) and PartiQL transactions can
// briefly observe stale/empty state right after the table is provisioned.
const fetchUntil = <A>(
  fetch: Effect.Effect<unknown, any, HttpClient.HttpClient>,
  ready: (body: any) => boolean,
) =>
  fetch.pipe(
    Effect.flatMap((body) =>
      ready(body)
        ? Effect.succeed(body as A)
        : Effect.fail(new BindingNotConsistent()),
    ),
    Effect.retry({
      while: (e) => e._tag === "BindingNotConsistent",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
