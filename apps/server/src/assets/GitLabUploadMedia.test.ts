import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
  HttpServerResponse,
} from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { GitLabUploadReference } from "@t3tools/contracts";
import * as GitLabUploadMedia from "./GitLabUploadMedia.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const reference: GitLabUploadReference = {
  origin: "http://gl.here",
  project: "team/project",
  secret: "66dbcd21ec5d24ed6ea225176098d52b",
  fileName: "my clip.mp4",
};
const output = (stdout: string) => ({
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  exitCode: ChildProcessSpawner.ExitCode(0),
});

function fixture(
  options: {
    protocol?: string;
    endpoint?: string;
    token?: () => string;
    environment?: NodeJS.ProcessEnv;
    response?: (
      request: { url: string; method: string; headers: Readonly<Record<string, string>> },
      index: number,
    ) => Response;
  } = {},
) {
  const commands: ReadonlyArray<string>[] = [];
  const requests: { url: string; method: string; headers: Readonly<Record<string, string>> }[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        options.response?.(request, requests.length - 1) ??
          new Response("video-bytes", {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": "11",
              "accept-ranges": "bytes",
            },
          }),
      ),
    );
  });
  const layer = GitLabUploadMedia.layer.pipe(
    Layer.provide(
      GitLabCli.layer.pipe(
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: ({ args, env }) => {
              commands.push(args);
              const environment = { ...options.environment, ...env };
              // glab gives ambient access tokens precedence over the selected host's stored token.
              const token =
                environment.GITLAB_TOKEN ||
                environment.GITLAB_ACCESS_TOKEN ||
                environment.OAUTH_TOKEN ||
                (options.token?.() ?? "private-credential") ||
                (environment.GLAB_ENABLE_CI_AUTOLOGIN === "true" ? environment.CI_JOB_TOKEN : "");
              return Effect.succeed(
                output(
                  args[0] === "config"
                    ? (options.protocol ?? "https")
                    : `REST API Endpoint: ${options.endpoint ?? "https://api.example/api/v4/"}\nToken found in config file: ${token}`,
                ),
              );
            },
          }),
        ),
      ),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-gitlab-media-test-" }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { layer, commands, requests };
}

