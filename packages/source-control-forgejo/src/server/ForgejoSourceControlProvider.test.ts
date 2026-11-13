import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import { encodeJson, processOutput, requestJson } from "./ForgejoSourceControlProvider.part2.testkit.ts";

it.effect("routes mounted Forgejo repositories without repeating the mount in API paths", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const viewer = yield* cli.api({ cwd: "/upstream-only", host: "code.test", path: "user" });
    assert.strictEqual(viewer.stdout, "[]");
    const mountedRepository = yield* cli.resolveRepository({
      cwd: "/upstream-only",
      host: "code.test",
      repository: "maria/project",
    });
    assert.strictEqual(mountedRepository.baseUrl, "https://code.test/forgejo");
    assert.strictEqual(mountedRepository.repository, "maria/project");
    for (const path of [
      "repos/forgejo/maria/project/pulls?state=open",
      "repos/forgejo/maria/project",
      "repos/reviewer/project/contents/file.ts",
    ]) {
      const result = yield* cli.api({
        cwd: "/repo",
        repository: "forgejo/maria/project",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("forgejo"),
            name: "Forgejo",
            baseUrl: "https://code.test/forgejo",
          },
          remoteName: "origin",
          remoteUrl: "https://code.test/forgejo/maria/project.git",
        },
        path,
      });
      assert.strictEqual(result.stdout, "[]");
    }
    const sameOwnerAsMount = yield* cli.resolveRepository({
      cwd: "/repo",
      repository: "forgejo/project",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("forgejo"),
          name: "Forgejo",
          baseUrl: "https://code.test/forgejo",
        },
        remoteName: "origin",
        remoteUrl: "ssh://git@code.test/forgejo/project.git",
      },
    });
    assert.strictEqual(sameOwnerAsMount.command, "tea");
    assert.strictEqual(sameOwnerAsMount.repository, "forgejo/project");
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: { "code.test/forgejo": { type: "Application", token: "test-token" } },
            }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => {
        throw new Error("tea must handle its own HTTP request");
      }),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            if (input.command === "git")
              return Effect.succeed(
                processOutput("", { exitCode: ChildProcessSpawner.ExitCode(2) }),
              );
            if (input.args[0] === "login")
              return Effect.succeed(
                processOutput(
                  encodeJson([
                    {
                      name: "mounted",
                      url: "https://code.test/forgejo",
                      ssh_host: "code.test",
                      user: "maria",
                      default: "true",
                    },
                  ]),
                ),
              );
            const supported = [
              "https://code.test/forgejo/api/v1/user",
              "https://code.test/forgejo/api/v1/repos/maria/project/pulls?state=open",
              "https://code.test/forgejo/api/v1/repos/maria/project",
              "https://code.test/forgejo/api/v1/repos/reviewer/project/contents/file.ts",
            ];
            if (input.args.at(-1)?.endsWith("/user")) assert.notInclude(input.args, "--repo");
            assert.strictEqual(input.command, "tea");
            return Effect.succeed(
              supported.includes(input.args.at(-1) ?? "")
                ? processOutput("[]", { stderr: "HTTP/1.1 200 OK\n" })
                : processOutput("{}", { stderr: "HTTP/1.1 404 Not Found\n" }),
            );
          },
        },
      }),
    ),
  ),
);

