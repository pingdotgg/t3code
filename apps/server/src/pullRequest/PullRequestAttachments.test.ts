import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ProjectId } from "@t3tools/contracts";
import { attachmentFileExtension, createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import type { GitHubCli } from "../sourceControl/GitHubCli.ts";
import type { GitLabCli } from "../sourceControl/GitLabCli.ts";
import { ForgejoCli } from "../sourceControl/ForgejoCli.ts";
import * as ForgejoProvider from "./ForgejoPullRequestProvider.ts";
import {
  attachmentMarkdown,
  readGitLabAttachment,
  readGitHubAttachment,
  uploadGitHubAttachment,
  uploadGitLabAttachment,
  withPullRequestAttachment,
} from "./PullRequestAttachments.ts";

const projectId = Schema.decodeSync(ProjectId)("p1");

const input = {
  cwd: "/repo",
  repository: "owner/repo",
  host: "github.com",
  number: 7,
  name: "screen[1].png",
  mimeType: "image/png",
  data: new Uint8Array([0, 128, 255]),
  filePath: "/tmp/attachment/screen[1].png",
};
const output = (stdout: string) => ({
  stdout,
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdoutTruncated: false,
  stderrTruncated: false,
});

describe("pull request attachments", () => {
  it.effect("uploads GitHub bytes only to the selected repository with original filename", () =>
    Effect.gen(function* () {
      const execute = vi
        .fn<GitHubCli["Service"]["execute"]>()
        .mockReturnValueOnce(Effect.succeed(output('{"id":42,"permissions":{"push":true}}')))
        .mockReturnValueOnce(
          Effect.succeed(output('{"url":"https://github.com/user-attachments/assets/example"}')),
        );
      const result = yield* uploadGitHubAttachment(execute, input);
      expect(execute.mock.calls[0]?.[0].args).toEqual([
        "api",
        "repos/owner/repo",
        "--hostname",
        "github.com",
      ]);
      const request = execute.mock.calls[1]?.[0];
      expect(request?.args).toContain(input.filePath);
      const url = new URL(request?.args[1] ?? "");
      expect(url.origin).toBe("https://uploads.github.com");
      expect(url.searchParams.get("repository_id")).toBe("42");
      expect(url.searchParams.get("name")).toBe(input.name);
      expect(result.markdown).toBe(
        "![screen\\[1\\].png](<https://github.com/user-attachments/assets/example>)",
      );
    }),
  );

  it.effect("refuses GitHub read-only repositories before uploading", () =>
    Effect.gen(function* () {
      const execute = vi
        .fn<GitHubCli["Service"]["execute"]>()
        .mockReturnValue(Effect.succeed(output('{"id":42,"permissions":{"push":false}}')));
      const error = yield* uploadGitHubAttachment(execute, input).pipe(Effect.flip);
      expect(error.detail).toContain("write access");
      expect(execute).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("rejects GHES, unlisted types, and oversized GitHub images before a request", () =>
    Effect.gen(function* () {
      const execute = vi.fn<GitHubCli["Service"]["execute"]>();
      for (const override of [
        { host: "github.example.com" },
        { name: "secret.txt" },
        { data: new Uint8Array(10 * 1024 * 1024 + 1) },
      ]) {
        const error = yield* uploadGitHubAttachment(execute, { ...input, ...override }).pipe(
          Effect.flip,
        );
        expect(error.operation).toBe("uploadAttachment");
      }
      expect(execute).not.toHaveBeenCalled();
    }),
  );

  it.effect("uses GitLab multipart and its full native attachment path on the selected host", () =>
    Effect.gen(function* () {
      const execute = vi
        .fn<GitLabCli["Service"]["execute"]>()
        .mockReturnValue(
          Effect.succeed(output('{"full_path":"/-/project/42/uploads/hash/file.png"}')),
        );
      const result = yield* uploadGitLabAttachment(execute, {
        ...input,
        host: "gitlab.example.com",
        repository: "group/nested/repo",
      });
      expect(execute.mock.calls[0]?.[0].args).toEqual([
        "api",
        "projects/group%2Fnested%2Frepo/uploads",
        "--hostname",
        "gitlab.example.com",
        "--method",
        "POST",
        "--form",
        `file=@${input.filePath}`,
      ]);
      expect(result.url).toBe("https://gitlab.example.com/-/project/42/uploads/hash/file.png");
    }),
  );

  it.effect("uploads Forgejo assets to the issue behind the current pull request", () =>
    Effect.gen(function* () {
      const api = vi
        .fn<ForgejoCli["Service"]["api"]>()
        .mockReturnValue(
          Effect.succeed(
            output('{"browser_download_url":"https://forgejo.example/attachments/id"}'),
          ),
        );
      const provider = yield* ForgejoProvider.make.pipe(
        Effect.provide(Layer.mock(ForgejoCli)({ api })),
      );
      const result = yield* provider.uploadAttachment!({ ...input, host: "forgejo.example" });
      const request = api.mock.calls[0]?.[0];
      expect(request?.path).toBe("repos/owner/repo/issues/7/assets");
      expect(request?.method).toBe("POST");
      const file = request?.formData?.get("attachment");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error("Expected attachment file");
      expect(file.name).toBe(input.name);
      const data = yield* Effect.promise(() => file.arrayBuffer());
      expect(new Uint8Array(data)).toEqual(input.data);
      expect(result.url).toBe("https://forgejo.example/attachments/id");
    }),
  );

  it("escapes names and URL delimiters in Markdown", () => {
    expect(attachmentMarkdown("https://host/file (1)>x", "[a]\\b.txt", "text/plain")).toBe(
      "[\\[a\\]\\\\b.txt](<https://host/file%20(1)%3Ex>)",
    );
  });
});

const storageLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-pr-upload-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("reads only pending uploads, preserves bytes, and removes temporary copies", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const attachmentId = createPendingAttachmentId(attachmentFileExtension("screen.png"));
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(path.join(config.attachmentsDir, `${attachmentId}.png`), input.data);
    const request = {
      projectId,
      repository: input.repository,
      number: input.number,
      attachmentId,
      name: input.name,
      mimeType: input.mimeType,
    };
    const temporaryPath = yield* withPullRequestAttachment(request, (attachment) =>
      Effect.gen(function* () {
        expect([...attachment.data]).toEqual([...input.data]);
        expect([...(yield* fs.readFile(attachment.filePath))]).toEqual([...input.data]);
        expect(path.basename(attachment.filePath)).toBe(input.name);
        return attachment.filePath;
      }),
    );
    expect(yield* fs.exists(temporaryPath)).toBe(false);
    expect(yield* fs.exists(path.join(config.attachmentsDir, `${attachmentId}.png`))).toBe(true);
    const use = vi.fn(() => Effect.void);
    for (const invalidId of ["../secrets", attachmentId.replace("pending-", "thread-")]) {
      const error = yield* withPullRequestAttachment(
        { ...request, attachmentId: invalidId },
        use,
      ).pipe(Effect.flip);
      expect(error.detail).toContain("Upload the attachment again");
    }
    expect(use).not.toHaveBeenCalled();
  }).pipe(Effect.provide(storageLayer)),
);

for (const provider of ["github", "gitlab"] as const) {
  it.effect(`reads private ${provider} media with selected CLI auth and manual redirects`, () => {
    const host = provider === "github" ? "github.com" : "gitlab.example";
    const url =
      provider === "github"
        ? "https://github.com/owner/repo/blob/main/shot.png"
        : `https://${host}/-/project/42/uploads/${"a".repeat(32)}/shot.png`;
    const execute = vi.fn((_request: Parameters<GitLabCli["Service"]["execute"]>[0]) =>
      Effect.succeed({
        ...output(provider === "github" ? "test-token\n" : ""),
        stderr: provider === "gitlab" ? "  ✓ Token found in keyring: test-token\n" : "",
      }),
    );
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        expect(request.headers.authorization).toBe("Bearer test-token");
        expect(request.headers.range).toBe("bytes=0-2");
        expect(request.headers.cookie).toBeUndefined();
        expect(
          Option.getOrThrow(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).redirect,
        ).toBe("manual");
        expect(request.url).toBe(
          provider === "github"
            ? "https://raw.githubusercontent.com/owner/repo/main/shot.png"
            : `https://${host}/api/v4/projects/owner%2Frepo/uploads/${"a".repeat(32)}/shot.png`,
        );
        return HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array([0, 128, 255]), {
            status: 206,
            headers: { "content-type": "image/png", "content-range": "bytes 0-2/3" },
          }),
        );
      }),
    );
    return Effect.gen(function* () {
      const read = provider === "github" ? readGitHubAttachment : readGitLabAttachment;
      const response = yield* read(execute, {
        ...input,
        host,
        url,
        headers: { range: "bytes=0-2", cookie: "never-forward" },
      });
      expect(response.status).toBe(206);
      expect(new Uint8Array(yield* response.arrayBuffer)).toEqual(new Uint8Array([0, 128, 255]));
      expect(execute.mock.calls[0]?.[0].args).toContain(host);
      expect(execute.mock.calls[0]?.[0].args).toEqual(
        provider === "github"
          ? ["auth", "token", "--hostname", host]
          : ["auth", "status", "--hostname", host, "--show-token"],
      );
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.scoped);
  });
}

