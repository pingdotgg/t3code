import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { pullRequestMediaResponse } from "./PullRequestMediaFetch.ts";
import { githubMediaResponse } from "./GitHubMediaFetch.ts";
import { GitHubCli } from "../sourceControl/GitHubCli.ts";

const asset = {
  version: 1 as const,
  kind: "pull-request-media" as const,
  provider: "gitlab" as const,
  reference: {
    projectId: Schema.decodeSync(ProjectId)("p1"),
    repository: "owner/repo",
    number: 7,
    host: "gitlab.example",
    expectedAccountId: "account-1",
  },
  url: `https://gitlab.example/owner/repo/uploads/${"a".repeat(32)}/clip.mp4`,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

it.effect("applies the same redirect boundary to legacy GitHub media", () => {
  const requests: string[] = [];
  return Effect.gen(function* () {
    const response = yield* githubMediaResponse(
      {
        url: "https://github.com/user-attachments/assets/id",
        cwd: "/repo",
        expiresAt: asset.expiresAt,
      },
      {},
    );
    expect(response.status).toBe(502);
    expect(requests).toEqual([
      "https://github.com/user-attachments/assets/id",
      "https://private-user-images.githubusercontent.com/object",
    ]);
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubCli)({
        execute: () =>
          Effect.succeed({
            stdout: "test-token",
            stderr: "",
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.url);
        expect(request.headers.authorization).toBe(
          requests.length === 1 ? "Bearer test-token" : undefined,
        );
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              status: 302,
              headers: {
                location:
                  requests.length === 1
                    ? "https://private-user-images.githubusercontent.com/object"
                    : "https://127.0.0.1/internal",
              },
            }),
          ),
        );
      }),
    ),
    Effect.scoped,
  );
});

it.effect("preserves signed PR scope and ranges while stripping auth on redirected media", () => {
  const redirects: string[] = [];
  return Effect.gen(function* () {
    const response = yield* pullRequestMediaResponse(asset, {
      range: "bytes=1-3",
      "if-range": "etag",
      authorization: "browser-token",
      cookie: "browser-cookie",
    });
    expect(response.status).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 1-3/5");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(redirects).toEqual(["https://storage.googleapis.com/bucket/signed-object"]);
  }).pipe(
    Effect.provide(
      Layer.mock(PullRequestService)({
        readAttachment: (input) => {
          expect(input.expectedAccountId).toBe("account-1");
          expect(input.repository).toBe("owner/repo");
          expect(input.headers).toEqual({
            range: "bytes=1-3",
            "if-range": "etag",
            "accept-encoding": "identity",
          });
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              HttpClientRequest.get(asset.url),
              new Response(null, {
                status: 302,
                headers: { location: "https://storage.googleapis.com/bucket/signed-object" },
              }),
            ),
          );
        },
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        redirects.push(request.url);
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
        expect(request.headers.range).toBe("bytes=1-3");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(new Uint8Array([0, 128, 255]), {
              status: 206,
              headers: { "content-type": "video/mp4", "content-range": "bytes 1-3/5" },
            }),
          ),
        );
      }),
    ),
    Effect.scoped,
  );
});

it.effect("refuses unapproved redirects at every hop before making a request", () =>
  Effect.gen(function* () {
    for (const location of [
      "https://127.0.0.1/private",
      "https://[::1]/private",
      "https://169.254.169.254/private",
      "https://10.0.0.1/private",
      "https://internal/private",
      "https://storage.googleapis.com.evil.example/private",
      "https://objects.githubusercontent.com/private",
      "https://storage.googleapis.com:444/private",
      "https://user@storage.googleapis.com/private",
      "http://storage.googleapis.com/private",
      "https://[invalid",
    ]) {
      let calls = 0;
      const response = yield* pullRequestMediaResponse(asset, {}).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            calls++;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, { status: 302, headers: { location } }),
              ),
            );
          }),
        ),
      );
      expect(response.status).toBe(502);
      expect(calls).toBe(1);
    }
  }).pipe(
    Effect.provide(
      Layer.mock(PullRequestService)({
        readAttachment: () =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              HttpClientRequest.get(asset.url),
              new Response(null, {
                status: 302,
                headers: { location: "https://storage.googleapis.com/bucket/object" },
              }),
            ),
          ),
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("keeps redirects within the verified private host and provider storage origins", () =>
  Effect.gen(function* () {
    for (const [provider, original, location] of [
      ["forgejo", "https://10.0.0.4:3000/attachments/id", "/attachments/id?download=1"],
      ["gitlab", asset.url, "https://bucket.s3.eu-west-1.amazonaws.com/object"],
      ["gitlab", asset.url, "https://storage.googleapis.com/bucket/object"],
      [
        "github",
        "https://github.com/user-attachments/assets/id",
        "https://private-user-images.githubusercontent.com/object",
      ],
      [
        "github",
        "https://github.com/user-attachments/assets/id",
        "https://github-production-user-asset-6210df.s3.amazonaws.com/object",
      ],
      [
        "github",
        "https://media.githubusercontent.com/media/o/r/main/video.mp4",
        "https://github-cloud.s3.amazonaws.com/object",
      ],
      [
        "bitbucket",
        "https://api.bitbucket.org/2.0/repositories/o/r/downloads/image.png",
        "https://bbuseruploads.s3.amazonaws.com/object",
      ],
      [
        "azure-devops",
        "https://dev.azure.com/org/project/attachment",
        "https://account.blob.core.windows.net/object",
      ],
    ] as const) {
      const response = yield* pullRequestMediaResponse({ ...asset, provider }, {}).pipe(
        Effect.provide(
          Layer.mock(PullRequestService)({
            readAttachment: () =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  HttpClientRequest.get(original),
                  new Response(null, { status: 302, headers: { location } }),
                ),
              ),
          }),
        ),
      );
      expect(response.status).toBe(200);
    }
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("image", { headers: { "content-type": "image/png" } }),
          ),
        ),
      ),
    ),
    Effect.scoped,
  ),
);

for (const [contentType, expected] of [
  ["image/svg+xml", 200],
  ["text/html", 415],
] as const) {
  it.effect(`keeps SVG sandbox and refuses active ${contentType} responses`, () =>
    Effect.gen(function* () {
      const response = yield* pullRequestMediaResponse(
        { ...asset, url: asset.url.replace("clip.mp4", "document") },
        {},
      );
      expect(response.status).toBe(expected);
      if (expected === 200)
        expect(response.headers["content-security-policy"]).toContain("sandbox");
    }).pipe(
      Effect.provide(
        Layer.mock(PullRequestService)({
          readAttachment: () =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                HttpClientRequest.get(asset.url),
                new Response("<svg/>", { headers: { "content-type": contentType } }),
              ),
            ),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("No redirect expected")),
      ),
      Effect.scoped,
    ),
  );
}
