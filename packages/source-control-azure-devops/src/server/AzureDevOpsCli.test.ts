import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCredentials from "./AzureDevOpsCredentials.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { AzureCliInstallLocation, type AzureCliInstall } from "./azureCliLauncher.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import { primaryRemoteUrl, scopeAzureCliArgs } from "./AzureDevOpsCli.ts";

const processOutput = (stdout: string): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();

// The CLI layer is exercised on a host that spawns `az` itself, so the launcher upgrade stays out of these assertions.
const layerSupport = Layer.mergeAll(
  TestSourceControlHost.layer({
    // No remotes: these cases leave `--detect true` to az.
    process: {
      run: (input) =>
        input.command === "git" ? Effect.succeed(processOutput("")) : mockRun(input),
    },
  }),
  NodeServices.layer,
  Layer.succeed(HostProcess.Platform, "linux"),
);
const layer = Layer.mergeAll(
  AzureDevOpsCli.layer.pipe(
    Layer.provide(AzureDevOpsCredentials.layer),
    Layer.provide(layerSupport),
  ),
  layerSupport,
);

afterEach(() => {
  mockRun.mockReset();
});

describe("AzureDevOpsCli.layer", () => {
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
              lastMergeSourceCommit: { commitId: "a".repeat(40) },
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
        // The selected remote numbers the pull request, whatever the checkout's primary remote.
        remoteUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Add Azure provider");
      assert.strictEqual(result.url, "https://dev.azure.com/acme/project/_git/repo/pullrequest/42");
      assert.strictEqual(result.baseRefName, "main");
      assert.strictEqual(result.headRefName, "feature/source-control");
      assert.strictEqual(result.headSha, "a".repeat(40));
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(result.updatedAt._tag, Option.some(1)._tag);
      const { classifyFailure, ...call } = mockRun.mock.calls.at(-1)?.[0] ?? {};
      assert.strictEqual(
        classifyFailure?.("Please run az login to setup account."),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.("Please run 'az login' to setup account."),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.("TF401180: The requested pull request was not found."),
        "not-found",
      );
      assert.strictEqual(
        classifyFailure?.(
          "ERROR: TF400733: The request has been canceled: Request was blocked due to exceeding usage of resource 'Global' in namespace 'User'.",
        ),
        "rate-limited",
      );
      assert.deepStrictEqual(call, {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "false",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
          "--organization",
          "https://dev.azure.com/acme",
        ],
        cwd: "/repo",
        notFoundDetail: "Pull request not found.",
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

  it.effect("looks up a project/repository path as that project's repository", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: { name: "project" },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.getRepositoryCloneUrls({ cwd: "/somewhere", repository: "project/repo" });

      assert.deepStrictEqual(mockRun.mock.calls.at(-1)?.[0].args, [
        "repos",
        "show",
        "--detect",
        "true",
        "--repository=repo",
        "--project=project",
        "--only-show-errors",
        "--output",
        "json",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sends repository and project names that look like `@path` as text", () =>
    Effect.gen(function* () {
      const repository = JSON.stringify({
        name: "repo",
        webUrl: "https://dev.azure.com/acme/project/_git/repo",
        remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const callsFor = (
        outputs: ReadonlyArray<string>,
        run: Effect.Effect<unknown, AzureDevOpsCli.AzureDevOpsCliError>,
      ) =>
        Effect.gen(function* () {
          mockRun.mockReset();
          for (const stdout of outputs) {
            mockRun.mockReturnValueOnce(Effect.succeed(processOutput(stdout)));
          }
          yield* run;
          return mockRun.mock.calls.map(([call]) => ({
            args: call.args.slice(0, -3),
            stdin: call.stdin,
          }));
        });
      const show = (specifier: string) =>
        callsFor(
          [repository],
          az.getRepositoryCloneUrls({ cwd: "/somewhere", repository: specifier }),
        );
      const repos = ["repos", "show", "--detect", "true"];

      assert.deepStrictEqual(yield* show("project/@repo"), [
        { args: [...repos, "--repository=@-", "--project=project"], stdin: "@repo" },
      ]);
      assert.deepStrictEqual(yield* show("@project/-repo"), [
        { args: [...repos, "--repository=-repo", "--project=@-"], stdin: "@project" },
      ]);

      // az has one stdin: the project is read first and named by its ID in the lookup.
      const projectId = "d18445d6-86b1-4b1d-88aa-bc6d45d8b9b0";
      const withProjectId = (run: Effect.Effect<unknown, AzureDevOpsCli.AzureDevOpsCliError>) =>
        callsFor([JSON.stringify({ id: projectId }), repository], run);
      const project = {
        args: ["devops", "project", "show", "--detect", "true", "--project=@-"],
        stdin: "@project",
      };
      assert.deepStrictEqual(
        yield* withProjectId(
          az.getDefaultBranch({ cwd: "/somewhere", repository: "@project/@repo" }),
        ),
        [
          project,
          { args: [...repos, "--repository=@-", `--project=${projectId}`], stdin: "@repo" },
        ],
      );
      assert.deepStrictEqual(
        yield* withProjectId(
          az.createRepository({
            cwd: "/somewhere",
            repository: "@project/@repo",
            visibility: "private",
          }),
        ),
        [
          project,
          {
            args: ["repos", "create", "--detect", "true", "--name=@-", `--project=${projectId}`],
            stdin: "@repo",
          },
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs az only for a reference that holds a pull request number", () =>
    Effect.gen(function* () {
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      // az would read `@notes.txt` as a file and `--help` as an option.
      for (const reference of ["@notes.txt", "--help", "feature"]) {
        const error = yield* az.getPullRequest({ cwd: "/repo", reference }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "AzureDevOpsPullRequestNotFoundError");
      }
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("percent-encodes the source branch while preserving recognized ref prefixes", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.listPullRequests({
        cwd: "/somewhere",
        headSelector: "user/feat/1-(#2)-slug",
        state: "open",
      });

      // Joined so a branch starting with `-` stays the option's value.
      expect(mockRun.mock.calls.at(-1)?.[0].args).toContain(
        "--source-branch=user%2Ffeat%2F1-(%232)-slug",
      );

      for (const prefix of ["refs/heads/", "refs/pull/", "refs/tags/"]) {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
        yield* az.listPullRequests({
          cwd: "/somewhere",
          headSelector: "fallback",
          source: { refName: `${prefix}user/feat/1-(#2)-slug` },
          state: "open",
        });

        expect(mockRun.mock.calls.at(-1)?.[0].args).toContain(
          `--source-branch=${prefix}user%2Ffeat%2F1-(%232)-slug`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("sends a title that looks like `@path` as text, not as a file for az to read", () =>
    Effect.gen(function* () {
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      for (const title of ["@notes.txt", "a=@notes.txt"]) {
        mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
        yield* az.createPullRequest({
          cwd: "/somewhere",
          baseBranch: "main",
          headSelector: "feature",
          title,
          bodyFile: "/tmp/body.md",
        });

        // az replaces an argument that starts with `@`, or whose text after the first `=` does, with that file's contents.
        const fileReads = (mockRun.mock.calls.at(-1)?.[0].args ?? []).flatMap((arg) => {
          const value = arg.startsWith("@") ? arg : arg.slice(arg.indexOf("=") + 1);
          return (arg.startsWith("@") || arg.includes("=")) && value.startsWith("@")
            ? [value.slice(1)]
            : [];
        });
        expect(fileReads).not.toContain("notes.txt");
        expect(mockRun.mock.calls.at(-1)?.[0].stdin).toBe(
          title.startsWith("@") ? title : undefined,
        );
        // az expands a separate `@file` value a second time, so a body of `@notes.txt` read notes.txt.
        expect(mockRun.mock.calls.at(-1)?.[0].args).toContain("--description=@/tmp/body.md");
      }

      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));
      yield* az.createPullRequest({
        cwd: "/somewhere",
        baseBranch: "main",
        headSelector: "feature",
        title: "Draft",
        bodyFile: "/tmp/body.md",
        draft: true,
      });
      expect(mockRun.mock.calls.at(-1)?.[0].args.join(" ")).toContain("--draft true");
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

describe("azureCliInvocation", () => {
  const launcher = "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd";
  const msi: AzureCliInstall = {
    interpreter: "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\python.exe",
    installer: "MSI",
  };

  const invocationFor = (install: AzureCliInstall | undefined) =>
    AzureDevOpsCli.azureCliInvocation().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, { PATH: "C:\\tools" }),
      Effect.provideService(SpawnExecutableResolution, async () => launcher),
      Effect.provideService(AzureCliInstallLocation, () => install),
    );

  it.effect("runs the install's interpreter in UTF-8 mode", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* invocationFor(msi), {
        command: msi.interpreter,
        args: ["-X", "utf8", "-IBm", "azure.cli"],
        env: { AZ_INSTALLER: "MSI" },
      });
    }),
  );

  it.effect("keeps the launcher when the install is not recognized", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* invocationFor(undefined), {
        command: "az",
        args: [],
      });
    }),
  );

  it.effect("spawns az directly off Windows", () =>
    Effect.gen(function* () {
      const invocation = yield* AzureDevOpsCli.azureCliInvocation().pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );

      assert.deepStrictEqual(invocation, { command: "az", args: [] });
    }),
  );
});

describe("scopeAzureCliArgs", () => {
  const origin = "https://dev.azure.com/acme/Project/_git/Repo";
  const show = ["repos", "show", "--detect", "true"];

  it.each([
    [
      ["repos", "show"],
      ["--project=Project", "--repository=Repo"],
    ],
    [["repos", "create", "--name", "New"], ["--project=Project"]],
    [
      ["repos", "pr", "list"],
      ["--project=Project", "--repository=Repo"],
    ],
    [
      ["repos", "pr", "create"],
      ["--project=Project", "--repository=Repo"],
    ],
    [["repos", "pr", "show", "--id", "42"], []],
    [["devops", "invoke", "--area", "git"], []],
  ])("scopes %j to the commands' supported arguments", (command, scope) => {
    expect(scopeAzureCliArgs([...command, "--detect", "true"], origin)).toEqual([
      ...command,
      "--detect",
      "false",
      "--organization",
      "https://dev.azure.com/acme",
      ...scope,
    ]);
  });

  it.each([
    ["https://dev.azure.com/acme/My%20Project/_git/My%20Repo", "https://dev.azure.com/acme"],
    ["https://user@dev.azure.com/acme/My%20Project/_git/My%20Repo", "https://dev.azure.com/acme"],
    [
      "https://acme.visualstudio.com/DefaultCollection/My%20Project/_git/My%20Repo",
      "https://acme.visualstudio.com",
    ],
    ["https://acme.visualstudio.com/My%20Project/_git/My%20Repo", "https://acme.visualstudio.com"],
    ["git@ssh.dev.azure.com:v3/acme/My%20Project/My%20Repo", "https://dev.azure.com/acme"],
    ["ssh://git@ssh.dev.azure.com:22/v3/acme/My%20Project/My%20Repo", "https://dev.azure.com/acme"],
    ["git@vs-ssh.visualstudio.com:v3/acme/My%20Project/My%20Repo", "https://acme.visualstudio.com"],
  ])("reads the organization of %s", (url, organization) => {
    expect(scopeAzureCliArgs(show, url)).toEqual([
      "repos",
      "show",
      "--detect",
      "false",
      "--organization",
      organization,
      "--project=My Project",
      "--repository=My Repo",
    ]);
  });

  it.each([
    ["https://dev.azure.com/acme/_git/My%20Repo", "https://dev.azure.com/acme", "My Repo"],
    ["https://acme.visualstudio.com/_git/My%20Repo", "https://acme.visualstudio.com", "My Repo"],
    [
      "https://acme.visualstudio.com/DefaultCollection/_git/My%20Repo",
      "https://acme.visualstudio.com",
      "My Repo",
    ],
  ])("reads shorthand %s as a project named after its repository", (url, organization, name) => {
    expect(scopeAzureCliArgs(show, url)).toEqual([
      "repos",
      "show",
      "--detect",
      "false",
      "--organization",
      organization,
      `--project=${name}`,
      `--repository=${name}`,
    ]);
  });

  it("joins names starting with `-` to their options", () => {
    expect(
      scopeAzureCliArgs(
        ["repos", "pr", "list", "--detect", "true"],
        "https://dev.azure.com/acme/-Project/_git/-Repo",
      ),
    ).toEqual(expect.arrayContaining(["--project=-Project", "--repository=-Repo"]));
  });

  it("keeps the caller's project and repository", () => {
    for (const selection of [
      ["--project", "Chosen", "--repository", "Chosen"],
      ["-p", "Chosen", "-r", "Chosen"],
      ["--repository=Chosen", "--project", "Chosen"],
    ]) {
      expect(
        scopeAzureCliArgs(["repos", "show", ...selection, "--detect", "true"], origin),
      ).toEqual([
        "repos",
        "show",
        ...selection,
        "--detect",
        "false",
        "--organization",
        "https://dev.azure.com/acme",
      ]);
    }
  });

  it.each([
    [["account", "show", "--detect", "true"], origin],
    [["repos", "show"], origin],
    [["repos", "show", "--detect", "false"], origin],
    [["repos", "show", "--detect", "true", "--org", "https://dev.azure.com/explicit"], origin],
    [show, "https://github.com/acme/repo"],
    [show, "https://dev.azure.com/acme"],
    [show, "https://dev.azure.com/acme/%XX/_git/Repo"],
    [show, "git@ssh.dev.azure.com:v4/acme/Project/Repo"],
    [show, "git@vs-ssh.visualstudio.com:v3/acme.invalid/Project/Repo"],
    // az would replace the value with the contents of a local file.
    [show, "https://dev.azure.com/acme/Project/_git/%40.env"],
  ])("leaves %j to az when %s gives no scope", (args, url) => {
    expect(scopeAzureCliArgs(args, url)).toEqual(args);
  });
});

describe("primaryRemoteUrl", () => {
  const remotes = (...entries: ReadonlyArray<readonly [string, string]>) =>
    entries.map(([name, url]) => `${name}\t${url} (fetch)\n${name}\tpush-url (push)\n`).join("");
  const azure = (name: string) => [name, `https://dev.azure.com/${name}/P/_git/R`] as const;

  it.each([
    // Where T3 publishes the branch and creates its pull requests.
    [remotes(azure("upstream"), azure("origin")), azure("origin")[1]],
    [
      remotes(["github", "https://github.com/acme/repo"], azure("zebra"), azure("alpha")),
      azure("zebra")[1],
    ],
    // A non-Azure origin leaves detection to az rather than scoping another repository.
    [
      remotes(azure("upstream"), ["origin", "https://github.com/acme/repo"]),
      "https://github.com/acme/repo",
    ],
    [
      `origin\t${azure("origin")[1]} (fetch) [blob:none]\norigin\tpush-url (push)\n`,
      azure("origin")[1],
    ],
    [
      remotes(["origin", "ssh://github.com/acme/repo"]) +
        `upstream\t${azure("upstream")[1]} (fetch)\nupstream\t${azure("upstream")[1]} (push)\n`,
      azure("upstream")[1],
    ],
    [
      "origin\thttps://tfs.example.com/p/_git/r (fetch)\norigin\thttps://tfs.example.com/p/_git/r (push)\n" +
        `upstream\t${azure("upstream")[1]} (fetch)\nupstream\t${azure("upstream")[1]} (push)\n`,
      "https://tfs.example.com/p/_git/r",
    ],
    [
      remotes(["origin", "https://dev.azure.com/acme/My Project/_git/My Repo"]),
      "https://dev.azure.com/acme/My Project/_git/My Repo",
    ],
    [remotes(["backup", "/Users/alice/My Repos/app"], azure("origin")), azure("origin")[1]],
    [remotes(), null],
    [`origin\t${azure("origin")[1]} (fetch)`, null],
    [remotes(["origin", "https://dev.azure.com/acme/My\tProject/_git/Repo"]), null],
  ])("picks the scoping remote from %j", (output, url) => {
    expect(primaryRemoteUrl(output)).toBe(url);
  });
});
