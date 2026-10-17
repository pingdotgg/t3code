import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const processOutput = (stdout: string): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();

const layerSupport = Layer.mergeAll(
  TestSourceControlHost.layer({ process: { run: mockRun } }),
  NodeServices.layer,
);
const layer = Layer.mergeAll(AzureDevOpsCli.layer.pipe(Layer.provide(layerSupport)), layerSupport);

const pythonFixture = String.raw`
import contextlib
import io
import json
import logging
import sys
import types
request = json.loads(sys.stdin.read())
scenario = request["scenario"]
records = []
for name in ["azure", "azure.cli", "azure.cli.core", "azure.cli.core.extension", "azext_devops", "azext_devops.dev", "azext_devops.dev.common", "azext_devops.dev.common.services", "azext_devops.devops_sdk", "azext_devops.devops_sdk.exceptions"]:
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module
def boot():
    records.append("boot")
sys.modules["azure.cli.core"].get_default_cli = boot
def extension(name):
    records.append(["extension", name])
    if scenario == "extension-missing":
        raise RuntimeError("SENSITIVE-MARKER")
    return types.SimpleNamespace(path="/fake extension")
sys.modules["azure.cli.core.extension"].get_extension = extension
sys.modules["azure.cli.core.extension"].get_extension_path = lambda name: "/unused"
class AuthenticationError(Exception):
    pass
sys.modules["azext_devops.devops_sdk.exceptions"].AzureDevOpsAuthenticationError = AuthenticationError
services = sys.modules["azext_devops.dev.common.services"]
def connection(organization):
    records.append(["connection", organization])
    if scenario == "no-credentials":
        raise services.get_authentication_error("SENSITIVE-MARKER")
    def client(kind):
        records.append(["client", kind])
        value = types.SimpleNamespace()
        def original_error(request, response):
            raise RuntimeError("SENSITIVE-MARKER")
        value._handle_error = original_error
        def data():
            records.append("connectionData")
            print("SENSITIVE-MARKER")
            print("SENSITIVE-MARKER", file=sys.stderr)
            logging.warning("SENSITIVE-MARKER")
            if scenario in ["401", "429", "500"]:
                value._handle_error(None, types.SimpleNamespace(status_code=int(scenario)))
            if scenario == "native-authentication":
                raise AuthenticationError("SENSITIVE-MARKER")
            properties = {} if scenario == "missing-account" else {"Account": {"$value": "native@fake.test"}}
            return types.SimpleNamespace(authenticated_user=types.SimpleNamespace(properties=properties, provider_display_name="Wrong Name"))
        value.get_connection_data = data
        return value
    return types.SimpleNamespace(get_client=client)
services.get_connection = connection
sys.stdin = io.StringIO(json.dumps({"organization": request["organization"]}))
stdout, stderr = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
    exec(compile(request["script"], "identity-helper.py", "exec"), {})
json.dump({"stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "records": records}, sys.stdout)
`;

afterEach(() => {
  mockRun.mockReset();
});

