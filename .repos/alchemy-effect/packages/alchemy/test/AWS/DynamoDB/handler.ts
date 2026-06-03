import * as DynamoDB from "@/AWS/DynamoDB";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class DynamoDBTestFunction extends Lambda.Function<Lambda.Function>()(
  "DynamoDBTestFunction",
  {
    main,
    url: true,
  },
) {}

export default DynamoDBTestFunction.make(
  Effect.gen(function* () {
    const sourceTable = yield* DynamoDB.Table("TestTable", {
      partitionKey: "pk",
      sortKey: "sk",
      attributes: { pk: "S", sk: "S" },
    });
    const restoreTargetTable = yield* DynamoDB.Table("RestoreTargetTable", {
      partitionKey: "pk",
      sortKey: "sk",
      attributes: { pk: "S", sk: "S" },
    });

    const getItem = yield* DynamoDB.GetItem.bind(sourceTable);
    const batchGetItem = yield* DynamoDB.BatchGetItem.bind(sourceTable);
    const batchWriteItem = yield* DynamoDB.BatchWriteItem.bind(sourceTable);
    const batchExecuteStatement =
      yield* DynamoDB.BatchExecuteStatement.bind(sourceTable);
    const describeTable = yield* DynamoDB.DescribeTable.bind(sourceTable);
    const describeTimeToLive =
      yield* DynamoDB.DescribeTimeToLive.bind(sourceTable);
    const executeStatement = yield* DynamoDB.ExecuteStatement.bind(sourceTable);
    const executeTransaction =
      yield* DynamoDB.ExecuteTransaction.bind(sourceTable);
    const putItem = yield* DynamoDB.PutItem.bind(sourceTable);
    const deleteItem = yield* DynamoDB.DeleteItem.bind(sourceTable);
    const listTables = yield* DynamoDB.ListTables.bind();
    const listTagsOfResource =
      yield* DynamoDB.ListTagsOfResource.bind(sourceTable);
    const updateItem = yield* DynamoDB.UpdateItem.bind(sourceTable);
    const updateTimeToLive = yield* DynamoDB.UpdateTimeToLive.bind(sourceTable);
    const query = yield* DynamoDB.Query.bind(sourceTable);
    const scan = yield* DynamoDB.Scan.bind(sourceTable);
    const TableName = yield* sourceTable.tableName;
    const restoreTableToPointInTime =
      yield* DynamoDB.RestoreTableToPointInTime.bind(
        sourceTable,
        restoreTargetTable,
      );
    const transactGetItems = yield* DynamoDB.TransactGetItems.bind(sourceTable);
    const transactWriteItems =
      yield* DynamoDB.TransactWriteItems.bind(sourceTable);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        yield* Effect.logInfo(
          `Request: ${request.method} ${pathname} (originalUrl: ${request.originalUrl}, url: ${request.url})`,
        );

        if (request.method === "POST" && pathname === "/put") {
          const body = (yield* request.json) as unknown as {
            pk: string;
            sk: string;
            data?: string;
          };
          const result = yield* putItem({
            Item: {
              pk: { S: body.pk },
              sk: { S: body.sk },
              ...(body.data ? { data: { S: body.data } } : {}),
            },
          });
          return yield* HttpServerResponse.json({ success: true, result });
        }

        if (request.method === "GET" && pathname === "/get") {
          const pk = url.searchParams.get("pk");
          const sk = url.searchParams.get("sk");
          if (!pk || !sk) {
            return HttpServerResponse.text("Missing pk or sk", { status: 400 });
          }
          const result = yield* getItem({
            Key: {
              pk: { S: pk },
              sk: { S: sk },
            },
          });
          return yield* HttpServerResponse.json({ item: result.Item });
        }

        if (request.method === "GET" && pathname === "/describe-table") {
          const result = yield* describeTable();
          return yield* HttpServerResponse.json({
            table: result.Table,
          });
        }

        if (request.method === "GET" && pathname === "/describe-ttl") {
          const result = yield* describeTimeToLive();
          return yield* HttpServerResponse.json({
            timeToLiveDescription: result.TimeToLiveDescription,
          });
        }

        if (request.method === "DELETE" && pathname === "/delete") {
          const body = (yield* request.json) as unknown as {
            pk: string;
            sk: string;
          };
          const result = yield* deleteItem({
            Key: {
              pk: { S: body.pk },
              sk: { S: body.sk },
            },
          });
          return yield* HttpServerResponse.json({ success: true, result });
        }

        if (request.method === "POST" && pathname === "/update") {
          const body = (yield* request.json) as unknown as {
            pk: string;
            sk: string;
            data: string;
          };
          const result = yield* updateItem({
            Key: {
              pk: { S: body.pk },
              sk: { S: body.sk },
            },
            UpdateExpression: "SET #data = :data",
            ExpressionAttributeNames: { "#data": "data" },
            ExpressionAttributeValues: { ":data": { S: body.data } },
            ReturnValues: "ALL_NEW",
          });
          return yield* HttpServerResponse.json({
            success: true,
            attributes: result.Attributes,
          });
        }

        if (request.method === "POST" && pathname === "/update-ttl") {
          const body = (yield* request.json) as unknown as {
            attributeName: string;
            enabled: boolean;
          };
          const result = yield* updateTimeToLive({
            TimeToLiveSpecification: {
              AttributeName: body.attributeName,
              Enabled: body.enabled,
            },
          });
          return yield* HttpServerResponse.json({
            timeToLiveSpecification: result.TimeToLiveSpecification,
          });
        }

        if (request.method === "POST" && pathname === "/batch-write") {
          const body =
            (yield* request.json) as unknown as DynamoDB.BatchWriteItemRequest;
          const result = yield* batchWriteItem(body);
          return yield* HttpServerResponse.json({
            unprocessedItems: result.UnprocessedItems ?? {},
          });
        }

        if (request.method === "POST" && pathname === "/batch-get") {
          const body =
            (yield* request.json) as unknown as DynamoDB.BatchGetItemRequest;
          const result = yield* batchGetItem(body);
          return yield* HttpServerResponse.json({
            responses: result.Responses ?? {},
            unprocessedKeys: result.UnprocessedKeys ?? {},
          });
        }

        if (request.method === "POST" && pathname === "/transact-write") {
          const body =
            (yield* request.json) as unknown as DynamoDB.TransactWriteItemsRequest;
          const result = yield* transactWriteItems(body);
          return yield* HttpServerResponse.json({
            success: true,
            result,
          });
        }

        if (request.method === "POST" && pathname === "/transact-get") {
          const body =
            (yield* request.json) as unknown as DynamoDB.TransactGetItemsRequest;
          const result = yield* transactGetItems(body);
          return yield* HttpServerResponse.json({
            responses: result.Responses ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/execute-transaction") {
          const tableName = yield* TableName;
          const result = yield* executeTransaction({
            TransactStatements: [
              {
                Statement: `SELECT * FROM "${tableName}" WHERE pk=? AND sk=?`,
                Parameters: [{ S: "tx#1" }, { S: "item1" }],
              },
              {
                Statement: `SELECT * FROM "${tableName}" WHERE pk=? AND sk=?`,
                Parameters: [{ S: "tx#1" }, { S: "item2" }],
              },
            ],
          });
          return yield* HttpServerResponse.json({
            responses: result.Responses,
          });
        }

        if (request.method === "POST" && pathname === "/execute-statement") {
          const body = (yield* request.json) as unknown as {
            pk: string;
            sk: string;
          };
          const tableName = yield* TableName;
          const result = yield* executeStatement({
            Statement: `SELECT * FROM "${tableName}" WHERE pk=? AND sk=?`,
            Parameters: [{ S: body.pk }, { S: body.sk }],
          });
          return yield* HttpServerResponse.json({
            items: result.Items ?? [],
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/batch-execute-statement"
        ) {
          const body = (yield* request.json) as unknown as {
            first: { pk: string; sk: string };
            second: { pk: string; sk: string };
          };
          const sourceTableName = yield* TableName;
          const result = yield* batchExecuteStatement({
            Statements: [
              {
                Statement: `SELECT * FROM "${sourceTableName}" WHERE pk=? AND sk=?`,
                Parameters: [{ S: body.first.pk }, { S: body.first.sk }],
              },
              {
                Statement: `SELECT * FROM "${sourceTableName}" WHERE pk=? AND sk=?`,
                Parameters: [{ S: body.second.pk }, { S: body.second.sk }],
              },
            ],
          });
          return yield* HttpServerResponse.json({
            responses: result.Responses ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/restore-table") {
          const result = yield* restoreTableToPointInTime({
            UseLatestRestorableTime: true,
          }).pipe(
            Effect.map((result) => ({
              ok: true as const,
              result,
            })),
            Effect.catch((error) =>
              Effect.succeed({
                ok: false as const,
                error:
                  typeof error === "object" && error !== null && "_tag" in error
                    ? (error as { _tag: string })._tag
                    : `${error}`,
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/query") {
          const pk = url.searchParams.get("pk");
          if (!pk) {
            return HttpServerResponse.text("Missing pk", { status: 400 });
          }
          const result = yield* query({
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": { S: pk } },
          });
          return yield* HttpServerResponse.json({
            items: result.Items,
            count: result.Count,
          });
        }

        if (request.method === "GET" && pathname === "/list-tables") {
          const result = yield* listTables();
          return yield* HttpServerResponse.json({
            tableNames: result.TableNames,
          });
        }

        if (request.method === "GET" && pathname === "/list-tags") {
          const result = yield* listTagsOfResource();
          return yield* HttpServerResponse.json({
            tags: result.Tags,
          });
        }

        if (request.method === "GET" && pathname === "/scan") {
          const result = yield* scan({});
          return yield* HttpServerResponse.json({
            items: result.Items,
            count: result.Count,
          });
        }

        return yield* HttpServerResponse.json(
          {
            error: "Not found",
            method: request.method,
            pathname,
            url: request.url,
          },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DynamoDB.BatchExecuteStatementLive,
        DynamoDB.BatchGetItemLive,
        DynamoDB.BatchWriteItemLive,
        DynamoDB.DescribeTableLive,
        DynamoDB.DescribeTimeToLiveLive,
        DynamoDB.ExecuteStatementLive,
        DynamoDB.ExecuteTransactionLive,
        DynamoDB.GetItemLive,
        DynamoDB.ListTablesLive,
        DynamoDB.ListTagsOfResourceLive,
        DynamoDB.PutItemLive,
        DynamoDB.DeleteItemLive,
        DynamoDB.UpdateItemLive,
        DynamoDB.UpdateTimeToLiveLive,
        DynamoDB.QueryLive,
        DynamoDB.RestoreTableToPointInTimeLive,
        DynamoDB.ScanLive,
        DynamoDB.TransactGetItemsLive,
        DynamoDB.TransactWriteItemsLive,
      ),
    ),
  ),
);
