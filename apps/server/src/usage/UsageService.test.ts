import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { UsageDay } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";
import { listTranscriptFiles } from "./usageTranscriptReader.ts";

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
  ),
);

const AUGUST_WINDOW = {
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-31"),
  timeZone: "UTC",
} as const;

function makeUsageLayer(input: {
  readonly baseDir: string;
  readonly claudeHome: string;
  readonly codexHome: string;
  readonly fileSystem?: FileSystem.FileSystem;
}) {
  const platformLayer =
    input.fileSystem === undefined
      ? NodeServices.layer
      : Layer.merge(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, input.fileSystem));
  return UsageService.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provide(
      ServerSettings.layerTest({
        providers: {
          claudeAgent: { homePath: input.claudeHome },
          codex: { homePath: input.codexHome },
        },
      }),
    ),
    Layer.provide(TestHttpClientLive),
    Layer.provideMerge(platformLayer),
  );
}

function claudeUsageLine(outputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-08T12:00:00.000Z",
    sessionId: "session-a",
    message: {
      id: `msg-${outputTokens}`,
      model: "claude-fable-5",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        output_tokens: outputTokens,
      },
    },
  });
}

it.layer(NodeServices.layer)("UsageService", (it) => {
  it.effect("keeps an unreadable default Claude root instead of using the legacy fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-usage-service-default-root-",
      });
      const homePath = path.join(root, "home");
      const preferred = path.join(homePath, ".claude", "projects");
      yield* fileSystem.makeDirectory(path.dirname(preferred), { recursive: true });
      yield* fileSystem.writeFileString(preferred, "not a directory");

      const inspectionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "exists",
        description: "permission denied",
        pathOrDescriptor: preferred,
      });
      const failingFileSystem = {
        ...fileSystem,
        exists: (candidate: string) =>
          candidate === preferred ? Effect.fail(inspectionError) : fileSystem.exists(candidate),
      } satisfies FileSystem.FileSystem;

      const resolved = yield* UsageService.resolveClaudeTranscriptDir({
        homePath,
        explicitHome: false,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem));
      const listing = yield* Effect.promise(() => listTranscriptFiles(resolved, 0));

      expect(resolved).toBe(preferred);
      expect(listing.rootStatus).toBe("failed");
    }),
  );

  it.effect("uses the legacy default-home layout only when the preferred root is absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-usage-service-legacy-root-",
      });
      const homePath = path.join(root, "home");

      const resolved = yield* UsageService.resolveClaudeTranscriptDir({
        homePath,
        explicitHome: false,
      });

      expect(resolved).toBe(path.join(homePath, "projects"));
    }),
  );

  it.effect("reads an explicit Claude home directly without probing the default layout", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-usage-service-preferred-root-",
      });
      const baseDir = path.join(root, "t3-home");
      const claudeHome = path.join(root, "claude");
      const codexHome = path.join(root, "codex");
      const direct = path.join(claudeHome, "projects");
      const defaultLayout = path.join(claudeHome, ".claude", "projects");
      yield* fileSystem.makeDirectory(direct, { recursive: true });
      yield* fileSystem.writeFileString(path.join(direct, "usage.jsonl"), claudeUsageLine(40));
      yield* fileSystem.makeDirectory(path.dirname(defaultLayout), { recursive: true });
      yield* fileSystem.writeFileString(defaultLayout, "not a directory");

      const inspectionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "exists",
        description: "permission denied",
        pathOrDescriptor: defaultLayout,
      });
      const failingFileSystem = {
        ...fileSystem,
        exists: (candidate: string) =>
          candidate === defaultLayout ? Effect.fail(inspectionError) : fileSystem.exists(candidate),
      } satisfies FileSystem.FileSystem;

      const summary = yield* Effect.gen(function* () {
        const usage = yield* UsageService.UsageService;
        return yield* usage.readSummary(AUGUST_WINDOW);
      }).pipe(
        Effect.provide(
          makeUsageLayer({ baseDir, claudeHome, codexHome, fileSystem: failingFileSystem }),
        ),
      );

      expect(
        summary.sources.find(({ fingerprint }) => fingerprint.provider === "claude"),
      ).toMatchObject({
        fingerprint: { resolvedHomePath: direct },
        status: "ok",
        scannedFiles: 1,
        message: null,
      });
      expect(summary.buckets[0]?.totals.outputTokens).toBe(40);
    }),
  );

  it.effect("reports partial coverage while retaining readable transcript usage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-usage-service-partial-",
      });
      const baseDir = path.join(root, "t3-home");
      const claudeHome = path.join(root, "claude");
      const codexHome = path.join(root, "codex");
      const transcriptDir = path.join(claudeHome, "projects");
      const readablePath = path.join(transcriptDir, "readable.jsonl");
      const unreadablePath = path.join(transcriptDir, "unreadable.jsonl");

      yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
      yield* fileSystem.writeFileString(readablePath, claudeUsageLine(40));
      yield* fileSystem.writeFileString(unreadablePath, claudeUsageLine(900));
      yield* fileSystem.chmod(unreadablePath, 0o000);
      yield* Effect.addFinalizer(() => fileSystem.chmod(unreadablePath, 0o600).pipe(Effect.ignore));

      const summary = yield* Effect.gen(function* () {
        const usage = yield* UsageService.UsageService;
        return yield* usage.readSummary(AUGUST_WINDOW);
      }).pipe(Effect.provide(makeUsageLayer({ baseDir, claudeHome, codexHome })));

      const source = summary.sources.find(({ fingerprint }) => fingerprint.provider === "claude");
      expect(source).toMatchObject({
        status: "partial",
        scannedFiles: 1,
        skippedFiles: 1,
        message: "Usage may be incomplete: 1 transcript file could not be read.",
      });
      expect(summary.buckets).toHaveLength(1);
      expect(summary.buckets[0]?.totals.outputTokens).toBe(40);
    }),
  );

  it.effect("reports failed coverage when an existing transcript root cannot be listed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-usage-service-failed-",
      });
      const baseDir = path.join(root, "t3-home");
      const claudeHome = path.join(root, "claude");
      const codexHome = path.join(root, "codex");
      const transcriptDir = path.join(claudeHome, "projects");

      yield* fileSystem.makeDirectory(path.dirname(transcriptDir), { recursive: true });
      yield* fileSystem.writeFileString(transcriptDir, "not a directory");

      const summary = yield* Effect.gen(function* () {
        const usage = yield* UsageService.UsageService;
        return yield* usage.readSummary(AUGUST_WINDOW);
      }).pipe(Effect.provide(makeUsageLayer({ baseDir, claudeHome, codexHome })));

      expect(
        summary.sources.find(({ fingerprint }) => fingerprint.provider === "claude"),
      ).toMatchObject({
        status: "failed",
        scannedFiles: 0,
        skippedFiles: 0,
        message: "Transcript directory could not be read.",
      });
      expect(
        summary.sources.find(({ fingerprint }) => fingerprint.provider === "codex"),
      ).toMatchObject({
        status: "missing",
        message: "No transcript directory on this environment.",
      });
      expect(summary.buckets).toHaveLength(0);
    }),
  );

  it.effect("reports partial coverage when a nested transcript directory cannot be listed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-usage-service-nested-partial-",
      });
      const baseDir = path.join(root, "t3-home");
      const claudeHome = path.join(root, "claude");
      const codexHome = path.join(root, "codex");
      const transcriptDir = path.join(claudeHome, "projects");
      const unreadableDir = path.join(transcriptDir, "unreadable-session");

      yield* fileSystem.makeDirectory(unreadableDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(transcriptDir, "readable.jsonl"),
        claudeUsageLine(40),
      );
      yield* fileSystem.writeFileString(
        path.join(unreadableDir, "hidden.jsonl"),
        claudeUsageLine(900),
      );
      yield* fileSystem.chmod(unreadableDir, 0o000);
      yield* Effect.addFinalizer(() => fileSystem.chmod(unreadableDir, 0o700).pipe(Effect.ignore));

      const summary = yield* Effect.gen(function* () {
        const usage = yield* UsageService.UsageService;
        return yield* usage.readSummary(AUGUST_WINDOW);
      }).pipe(Effect.provide(makeUsageLayer({ baseDir, claudeHome, codexHome })));

      expect(
        summary.sources.find(({ fingerprint }) => fingerprint.provider === "claude"),
      ).toMatchObject({
        status: "partial",
        scannedFiles: 1,
        skippedFiles: 0,
        message: "Usage may be incomplete: 1 transcript path could not be listed or inspected.",
      });
      expect(summary.buckets).toHaveLength(1);
      expect(summary.buckets[0]?.totals.outputTokens).toBe(40);
    }),
  );
});