describe("AzureDevOpsCli.layer", () => {
  it.effect("keeps JSON command output and caller limits through the native executor", () =>
    Effect.gen(function* () {
      const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
      const output = { ...processOutput(" raw response "), stdoutTruncated: true };
      mockRun.mockReturnValueOnce(Effect.succeed(output));
      assert.strictEqual(
        yield* AzureDevOpsCli.executeJson(azure.execute, {
          cwd: "/repo",
          args: ["devops", "invoke", "--detect", "false", "--area", "wit"],
          timeoutMs: 60_000,
          maxOutputBytes: 8 * 1024 * 1024,
        }),
        output,
      );
      assert.deepStrictEqual(mockRun.mock.calls[0]?.[0], {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd: "/repo",
        args: [
          "devops",
          "invoke",
          "--detect",
          "false",
          "--area",
          "wit",
          "--only-show-errors",
          "--output",
          "json",
        ],
        timeoutMs: 60_000,
        maxOutputBytes: 8 * 1024 * 1024,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads the native organization account through the exact Azure Python runtime", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const python = path.resolve("/native python/it's ä/python");
      mockRun.mockReturnValueOnce(
        Effect.succeed(processOutput(`azure-cli 2.0\nPython location '${python}'\n`)),
      );
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput('{"account":"native@fake.test"}')));
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      assert.strictEqual(
        yield* az.getCurrentIdentity({ cwd: "/repo", organization: "https://dev.azure.com/acme" }),
        "native@fake.test",
      );
      const discovery = mockRun.mock.calls[0]?.[0];
      const helper = mockRun.mock.calls[1]?.[0];
      expect(discovery).toEqual(
        expect.objectContaining({
          command: "az",
          args: ["--version"],
          timeoutMs: 30_000,
          maxOutputBytes: 16_384,
        }),
      );
      expect(helper).toEqual(
        expect.objectContaining({
          command: python,
          spawnCwd: path.dirname(python),
          cwd: "/repo",
          stdin: '{"organization":"https://dev.azure.com/acme"}',
          timeoutMs: 30_000,
          maxOutputBytes: 16_384,
        }),
      );
      assert.strictEqual(helper?.args[0], "-B");
      assert.strictEqual(helper?.args[1], "-c");
      assert.strictEqual(helper?.args.length, 3);
      assert.strictEqual(helper?.env?.AZURE_AUTO_UPGRADE_ENABLE, "false");
      const script = helper?.args[2];
      assert.isString(script);
      for (const [scenario, organization, expected] of [
        ["success", "https://dev.azure.com/acme", { account: "native@fake.test" }],
        ["success", "https://other.visualstudio.com/", { account: "native@fake.test" }],
        ["401", "https://dev.azure.com/acme", { error: "authentication" }],
        ["429", "https://dev.azure.com/acme", { error: "rate-limited" }],
        ["500", "https://dev.azure.com/acme", { error: "failed" }],
        ["native-authentication", "https://dev.azure.com/acme", { error: "authentication" }],
        ["no-credentials", "https://dev.azure.com/acme", { error: "authentication" }],
        ["extension-missing", "https://dev.azure.com/acme", { error: "runtime" }],
        ["missing-account", "https://dev.azure.com/acme", { error: "failed" }],
        ["success", "https://foreign.test/acme", { error: "failed" }],
        ["success", "https://user@dev.azure.com/acme", { error: "failed" }],
        ["success", "https://dev.azure.com/acme?redirect=foreign", { error: "failed" }],
      ] as const) {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(
                path.sep === "\\" ? "python" : "python3",
                ["-I", "-B", "-c", pythonFixture],
                {
                  stdin: Stream.make(
                    new TextEncoder().encode(JSON.stringify({ script, scenario, organization })),
                  ),
                },
              ),
            );
            return yield* Effect.all(
              {
                stdout: Stream.mkString(Stream.decodeText(child.stdout)),
                stderr: Stream.mkString(Stream.decodeText(child.stderr)),
                status: child.exitCode,
              },
              { concurrency: "unbounded" },
            );
          }),
        );
        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stderr, "");
        assert.isFalse(result.stdout.includes("SENSITIVE-MARKER"));
        const proof = JSON.parse(result.stdout) as {
          stdout: string;
          stderr: string;
          records: unknown[];
        };
        assert.deepStrictEqual(JSON.parse(proof.stdout), expected);
        assert.strictEqual(proof.stderr, "");
        if (organization.includes("foreign") || organization.includes("user@"))
          assert.deepStrictEqual(proof.records, []);
        if (scenario === "success" && "account" in expected)
          expect(proof.records).toContainEqual(["connection", organization]);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses unsafe organization URLs before starting Azure CLI", () =>
    Effect.gen(function* () {
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      for (const organization of [
        "http://dev.azure.com/acme",
        "https://dev.azure.com:443/acme",
        "https://user@dev.azure.com/acme",
        "https://dev.azure.com/acme/../other",
        "https://evil.visualstudio.com.foreign.test",
        "https://dev.azure.com/acme\n",
        "https://dev.azure.com/acme?x=y",
      ]) {
        const error = yield* az
          .getCurrentIdentity({ cwd: "/repo", organization })
          .pipe(Effect.flip);
        assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      }
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses invalid, ambiguous, or truncated runtime discovery", () =>
    Effect.gen(function* () {
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      for (const output of [
        processOutput("not a native version"),
        processOutput("Python location 'relative/python'\n"),
        processOutput("Python location '/python'\nPython location '/other'\n"),
        { ...processOutput("Python location '/python'\n"), stdoutTruncated: true },
        { ...processOutput("Python location '/python'\n"), stdoutInvalidUtf8: true },
      ]) {
        mockRun.mockReturnValueOnce(Effect.succeed(output));
        const error = yield* az
          .getCurrentIdentity({ cwd: "/repo", organization: "https://dev.azure.com/acme" })
          .pipe(Effect.flip);
        assert.include(
          ["AzureDevOpsCliUnavailableError", "AzureDevOpsCommandFailedError"],
          error._tag,
        );
      }
      assert.strictEqual(mockRun.mock.calls.length, 5);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("maps only fixed helper errors and hides native failure details", () =>
    Effect.gen(function* () {
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      for (const [payload, tag] of [
        ['{"error":"authentication"}', "AzureDevOpsCliAuthenticationError"],
        ['{"error":"rate-limited"}', "AzureDevOpsCliRateLimitError"],
        ['{"error":"runtime"}', "AzureDevOpsCliUnavailableError"],
        ['{"error":"SENSITIVE-MARKER"}', "AzureDevOpsCommandFailedError"],
        ["SENSITIVE-MARKER", "AzureDevOpsCommandFailedError"],
        ['{"account":""}', "AzureDevOpsCommandFailedError"],
      ] as const) {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("Python location '/python'\n")));
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput(payload)));
        const error = yield* az
          .getCurrentIdentity({ cwd: "/repo", organization: "https://dev.azure.com/acme" })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, tag);
        assert.isFalse(JSON.stringify(error).includes("SENSITIVE-MARKER"));
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses incomplete helper output and sanitizes process failures", () =>
    Effect.gen(function* () {
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      for (const output of [
        { ...processOutput('{"account":"native@fake.test"}'), stdoutTruncated: true },
        { ...processOutput('{"account":"native@fake.test"}'), stderrTruncated: true },
        { ...processOutput('{"account":"native@fake.test"}'), stdoutInvalidUtf8: true },
        {
          ...processOutput('{"account":"native@fake.test"}'),
          exitCode: ChildProcessSpawner.ExitCode(1),
        },
      ]) {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("Python location '/python'\n")));
        mockRun.mockReturnValueOnce(Effect.succeed(output));
        const error = yield* az
          .getCurrentIdentity({ cwd: "/repo", organization: "https://dev.azure.com/acme" })
          .pipe(Effect.flip);
        assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      }
      for (const cause of [
        new VcsProcessTimeoutError({
          operation: "identity",
          command: "SENSITIVE-MARKER",
          cwd: "/repo",
          timeoutMs: 30_000,
        }),
        new VcsProcessExitError({
          operation: "identity",
          command: "SENSITIVE-MARKER",
          cwd: "/repo",
          exitCode: 1,
          detail: "SENSITIVE-MARKER",
        }),
        new VcsProcessSpawnError({
          operation: "identity",
          command: "SENSITIVE-MARKER",
          cwd: "/repo",
          cause: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            syscall: "spawn",
            pathOrDescriptor: "/missing/python",
          }),
        }),
      ]) {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("Python location '/python'\n")));
        mockRun.mockReturnValueOnce(Effect.fail(cause));
        const error = yield* az
          .getCurrentIdentity({ cwd: "/repo", organization: "https://dev.azure.com/acme" })
          .pipe(Effect.flip);
        assert.strictEqual(
          error._tag,
          cause._tag === "VcsProcessSpawnError"
            ? "AzureDevOpsCliUnavailableError"
            : "AzureDevOpsCommandFailedError",
        );
        assert.isFalse(JSON.stringify(error).includes("SENSITIVE-MARKER"));
      }
    }).pipe(Effect.provide(layer)),
  );
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 42,
              title: "Add Azure provider",
              sourceRefName: "refs/heads/feature/source-control",
              targetRefName: "refs/heads/main",
              status: "active",
              creationDate: "2026-01-02T00:00:00.000Z",
              closedDate: null,
              _links: {
                web: {
                  href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
                },
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Add Azure provider");
      assert.strictEqual(result.url, "https://dev.azure.com/acme/project/_git/repo/pullrequest/42");
      assert.strictEqual(result.baseRefName, "main");
      assert.strictEqual(result.headRefName, "feature/source-control");
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(result.updatedAt._tag, Option.some(1)._tag);
      assert.deepStrictEqual(mockRun.mock.calls.at(-1)?.[0], {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
      assert.strictEqual(result.isCrossRepository, false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("marks a pull request from a fork as cross-repository", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 43,
              title: "From a fork",
              sourceRefName: "refs/heads/main",
              targetRefName: "refs/heads/main",
              status: "active",
              forkSource: { name: "refs/heads/main", repository: { name: "repo-fork" } },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({ cwd: "/repo", reference: "43" });

      assert.strictEqual(result.isCrossRepository, true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("builds a web URL when Azure returns only the pull request REST URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 863,
              title: "Fix Azure link",
              url: "https://dev.azure.com/saplyai/a8fe4088-ad76-4eda-aaaa-e3329713a097/_apis/git/repositories/16108a25-93a3-4eff-b77d-85e894ee0fe4/pullRequests/863",
              repository: {
                name: "CV-engine",
                project: {
                  name: "CV-engine",
                },
              },
              sourceRefName: "refs/heads/feature/azure-pr-link",
              targetRefName: "refs/heads/main",
              status: "active",
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "863",
      });

      assert.strictEqual(
        result.url,
        "https://dev.azure.com/saplyai/CV-engine/_git/CV-engine/pullrequest/863",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists pull requests with Azure status and source branch arguments", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                pullRequestId: 7,
                title: "Merged work",
                sourceRefName: "refs/heads/feature/merged",
                targetRefName: "refs/heads/main",
                status: "completed",
                closedDate: "2026-01-03T00:00:00.000Z",
                _links: {
                  web: {
                    href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/7",
                  },
                },
              },
            ]),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.listPullRequests({
        cwd: "/repo",
        headSelector: "origin:feature/merged",
        state: "merged",
        limit: 10,
      });

      assert.strictEqual(result[0]?.state, "merged");
      assert.strictEqual(result[0]?.mergedAt, "2026-01-03T00:00:00.000Z");
      assert.strictEqual(result[0]?.closedAt, null);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          "--source-branch",
          "feature/merged",
          "--status",
          "completed",
          "--top",
          "10",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "repo",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories through Azure Repos", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.createRepository({
        cwd: "/repo",
        repository: "project/repo",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "create",
          "--detect",
          "true",
          "--name",
          "repo",
          "--project",
          "project",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates pull requests using the body file as the Azure description", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bodyFile = `/tmp/t3code-azure-devops-cli-.md`;
      yield* fileSystem.writeFileString(bodyFile, "Generated body");
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/provider",
        title: "Provider PR",
        bodyFile,
      });

      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "az",
          cwd: "/repo",
          args: expect.arrayContaining(["--description", `@${bodyFile}`]),
        }),
      );
      expect(mockRun.mock.calls[0]?.[0].args).not.toContain("--output");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not force JSON output on checkout side-effect commands", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.checkoutPullRequest({
        cwd: "/repo",
        reference: "42",
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "checkout",
          "--only-show-errors",
          "--detect",
          "true",
          "--id",
          "42",
          "--remote-name",
          "origin",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("forwards explicit output limits to the process boundary", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.execute({
        cwd: "/repo",
        args: ["repos", "pr", "list"],
        maxOutputBytes: 16 * 1024 * 1024,
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: ["repos", "pr", "list"],
        cwd: "/repo",
        timeoutMs: 30_000,
        maxOutputBytes: 16 * 1024 * 1024,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves VCS causes without copying upstream details into messages", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az repos list --organization sensitive-upstream-detail",
        cwd: "/repo",
        exitCode: 1,
        detail: "sensitive-upstream-detail",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.operation, "execute");
      assert.strictEqual(error.command, "az");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.argumentCount, 2);
      assert.strictEqual(error.detail, "Azure DevOps CLI command failed.");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes("sensitive-upstream-detail"), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not report a missing working directory as a missing Azure CLI", () =>
    Effect.gen(function* () {
      const cwd = "/missing/repo";
      const platformCause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        syscall: "chdir",
        pathOrDescriptor: cwd,
      });
      const cause = new VcsProcessSpawnError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd,
        argumentCount: 2,
        cause: platformCause,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd, args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.cwd, cwd);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps invalid pull request output diagnostics structured", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("not-json")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.getPullRequest({ cwd: "/repo", reference: "42" }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsPullRequestDecodeError);
      assert.strictEqual(error.operation, "getPullRequest");
      assert.strictEqual(error.command, "az");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.outputLength, 8);
      assert.strictEqual(error.detail, "Azure DevOps CLI returned invalid pull request JSON.");
      assert.exists(error.cause);
      assert.strictEqual(
        error.message,
        "Azure DevOps CLI failed in getPullRequest: Azure DevOps CLI returned invalid pull request JSON.",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd: "/repo",
        argumentCount: 2,
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCliRateLimitError);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );
});
