// @effect-diagnostics nodeBuiltinImport:off - The local server is a plain Node HTTP server.
/**
 * The relay's mobile telemetry route on this machine, for testing crash
 * reports from a real app build without deploying a relay stage:
 *
 *   node scripts/mobile-telemetry-local.ts [port] [dir]
 *
 * It runs the relay's own ingest and symbolication. Axiom is replaced by
 * `<dir>/forwarded`, which receives every payload as it would be forwarded,
 * and R2 by `<dir>/maps`, which also takes S3 PUTs so
 * `apps/mobile/scripts/upload-sourcemaps.mts` can upload into it. Build the
 * app with `T3CODE_RELAY_URL=http://<this machine's LAN address>:<port>`.
 */
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as MobileTelemetry from "../src/mobileTelemetry/MobileTelemetry.ts";

// `vp run` passes its `--` separator through.
const [portArg, dirArg] = process.argv.slice(2).filter((arg) => arg !== "--");
const port = Number(portArg ?? 4318);

const Attributes = Schema.Array(
  Schema.Struct({
    key: Schema.String,
    value: Schema.optional(Schema.Struct({ stringValue: Schema.optional(Schema.String) })),
  }),
);
/** The parts of an OTLP/JSON logs request this script prints. */
const LogsPayload = Schema.Struct({
  resourceLogs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        resource: Schema.optional(Schema.Struct({ attributes: Schema.optional(Attributes) })),
        scopeLogs: Schema.optional(
          Schema.Array(
            Schema.Struct({
              logRecords: Schema.optional(
                Schema.Array(Schema.Struct({ attributes: Schema.optional(Attributes) })),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});
const decodeLogsPayload = Schema.decodeUnknownOption(Schema.fromJsonString(LogsPayload));

const attribute = (attributes: typeof Attributes.Type | undefined, key: string) =>
  attributes?.find((candidate) => candidate.key === key)?.value?.stringValue;

/** One entry per JavaScript exception: its bundle and how symbolication went, then the stack. */
const describeExceptions = (body: string) =>
  Option.match(decodeLogsPayload(body), {
    onNone: () => [],
    onSome: (payload) =>
      (payload.resourceLogs ?? []).flatMap((resourceLogs) => {
        const resource = resourceLogs.resource?.attributes;
        return (resourceLogs.scopeLogs ?? []).flatMap((scopeLogs) =>
          (scopeLogs.logRecords ?? []).flatMap((record) => {
            const stack = attribute(record.attributes, "exception.stacktrace");
            if (stack === undefined) return [];
            return [
              [
                `  ${attribute(record.attributes, "expo.error.source")} exception: ${attribute(record.attributes, "exception.message")}`,
                `    os=${attribute(resource, "os.type")} update=${attribute(resource, "expo.app.updates.id")} build=${attribute(resource, "expo.eas_build.id")}`,
                `    symbolication=${attribute(record.attributes, "relay.symbolication.status")} map=${attribute(record.attributes, "relay.symbolication.source_map")}`,
                ...stack
                  .split("\n")
                  .slice(0, 10)
                  .map((line) => `    | ${line}`),
              ].join("\n"),
            ];
          }),
        );
      }),
  });

const layerRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.resolve(dirArg ?? path.join(NodeOS.tmpdir(), "t3-mobile-telemetry"));
    const mapsDir = path.join(dir, "maps");
    const forwardedDir = path.join(dir, "forwarded");
    yield* fs.makeDirectory(mapsDir, { recursive: true });
    yield* fs.makeDirectory(forwardedDir, { recursive: true });

    /** The file for an R2 key, or undefined when the key would leave `maps`. */
    const mapPath = (key: string) => {
      const file = path.resolve(mapsDir, key);
      return file.startsWith(mapsDir + path.sep) ? file : undefined;
    };

    const sourceMapObjects = Layer.succeed(MobileTelemetry.SourceMapObjects, {
      get: Effect.fn("LocalSourceMapObjects.get")(
        function* (key: string) {
          const file = mapPath(key);
          if (file === undefined || !(yield* fs.exists(file))) return undefined;
          const { size } = yield* fs.stat(file);
          return {
            size: Number(size),
            text: fs
              .readFileString(file)
              .pipe(
                Effect.mapError(
                  (cause) => new MobileTelemetry.SourceMapObjectError({ key, cause }),
                ),
              ),
          };
        },
        (effect, key) =>
          effect.pipe(
            Effect.mapError((cause) => new MobileTelemetry.SourceMapObjectError({ key, cause })),
          ),
      ),
    });

    /** Stands in for Axiom: keeps each forwarded payload and summarizes logs. */
    const axiom = HttpClient.make((request) =>
      Effect.gen(function* () {
        const dataset = request.headers["x-axiom-dataset"] ?? "unknown";
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const file = path.join(forwardedDir, `${yield* Clock.currentTimeMillis}-${dataset}.json`);
        yield* fs.writeFileString(file, body).pipe(Effect.orDie);
        yield* Console.log(`forwarded ${dataset} (${body.length} bytes) to ${file}`);
        for (const line of dataset === "logs" ? describeExceptions(body) : []) {
          yield* Console.log(line);
        }
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    );

    const telemetry = yield* MobileTelemetry.MobileTelemetry.pipe(
      Effect.provide(
        MobileTelemetry.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(MobileTelemetry.MobileTelemetrySettings, {
                axiomToken: Redacted.make("local"),
                destinations: {
                  traces: { url: "http://axiom.local/v1/traces", dataset: "traces" },
                  logs: { url: "http://axiom.local/v1/logs", dataset: "logs" },
                  metrics: { url: "http://axiom.local/v1/metrics", dataset: "metrics" },
                },
              }),
              Layer.succeed(MobileTelemetry.MobileTelemetryRateLimiter, {
                allow: () => Effect.succeed(true),
              }),
              MobileTelemetry.layerSourceMaps.pipe(Layer.provide(sourceMapObjects)),
              Layer.succeed(HttpClient.HttpClient, axiom),
            ),
          ),
        ),
      ),
    );

    // S3 PutObject as the upload script sends it, `/<bucket>/<key>`. The
    // signature is not checked: this stands in for the bucket, not its access.
    const storeMap = Effect.fn(function* (request: HttpServerRequest.HttpServerRequest) {
      const key = new URL(request.url, "http://local").pathname.split("/").slice(2).join("/");
      const file = mapPath(key);
      if (file === undefined) return HttpServerResponse.empty({ status: 400 });
      const body = new Uint8Array(yield* request.arrayBuffer);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFile(file, body);
      yield* Console.log(`stored map ${key} (${body.length} bytes)`);
      return HttpServerResponse.empty({ status: 200 });
    });

    yield* Console.log(
      [
        `Mobile telemetry on port ${port}; maps and forwarded payloads in ${dir}`,
        `Build the app with T3CODE_RELAY_URL=http://<this machine's LAN address>:${port}`,
        `Upload maps with MOBILE_SOURCEMAPS_R2='{"endpoint":"http://127.0.0.1:${port}","bucketName":"local","accessKeyId":"local","secretAccessKey":"local"}'`,
      ].join("\n"),
    );

    return HttpRouter.add("*", "*", (request) =>
      request.method === "PUT"
        ? storeMap(request).pipe(Effect.orDie)
        : telemetry
            .handle(request)
            .pipe(
              Effect.tap((response) =>
                Console.log(`${request.method} ${request.url} -> ${response.status}`),
              ),
            ),
    );
  }),
);

HttpRouter.serve(layerRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, { port, host: "0.0.0.0" })),
  Layer.provide(NodeServices.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
