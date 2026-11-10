// Self-hosted relay entrypoint. The same composition as the Cloudflare Worker (`composition.ts`),
// served from Node with Postgres. See `host/node.ts` for what differs and why.
// @effect-diagnostics nodeBuiltinImport:off - the Node HTTP server is the platform entry point.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { makeWithDefaults } from "drizzle-orm/effect-postgres";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServer from "effect/http/HttpServer";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { composeRelay } from "./composition.ts";
import { makeNodeHost, withPublicOrigin } from "./host/node.ts";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const readSecret = (path: string) =>
    fs.readFileString(path).pipe(Effect.map((text) => text.trim()));

  const relayPublicOrigin = yield* Config.String("RELAY_PUBLIC_ORIGIN");
  const migrationsFolder = yield* Config.String("RELAY_MIGRATIONS_FOLDER").pipe(
    Config.withDefault("migrations/postgres"),
  );
  const mintPrivateKey = yield* readSecret(yield* Config.String("CLOUD_MINT_PRIVATE_KEY_FILE"));
  const mintPublicKey = yield* readSecret(yield* Config.String("CLOUD_MINT_PUBLIC_KEY_FILE"));
  // Compose passes unset variables as empty strings; an empty secret must count as absent.
  const nonEmpty = (value: Redacted.Redacted<string>) => Redacted.value(value).trim().length > 0;
  const apnsJobSigningSecret = Option.filter(
    yield* Config.option(Config.Redacted("APNS_DELIVERY_JOB_SIGNING_SECRET")),
    nonEmpty,
  );
  const mobileTelemetryToken = Option.filter(
    yield* Config.option(Config.Redacted("MOBILE_TELEMETRY_TOKEN")),
    nonEmpty,
  );

  const database = yield* makeWithDefaults();
  // A failed migration leaves the database in an unknown state; refuse to start instead of serving.
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - drizzle's migrate types its error as any
  yield* migrate(database, { migrationsFolder, migrationsTable: "relay_migrations" }).pipe(
    Effect.orDie,
  );

  const host = yield* makeNodeHost({
    relayPublicOrigin,
    stage: "selfhost",
    mintKeyPair: {
      privateKey: Redacted.make(mintPrivateKey),
      publicKey: mintPublicKey,
    },
    ...(apnsJobSigningSecret._tag === "Some"
      ? { apnsJobSigningSecret: apnsJobSigningSecret.value }
      : {}),
    database,
    mobileTelemetry: {
      token: mobileTelemetryToken._tag === "Some" ? mobileTelemetryToken.value : undefined,
      traces: yield* Config.String("MOBILE_TELEMETRY_TRACES_URL").pipe(Config.withDefault("")),
      logs: yield* Config.String("MOBILE_TELEMETRY_LOGS_URL").pipe(Config.withDefault("")),
      metrics: yield* Config.String("MOBILE_TELEMETRY_METRICS_URL").pipe(Config.withDefault("")),
    },
  });

  const relay = yield* composeRelay(host);
  // Built once: every request reuses the same services, as the Worker's per-isolate layers do.
  const context = yield* Layer.build(relay.runtime);
  const handler = yield* relay.fetch.pipe(Effect.provideContext(context));
  yield* HttpServer.serveEffect(
    handler.pipe(withPublicOrigin(relayPublicOrigin), Effect.provideContext(context)),
  );
  yield* Effect.logInfo("Self-hosted relay is serving", { relayPublicOrigin });
  // Serving is scoped to this program; keep it alive until the process is stopped.
  return yield* Effect.never;
});

const serverLayer = Layer.unwrap(
  Effect.map(Config.Int("PORT").pipe(Config.withDefault(8080)), (port) =>
    NodeHttpServer.layer(NodeHttp.createServer, { port, host: "0.0.0.0" }),
  ),
);

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        serverLayer,
        NodeServices.layer,
        FetchHttpClient.layer,
        SecureRandom.layerWebCrypto,
        PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") }),
      ),
    ),
  ),
);
