import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Generator from "./generate.ts";

const isGeneratorFetchError = Schema.is(Generator.GeneratorFetchError);

const httpClient = (response: Response) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)));

describe("Codex schema generator errors", () => {
  it.effect("retains safe URL diagnostics and the HTTP cause when fetching fails", () =>
    Effect.gen(function* () {
      const url =
        "https://generator-user:generator-password@example.test/private/schema.json?token=generator-secret#fragment";
      const error = yield* Generator.fetchText(url).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          httpClient(new Response("unavailable", { status: 503 })),
        ),
        Effect.flip,
      );

      assert(isGeneratorFetchError(error));
      expect(error).toMatchObject({
        urlInputLength: url.length,
        urlProtocol: "https:",
        urlHostname: "example.test",
      });
      expect(error).not.toHaveProperty("url");
      expect(error.stage).toBe("request");
      expect(error.cause).toBeDefined();
      const { cause: _, ...directDiagnostics } = error;
      expect(directDiagnostics).not.toHaveProperty("url");
      expect(directDiagnostics.urlProtocol).toBe("https:");
      expect(directDiagnostics.urlHostname).toBe("example.test");
      expect(error.message).not.toMatch(
        /generator-user|generator-password|private|token|generator-secret|fragment/,
      );
    }),
  );
});
