#!/usr/bin/env node
/**
 * Rewrites the `benchmarks` section of the model manifest from Slopalytics.
 *
 *   pnpm benchmarks:refresh && vp fmt apps/server/src/provider/model-manifest.json
 *
 * Slopalytics publishes no JSON endpoint, so this reads the variant literals
 * out of its JS bundle. Each variant is a model family (a T3 slug with dots as
 * dashes) at one reasoning effort, scored on the Artificial Analysis coding
 * index. Review the diff before committing: a bundle change can break parsing.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

const SITE = "https://slopalytics.com";
/** Ids are written into JSON unescaped, so only slug characters pass. */
const ID_PATTERN = /^[\w.-]+$/;

class BenchmarkRefreshError extends Schema.TaggedError<BenchmarkRefreshError>()(
  "BenchmarkRefreshError",
  { message: Schema.String },
) {}

const fetchText = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
  );

const readField = (body: string, key: string) =>
  new RegExp(`(?:^|,)${key}:(\`[^\`]*\`|-?[\\d.]+(?:e[+-]?\\d+)?)`).exec(body)?.[1];

/** Every priced variant in the bundle, one per family and effort. */
function parseBenchmarkVariants(bundle: string) {
  const variants = new Map<string, { intelligence: number; costPerTask: number }>();
  for (const [, model, body = ""] of bundle.matchAll(/\{id:`[^`]+`,family:`([^`]+)`,(.*?)\}/g)) {
    const effort = readField(body, "effort")?.replaceAll("`", "");
    const intelligence = Number(readField(body, "intelligence"));
    const costPerTask = Number(readField(body, "cost"));
    if (!model || !ID_PATTERN.test(model) || !effort || !ID_PATTERN.test(effort)) continue;
    if (!(intelligence > 0) || !(costPerTask > 0)) continue;
    variants.set(`${model}\u0000${effort}`, {
      intelligence: Number(intelligence.toFixed(2)),
      costPerTask: Number(costPerTask.toPrecision(4)),
    });
  }
  return [...variants]
    .map(([key, scores]) => {
      const [model = "", effort = ""] = key.split("\u0000");
      return { model, effort, ...scores };
    })
    .toSorted((a, b) => a.model.localeCompare(b.model) || a.costPerTask - b.costPerTask);
}

const refresh = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = yield* path.fromFileUrl(
    new URL("../apps/server/src/provider/model-manifest.json", import.meta.url),
  );

  const html = yield* fetchText(`${SITE}/`);
  const bundlePath = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
  if (!bundlePath) {
    return yield* new BenchmarkRefreshError({ message: "Slopalytics bundle script tag not found" });
  }
  const variants = parseBenchmarkVariants(yield* fetchText(`${SITE}${bundlePath}`));
  if (variants.length < 20) {
    return yield* new BenchmarkRefreshError({
      message: `Only ${variants.length} priced variants parsed`,
    });
  }

  const now = DateTime.formatIso(yield* DateTime.now).replace(/\.\d+Z$/, "Z");
  // One variant per line keeps refresh diffs readable.
  const rows = variants.map(
    (variant) =>
      `      { "model": "${variant.model}", "effort": "${variant.effort}", ` +
      `"intelligence": ${variant.intelligence}, "costPerTask": ${variant.costPerTask} }`,
  );
  const section = [
    "{",
    `    "source": "Slopalytics",`,
    `    "url": "${SITE}/?frontier=true",`,
    `    "updatedAt": "${now}",`,
    `    "variants": [\n${rows.join(",\n")}\n    ]`,
    "  }",
  ].join("\n");

  // Edit the text rather than re-serializing, so the rest of the file keeps its
  // formatting. `benchmarks` stays the last top-level key.
  const original = yield* fs.readFileString(manifestPath);
  const head = original
    .slice(0, original.search(/,\n {2}"benchmarks": \{|\n\}\s*$/))
    .replace(/^ {2}"updatedAt": "[^"]*"/m, `  "updatedAt": "${now}"`);
  yield* fs.writeFileString(manifestPath, `${head},\n  "benchmarks": ${section}\n}\n`);
  yield* Effect.logInfo(`Wrote ${variants.length} benchmark variants`);
});

if (import.meta.main) {
  refresh.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