describe("GitLabUploadMedia", () => {
  it.effect.each(["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN"])(
    "does not use ambient %s for an upload-selected host",
    (key) => {
      const environment = { [key]: "ambient-secret", GLAB_ENABLE_CI_AUTOLOGIN: "true" };
      const configured = fixture({ environment });
      const unconfigured = fixture({ environment, token: () => "" });
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* GitLabUploadMedia.GitLabUploadMedia;
          expect((yield* service.respond(reference, {}, "GET")).status).toBe(200);
          expect(configured.requests[0]?.headers["private-token"]).toBe("private-credential");
        }).pipe(Effect.provide(configured.layer));
        yield* Effect.gen(function* () {
          const service = yield* GitLabUploadMedia.GitLabUploadMedia;
          expect((yield* service.respond(reference, {}, "GET")).status).toBe(502);
          expect(unconfigured.requests).toHaveLength(0);
        }).pipe(Effect.provide(unconfigured.layer));
      }).pipe(Effect.scoped);
    },
  );

  it.effect("streams decoded upload names through the HTTPS API and reuses the credential", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* GitLabUploadMedia.GitLabUploadMedia;
      const response = HttpServerResponse.toWeb(yield* service.respond(reference, {}, "GET"));
      expect(yield* Effect.promise(() => response.text())).toBe("video-bytes");
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      yield* service.respond(reference, {}, "GET");
      expect(f.commands).toHaveLength(2);
      expect(f.commands[1]).toEqual(["auth", "status", "--hostname", "gl.here", "--show-token"]);
      expect(f.requests[0]?.url).toBe(
        `https://api.example/api/v4/projects/team%2Fproject/uploads/${reference.secret}/my%20clip.mp4`,
      );
      expect(f.requests[0]?.headers["private-token"]).toBe("private-credential");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("rejects plaintext configuration before auth status can transmit a credential", () => {
    const f = fixture({ protocol: "http" });
    return Effect.gen(function* () {
      const service = yield* GitLabUploadMedia.GitLabUploadMedia;
      expect((yield* service.respond(reference, {}, "GET")).status).toBe(502);
      expect(f.commands).toHaveLength(1);
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("rejects a plaintext API endpoint even when the configured protocol is HTTPS", () => {
    const f = fixture({ endpoint: "http://api.example/api/v4/" });
    return Effect.gen(function* () {
      const service = yield* GitLabUploadMedia.GitLabUploadMedia;
      expect((yield* service.respond(reference, {}, "GET")).status).toBe(502);
      expect(f.requests).toHaveLength(0);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("does not cache a missing credential after login", () => {
    let token = "";
    const f = fixture({ token: () => token });
    return Effect.gen(function* () {
      const service = yield* GitLabUploadMedia.GitLabUploadMedia;
      expect((yield* service.respond(reference, {}, "GET")).status).toBe(502);
      token = "signed-in";
      expect((yield* service.respond(reference, {}, "GET")).status).toBe(200);
      expect(f.commands).toHaveLength(4);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("keeps credentials off storage redirects, including a later hop back", () => {
    const f = fixture({
      response: (_, index) =>
        index < 2
          ? new Response(null, {
              status: 302,
              headers: {
                location:
                  index === 0 ? "https://storage.example/signed" : "https://api.example/file",
              },
            })
          : new Response("png", { headers: { "content-type": "image/png" } }),
    });
    return Effect.gen(function* () {
      const service = yield* GitLabUploadMedia.GitLabUploadMedia;
      expect((yield* service.respond(reference, {}, "GET")).status).toBe(200);
      expect(f.requests.map((r) => r.headers["private-token"])).toEqual([
        "private-credential",
        undefined,
        undefined,
      ]);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("forwards ranges and if-range and serves HEAD without a body", () => {
    const f = fixture({
      response: ({ method }) =>
        new Response(method === "HEAD" ? null : "part", {
          status: method === "HEAD" ? 200 : 206,
          headers: {
            "content-type": "video/mp4",
            "content-range": "bytes 2-5/11",
            "content-length": "4",
          },
        }),
    });
    return Effect.gen(function* () {
      const service = yield* GitLabUploadMedia.GitLabUploadMedia;
      const response = HttpServerResponse.toWeb(
        yield* service.respond(reference, { range: "bytes=2-5", "if-range": '"etag"' }, "GET"),
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 2-5/11");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(yield* Effect.promise(() => response.text())).toBe("part");
      expect(f.requests[0]?.headers.range).toBe("bytes=2-5");
      expect(f.requests[0]?.headers["if-range"]).toBe('"etag"');
      const head = HttpServerResponse.toWeb(yield* service.respond(reference, {}, "HEAD"));
      expect(f.requests[1]?.method).toBe("HEAD");
      expect(yield* Effect.promise(() => head.text())).toBe("");
      expect(head.headers.get("cache-control")).toBe("private, no-store");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("uses project IDs verbatim and removes the configured installation subfolder", () => {
    const f = fixture({ endpoint: "https://api.example/gitlab/api/v4/" });
    return Effect.gen(function* () {
      const service = yield* GitLabUploadMedia.GitLabUploadMedia;
      yield* service.respond({ ...reference, project: "gitlab/team/project" }, {}, "GET");
      yield* service.respond({ ...reference, project: "42" }, {}, "GET");
      expect(f.requests[0]?.url).toContain("/gitlab/api/v4/projects/team%2Fproject/uploads/");
      expect(f.requests[1]?.url).toContain("/gitlab/api/v4/projects/42/uploads/");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("omits unsafe lengths and protects SVG responses", () => {
    const f = fixture({
      response: () =>
        new Response("<svg/>", {
          headers: { "content-type": "image/svg+xml", "content-length": "9007199254740992" },
        }),
    });
    return Effect.gen(function* () {
      const service = yield* GitLabUploadMedia.GitLabUploadMedia;
      const response = yield* service.respond(reference, {}, "GET");
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toContain("sandbox");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("rejects redirect loops, insecure targets and non-media responses", () => {
    return Effect.forEach(
      [
        { status: 302, headers: { location: "http://api.example/file" } },
        { status: 302, headers: { location: "https://user:pass@api.example/file" } },
        { status: 302, headers: { location: "https://api.example/loop" } },
        { status: 302, headers: { location: "https://[" } },
        { status: 200, headers: { "content-type": "text/html" } },
        { status: 206, headers: { "content-type": "video/mp4" } },
        {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-range": "bytes 0-2/3",
            "content-encoding": "gzip",
          },
        },
      ],
      (response) => {
        const f = fixture({ response: () => new Response("bad", response) });
        return Effect.gen(function* () {
          const service = yield* GitLabUploadMedia.GitLabUploadMedia;
          const result = yield* service.respond(reference, {}, "GET");
          expect(result.status).toBe(502);
          expect(result.headers["cache-control"]).toBe("private, no-store");
          expect(f.requests.length).toBeLessThanOrEqual(5);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      },
    );
  });

  it.effect("preserves unsatisfiable ranges without forwarding error bodies", () => {
    const f = fixture({
      response: () =>
        new Response("private upstream error", {
          status: 416,
          headers: { "content-range": "bytes */11", "content-length": "22" },
        }),
    });
    return Effect.gen(function* () {
      const service = yield* GitLabUploadMedia.GitLabUploadMedia;
      const response = HttpServerResponse.toWeb(
        yield* service.respond(reference, { range: "bytes=100-" }, "GET"),
      );
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */11");
      expect(yield* Effect.promise(() => response.text())).toBe("");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("cancels the upstream transfer when the caller closes its scope", () => {
    let signal: AbortSignal | null | undefined;
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* GitLabUploadMedia.GitLabUploadMedia;
        yield* service.respond(reference, {}, "GET");
        expect(signal?.aborted).toBe(false);
      }).pipe(Effect.scoped);
      expect(signal?.aborted).toBe(true);
    }).pipe(
      Effect.provide(
        GitLabUploadMedia.layer.pipe(
          Layer.provide(
            Layer.mock(GitLabCli.GitLabCli)({
              execute: ({ args }) =>
                Effect.succeed(
                  output(
                    args[0] === "config"
                      ? "https"
                      : "REST API Endpoint: https://api.example/api/v4/\nToken found in config file: token",
                  ),
                ),
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, (_url, init) => {
              signal = init?.signal;
              return Promise.resolve(
                new Response("bytes", { headers: { "content-type": "video/mp4" } }),
              );
            }),
          ),
          Layer.provide(
            ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-gitlab-cancel-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });
});
