import { expect, it } from "@effect/vitest";
import { fakeSourceControlDriverInstance } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { sourceControlMediaResponse } from "./sourceControlMediaResponse.ts";

it.effect.each(["image/svg+xml", "text/html"])(
  "preserves content defenses for %s",
  (contentType) => {
    const url = "https://github.com/user-attachments/assets/fake";
    const media = sourceControlDefinitions.mediaUrl(url)!;
    return Effect.gen(function* () {
      const response = yield* sourceControlMediaResponse(
        { url, cwd: "/untrusted-checkout", expiresAt: Number.MAX_SAFE_INTEGER },
        { range: "bytes=0-9", authorization: "never-forward" },
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.status).toBe(contentType === "image/svg+xml" ? 200 : 415);
      if (contentType === "image/svg+xml")
        expect(response.headers["content-security-policy"]).toContain("sandbox");
    }).pipe(
      Effect.provide(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: (cwd) => {
            expect(cwd).toBe("/untrusted-checkout");
            return Effect.succeed(null);
          },
        }),
      ),
      Effect.provideService(BuiltInDrivers.SourceControlDrivers, [
        {
          driver: { kind: media.definition.kind, definition: media.definition },
          instance: fakeSourceControlDriverInstance(media.definition.kind, {
            pullRequests: null,
            fetchMedia: (request) => {
              expect(request.headers.range).toBe("bytes=0-9");
              expect(request.headers.authorization).toBeUndefined();
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  HttpClientRequest.get(request.url),
                  new Response("synthetic", {
                    headers: { "content-type": contentType, "set-cookie": "never-forward" },
                  }),
                ),
              );
            },
          }),
        },
      ]),
      Effect.scoped,
    );
  },
);
