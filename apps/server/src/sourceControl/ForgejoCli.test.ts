import * as Option from "effect/Option";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";

it.effect("sends binary issue attachments using the selected fj login", () => {
  const data = new FormData();
  data.set("attachment", new Blob([new Uint8Array([0, 128, 255])]), "image.png");
  const requests: string[] = [];
  const httpClient = HttpClient.make((request) => {
    requests.push(request.url);
    expect(request.headers.authorization).toBe("token test-fj-token");
    if (request.method === "GET")
      return Effect.gen(function* () {
        expect(
          Option.getOrThrow(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).redirect,
        ).toBe("manual");
        expect(request.headers.range).toBe("bytes=0-2");
        expect(request.headers.cookie).toBeUndefined();
        return HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array([0, 128, 255]), { status: 206 }),
        );
      });
    expect(request.body._tag).toBe("FormData");
    if (request.body._tag === "FormData") expect(request.body.formData).toBe(data);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response('{"browser_download_url":"https://forgejo.example/attachments/id"}', {
          status: 201,
        }),
      ),
    );
  });
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const result = yield* cli.api({
      cwd: "/repo",
      repository: "owner/repo",
      reference: "https://forgejo.example/owner/repo",
      host: "forgejo.example",
      path: "repos/owner/repo/issues/7/assets",
      method: "POST",
      formData: data,
    });
    expect(result.stdout).toContain("browser_download_url");
    const url = "https://forgejo.example/attachments/12345678-1234-1234-1234-123456789012";
    const response = yield* cli.readAttachment!({
      cwd: "/repo",
      repository: "owner/repo",
      host: "forgejo.example",
      reference: "https://forgejo.example/owner/repo",
      number: 7,
      url,
      headers: { range: "bytes=0-2", cookie: "never-forward" },
    });
    expect(new Uint8Array(yield* response.arrayBuffer)).toEqual(new Uint8Array([0, 128, 255]));
    expect(requests).toEqual([
      "https://forgejo.example/api/v1/repos/owner/repo/issues/7/assets",
      url,
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(true),
          readFileString: () =>
            Effect.succeed(
              '{"hosts":{"forgejo.example":{"type":"Application","token":"test-fj-token"}}}',
            ),
        }),
        Layer.mock(VcsProcess.VcsProcess)({
          run: () =>
            Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );
});
