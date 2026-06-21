import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Generator from "./generate.ts";

const isDownloadError = Schema.is(Generator.AcpGeneratorDownloadError);

const httpClient = (response: Response) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)));

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
});
