import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessSpawnError } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { SourceControlDiscovery, layer } from "./SourceControlDiscovery.ts";

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

it.effect("reports implemented tools separately from locally available CLIs", () => {
  const testLayer = layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-" }),
    ),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          if (input.command === "git") {
            return Effect.succeed(processOutput("git version 2.51.0\n"));
          }
          if (input.command === "gh" && input.args[0] === "--version") {
            return Effect.succeed(processOutput("gh version 2.83.0\n"));
          }
          if (input.command === "gh" && input.args.join(" ") === "auth status") {
            return Effect.succeed(
              processOutput(`github.com
Logged in to github.com account juliusmarminge (keyring)
- Active account: true
- Git operations protocol: ssh
- Token: gho_************************************
- Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
`),
            );
          }
          return Effect.fail(
            new VcsProcessSpawnError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              cause: new Error(`${input.command} not found`),
            }),
          );
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => ({
        kind: item.kind,
        implemented: item.implemented,
        status: item.status,
      })),
      [
        { kind: "git", implemented: true, status: "available" },
        { kind: "jj", implemented: false, status: "missing" },
      ],
    );
    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        implemented: item.implemented,
        status: item.status,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: "github",
          implemented: true,
          status: "available",
          auth: "authenticated",
          account: Option.some("juliusmarminge"),
        },
        {
          kind: "gitlab",
          implemented: true,
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: "azure-devops",
          implemented: false,
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: "bitbucket",
          implemented: false,
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
      ],
    );
  }).pipe(Effect.provide(testLayer));
});

it.effect("probes provider authentication without exposing token details", () => {
  const testLayer = layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-auth-discovery-" }),
    ),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          if (input.args[0] === "--version") {
            return Effect.succeed(processOutput(`${input.command} version test\n`));
          }
          if (input.command === "gh" && input.args.join(" ") === "auth status") {
            return Effect.succeed(
              processOutput(`github.com
Logged in to github.com account octocat (keyring)
- Token: gho_************************************
- Token scopes: 'repo'
`),
            );
          }
          if (input.command === "glab" && input.args.join(" ") === "auth status") {
            return Effect.succeed(
              processOutput(`gitlab.com
Logged in to gitlab.com as gitlab-user
`),
            );
          }
          if (
            input.command === "az" &&
            input.args.join(" ") === "account show --query user.name -o tsv"
          ) {
            return Effect.succeed(processOutput("azure-user@example.com\n"));
          }
          if (input.command === "bb" && input.args.join(" ") === "auth status") {
            return Effect.succeed(
              processOutput(`bitbucket.org
Logged in as bitbucket-user
`),
            );
          }
          return Effect.fail(
            new VcsProcessSpawnError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              cause: new Error(`${input.command} not found`),
            }),
          );
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        auth: item.auth.status,
        account: item.auth.account,
        detail: item.auth.detail,
      })),
      [
        {
          kind: "github",
          auth: "authenticated",
          account: Option.some("octocat"),
          detail: Option.none(),
        },
        {
          kind: "gitlab",
          auth: "authenticated",
          account: Option.some("gitlab-user"),
          detail: Option.none(),
        },
        {
          kind: "azure-devops",
          auth: "authenticated",
          account: Option.some("azure-user@example.com"),
          detail: Option.none(),
        },
        {
          kind: "bitbucket",
          auth: "authenticated",
          account: Option.some("bitbucket-user"),
          detail: Option.none(),
        },
      ],
    );
  }).pipe(Effect.provide(testLayer));
});
