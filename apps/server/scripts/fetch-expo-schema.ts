#!/usr/bin/env node
/**
 * Refreshes `schema/expo.graphql` from Expo's API, which answers introspection
 * without a credential. eas-cli generates its own client from the same
 * endpoint. Run `vp run generate` afterwards to regenerate the operations.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  buildClientSchema,
  getIntrospectionQuery,
  lexicographicSortSchema,
  printSchema,
  type IntrospectionQuery,
} from "graphql";

const EXPO_GRAPHQL_URL = "https://api.expo.dev/graphql";

const IntrospectionResponse = Schema.Struct({
  data: Schema.Struct({ __schema: Schema.Unknown }),
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* HttpClientRequest.post(EXPO_GRAPHQL_URL).pipe(
    HttpClientRequest.bodyJson({ query: getIntrospectionQuery() }),
    Effect.flatMap(client.execute),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(IntrospectionResponse)),
  );
  // Sorted so a refresh diffs by what Expo changed, not by its declaration order.
  const sdl = printSchema(
    lexicographicSortSchema(buildClientSchema(response.data as unknown as IntrospectionQuery)),
  );
  const target = path.join(import.meta.dirname, "..", "schema", "expo.graphql");
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, `${sdl}\n`);
  yield* Effect.log(`Wrote ${target}`);
});

program.pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  NodeRuntime.runMain,
);
