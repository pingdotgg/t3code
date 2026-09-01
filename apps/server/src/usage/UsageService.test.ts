// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  ProviderInstanceId,
  UsageDay,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const EmptyRatesHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
  ),
);

it.effect("includes an OpenCode instance database override in the summary", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-usage-service-" });
    const databasePath = path.join(root, "opencode.db");
    const completedAt = Date.parse("2026-08-27T12:00:00.000Z");

    const database = new NodeSqlite.DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
      database
        .prepare(
          "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "message-1",
          "session-1",
          completedAt,
          completedAt,
          encodeUnknownJson({
            role: "assistant",
            time: { completed: completedAt },
            providerID: "openai",
            modelID: "gpt-5.4",
            tokens: {
              input: 5,
              output: 2,
              reasoning: 1,
              cache: { read: 4, write: 3 },
            },
            cost: 0.25,
          }),
        );
    } finally {
      database.close();
    }

    const usageService = yield* UsageService.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            providers: {
              claudeAgent: { homePath: path.join(root, "claude") },
              codex: { homePath: path.join(root, "codex") },
            },
            providerInstances: {
              [ProviderInstanceId.make("opencode_custom")]: {
                driver: ProviderDriverKind.make("opencode"),
                environment: [
                  {
                    name: ProviderInstanceEnvironmentVariableName.make("OPENCODE_DB"),
                    value: databasePath,
                    sensitive: false,
                  },
                ],
              },
            },
          }),
          ServerConfig.layerTest(process.cwd(), path.join(root, "t3-home")),
          EmptyRatesHttpClient,
          Layer.succeed(HostProcessEnvironment, {
            GROK_HOME: path.join(root, "grok"),
            OPENCODE_DB: path.join(root, "missing-global-opencode.db"),
          }),
        ),
      ),
    );

    const summary = yield* usageService.readSummary({
      sinceDay: UsageDay.make("2026-08-27"),
      untilDay: UsageDay.make("2026-08-27"),
      timeZone: "UTC",
    });

    expect(
      summary.sources.find(
        (source) =>
          source.fingerprint.provider === "opencode" &&
          source.fingerprint.resolvedHomePath === databasePath,
      ),
    ).toMatchObject({
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
    });
    expect(summary.buckets.find((bucket) => bucket.provider === "opencode")).toMatchObject({
      day: "2026-08-27",
      sourcePath: databasePath,
      model: "openai/gpt-5.4",
      totals: {
        uncachedInputTokens: 5,
        cachedInputTokens: 4,
        cacheCreationTokens: 3,
        outputTokens: 3,
        reasoningTokens: 1,
      },
      costUsd: 0.25,
      costSource: "providerReported",
      records: 1,
      sessions: 1,
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