it.effect("prefers fj for HTTP and ported SSH aliases on root servers", () => {
  const commands: string[] = [];
  const requests: string[] = [];
  let repositoryCwd = "";
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    for (const remoteUrl of [
      "http://forgejo.local:3000/maria/project.git",
      "ssh://git@ssh.forgejo.local:2222/maria/project.git",
      "ssh://git@forgejo.local:2222/maria/project.git",
    ]) {
      const result = yield* cli.api({
        cwd: "/repo",
        repository: "maria/project",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("forgejo"),
            name: "Forgejo",
            baseUrl: "http://forgejo.local:3000",
          },
          remoteName: "origin",
          remoteUrl,
          requestedHost: "forgejo.local:3000",
        },
        path: "repos/maria/project/issues/42/comments",
        method: "POST",
        body: { body: "verified through fj" },
      });
      assert.strictEqual(result.stdout, '{"id":99}');
    }
    assert.deepStrictEqual(commands, ["fj"]);
    assert.deepStrictEqual(requests, [
      "http://forgejo.local:3000/api/v1/repos/maria/project/issues/42/comments",
      "http://forgejo.local:3000/api/v1/repos/maria/project/issues/42/comments",
      "http://forgejo.local:3000/api/v1/repos/maria/project/issues/42/comments",
    ]);
    const viewer = yield* cli.api({
      cwd: "/no-remotes",
      host: "forgejo.local:3000",
      path: "user",
    });
    assert.strictEqual(viewer.stdout, '{"login":"maria"}');
    assert.strictEqual(requests.at(-1), "https://forgejo.local:3000/api/v1/user");
    const upstreamViewer = yield* cli.api({
      cwd: "/upstream-only",
      host: "forgejo.local:3000",
      path: "user",
    });
    assert.strictEqual(upstreamViewer.stdout, '{"login":"maria"}');
    assert.strictEqual(requests.at(-1), "http://forgejo.local:3000/api/v1/user");
    const upstreamRepository = yield* cli.resolveRepository({
      cwd: "/upstream-only",
      host: "forgejo.local:3000",
      repository: "maria/project",
    });
    assert.strictEqual(upstreamRepository.baseUrl, "http://forgejo.local:3000");
    assert.strictEqual(upstreamRepository.repository, "maria/project");
    const httpViewer = yield* cli.api({ cwd: "/repo", host: "forgejo.local:3000", path: "user" });
    assert.strictEqual(httpViewer.stdout, '{"login":"maria"}');
    assert.strictEqual(requests.at(-1), "http://forgejo.local:3000/api/v1/user");
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: {
                "forgejo.local:3000": { type: "Application", token: "test-token" },
                "forgejo.local:4000": { type: "Application", token: "other-token" },
              },
              aliases: { "ssh.forgejo.local:2222": "forgejo.local:3000" },
            }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.url);
        if (request.url.endsWith("/user")) {
          assert.strictEqual(request.method, "GET");
          assert.strictEqual(request.headers.authorization, "token test-token");
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response('{"login":"maria"}')),
          );
        }
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.headers.authorization, "token test-token");
        assert.deepStrictEqual(requestJson(request), { body: "verified through fj" });
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('{"id":99}', { status: 201 })),
        );
      }),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            commands.push(input.command);
            if (input.command === "git") {
              repositoryCwd = input.cwd;
              return Effect.succeed(
                input.cwd === "/no-remotes"
                  ? processOutput("", { exitCode: ChildProcessSpawner.ExitCode(2) })
                  : processOutput(
                      input.cwd === "/upstream-only"
                        ? "upstream\thttp://forgejo.local:3000/maria/project.git (fetch) [blob:none]\nother\thttp://forgejo.local:3000/maria/other.git (fetch) [blob:none]\nunrelated\thttp://other.local:3000/maria/project.git (fetch) [blob:none]"
                        : "origin\thttp://forgejo.local:3000/maria/project.git (fetch)\nother\thttp://forgejo.local:3000/maria/other.git (fetch)\nunrelated\thttp://other.local:3000/maria/project.git (fetch)",
                    ),
              );
            }
            assert.strictEqual(input.command, "fj");
            assert.deepStrictEqual(input.args, [
              "--host",
              repositoryCwd === "/no-remotes"
                ? "https://forgejo.local:3000"
                : "http://forgejo.local:3000",
              "whoami",
            ]);
            return Effect.succeed(processOutput(""));
          },
        },
      }),
    ),
  );
});

