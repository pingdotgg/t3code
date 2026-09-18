/**
 * Bytes on S3, compute on Cloudflare: the Worker and the Repo DO reach the
 * bucket through the S3 bindings with an identity Alchemy minted. A push
 * that spills, compaction into an S3 pack, and a clone back under
 * `fsck --strict`. Every byte of the clone came back through S3.
 */
import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import { GitApi } from "@/Git/Api.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { makeS3TestStack, TEST_SECRET } from "./fixtures/s3-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = makeS3TestStack("GitBlobStoreS3Stack");

const makeClient = (url: string, token: string) =>
  HttpApiClient.make(GitApi, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest((request) =>
      request.pipe(HttpClientRequest.bearerToken(token)),
    ),
  });

const edgeRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout("10 seconds"),
    Effect.retry({
      while: (error: unknown) =>
        (error as { _tag?: string })._tag === "TimeoutError" ||
        (error as { _tag?: string })._tag === "HttpClientError",
      schedule: Schedule.spaced("1500 millis"),
      times: 20,
    }),
  );

class ShellError extends Data.TaggedError("ShellError")<{
  readonly script: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  override get message(): string {
    return `shell script exited ${this.exitCode}\n--- script ---\n${this.script}\n--- stdout ---\n${this.stdout}\n--- stderr ---\n${this.stderr}`;
  }
}

const sh = Effect.fn(function* (cwd: string, script: string) {
  const handle = yield* ChildProcess.make("sh", ["-ec", script], {
    cwd,
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "S3 Bot",
      GIT_AUTHOR_EMAIL: "s3@example.com",
      GIT_COMMITTER_NAME: "S3 Bot",
      GIT_COMMITTER_EMAIL: "s3@example.com",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
    extendEnv: true,
  });
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [
      handle.exitCode,
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
    ],
    { concurrency: 3 },
  );
  if (exitCode !== 0) {
    return yield* new ShellError({ script, exitCode, stdout, stderr });
  }
  return { stdout: stdout.trim(), stderr };
}, Effect.timeout("180 seconds"));

const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.tap(({ url }) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`git-service (S3 bytes) deployed at ${url}`);
        const admin = yield* makeClient(url, TEST_SECRET);
        yield* admin.repos.list({ query: {} }).pipe(
          edgeRetry,
          Effect.retry({
            schedule: Schedule.spaced("1500 millis"),
            times: 40,
          }),
        );
      }),
    ),
    logLevel,
  ),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack).pipe(logLevel));

test(
  "a spilling push lands in S3, compacts into an S3 pack, and clones back under fsck --strict",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const admin = yield* makeClient(url, TEST_SECRET);
    const owner = "s3";
    const name = "bytes";
    yield* admin.repos.delete({ params: { owner, repo: name } }).pipe(
      Effect.catchTag("RepoNotFound", () => Effect.void),
      edgeRetry,
    );
    yield* admin.repos.create({ payload: { owner, name } }).pipe(edgeRetry);
    const parsed = new URL(url);
    const remote = `${parsed.protocol}//x:${TEST_SECRET}@${parsed.host}/${owner}/${name}.git`;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory({ prefix: "git-s3-" });
    // ~14 MiB of incompressible blobs: a body that spills to the store.
    yield* sh(
      dir,
      `git init -q -b main src && cd src
       for i in $(seq 1 14); do head -c 1000000 /dev/urandom > bin-$i.dat; done
       git add -A && git commit -qm base
       git push -q ${remote} main`,
    );
    // Compact now; the pack is written to the store.
    yield* admin.repos
      .compact({ params: { owner, repo: name } })
      .pipe(edgeRetry);
    const repo = yield* admin.repos.get({ params: { owner, repo: name } }).pipe(
      edgeRetry,
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (r) => r.objects.loose === 0,
        times: 30,
      }),
    );
    expect(repo.objects.loose).toBe(0);
    expect(repo.objects.packed).toBeGreaterThan(0);
    const back = yield* sh(
      dir,
      `git clone -q ${remote} back && cd back && git fsck --strict && git rev-parse HEAD`,
    );
    const head = yield* sh(dir, "cd src && git rev-parse HEAD");
    expect(back.stdout.trim().split("\n").pop()).toBe(head.stdout.trim());
    yield* Effect.logInfo(`objects: ${JSON.stringify(repo.objects)}`);
  }),
  { timeout: 600_000 },
);
