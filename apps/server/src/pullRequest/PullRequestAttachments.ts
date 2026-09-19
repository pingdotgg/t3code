import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { pullRequestMediaUrl } from "@t3tools/shared/pullRequestMedia";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PullRequestOperationError,
  type PullRequestAttachmentCapability,
  type PullRequestUploadAttachmentInput,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import { PullRequestProviderError, type PullRequestProviderApi } from "./PullRequestProvider.ts";
import type { GitHubCli } from "../sourceControl/GitHubCli.ts";
import type { GitLabCli } from "../sourceControl/GitLabCli.ts";

const decodeGitHubRepository = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Int.check(Schema.isGreaterThan(0)),
      permissions: Schema.Struct({ push: Schema.Boolean }),
    }),
  ),
);
const decodeGitHubAsset = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ url: Schema.String.check(Schema.isPattern(/^https:\/\//)) }),
  ),
);
const decodeGitLabAsset = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ full_path: Schema.String.check(Schema.isPattern(/^\/(?!\/)/)) }),
  ),
);

type UploadInput = Parameters<NonNullable<PullRequestProviderApi["uploadAttachment"]>>[0];

export const NATIVE_ATTACHMENT_CAPABILITY: PullRequestAttachmentCapability = {
  supported: true,
  maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  destination: "pull-request",
};

const GITHUB_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export const GITHUB_ATTACHMENT_CAPABILITY: PullRequestAttachmentCapability = {
  ...NATIVE_ATTACHMENT_CAPABILITY,
  acceptedExtensions: Object.keys(GITHUB_CONTENT_TYPES),
  reason:
    "Requires write access. Images: up to 10 MB. Videos: up to 50 MB; your GitHub plan may allow less. GitHub Enterprise Server is not supported.",
};

export function attachmentMarkdown(url: string, name: string, mimeType: string) {
  const label = name.replace(/[\\[\]]/g, "\\$&");
  const target = url.replace(/[<>\s]/g, (character) => encodeURIComponent(character));
  return `${mimeType.startsWith("image/") ? "!" : ""}[${label}](<${target}>)`;
}

export const withPullRequestAttachment = Effect.fn("PullRequestAttachments.read")(function* <
  A,
  E,
  R,
>(
  input: PullRequestUploadAttachmentInput,
  use: (attachment: {
    readonly filePath: string;
    readonly data: Uint8Array;
  }) => Effect.Effect<A, E, R>,
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source =
    parseThreadSegmentFromAttachmentId(input.attachmentId) === PENDING_ATTACHMENT_THREAD_SEGMENT
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: input.attachmentId,
        })
      : null;
  if (
    !source ||
    path.basename(input.name) !== input.name ||
    input.name === "." ||
    input.name === ".."
  ) {
    return yield* new PullRequestOperationError({
      operation: "uploadAttachment",
      detail: "Upload the attachment again before attaching it.",
    });
  }
  const prepared = Effect.gen(function* () {
    const stat = yield* fs.stat(source);
    if (stat.type !== "File" || stat.size <= 0 || stat.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
      return yield* new PullRequestOperationError({
        operation: "uploadAttachment",
        detail: "Attachments must be a non-empty file of at most 50 MB.",
      });
    }
    const data = yield* fs.readFile(source);
    if (data.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
      return yield* new PullRequestOperationError({
        operation: "uploadAttachment",
        detail: "Attachments must be at most 50 MB.",
      });
    }
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pr-attachment-" });
    const filePath = path.join(directory, input.name);
    yield* fs.writeFile(filePath, data, { mode: 0o600 });
    return { filePath, data };
  }).pipe(
    Effect.catchTags({
      PlatformError: () =>
        Effect.fail(
          new PullRequestOperationError({
            operation: "uploadAttachment",
            detail: "The attachment could not be read. Upload it again.",
          }),
        ),
    }),
  );
  return yield* Effect.scoped(Effect.flatMap(prepared, use));
});

export const uploadGitHubAttachment = Effect.fn("PullRequestAttachments.github")(function* (
  execute: GitHubCli["Service"]["execute"],
  input: UploadInput,
) {
  const failure = (detail: string) =>
    new PullRequestProviderError({
      provider: "github",
      operation: "uploadAttachment",
      reason: "failed",
      detail,
    });
  const host = input.host.toLowerCase();
  if (host !== "github.com" && !/^[a-z0-9-]+\.ghe\.com$/.test(host))
    return yield* failure("Attachments are not supported on GitHub Enterprise Server.");
  const extension = /\.[^.]+$/.exec(input.name)?.[0].toLowerCase() ?? "";
  const contentType = GITHUB_CONTENT_TYPES[extension];
  if (!contentType)
    return yield* failure(
      "GitHub accepts PNG, JPG, GIF, WebP, SVG, MP4, MOV, and WebM attachments.",
    );
  if (contentType.startsWith("image/") && input.data.byteLength > 10 * 1024 * 1024)
    return yield* failure("GitHub images must be at most 10 MB.");
  const result = yield* execute({
    cwd: input.cwd,
    args: [
      "api",
      `repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`,
      "--hostname",
      host,
    ],
  }).pipe(Effect.mapError((error) => failure(error.message)));
  const repository = yield* decodeGitHubRepository(result.stdout).pipe(
    Effect.mapError(() => failure("GitHub did not return repository upload permissions.")),
  );
  if (!repository.permissions.push)
    return yield* failure("Attaching files requires write access to this repository.");
  const url = new URL(`https://uploads.${host}/user-attachments/assets`);
  url.search = new URLSearchParams({
    name: input.name,
    content_type: contentType,
    repository_id: String(repository.id),
  }).toString();
  const uploaded = yield* execute({
    cwd: input.cwd,
    args: [
      "api",
      url.toString(),
      "--hostname",
      host,
      "--method",
      "POST",
      "--header",
      "Content-Type: application/octet-stream",
      "--input",
      input.filePath,
    ],
    timeoutMs: 120_000,
  }).pipe(Effect.mapError((error) => failure(error.message)));
  const asset = yield* decodeGitHubAsset(uploaded.stdout).pipe(
    Effect.mapError(() => failure("GitHub returned no attachment URL.")),
  );
  return {
    url: asset.url,
    markdown: contentType.startsWith("video/")
      ? asset.url
      : attachmentMarkdown(asset.url, input.name, contentType),
  };
});

