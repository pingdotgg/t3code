import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { createJjRepo, describeJj, runGit, runJj } from "../vcs/testing/JjTestSupport.ts";

const makeProjectShell = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make("project-1"),
  title: "Imported",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const layerProjectStore = (importedWorkspaceRoots: ReadonlyArray<string>) =>
  Layer.mock(ProjectStore.ProjectStoreV2)({
    listShells: () =>
      Effect.succeed(
        importedWorkspaceRoots.map((workspaceRoot) => makeProjectShell(workspaceRoot)),
      ),
  });

interface ScannerTestInput {
  readonly claudeHomePath: string;
  readonly codexHomePath: string;
  readonly importedWorkspaceRoots?: ReadonlyArray<string>;
  readonly configBaseDir?: string;
  readonly providerInstances?: ContractServerSettings["providerInstances"];
}

const layerScannerTest = (input: ScannerTestInput) =>
  AgentSessionScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: input.claudeHomePath },
            },
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: input.codexHomePath },
            },
            ...input.providerInstances,
          },
        }),
        ServerConfig.layerTest(
          input.claudeHomePath,
          input.configBaseDir ?? { prefix: "t3code-scanner-config-" },
        ),
        layerProjectStore(input.importedWorkspaceRoots ?? []),
      ),
    ),
  );

const runScan = (input: ScannerTestInput) =>
  Effect.gen(function* () {
    const scanner = yield* AgentSessionScanner.AgentSessionScanner;
    return yield* scanner.scan;
  }).pipe(Effect.provide(layerScannerTest(input)));

const makeTempDir = Effect.fn("AgentSessionScanner.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTranscript = Effect.fn("AgentSessionScanner.test.writeTranscript")(function* (input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mtimeMs: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(input.filePath), { recursive: true });
  yield* fileSystem.writeFileString(input.filePath, input.contents);
  const seconds = input.mtimeMs / 1000;
  yield* fileSystem.utimes(input.filePath, seconds, seconds);
});

const claudeSessionLine = (cwd: string) =>
  `${JSON.stringify({ type: "user", cwd, sessionId: "s1" })}\n${JSON.stringify({ type: "assistant" })}\n`;

it.layer(NodeServices.layer)("AgentSessionScanner activation", (it) => {
  describeJj("secondary workspaces", () => {
    it.effect("reports a non-colocated main workspace without a git marker", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const main = yield* makeTempDir("t3code-non-colocated-jj-");
        yield* runJj(main, ["git", "init", "--no-colocate"]);
        expect(yield* fileSystem.exists(path.join(main, ".git"))).toBe(false);
        expect(yield* fileSystem.exists(path.join(main, ".jj", "repo", "store", "git"))).toBe(
          true,
        );
        yield* writeTranscript({
          filePath: path.join(claudeHomePath, "projects", "-non-colocated-jj", "a.jsonl"),
          contents: claudeSessionLine(main),
          mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
        });

        const result = yield* runScan({ claudeHomePath, codexHomePath });

        // Non-colocated stores have no supported Git remote identity, but are still repositories.
        expect(
          result.candidates.map((candidate) => ({ path: candidate.path, git: candidate.git })),
        ).toEqual([{ path: main, git: { remoteKey: null, repository: null } }]);
      }),
    );

    it.effect("excludes user-added workspaces and aliases unless registered as projects", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const claudeHomePath = yield* makeTempDir("t3code-claude-home-");
        const codexHomePath = yield* makeTempDir("t3code-codex-home-");
        const base = yield* makeTempDir("t3code-workspace-jj-");
        const main = path.join(base, "project");
        const workspace = path.join(base, "thread");

        yield* fileSystem.makeDirectory(main, { recursive: true });
        yield* createJjRepo(main);
        yield* runGit(main, ["remote", "add", "origin", "git@github.com:pingdotgg/t3code.git"]);
        yield* runJj(main, ["workspace", "add", workspace]);
        const nested = path.join(workspace, "nested");
        const alias = path.join(base, "alias");
        yield* fileSystem.makeDirectory(nested);
        yield* fileSystem.symlink(workspace, alias);

        for (const [index, cwd] of [
          workspace,
          nested,
          alias,
          path.join(alias, "nested"),
        ].entries()) {
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", "-slug-jj", `${index}.jsonl`),
            contents: claudeSessionLine(cwd),
            mtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          });
        }

        expect((yield* runScan({ claudeHomePath, codexHomePath })).candidates).toEqual([]);
        const result = yield* runScan({
          claudeHomePath,
          codexHomePath,
          importedWorkspaceRoots: [workspace],
        });

        expect(
          result.candidates.map((candidate) => ({ path: candidate.path, git: candidate.git })),
        ).toEqual([
          {
            path: workspace,
            git: { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" },
          },
        ]);
      }),
    );
  });
});
