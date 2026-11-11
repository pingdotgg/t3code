import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LinkNotFound, Links, LinkStoreError, newCode, type Link } from "./Links.ts";

/** `Links` stored in a DynamoDB table that this Layer owns. Reads are strongly consistent. */
export const LinksDynamo = Layer.effect(
  Links,
  Effect.gen(function* () {
    const table = yield* AWS.DynamoDB.Table("LinksTable", {
      partitionKey: "code",
      attributes: { code: "S" },
    });
    const getItem = yield* AWS.DynamoDB.GetItem(table);
    const putItem = yield* AWS.DynamoDB.PutItem(table);
    const scan = yield* AWS.DynamoDB.Scan(table);

    const toItem = (link: Link) => ({
      code: { S: link.code },
      link: { S: JSON.stringify(link) },
    });
    const fromItem = (item: { link?: { S?: string } }) => JSON.parse(item.link!.S!) as Link;

    const get = Effect.fn(function* (code: string) {
      const { Item } = yield* getItem({ Key: { code: { S: code } }, ConsistentRead: true });
      if (!Item) return yield* new LinkNotFound({ code });
      return fromItem(Item);
    });

    const storeError = (cause: unknown) => new LinkStoreError({ cause });

    return {
      create: Effect.fn(function* (url: string) {
        const link: Link = { code: newCode(), url, createdAt: Date.now() };
        yield* putItem({ Item: toItem(link) });
        return link;
      }, Effect.mapError(storeError)),
      get: (code: string) =>
        get(code).pipe(
          Effect.catchIf(
            (error) => error._tag !== "LinkNotFound",
            (cause) => Effect.fail(storeError(cause)),
          ),
        ),
      list: Effect.fn(function* () {
        const { Items } = yield* scan({ ConsistentRead: true });
        return (Items ?? []).map(fromItem).sort((a, b) => b.createdAt - a.createdAt);
      }, Effect.mapError(storeError)),
      setPreview: (code: string, preview: Link["preview"] & {}) =>
        get(code).pipe(
          Effect.flatMap((link) => putItem({ Item: toItem({ ...link, preview }) })),
          Effect.asVoid,
          Effect.catchIf(
            (error) => error._tag !== "LinkNotFound",
            (cause) => Effect.fail(storeError(cause)),
          ),
        ),
    };
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(AWS.DynamoDB.GetItemHttp, AWS.DynamoDB.PutItemHttp, AWS.DynamoDB.ScanHttp),
  ),
);