it.effect("reads only assets listed on the selected Forgejo pull request", () =>
  Effect.gen(function* () {
    const url = "https://forgejo.example/attachments/12345678-1234-1234-1234-123456789012";
    const api = vi
      .fn<ForgejoCli["Service"]["api"]>()
      .mockReturnValue(Effect.succeed(output(`[{"browser_download_url":"${url}"}]`)));
    const readAttachment = vi
      .fn<NonNullable<ForgejoCli["Service"]["readAttachment"]>>()
      .mockReturnValue(
        Effect.succeed(
          HttpClientResponse.fromWeb(HttpClientRequest.get(url), new Response("image")),
        ),
      );
    const provider = yield* ForgejoProvider.make.pipe(
      Effect.provide(Layer.mock(ForgejoCli)({ api, readAttachment })),
    );
    expect(
      (yield* provider.readAttachment!({ ...input, host: "forgejo.example", url, headers: {} }))
        .status,
    ).toBe(200);
    expect(api.mock.calls[0]?.[0].path).toContain("repos/owner/repo/issues/7/assets");
    const wrong = yield* provider.readAttachment!({
      ...input,
      host: "forgejo.example",
      url: url.replace("123456789012", "123456789013"),
      headers: {},
    }).pipe(Effect.flip);
    expect(wrong.detail).toContain("does not belong");
    expect(readAttachment).toHaveBeenCalledTimes(1);
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Provider owns read")),
    ),
    Effect.scoped,
  ),
);

it.effect("retries GitLab once when glab refreshes an expired OAuth token", () => {
  const execute = vi
    .fn<GitLabCli["Service"]["execute"]>()
    .mockReturnValueOnce(
      Effect.succeed({ ...output(""), stderr: "Token found in keyring: expired" }),
    )
    .mockReturnValueOnce(
      Effect.succeed({ ...output(""), stderr: "Token found in keyring: refreshed" }),
    );
  const tokens: string[] = [];
  return Effect.gen(function* () {
    const response = yield* readGitLabAttachment(execute, {
      ...input,
      host: "gitlab.example",
      url: `/uploads/${"a".repeat(32)}/shot.png`,
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(tokens).toEqual(["Bearer expired", "Bearer refreshed"]);
    expect(execute).toHaveBeenCalledTimes(2);
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        tokens.push(request.headers.authorization!);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: tokens.length === 1 ? 401 : 200 }),
          ),
        );
      }),
    ),
    Effect.scoped,
  );
});
