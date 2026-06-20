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
const isSchemaNameParseError = Schema.is(Generator.AcpGeneratorSchemaNameParseError);
const isSchemaValueDeclarationMissingError = Schema.is(
  Generator.AcpGeneratorSchemaValueDeclarationMissingError,
);

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
  it.effect("retains safe URL diagnostics, output path, and HTTP cause when a download fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-generator-test-" });
      const url =
        "https://generator-user:generator-password@example.test/private/schema.json?token=generator-secret#fragment";
      const outputPath = `${directory}/schema.json`;
      const error = yield* Generator.downloadFile(url, outputPath).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          httpClient(new Response("unavailable", { status: 503 })),
        ),
        Effect.flip,
      );

      assert(isDownloadError(error));
      expect(error).toMatchObject({
        urlInputLength: url.length,
        urlProtocol: "https:",
        urlHostname: "example.test",
      });
      expect(error).not.toHaveProperty("url");
      expect(error.outputPath).toBe(outputPath);
      expect(error.stage).toBe("request");
      expect(error.cause).toBeDefined();
      expect(error.message).toContain(outputPath);
      const { cause: _, ...directDiagnostics } = error;
      expect(directDiagnostics).not.toHaveProperty("url");
      expect(directDiagnostics.urlProtocol).toBe("https:");
      expect(directDiagnostics.urlHostname).toBe("example.test");
      expect(error.message).not.toMatch(
        /generator-user|generator-password|private|token|generator-secret|fragment/,
      );
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
      expect(error).toMatchObject({
        urlInputLength: url.length,
        urlProtocol: "https:",
        urlHostname: "example.test",
      });
      expect(error).not.toHaveProperty("url");
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
      expect(error.argumentCount).toBe(2);
      expect(error).not.toHaveProperty("args");
      expect(error.generatedDir).toBe(generatedDir);
      expect(error.exitCode).toBe(23);
      expect(error.message).toContain("23");
      expect(spawned?.command).toBe("bun");
      expect(spawned?.args).toEqual(["oxfmt", generatedDir]);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  });

  it.effect("returns malformed generated schema declarations as typed failures", () =>
    Effect.gen(function* () {
      const missingValueError = yield* Generator.collectSchemaEntries(
        "export type Session = string;",
      ).pipe(Effect.flip);
      assert(isSchemaValueDeclarationMissingError(missingValueError));
      expect(missingValueError).toMatchObject({
        lineIndex: 0,
        typeDeclarationLength: 29,
        nextLinePresent: false,
      });
      expect(missingValueError).not.toHaveProperty("typeDeclaration");

      const nameParseError = yield* Generator.collectSchemaEntries(
        "export type @ = string;\nexport const invalid = Schema.String;",
      ).pipe(Effect.flip);
      assert(isSchemaNameParseError(nameParseError));
      expect(nameParseError).toMatchObject({
        lineIndex: 0,
        typeDeclarationLength: 23,
      });
      expect(nameParseError).not.toHaveProperty("typeDeclaration");
    }),
  );
});
