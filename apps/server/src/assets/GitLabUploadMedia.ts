import * as NodeUtil from "node:util";
import { isGitLabUploadReference, type GitLabUploadReference } from "@t3tools/contracts";
import { mediaMimeType } from "@t3tools/shared/filePreview";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  type HttpClientResponse,
} from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";

const Connection = Schema.Struct({
  apiBaseUrl: Schema.URLFromString.check(
    Schema.makeFilter(
      (url) =>
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.endsWith("/api/v4/"),
    ),
  ),
  token: Schema.String.check(Schema.isPattern(/^\S+$/u)),
});
const decodeConnection = Schema.decodeUnknownOption(Connection);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MEDIA_TYPE = /^(?:image|video)\/[\w!#$&^.+-]+$/iu;
const RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
const unavailable = () => HttpServerResponse.empty({ status: 502, headers: RESPONSE_HEADERS });

/** The caller's request scope must remain open until the returned media stream finishes. */
export class GitLabUploadMedia extends Context.Service<
  GitLabUploadMedia,
  {
    readonly respond: (
      reference: GitLabUploadReference,
      headers: Readonly<Record<string, string | undefined>>,
      method: "GET" | "HEAD",
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope>;
  }
>()("t3/assets/GitLabUploadMedia") {}

const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;
  const config = yield* ServerConfig.ServerConfig;
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const connections = yield* Cache.makeWith(
    Effect.fn("GitLabUploadMedia.connection")(
      function* (origin: string) {
        const host = new URL(origin).host;
        const execute = (args: ReadonlyArray<string>) =>
          gitlab.execute({
            cwd: config.stateDir,
            args,
            timeoutMs: 10_000,
            maxOutputBytes: 16 * 1024,
            // Upload authors choose the host. Only its stored credentials may be used;
            // glab otherwise sends a higher-priority ambient token during auth status.
            env: {
              GITLAB_TOKEN: "",
              GITLAB_ACCESS_TOKEN: "",
              OAUTH_TOKEN: "",
              CI_JOB_TOKEN: "",
              GLAB_ENABLE_CI_AUTOLOGIN: "false",
            },
          });
        // auth status validates the token over the network. Check the effective protocol first.
        const protocol = yield* execute(["config", "get", "api_protocol", "--host", host]);
        if (protocol.stdout.trim() !== "https") return null;
        const output = yield* execute(["auth", "status", "--hostname", host, "--show-token"]);
        const text = NodeUtil.stripVTControlCharacters(`${output.stdout}\n${output.stderr}`);
        const connection = Option.getOrNull(
          decodeConnection({
            apiBaseUrl: /REST API Endpoint:\s*(\S+)/u.exec(text)?.[1],
            token: /Token found in [^\r\n]*?:\s*(\S+)/u.exec(text)?.[1],
          }),
        );
        return connection === null
          ? null
          : {
              apiBaseUrl: connection.apiBaseUrl,
              token: Redacted.make(connection.token),
            };
      },
      // CLI errors can contain the credential output. Never log or expose them.
      Effect.orElseSucceed(() => null),
    ),
    {
      capacity: 64,
      timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value !== null ? "5 minutes" : 0),
    },
  );
  const respond = Effect.fn("GitLabUploadMedia.respond")(
    function* (
      reference: GitLabUploadReference,
      requestHeaders: Readonly<Record<string, string | undefined>>,
      method: "GET" | "HEAD",
    ) {
      if (!isGitLabUploadReference(reference)) return unavailable();
      const connection = yield* Cache.get(connections, reference.origin);
      if (connection === null) return unavailable();
      const subfolder = connection.apiBaseUrl.pathname.replace(/\/api\/v4\/$/u, "").slice(1);
      const project =
        subfolder && reference.project.startsWith(`${subfolder}/`)
          ? reference.project.slice(subfolder.length + 1)
          : reference.project;
      let url = new URL(
        `projects/${encodeURIComponent(project)}/uploads/${reference.secret}/${encodeURIComponent(reference.fileName)}`,
        connection.apiBaseUrl,
      );
      let authenticated = true;
      for (let hop = 0; hop < 5; hop++) {
        const range = requestHeaders.range;
        const response: HttpClientResponse.HttpClientResponse = yield* client
          .execute(
            HttpClientRequest.make(method)(url.toString(), {
              headers: {
                ...(authenticated ? { "private-token": Redacted.value(connection.token) } : {}),
                "accept-encoding": "identity",
                ...(method === "GET" && range && /^bytes=(?:\d+-\d*|-\d+)$/u.test(range)
                  ? {
                      range,
                      ...(requestHeaders["if-range"]
                        ? { "if-range": requestHeaders["if-range"] }
                        : {}),
                    }
                  : {}),
              },
            }),
          )
          .pipe(Effect.timeout("15 seconds"));
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.location;
          const next = location
            ? Option.getOrNull(Option.liftThrowable(() => new URL(location, url))())
            : null;
          if (next === null || next.protocol !== "https:" || next.username || next.password)
            return unavailable();
          // Once off the API origin, even a redirect back must not regain the credential.
          authenticated = authenticated && next.origin === url.origin;
          url = next;
          continue;
        }
        const headers: Record<string, string> = { ...RESPONSE_HEADERS };
        const contentRange = response.headers["content-range"];
        if (response.status === 416) {
          if (contentRange && /^bytes \*\/\d+$/u.test(contentRange))
            headers["content-range"] = contentRange;
          return HttpServerResponse.empty({ status: 416, headers });
        }
        if (response.status >= 400 && response.status < 500) {
          return HttpServerResponse.empty({ status: response.status, headers });
        }
        if (response.status !== 200 && response.status !== 206) return unavailable();
        const upstreamType = response.headers["content-type"]
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        // GitLab labels both uploaded PNGs and MP4s as octet-stream.
        const contentType =
          upstreamType === "application/octet-stream"
            ? mediaMimeType(reference.fileName)
            : upstreamType;
        if (!contentType || !MEDIA_TYPE.test(contentType)) return unavailable();
        const encoded =
          response.headers["content-encoding"] !== undefined &&
          response.headers["content-encoding"] !== "identity";
        if (response.status === 206) {
          if (encoded || !contentRange || !/^bytes \d+-\d+\/\d+$/u.test(contentRange))
            return unavailable();
          headers["content-range"] = contentRange;
        }
        if (response.headers["accept-ranges"] === "bytes") headers["accept-ranges"] = "bytes";
        for (const name of ["etag", "last-modified"] as const) {
          const value = response.headers[name];
          if (value !== undefined) headers[name] = value;
        }
        const length = response.headers["content-length"];
        if (!encoded && length && /^\d+$/u.test(length) && Number.isSafeInteger(Number(length))) {
          headers["content-length"] = length;
        }
        headers["content-type"] = contentType;
        if (contentType === "image/svg+xml") {
          headers["content-security-policy"] =
            "default-src 'none'; style-src 'unsafe-inline'; sandbox";
        }
        return method === "HEAD"
          ? HttpServerResponse.empty({ status: response.status, headers })
          : HttpServerResponse.stream(response.stream, {
              status: response.status,
              headers,
              contentType,
            });
      }
      return unavailable();
    },
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    // Request errors may carry tokens or signed storage URLs.
    Effect.orElseSucceed(unavailable),
  );
  return GitLabUploadMedia.of({ respond });
});

export const layer = Layer.effect(GitLabUploadMedia, make);