export const uploadGitLabAttachment = Effect.fn("PullRequestAttachments.gitlab")(function* (
  execute: GitLabCli["Service"]["execute"],
  input: UploadInput,
) {
  const failure = (detail: string) =>
    new PullRequestProviderError({
      provider: "gitlab",
      operation: "uploadAttachment",
      reason: "failed",
      detail,
    });
  const uploaded = yield* execute({
    cwd: input.cwd,
    args: [
      "api",
      `projects/${encodeURIComponent(input.repository)}/uploads`,
      "--hostname",
      input.host,
      "--method",
      "POST",
      "--form",
      `file=@${input.filePath}`,
    ],
    timeoutMs: 120_000,
  }).pipe(Effect.mapError((error) => failure(error.message)));
  const asset = yield* decodeGitLabAsset(uploaded.stdout).pipe(
    Effect.mapError(() => failure("GitLab returned no attachment URL.")),
  );
  const url = new URL(asset.full_path, `https://${input.host}`).toString();
  return { url, markdown: attachmentMarkdown(url, input.name, input.mimeType) };
});

export const readGitLabAttachment = Effect.fn("PullRequestAttachments.readGitLabAttachment")(
  function* (
    execute: GitLabCli["Service"]["execute"],
    input: Parameters<NonNullable<PullRequestProviderApi["readAttachment"]>>[0],
  ) {
    const fail = (detail: string) =>
      new PullRequestProviderError({
        provider: "gitlab",
        reason: "failed",
        operation: "readAttachment",
        detail,
      });
    const url = pullRequestMediaUrl({ ...input, provider: "gitlab" });
    if (!url)
      return yield* fail("This attachment does not belong to the selected GitLab repository.");
    const path = new URL(url).pathname.split("/").slice(-2).join("/");
    const endpoint = `https://${input.host}/api/v4/projects/${encodeURIComponent(input.repository)}/uploads/${path}`;
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    for (let attempt = 0; ; attempt++) {
      const auth = yield* execute({
        cwd: input.cwd,
        args: ["auth", "status", "--hostname", input.host, "--show-token"],
        env: { NO_COLOR: "1", GLAB_DEBUG_HTTP: "" },
      }).pipe(Effect.mapError(() => fail("Sign in with glab to view private GitLab attachments.")));
      const token = /Token found in [^:\r\n]+: ([^\r\n]+)/.exec(auth.stderr)?.[1]?.trim();
      if (!token || /[\s\p{Cc}]/u.test(token))
        return yield* fail(
          "glab did not provide an attachment credential. Update glab and sign in again.",
        );
      const headers: Record<string, string> = {
        "accept-encoding": "identity",
        authorization: `Bearer ${token}`,
      };
      for (const name of ["range", "if-range"])
        if (input.headers[name]) headers[name] = input.headers[name];
      const response = yield* client
        .execute(HttpClientRequest.get(endpoint).pipe(HttpClientRequest.setHeaders(headers)))
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(() =>
            fail("GitLab attachment download failed. GitLab 17.4 or later is required."),
          ),
        );
      if (response.status !== 401 || attempt === 1) return response;
    }
  },
);

export const readGitHubAttachment = Effect.fn("PullRequestAttachments.readGitHubAttachment")(
  function* (
    execute: GitHubCli["Service"]["execute"],
    input: Parameters<NonNullable<PullRequestProviderApi["readAttachment"]>>[0],
  ) {
    const fail = (detail: string) =>
      new PullRequestProviderError({
        provider: "github",
        reason: "failed",
        operation: "readAttachment",
        detail,
      });
    const url = pullRequestMediaUrl({ ...input, provider: "github" });
    if (!url)
      return yield* fail("This attachment does not belong to the selected GitHub repository.");
    const output = yield* execute({
      cwd: input.cwd,
      args: ["auth", "token", "--hostname", input.host],
      env: { GH_DEBUG: "" },
    }).pipe(Effect.mapError(() => fail("Sign in with gh to view private GitHub attachments.")));
    const headers: Record<string, string> = {
      "accept-encoding": "identity",
      authorization: `Bearer ${output.stdout.trim()}`,
    };
    for (const name of ["range", "if-range"])
      if (input.headers[name]) headers[name] = input.headers[name];
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    return yield* client
      .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)))
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.mapError(() => fail("GitHub attachment download failed.")),
      );
  },
);
