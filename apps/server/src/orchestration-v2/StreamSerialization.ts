import { OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaParser from "effect/SchemaParser";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

// Committed events are immutable and shared by subscriptions. The first subscriber
// validates and encodes an event; the others reuse its encoded stream item.
const cachedThreadItem = Schema.declareConstructor<OrchestrationV2ThreadStreamItem, unknown>()(
  [Schema.toCodecJson(OrchestrationV2ThreadStreamItem)],
  ([codec]) => {
    const parse = SchemaParser.decodeUnknownEffect(codec);
    const cache = new WeakMap<
      object,
      { readonly sequence: number; readonly value: OrchestrationV2ThreadStreamItem }
    >();
    return (input, _ast, options) => {
      if (
        !Predicate.isObject(input) ||
        input.kind !== "event" ||
        typeof input.sequence !== "number" ||
        !Predicate.isObject(input.event)
      )
        return parse(input, options);
      const key = input.event;
      const sequence = input.sequence;
      const previous = cache.get(key);
      if (previous?.sequence === sequence) return Effect.succeed(previous.value);
      return parse(input, options).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            cache.set(key, { sequence, value });
          }),
        ),
      );
    };
  },
);
const threadChunkCodec = Schema.NonEmptyArray(cachedThreadItem);
const strings = new WeakMap<object, string>();

const codecFor: RpcSerialization.CodecFor = (schema) => {
  const ast = schema.ast;
  if (
    ast._tag === "Arrays" &&
    ast.elements.length === 1 &&
    ast.rest.length === 1 &&
    ast.elements[0] === OrchestrationV2ThreadStreamItem.ast &&
    ast.rest[0] === OrchestrationV2ThreadStreamItem.ast
  ) {
    // The identity check above selects exactly NonEmptyArray(ThreadStreamItem).
    return threadChunkCodec as Schema.Codec<
      typeof schema.Type,
      unknown,
      typeof schema.DecodingServices,
      typeof schema.EncodingServices
    >;
  }
  return RpcSerialization.json.codecFor(schema);
};

export const layer = Layer.succeed(RpcSerialization.RpcSerialization, {
  ...RpcSerialization.json,
  codecFor,
  makeUnsafe: () => {
    const parser = RpcSerialization.json.makeUnsafe();
    const stringifyItem = (item: unknown) => {
      if (!Predicate.isObject(item) || item.kind !== "event") return JSON.stringify(item);
      const cached = strings.get(item);
      if (cached !== undefined) return cached;
      const encoded = JSON.stringify(item);
      strings.set(item, encoded);
      return encoded;
    };
    return {
      ...parser,
      encode: (response: unknown) => {
        if (
          !Predicate.isObject(response) ||
          response._tag !== "Chunk" ||
          !Array.isArray(response.values) ||
          !response.values.every((item) => Predicate.isObject(item) && item.kind === "event")
        ) {
          return parser.encode(response);
        }
        return `{"_tag":"Chunk","requestId":${JSON.stringify(response.requestId)},"values":[${response.values.map(stringifyItem).join(",")}]}`;
      },
    };
  },
});