it.effect("loads later fj review pages when the server caps pages below the requested size", () => {
  const pages: number[] = [];
  let issueCommentRequests = 0;
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    const activity = yield* provider.getChangeRequestActivity({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
      number: 42,
    });
    assert.strictEqual(activity.commentCount, 42);
    assert.strictEqual(activity.comments.at(-1)?.id, "review:41");
    assert.strictEqual(activity.commentsTruncated, false);
    assert.deepStrictEqual(pages, [1, 2, 3]);
    assert.strictEqual(issueCommentRequests, 1);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({ hosts: { "forgejo.test": { type: "Application", token: "test-token" } } }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/repos/maria/project/issues/42/comments") {
          issueCommentRequests++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                encodeJson([
                  {
                    id: 100,
                    body: "Unpaginated issue comment",
                    user: { login: "maria" },
                    created_at: "2026-09-13T00:00:00Z",
                  },
                ]),
              ),
            ),
          );
        }
        if (url.pathname.endsWith("/reviews")) {
          const page = Number(url.searchParams.get("page"));
          pages.push(page);
          assert.ok(page >= 1 && page <= 3);
          const reviews = Array.from({ length: page < 3 ? 20 : 1 }, (_, index) => ({
            id: (page - 1) * 20 + index + 1,
            body: "Review from a capped page",
            user: { login: "maria" },
            state: "COMMENT",
            submitted_at: "2026-09-13T00:00:00Z",
            comments_count: 0,
          }));
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(encodeJson(reviews), {
                headers:
                  page === 2
                    ? {}
                    : {
                        Link:
                          page === 1
                            ? `<${url.origin}${url.pathname}?limit=50&page=2>; rel="next"`
                            : `<${url.origin}${url.pathname}?limit=50&page=1>; rel="prev"`,
                      },
              }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson(url.pathname === "/api/v1/user" ? { login: "maria" } : [])),
          ),
        );
      }),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            if (input.command === "git") {
              assert.deepStrictEqual(input.args, ["remote", "-v"]);
              return Effect.succeed(
                processOutput("origin\thttps://forgejo.test/maria/project.git (fetch)"),
              );
            }
            assert.strictEqual(input.command, "fj");
            assert.deepStrictEqual(input.args, ["--host", "https://forgejo.test", "whoami"]);
            assert.strictEqual(input.cwd, "/home/maria");
            return Effect.succeed(processOutput(""));
          },
        },
      }),
    ),
    Effect.provideService(HostProcess.HomeDirectory, "/home/maria"),
  );
});

it.effect("handles fj mutation statuses without retrying failures or reading absent bodies", () =>
  Effect.gen(function* () {
    for (const status of [204, 205, 302, 401, 403, 404, 429, 500]) {
      let writes = 0;
      yield* Effect.gen(function* () {
        const cli = yield* ForgejoCli.make;
        const result = yield* cli
          .api({
            cwd: "/repo",
            repository: "https://forgejo.local/maria/project",
            path: "repos/maria/project/issues/42/comments",
            method: "POST",
            body: { body: "only once" },
          })
          .pipe(Effect.result);
        assert.strictEqual(result._tag, status < 300 ? "Success" : "Failure");
        if (result._tag === "Success") assert.strictEqual(result.success.stdout, "");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure.command, "fj");
          assert.strictEqual(result.failure.httpStatus, status);
        }
        assert.strictEqual(writes, 1);
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: () => Effect.succeed(true),
            readFileString: () =>
              Effect.succeed(
                encodeJson({
                  hosts: {
                    "forgejo.local": { type: "Application", token: "test-token" },
                  },
                }),
              ),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            writes++;
            assert.strictEqual(
              request.url,
              "https://forgejo.local/api/v1/repos/maria/project/issues/42/comments",
            );
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(status < 300 ? null : "", {
                  status,
                  headers: { location: "https://other.local/" },
                }),
              ),
            );
          }),
        ),
        Effect.provide(
          TestSourceControlHost.layer({
            process: {
              run: (input) => {
                assert.strictEqual(
                  input.command,
                  "fj",
                  "a failed mutation must never switch accounts or CLI",
                );
                return Effect.succeed(processOutput(""));
              },
            },
          }),
        ),
      );
    }
  }),
);

