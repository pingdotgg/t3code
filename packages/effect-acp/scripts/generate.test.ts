import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Generator from "./generate.ts";

const isDownloadError = Schema.is(Generator.AcpGeneratorDownloadError);
const isDownloadFileError = Schema.is(Generator.AcpGeneratorDownloadFileError);
const isDocumentDecodeError = Schema.is(Generator.AcpGeneratorDocumentDecodeError);
const isFormatExitError = Schema.is(Generator.AcpGeneratorFormatExitError);

const httpClient = (response: Response) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)));

function processHandle(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("ACP schema generator errors", () => {
  it.effect("retains the URL, output path, and HTTP cause when a download fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-generator-test-" });
      const url = "https://example.test/schema.json";
      const outputPath = `${directory}/schema.json`;
      const error = yield* Generator.downloadFile(url, outputPath).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          httpClient(new Response("unavailable", { status: 503 })),
        ),
        Effect.flip,
      );

      assert(isDownloadError(error));
      expect(error.url).toBe(url);
      expect(error.outputPath).toBe(outputPath);
      expect(error.stage).toBe("request");
      expect(error.cause).toBeDefined();
      expect(error.message).toContain(outputPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retains download context when the response cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outputPath = yield* fs.makeTempDirectoryScoped({ prefix: "acp-generator-test-" });
      const url = "https://example.test/schema.json";
      const error = yield* Generator.downloadFile(url, outputPath).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          httpClient(new Response("{}", { status: 200 })),
        ),
        Effect.flip,
      );

      assert(isDownloadFileError(error));
      expect(error.url).toBe(url);
      expect(error.outputPath).toBe(outputPath);
      expect(error.stage).toBe("write-file");
      expect(error.cause).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("adds source file context to upstream document decode failures", () =>
    Effect.gen(function* () {
      const schemaPath = "/tmp/upstream-schema.json";
      const schemaError = yield* Generator.decodeUpstreamSchemaDocument(
        "not-json",
        schemaPath,
      ).pipe(Effect.flip);
      assert(isDocumentDecodeError(schemaError));
      expect(schemaError.document).toBe("schema");
      expect(schemaError.filePath).toBe(schemaPath);
      expect(schemaError.cause).toBeDefined();

      const metadataPath = "/tmp/upstream-meta.json";
      const metadataError = yield* Generator.decodeMetaDocument("not-json", metadataPath).pipe(
        Effect.flip,
      );
      assert(isDocumentDecodeError(metadataError));
      expect(metadataError.document).toBe("metadata");
      expect(metadataError.filePath).toBe(metadataPath);
      expect(metadataError.cause).toBeDefined();
    }),
  );

  it.effect("reports formatter commands and nonzero exit codes structurally", () => {
    let spawned: ChildProcess.StandardCommand | undefined;
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) {
        spawned = command;
      }
      return Effect.succeed(processHandle(23));
    });

    return Effect.gen(function* () {
      const generatedDir = "/tmp/acp-generated";
      const error = yield* Generator.formatGeneratedFiles(generatedDir).pipe(Effect.flip);

      assert(isFormatExitError(error));
      expect(error.command).toBe("bun");
      expect(error.args).toEqual(["oxfmt", generatedDir]);
      expect(error.generatedDir).toBe(generatedDir);
      expect(error.exitCode).toBe(23);
      expect(error.message).toContain("23");
      expect(spawned?.command).toBe("bun");
      expect(spawned?.args).toEqual(error.args);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  });
});
