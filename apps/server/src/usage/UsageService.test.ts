// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { UsageDay } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

const EmptyRatesHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
  ),
);

it.effect("reports a JSONL source as partial when a transcript cannot be read", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-usage-service-" });
    const claudeHome = path.join(root, "claude");
    const claudeProjects = path.join(claudeHome, "projects");
    const unreadableTranscript = path.join(claudeProjects, "session.jsonl");
    yield* fileSystem.makeDirectory(claudeProjects, { recursive: true });
    yield* fileSystem.writeFileString(unreadableTranscript, "{}");
    NodeFS.chmodSync(unreadableTranscript, 0);

    const usageService = yield* UsageService.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            providers: {
              claudeAgent: { homePath: claudeHome },
              codex: { homePath: path.join(root, "codex") },
            },
          }),
          ServerConfig.layerTest(process.cwd(), path.join(root, "t3-home")),
          EmptyRatesHttpClient,
          Layer.succeed(HostProcessEnvironment, {
            OPENCODE_DB: path.join(root, "missing-opencode.db"),
          }),
        ),
      ),
    );

    const summary = yield* usageService.readSummary({
      sinceDay: UsageDay.make("2026-08-22"),
      untilDay: UsageDay.make("2026-08-23"),
      timeZone: "UTC",
    });

    expect(
      summary.sources.find((source) => source.fingerprint.provider === "claude"),
    ).toMatchObject({
      status: "partial",
      scannedFiles: 0,
      skippedFiles: 1,
      message: "Some transcript files could not be read.",
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
