import * as Lambda from "@/AWS/Lambda";
import * as SimpleDB from "@/AWS/SimpleDB";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class SimpleDBTestFunction extends Lambda.Function<Lambda.Function>()(
  "SimpleDBTestFunction",
) {}

export default SimpleDBTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const domain = yield* SimpleDB.Domain("BindingsDomain", {});

    const putAttributes = yield* SimpleDB.PutAttributes(domain);
    const getAttributes = yield* SimpleDB.GetAttributes(domain);
    const deleteAttributes = yield* SimpleDB.DeleteAttributes(domain);
    const batchPutAttributes = yield* SimpleDB.BatchPutAttributes(domain);
    const batchDeleteAttributes = yield* SimpleDB.BatchDeleteAttributes(domain);
    const domainMetadata = yield* SimpleDB.DomainMetadata(domain);
    const select = yield* SimpleDB.Select(domain);
    const listDomains = yield* SimpleDB.ListDomains();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "POST" && pathname === "/put") {
          const body = (yield* request.json) as unknown as {
            item: string;
            attributes: { name: string; value: string; replace?: boolean }[];
          };
          yield* putAttributes({
            ItemName: body.item,
            Attributes: body.attributes.map((a) => ({
              Name: a.name,
              Value: a.value,
              Replace: a.replace ?? true,
            })),
          });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "GET" && pathname === "/get") {
          const item = url.searchParams.get("item");
          if (!item) {
            return HttpServerResponse.text("Missing item", { status: 400 });
          }
          const result = yield* getAttributes({
            ItemName: item,
            ConsistentRead: true,
          });
          return yield* HttpServerResponse.json({
            attributes: result.Attributes ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/select") {
          const where = url.searchParams.get("where");
          const result = yield* select({
            SelectExpression: (name) =>
              where
                ? `select * from \`${name}\` where ${where}`
                : `select * from \`${name}\``,
            ConsistentRead: true,
          });
          return yield* HttpServerResponse.json({
            items: result.Items ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/batch-put") {
          const body = (yield* request.json) as unknown as {
            items: {
              item: string;
              attributes: { name: string; value: string }[];
            }[];
          };
          yield* batchPutAttributes({
            Items: body.items.map((i) => ({
              ItemName: i.item,
              Attributes: i.attributes.map((a) => ({
                Name: a.name,
                Value: a.value,
                Replace: true,
              })),
            })),
          });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "POST" && pathname === "/batch-delete") {
          const body = (yield* request.json) as unknown as {
            items: string[];
          };
          yield* batchDeleteAttributes({
            Items: body.items.map((item) => ({ ItemName: item })),
          });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "DELETE" && pathname === "/delete") {
          const body = (yield* request.json) as unknown as {
            item: string;
            attributes?: string[];
          };
          yield* deleteAttributes({
            ItemName: body.item,
            ...(body.attributes
              ? { Attributes: body.attributes.map((name) => ({ Name: name })) }
              : {}),
          });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "GET" && pathname === "/domains") {
          const result = yield* listDomains({ MaxNumberOfDomains: 100 });
          return yield* HttpServerResponse.json({
            domainNames: result.DomainNames ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/metadata") {
          const result = yield* domainMetadata();
          return yield* HttpServerResponse.json({
            itemCount: result.ItemCount,
            attributeNameCount: result.AttributeNameCount,
            attributeValueCount: result.AttributeValueCount,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SimpleDB.BatchDeleteAttributesHttp,
        SimpleDB.BatchPutAttributesHttp,
        SimpleDB.DeleteAttributesHttp,
        SimpleDB.DomainMetadataHttp,
        SimpleDB.GetAttributesHttp,
        SimpleDB.ListDomainsHttp,
        SimpleDB.PutAttributesHttp,
        SimpleDB.SelectHttp,
      ),
    ),
  ),
);