it.effect(
  "discovers fj first and retains configured authentication failures instead of switching accounts",
  () =>
    Effect.gen(function* () {
      for (const scenario of ["authenticated", "revoked", "missing", "invalid-storage"] as const) {
        const commands: string[] = [];
        yield* Effect.gen(function* () {
          const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
          assert.strictEqual(spec.type, "managed-cli");
          if (spec.type !== "managed-cli") return;
          const result = yield* spec.probe("/repo");
          assert.strictEqual(result.executable, scenario === "missing" ? "tea" : "fj");
          assert.strictEqual(
            result.auth.status,
            scenario === "revoked"
              ? "unauthenticated"
              : scenario === "invalid-storage"
                ? "unknown"
                : "authenticated",
          );
          if (scenario !== "revoked" && scenario !== "invalid-storage")
            assert.deepStrictEqual(result.auth.host, Option.some("forgejo.local:3000"));
          assert.deepStrictEqual(
            result.auth.account,
            scenario === "authenticated" || scenario === "missing"
              ? Option.some("maria")
              : Option.none(),
          );
          assert.strictEqual(
            commands.some((command) => command.startsWith("tea ")),
            scenario === "missing",
          );
          assert.include(commands, "fj version");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ForgejoCli.ForgejoCli)({
                getAccount: (input) => {
                  assert.strictEqual(scenario, "authenticated");
                  assert.deepStrictEqual(input, {
                    cwd: "/repo",
                    baseUrl: "http://forgejo.local:3000",
                  });
                  return Effect.succeed("maria");
                },
                listLogins: (input) => {
                  assert.strictEqual(
                    input.remoteUrl,
                    "http://forgejo.local:3000/maria/project.git",
                  );
                  if (scenario === "invalid-storage")
                    return Effect.fail(
                      new ForgejoCli.ForgejoCliError({
                        command: "fj",
                        cwd: input.cwd,
                        reason: "authentication",
                        detail: "fj authentication storage is invalid.",
                      }),
                    );
                  return Effect.succeed([
                    {
                      name: "forgejo.local:3000",
                      url: "http://forgejo.local:3000",
                      user: "",
                      default: "false",
                    },
                  ]);
                },
              }),
              TestSourceControlHost.layer({
                process: {
                  run: (input) => {
                    commands.push(`${input.command} ${input.args.join(" ")}`);
                    if (input.command === "git")
                      return Effect.succeed(
                        processOutput("http://forgejo.local:3000/maria/project.git\n"),
                      );
                    if (input.command === "fj") {
                      assert.strictEqual(input.cwd, "/home/maria");
                      if (scenario === "missing")
                        return Effect.fail(
                          new VcsProcessSpawnError({
                            operation: input.operation,
                            command: input.command,
                            cwd: input.cwd,
                            cause: new Error("fj not found"),
                          }),
                        );
                      if (input.args[0] === "version")
                        return Effect.succeed(processOutput("fj 0.10.0"));
                      if (scenario === "invalid-storage") {
                        assert.deepStrictEqual(input.args, ["auth", "list"]);
                        return Effect.succeed(processOutput(""));
                      }
                      assert.deepStrictEqual(input.args, [
                        "--host",
                        "http://forgejo.local:3000",
                        "whoami",
                      ]);
                      return Effect.succeed(
                        processOutput("", {
                          exitCode: ChildProcessSpawner.ExitCode(scenario === "revoked" ? 1 : 0),
                        }),
                      );
                    }
                    assert.strictEqual(input.command, "tea");
                    return Effect.succeed(
                      input.args[0] === "--version"
                        ? processOutput("tea version 0.16.0")
                        : processOutput(
                            encodeJson([
                              {
                                name: "work",
                                url: "http://forgejo.local:3000",
                                user: "maria",
                                default: "true",
                                valid: "true",
                              },
                            ]),
                          ),
                    );
                  },
                },
              }),
            ),
          ),
          Effect.provideService(HostProcess.HomeDirectory, "/home/maria"),
        );
      }
    }),
);
