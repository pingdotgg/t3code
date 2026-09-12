import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as SourceControlMediaCredentials from "../sourceControl/SourceControlMediaCredentials.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlMediaProxy from "./SourceControlMediaProxy.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import { issueAssetUrl } from "./AssetAccess.ts";
import { assetRouteLayer } from "../http.ts";

const github = {
  _tag: "github",
  url: "https://github.com/user-attachments/assets/1234-abcd",
} as const;
const gitlab = {
  _tag: "gitlab",
  origin: "https://git.example",
  project: "123",
  secret: "e347d7ff85358d19b72222f1174b9a4b",
  fileName: "shot one.png",
} as const;
const signedUrl = "https://storage.example/image?X-Amz-Date=20260912T120000Z&X-Amz-Expires=300";

function fixture(input: {
  token?: () => string;
  fetch: (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>;
  commands?: Array<{ command: string; args: ReadonlyArray<string> }>;
}) {
  const cli = Layer.mergeAll(GitHubCli.layer, GitLabCli.layer).pipe(
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: ({ command, args }) =>
          Effect.sync(() => {
            input.commands?.push({ command, args });
            const token = input.token?.() ?? "dummy-token";
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: command === "gh" ? token : "",
              stderr:
                command === "glab" && token
                  ? `git.example\n  ✓ REST API Endpoint: https://api.git.example:3443/api/v4/\n  ✓ Token found in keyring: ${token}\n`
                  : "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      }),
    ),
  );
  return SourceControlMediaProxy.layer.pipe(
    Layer.provideMerge(SourceControlMediaCredentials.layer.pipe(Layer.provide(cli))),
    Layer.provide(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-image-proxy-" }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, Object.assign(input.fetch, { preconnect: () => {} })),
    ),
  );
}

describe("source-control image delivery", () => {
  it.effect(
    "serves signed assets through the real route and rejects tampering and expired grants",
    () =>
      Effect.gen(function* () {
        const config = ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-image-route-",
        });
        const dependencies = Layer.mergeAll(
          NodeHttpPlatform.layer,
          config,
          WorkspacePaths.layer,
          ServerSecretStore.layer.pipe(Layer.provide(config)),
          NativeAppIconResolver.layer.pipe(Layer.provide(config)),
          ProjectFaviconResolver.layer.pipe(
            Layer.provide(WorkspacePaths.layer),
            Layer.provide(T3ProjectFileLoader.layer),
          ),
          fixture({
            fetch: async (url, init) =>
              String(url).endsWith("clip.mp4")
                ? new Headers(init?.headers).get("range") === "bytes=2-5"
                  ? new Response("cdef", {
                      status: 206,
                      headers: {
                        "content-type": "application/octet-stream",
                        "content-range": "bytes 2-5/8",
                        "content-length": "4",
                        "accept-ranges": "bytes",
                      },
                    })
                  : new Headers(init?.headers).get("range") === "bytes=9-"
                    ? new Response(null, { status: 416, headers: { "content-range": "bytes */8" } })
                    : new Response("abcdefgh", {
                        headers: {
                          "content-type": "application/octet-stream",
                          "content-length": "8",
                          "accept-ranges": "bytes",
                        },
                      })
                : String(url).startsWith("https://github.com")
                  ? new Response(null, { status: 302, headers: { location: signedUrl } })
                  : new Response("<svg>image</svg>", {
                      headers: { "content-type": "image/svg+xml" },
                    }),
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        const services = Context.merge(
          yield* Effect.context<never>(),
          yield* Layer.build(dependencies),
        );
        const { handler, dispose } = HttpRouter.toWebHandler(
          assetRouteLayer.pipe(Layer.provideMerge(Layer.succeedContext(services))),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(dispose));
        yield* Effect.gen(function* () {
          const githubUrl = yield* issueAssetUrl({
            resource: { _tag: "source-control-media", reference: github },
          });
          const redirect = yield* Effect.promise(() =>
            handler(new Request(`http://t3.test${githubUrl.relativeUrl}`)),
          );
          expect(redirect.status).toBe(302);
          expect(redirect.headers.get("location")).toBe(signedUrl);
          const imageUrl = yield* issueAssetUrl({
            resource: { _tag: "source-control-media", reference: gitlab },
          });
          const fetchImage = (relativeUrl: string, method = "GET") =>
            Effect.promise(() => handler(new Request(`http://t3.test${relativeUrl}`, { method })));
          const image = yield* fetchImage(imageUrl.relativeUrl);
          expect(image.status).toBe(200);
          expect(image.headers.get("content-type")).toBe("image/svg+xml");
          expect(image.headers.get("content-security-policy")).toContain("sandbox");
          expect(yield* Effect.promise(() => image.text())).toBe("<svg>image</svg>");
          const head = yield* fetchImage(imageUrl.relativeUrl, "HEAD");
          expect(head.status).toBe(200);
          expect(yield* Effect.promise(() => head.text())).toBe("");
          expect(
            (yield* fetchImage(
              imageUrl.relativeUrl.replace("/api/assets/", "/api/assets/tampered"),
            )).status,
          ).toBe(404);
          expect(
            (yield* issueAssetUrl({
              resource: { _tag: "source-control-media", reference: gitlab },
            })).relativeUrl,
          ).toBe(imageUrl.relativeUrl);
          const videoUrl = yield* issueAssetUrl({
            resource: {
              _tag: "source-control-media",
              reference: { ...gitlab, fileName: "clip.mp4" },
            },
          });
          const requestVideo = (range?: string, method = "GET") =>
            Effect.promise(() =>
              handler(
                new Request(`http://t3.test${videoUrl.relativeUrl}`, {
                  method,
                  headers: range ? { range } : {},
                }),
              ),
            );
          const video = yield* requestVideo();
          expect(video.status).toBe(200);
          expect(video.headers.get("content-type")).toBe("video/mp4");
          expect(video.headers.get("accept-ranges")).toBe("bytes");
          expect(yield* Effect.promise(() => video.text())).toBe("abcdefgh");
          const segment = yield* requestVideo("bytes=2-5");
          expect(segment.status).toBe(206);
          expect(segment.headers.get("content-range")).toBe("bytes 2-5/8");
          expect(segment.headers.get("content-length")).toBe("4");
          expect(yield* Effect.promise(() => segment.text())).toBe("cdef");
          const invalidRange = yield* requestVideo("bytes=9-");
          expect(invalidRange.status).toBe(416);
          expect(invalidRange.headers.get("content-range")).toBe("bytes */8");
          const videoHead = yield* requestVideo("bytes=2-5", "HEAD");
          expect(videoHead.status).toBe(200);
          expect(videoHead.headers.get("content-length")).toBe("8");
          expect(yield* Effect.promise(() => videoHead.text())).toBe("");
          yield* TestClock.adjust("61 minutes");
          expect((yield* fetchImage(imageUrl.relativeUrl)).status).toBe(404);
        }).pipe(Effect.provide(Layer.succeedContext(services)));
      }),
  );

  it.effect("recognizes octet-stream image uploads and rejects unknown file types", () =>
    Effect.gen(function* () {
      const proxy = yield* SourceControlMediaProxy.SourceControlMediaProxy;
      const png = yield* proxy.resolve(gitlab);
      expect(png?.kind === "stream" && png.contentType).toBe("image/png");
      const svg = yield* proxy.resolve({ ...gitlab, fileName: "image.svg" });
      expect(svg?.kind === "stream" && svg.contentType).toBe("image/svg+xml");
      expect(yield* proxy.resolve({ ...gitlab, fileName: "page.html" })).toBeNull();
    }).pipe(
      Effect.provide(
        fixture({
          fetch: async () =>
            new Response("bytes", { headers: { "content-type": "application/octet-stream" } }),
        }),
      ),
    ),
  );

  it.effect("does not attach compressed lengths to a decoded media stream", () =>
    Effect.gen(function* () {
      const proxy = yield* SourceControlMediaProxy.SourceControlMediaProxy;
      const delivery = yield* proxy.resolve(gitlab);
      expect(delivery?.kind).toBe("stream");
      if (delivery?.kind !== "stream") return;
      expect(delivery.headers["content-length"]).toBeUndefined();
      expect(
        new TextDecoder().decode(
          yield* Stream.runFold(
            delivery.body,
            () => new Uint8Array(),
            (all, part) => new Uint8Array([...all, ...part]),
          ),
        ),
      ).toBe("decoded image bytes");
    }).pipe(
      Effect.provide(
        fixture({
          fetch: async (_url, init) => {
            expect(new Headers(init?.headers).get("accept-encoding")).toBe("identity");
            return new Response("decoded image bytes", {
              headers: {
                "content-type": "image/png",
                "content-encoding": "gzip",
                "content-length": "12",
              },
            });
          },
        }),
      ),
    ),
  );

  it.effect("aborts an unfinished GitLab transfer when the request scope closes", () => {
    let signal: AbortSignal | null | undefined;
    return Effect.gen(function* () {
      const proxy = yield* SourceControlMediaProxy.SourceControlMediaProxy;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const delivery = yield* proxy.resolve({ ...gitlab, fileName: "clip.mp4" });
          expect(delivery?.kind).toBe("stream");
          expect(signal?.aborted).toBe(false);
        }),
      );
      expect(signal?.aborted).toBe(true);
    }).pipe(
      Effect.provide(
        fixture({
          fetch: async (_url, init) => {
            signal = init?.signal;
            return new Response(new ReadableStream(), { headers: { "content-type": "video/mp4" } });
          },
        }),
      ),
    );
  });

  it.effect("retries a missing GitLab credential after login", () => {
    let token = "";
    return Effect.gen(function* () {
      const proxy = yield* SourceControlMediaProxy.SourceControlMediaProxy;
      expect(yield* proxy.resolve(gitlab)).toBeNull();
      token = "logged-in";
      const delivery = yield* proxy.resolve(gitlab);
      expect(delivery?.kind).toBe("stream");
    }).pipe(
      Effect.provide(
        fixture({
          token: () => token,
          fetch: async () => new Response("image", { headers: { "content-type": "image/png" } }),
        }),
      ),
    );
  });
  it.effect(
    "streams another GitLab project's image through a separate API host without forwarding its token",
    () => {
      const requests: Array<{ url: string; token: string | null; redirect: string | undefined }> =
        [];
      const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      return Effect.gen(function* () {
        const proxy = yield* SourceControlMediaProxy.SourceControlMediaProxy;
        const image = yield* proxy.resolve(gitlab);
        expect(image?.kind).toBe("stream");
        if (image?.kind !== "stream") throw new Error("Expected image stream");
        expect(yield* Stream.runCollect(image.body)).toEqual([
          new TextEncoder().encode("image bytes"),
        ]);
        expect(requests).toEqual([
          {
            url: `https://api.git.example:3443/api/v4/projects/123/uploads/${gitlab.secret}/shot%20one.png`,
            token: "dummy-token",
            redirect: "manual",
          },
          { url: "https://storage.example/image", token: null, redirect: "manual" },
        ]);
        expect(commands).toEqual([
          {
            command: "glab",
            args: ["auth", "status", "--hostname", "git.example", "--show-token"],
          },
        ]);
      }).pipe(
        Effect.provide(
          fixture({
            commands,
            fetch: async (url, init) => {
              requests.push({
                url: String(url),
                token: new Headers(init?.headers).get("private-token"),
                redirect: init?.redirect,
              });
              return String(url).includes("api.git.example")
                ? new Response(null, {
                    status: 302,
                    headers: { location: "https://storage.example/image" },
                  })
                : new Response("image bytes", { headers: { "content-type": "image/png" } });
            },
          }),
        ),
      );
    },
  );

  it.effect(
    "reuses concurrent successful credential lookups and picks up a later login immediately",
    () => {
      let token = "";
      const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const headers: Array<string | null> = [];
      return Effect.gen(function* () {
        const proxy = yield* SourceControlMediaProxy.SourceControlMediaProxy;
        yield* proxy.resolve(github);
        token = "logged-in";
        yield* Effect.all([proxy.resolve(github), proxy.resolve(github)], {
          concurrency: "unbounded",
        });
        expect(commands).toHaveLength(2);
        expect(headers).toEqual([null, "token logged-in", "token logged-in"]);
        yield* proxy.resolve(gitlab);
        yield* proxy.resolve(gitlab);
        expect(commands.filter((command) => command.command === "glab")).toHaveLength(1);
      }).pipe(
        Effect.provide(
          fixture({
            commands,
            token: () => token,
            fetch: async (_url, init) => {
              headers.push(new Headers(init?.headers).get("authorization"));
              return new Response(null, { status: 302, headers: { location: signedUrl } });
            },
          }),
        ),
      );
    },
  );

  it.effect(
    "aborts the unread GitHub response and returns a redirect instead of fetching image bytes",
    () => {
      let signal: AbortSignal | null | undefined;
      let requests = 0;
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 8, 12, 12, 2));
        const proxy = yield* SourceControlMediaProxy.SourceControlMediaProxy;
        expect(yield* proxy.resolve(github)).toEqual({
          kind: "redirect",
          location: signedUrl,
          cacheControl: "private, max-age=120",
        });
        expect(requests).toBe(1);
        expect(signal?.aborted).toBe(true);
      }).pipe(
        Effect.provide(
          fixture({
            fetch: async (_url, init) => {
              requests++;
              signal = init?.signal;
              return new Response("unread redirect body", {
                status: 302,
                headers: { location: signedUrl },
              });
            },
          }),
        ),
      );
    },
  );

  it.effect("bounds an unresponsive upstream request and aborts it", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let signal: AbortSignal | null | undefined;
      const program = Effect.gen(function* () {
        const proxy = yield* SourceControlMediaProxy.SourceControlMediaProxy;
        const fiber = yield* Effect.forkChild(proxy.resolve(github));
        yield* Deferred.await(started);
        yield* TestClock.adjust("16 seconds");
        expect(yield* Fiber.join(fiber)).toBeNull();
        expect(signal?.aborted).toBe(true);
      });
      yield* program.pipe(
        Effect.provide(
          fixture({
            fetch: (_url, init) => {
              signal = init?.signal;
              Deferred.doneUnsafe(started, Effect.void);
              return new Promise((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                }),
              );
            },
          }),
        ),
      );
    }),
  );

  it.effect("rejects HTML, redirect loops and HTTPS downgrades", () =>
    Effect.gen(function* () {
      for (const headers of [
        { "content-type": "text/html" },
        { location: "https://git.example/loop" },
        { location: "http://storage.example/image" },
      ]) {
        yield* Effect.gen(function* () {
          const proxy = yield* SourceControlMediaProxy.SourceControlMediaProxy;
          expect(yield* proxy.resolve(gitlab)).toBeNull();
        }).pipe(
          Effect.provide(
            fixture({
              fetch: async () =>
                new Response("body", { status: "location" in headers ? 302 : 200, headers }),
            }),
          ),
        );
      }
    }),
  );
});

describe("redirect cache lifetime", () => {
  it.each([
    [signedUrl, Date.UTC(2026, 8, 12, 12, 0), "private, max-age=240"],
    [signedUrl, Date.UTC(2026, 8, 12, 12, 4, 30), "private, no-store"],
    ["https://storage.example/unknown", 0, "private, no-store"],
    [signedUrl.replace("300", "invalid"), 0, "private, no-store"],
  ])("never outlives a signed target", (url, now, expected) => {
    expect(SourceControlMediaProxy.sourceControlRedirectCacheControl(url, now)).toBe(expected);
  });
});
