// @effect-diagnostics nodeBuiltinImport:off - fixtures use isolated temporary checkouts and verify source bytes against SHA-256 digests.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";

import * as NodeCryptoEffect from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestrationV2AppThread,
  ProjectId,
  ThreadId,
  VcsProcessExitError,
  type ProjectCodeIndexEvent,
  type VcsListWorkspaceFilesResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../config.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsDriver from "../../vcs/VcsDriver.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import * as CodeIntelligence from "./CodeIntelligence.ts";
import { indexRootFor, linkCheckoutSources } from "./codeIndexLayout.ts";
import { pinPublishedGeneration } from "./codeIndexLocks.ts";
import { rankListing } from "./codeIntelligenceWorker.ts";
import * as FileHistory from "./FileHistory.ts";

const notARepository = new VcsProcessExitError({
  operation: "test",
  command: "git ls-files",
  cwd: "/",
  exitCode: 128,
  detail: "not a git repository",
});

const projectId = ProjectId.make("project:code-intelligence");
const threadId = ThreadId.make("thread:code-intelligence");
const worktreeThreadId = ThreadId.make("thread:code-intelligence-worktree");
const codeGraphRequirePath = NodeURL.fileURLToPath(
  new URL("../../../package.json", import.meta.url),
);

class FixtureSetupFailed extends Schema.TaggedError<FixtureSetupFailed>()("FixtureSetupFailed", {
  cause: Schema.Defect(),
}) {}

async function makeFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-code-intelligence-"));
  const worktree = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-code-intelligence-worktree-"),
  );
  await NodeFSP.mkdir(NodePath.join(root, "src"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(worktree, "src"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(root, ".codegraph-t3-copy"), { recursive: true });
  const typescriptDefinition = 'const prefix = "🧪é"; export function greet() { return prefix; }\n';
  const typescriptCaller = [
    'import { greet as sayHello } from "./defs";',
    "// sayHello() is mentioned in a comment.",
    'const example = "sayHello()";',
    'export function caller() { const marker = "🧪é"; return sayHello(); }',
    'export function shadowed() { const sayHello = () => "local"; return sayHello(); }',
  ].join("\n");
  const goSource = [
    "package example",
    'func greet() string { return "hello" }',
    'func caller() string { _ = "🧪é"; return greet() }',
  ].join("\n");
  const pythonSource = [
    "def greet():",
    '    return "hello"',
    "def caller():",
    '    marker = "🧪é"; return greet()',
  ].join("\n");
  const worktreeSource = "export function workOnly() { return 2; }\n";
  await NodeFSP.writeFile(NodePath.join(root, "src/defs.ts"), typescriptDefinition);
  await NodeFSP.writeFile(NodePath.join(root, "src/use.ts"), typescriptCaller);
  await NodeFSP.writeFile(NodePath.join(root, "src/main.go"), goSource);
  await NodeFSP.writeFile(NodePath.join(root, "src/main.py"), pythonSource);
  await NodeFSP.writeFile(NodePath.join(root, ".codegraph-t3-copy/user.txt"), "User data.\n");
  await NodeFSP.writeFile(NodePath.join(worktree, "src/work.ts"), worktreeSource);
  return { root, worktree, typescriptDefinition, typescriptCaller, goSource, pythonSource };
}

function withFixture<A, E, R>(
  use: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: makeFixture,
      catch: (cause) => new FixtureSetupFailed({ cause }),
    }),
    // Services built in the test close, ending their builds, before the checkout is removed.
    (fixture) => Effect.scoped(use(fixture)),
    ({ root, worktree }) =>
      Effect.promise(async () => {
        await NodeFSP.rm(root, { recursive: true, force: true });
        await NodeFSP.rm(worktree, { recursive: true, force: true });
      }),
  );
}

type Query = Parameters<CodeIntelligence.CodeIntelligence["Service"]["query"]>[0]["query"];

/** The published generation's directory name, read the way a fresh reader would. */
async function publishedDirectory(indexRoot: string) {
  const generation = (
    await NodeFSP.readFile(NodePath.join(indexRoot, ".codegraph-t3/published"), "utf8")
  ).trim();
  return `.codegraph-t3-g${generation}`;
}

async function generationDirectories(indexRoot: string) {
  return (await NodeFSP.readdir(indexRoot).catch(() => [] as string[]))
    .filter((name) => /^\.codegraph-t3-g\d+$/.test(name))
    .toSorted();
}

// Windows has no SIGABRT; SIGKILL ends the process just as abruptly there.
const abortProcess = (pid: number) =>
  Effect.map(HostProcess.isWindows, (windows) =>
    process.kill(pid, windows ? "SIGKILL" : "SIGABRT"),
  );

function assertClearedIndex(indexRoot: string): void {
  assert.isFalse(NodeFS.existsSync(indexRoot));
}

/**
 * A server config whose data directory is outside the fixture, and the index root it implies for
 * a checkout.
 */
interface CheckoutConfig {
  readonly layer: Layer.Layer<ServerConfig.ServerConfig>;
  readonly codeIndexDir: string;
  readonly indexRoot: (checkoutPath: string) => string;
}

function checkoutConfig(): Effect.Effect<CheckoutConfig, PlatformError, Scope.Scope> {
  return Effect.gen(function* () {
    const context = yield* Layer.build(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-code-index-" }),
    );
    const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(context));
    return {
      layer: Layer.succeed(ServerConfig.ServerConfig, config),
      codeIndexDir: config.codeIndexDir,
      indexRoot: (checkoutPath: string) => indexRootFor(config.codeIndexDir, checkoutPath),
    };
  }).pipe(Effect.provide(NodeServices.layer));
}

it.effect(
  "serves bounded multilingual graph queries from the authorized project and selected worktree",
  () =>
    withFixture(
      ({ root, worktree, typescriptDefinition, typescriptCaller, goSource, pythonSource }) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await NodeFSP.symlink(worktree, NodePath.join(root, "linked-worktree"));
            await NodeFSP.symlink(
              NodePath.join(worktree, "src/work.ts"),
              NodePath.join(root, "src/linked-work.ts"),
            );
          });
          const project = {
            projectId,
            workspaceRoot: root,
            deletedAt: null,
          } as unknown as ProjectStore.ProjectRow;
          const mainThread = {
            id: threadId,
            projectId,
            worktreePath: null,
          } as unknown as OrchestrationV2AppThread;
          const worktreeThread = {
            id: worktreeThreadId,
            projectId,
            worktreePath: worktree,
          } as unknown as OrchestrationV2AppThread;
          let includeGeneratedInventoryFiles = false;
          const { layer: configLayer, indexRoot } = yield* checkoutConfig();
          const indexRootPath = indexRoot(root);
          const dependencies = Layer.mergeAll(
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () => Effect.succeedSome(project),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: (requestedThreadId) =>
                Effect.succeed(
                  requestedThreadId === worktreeThreadId ? worktreeThread : mainThread,
                ),
            }),
            Layer.mock(WorkspacePaths.WorkspacePaths)({
              normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
              resolveRelativePathWithinRoot: ({ relativePath }) =>
                Effect.succeed({ absolutePath: relativePath, relativePath }),
            }),
            Layer.mock(WorkspaceEntries.WorkspaceEntries)({
              refresh: () => Effect.void,
              list: ({ cwd }) =>
                Effect.promise(async () => {
                  const entries =
                    cwd === worktree
                      ? ["src/work.ts"]
                      : ["src/defs.ts", "src/use.ts", "src/main.go", "src/main.py"];
                  if (
                    cwd === root &&
                    includeGeneratedInventoryFiles &&
                    (await NodeFSP.stat(NodePath.join(indexRootPath, ".codegraph-t3/published"))
                      .then(() => true)
                      .catch(() => false))
                  ) {
                    entries.push(
                      ".codegraph-t3/.gitignore",
                      `${await publishedDirectory(indexRootPath)}/.gitignore`,
                      ".codegraph-t3-copy/user.txt",
                    );
                  }
                  return {
                    entries: entries.map((path) => ({ path, kind: "file" as const })),
                    truncated: false,
                  };
                }),
            }),
            Layer.mock(VcsDriver.VcsDriver)({
              checkpoints: {} as VcsDriver.VcsDriver["Service"]["checkpoints"],
              listWorkspaceFiles: () => Effect.fail(notARepository),
            }),
            ServerSettings.layerTest(),
            configLayer,
          );
          const provided = Layer.provide(CodeIntelligence.layer, dependencies);
          const intelligence = yield* CodeIntelligence.CodeIntelligence.pipe(
            Effect.provide(yield* Layer.build(provided)),
          );
          const target = (selectedThreadId?: ThreadId) => ({
            projectId,
            ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
          });
          const runQuery = (query: Query, selectedThreadId?: ThreadId) =>
            intelligence.query({ ...target(selectedThreadId), query });
          const refresh = (selectedThreadId?: ThreadId) =>
            intelligence.refresh(target(selectedThreadId));

          yield* Effect.promise(async () => {
            const seed = new NodeWorkerThreads.Worker(
              `const { parentPort, workerData } = require("node:worker_threads");
               const { createRequire } = require("node:module");
               const sdk = createRequire(workerData.requirePath)("@colbymchenry/codegraph");
               (async () => {
                 const graph = await sdk.CodeGraph.init(workerData.root, { index: false });
                 try { await graph.sync(); } finally { graph.close(); }
                 parentPort.postMessage({ ready: true });
               })().catch((error) => parentPort.postMessage({ error: String(error) }));`,
              {
                eval: true,
                workerData: { requirePath: codeGraphRequirePath, root: indexRootPath },
                env: { ...process.env, CODEGRAPH_DIR: ".codegraph-t3-g1" },
              },
            );
            await new Promise<void>((resolve, reject) => {
              seed.once("error", reject);
              seed.on(
                "message",
                (message: { readonly error?: string; readonly ready?: boolean }) => {
                  if (message.error !== undefined) reject(new Error(message.error));
                  else if (message.ready) resolve();
                },
              );
              seed.once("exit", (code) => {
                if (code !== 0) reject(new Error(`Seed index worker exited with code ${code}.`));
              });
            });
            await NodeFSP.mkdir(NodePath.join(indexRootPath, ".codegraph-t3"));
            await NodeFSP.writeFile(NodePath.join(indexRootPath, ".codegraph-t3/published"), "1");
          });

          const staleLinkedSymbols = yield* runQuery({
            operation: "symbols",
            name: "workOnly",
          });
          assert.equal(staleLinkedSymbols.nodes.length, 0);
          assert.equal(staleLinkedSymbols.index?.generation, 0);
          // The successor is rebuilt rather than copied, so the links the seed indexed are gone.
          yield* refresh();
          const persistedDirectory = yield* Effect.promise(() => publishedDirectory(indexRootPath));
          assert.notEqual(persistedDirectory, ".codegraph-t3-g1");
          const persistedLinkedSymbols = yield* Effect.promise(
            () =>
              new Promise<number>((resolve, reject) => {
                const inspect = new NodeWorkerThreads.Worker(
                  `const { parentPort, workerData } = require("node:worker_threads");
                   const { createRequire } = require("node:module");
                   const sdk = createRequire(workerData.requirePath)("@colbymchenry/codegraph");
                   (async () => {
                     const graph = await sdk.CodeGraph.open(workerData.root, { sync: false });
                     try { parentPort.postMessage(graph.getNodesByName("workOnly").length); }
                     finally { graph.close(); }
                   })().catch((error) => parentPort.postMessage({ error: String(error) }));`,
                  {
                    eval: true,
                    workerData: { requirePath: codeGraphRequirePath, root: indexRootPath },
                    env: { ...process.env, CODEGRAPH_DIR: persistedDirectory },
                  },
                );
                inspect.once("error", reject);
                inspect.on("message", (message: number | { readonly error: string }) => {
                  if (typeof message === "number") resolve(message);
                  else reject(new Error(message.error));
                });
                inspect.once("exit", (code) => {
                  if (code !== 0) reject(new Error(`Inspect worker exited with code ${code}.`));
                });
              }),
          );
          assert.equal(persistedLinkedSymbols, 0);
          yield* Effect.promise(async () => {
            for (const name of [".codegraph-t3", ...(await generationDirectories(indexRootPath))]) {
              await NodeFSP.rm(NodePath.join(indexRootPath, name), {
                recursive: true,
                force: true,
              });
            }
          });

          // Cold queries answer at once and share one build.
          const coldAnswers = yield* Effect.all(
            [runQuery({ operation: "status" }), runQuery({ operation: "search", text: "greet" })],
            { concurrency: 2 },
          );
          assert.deepEqual(
            coldAnswers.map((answer) => answer.index?.state),
            ["unindexed", "unindexed"],
          );
          assert.deepEqual(yield* refresh(), { _tag: "Unchanged" });
          assert.deepEqual(yield* Effect.promise(() => generationDirectories(indexRootPath)), [
            ".codegraph-t3-g1",
          ]);
          const [concurrentStatus, concurrentSearch] = yield* Effect.all(
            [runQuery({ operation: "status" }), runQuery({ operation: "search", text: "greet" })],
            { concurrency: 2 },
          );
          assert.equal(concurrentStatus.coverage.state, "complete");
          assert.equal(concurrentStatus.coverage.filesListed, 4);
          assert.equal(concurrentStatus.coverage.filesUnsupported, 0);
          assert.ok(concurrentSearch.matches.some((match) => match.symbol.name === "greet"));

          const toolLayer = McpHttpServer.layerProjectCodeToolkit.pipe(
            Layer.provide(provided),
            Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
            Layer.provide(Layer.mock(FileHistory.FileHistory)({})),
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provide(NodeCryptoEffect.layer),
            Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          );
          const toolResult = yield* Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            return yield* server
              .callTool({
                name: "t3_project_code_query",
                arguments: {
                  projectId,
                  query: { operation: "symbols", name: "greet" },
                },
              })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, {
                  environmentId: EnvironmentId.make("code-intelligence-test"),
                  requestNamespace: "client:code-intelligence-test",
                  thread: undefined,
                  client: {
                    sessionId: "code-intelligence-test",
                    label: "Code intelligence test",
                    access: "read-only",
                  },
                  issuedAt: 0,
                  capabilities: new Set<McpInvocationContext.McpCapability>([
                    "orchestration",
                    "project-code",
                  ]),
                }),
                Effect.provideService(
                  McpSchema.McpServerClient,
                  McpSchema.McpServerClient.of({
                    clientId: 1,
                    protocolVersion: "2025-06-18",
                    clientCapabilities: {},
                    clientInfo: { name: "code-intelligence-test", version: "1" },
                    initializePayload: {
                      protocolVersion: "2025-06-18",
                      capabilities: {},
                      clientInfo: { name: "code-intelligence-test", version: "1" },
                    },
                    getClient: Effect.die("unused"),
                  }),
                ),
              );
          }).pipe(Effect.provide(toolLayer));
          assert.equal(toolResult.isError, false);
          assert.ok(
            (
              toolResult.structuredContent as {
                readonly nodes: ReadonlyArray<{ readonly name: string }>;
              }
            ).nodes.some(({ name }) => name === "greet"),
          );

          const linkedSymbols = yield* runQuery({ operation: "symbols", name: "workOnly" });
          assert.equal(linkedSymbols.nodes.length, 0);
          const outsidePathError = yield* Effect.flip(
            runQuery({
              operation: "symbols",
              name: "workOnly",
              filePath: "src/linked-work.ts",
            }),
          );
          assert.equal(outsidePathError._tag, "CodeIntelligencePathOutsideCheckout");

          const outline = yield* runQuery({ operation: "symbols", filePath: "src/use.ts" });
          assert.deepEqual(
            outline.nodes.map((node) => [node.name, node.path]),
            [
              ["example", "src/use.ts"],
              ["caller", "src/use.ts"],
              ["shadowed", "src/use.ts"],
              ["sayHello", "src/use.ts"],
            ],
          );

          const callerQuery = yield* runQuery({
            operation: "callers",
            symbol: { name: "greet", filePath: "src/defs.ts" },
          });
          assert.equal(callerQuery.selection.state, "matched");
          assert.ok(
            callerQuery.nodes.some((node) => node.name === "caller" && node.path === "src/use.ts"),
          );
          const callEdge = callerQuery.edges.find((edge) => edge.kind === "calls");
          assert.ok(callEdge);
          assert.equal(callEdge.resolvedBy, "import");
          assert.equal(callEdge.provenance, null);
          assert.equal(callEdge.evidenceGrade, "static-candidate");
          assert.ok(callerQuery.edges.every((edge) => edge.evidenceGrade !== "compiler-indexed"));
          const caller = callerQuery.nodes.find((node) => node.name === "caller");
          assert.ok(caller);
          const callerCall = callerQuery.edges.find(
            (edge) => edge.source === caller.id && edge.kind === "calls",
          );
          assert.ok(callerCall);
          assert.equal(
            callerCall.column,
            typescriptCaller.split("\n")[callerCall.line! - 1]!.indexOf("sayHello()"),
          );
          assert.equal(
            callerQuery.nodes.find((node) => node.name === "greet" && node.path === "src/defs.ts")
              ?.startColumn,
            typescriptDefinition.indexOf("function"),
          );
          assert.ok(
            callerQuery.sourceDigests.some(
              (source) => source.path === "src/defs.ts" && source.verified,
            ),
          );
          assert.equal(callerQuery.coverage.relationSemantics, "static-candidates");
          assert.equal(callerQuery.coverage.columnEncoding, "utf16-code-units");
          assert.ok(
            callerQuery.coverage.limitations.some((limitation) =>
              limitation.includes("shadowed names"),
            ),
          );
          assert.equal(callerQuery.coverage.state, "complete");

          const reaches = yield* runQuery({
            operation: "path",
            from: { name: "caller", filePath: "src/use.ts" },
            to: { name: "greet", filePath: "src/defs.ts" },
          });
          assert.equal(reaches.pathSearch?.found, true);
          assert.equal(reaches.pathSearch?.maxDepth, 6);
          assert.equal(reaches.pathSearch?.walkTruncated, false);
          assert.equal(reaches.pathSearch?.unresolvedEndpoint, null);
          // The route runs from `from` to `to`, one edge per hop.
          assert.deepEqual(
            reaches.nodes.map((node) => node.name),
            ["caller", "greet"],
          );
          assert.deepEqual(
            reaches.edges.map((edge) => [edge.source, edge.target]),
            [[reaches.nodes[0]!.id, reaches.nodes[1]!.id]],
          );
          const reverse = yield* runQuery({
            operation: "path",
            from: { name: "greet", filePath: "src/defs.ts" },
            to: { name: "caller", filePath: "src/use.ts" },
            depth: 2,
          });
          assert.equal(reverse.pathSearch?.found, false);
          assert.equal(reverse.pathSearch?.maxDepth, 2);
          assert.deepEqual(reverse.nodes, []);
          const ambiguousTarget = yield* runQuery({
            operation: "path",
            from: { name: "caller", filePath: "src/use.ts" },
            to: { name: "greet" },
          });
          assert.equal(ambiguousTarget.selection.state, "ambiguous");
          assert.equal(ambiguousTarget.pathSearch?.unresolvedEndpoint, "to");
          assert.equal(ambiguousTarget.pathSearch?.found, false);

          const ambiguous = yield* runQuery({ operation: "callers", symbol: { name: "greet" } });
          assert.equal(ambiguous.selection.state, "ambiguous");
          assert.ok(ambiguous.selection.candidates.some((node) => node.language === "go"));
          assert.ok(ambiguous.selection.candidates.some((node) => node.language === "python"));
          assert.equal(ambiguous.edges.length, 0);

          const goCallers = yield* runQuery({
            operation: "callers",
            symbol: { name: "greet", filePath: "src/main.go" },
          });
          assert.ok(
            goCallers.nodes.some((node) => node.name === "caller" && node.language === "go"),
          );
          const goCall = goCallers.edges.find((edge) => edge.kind === "calls");
          assert.ok(goCall);
          assert.equal(goCall.resolvedBy, "exact-match");
          assert.equal(goCall.column, goSource.split("\n")[goCall.line! - 1]!.indexOf("greet()"));
          const pythonCallers = yield* runQuery({
            operation: "callers",
            symbol: { name: "greet", filePath: "src/main.py" },
          });
          assert.ok(
            pythonCallers.nodes.some(
              (node) => node.name === "caller" && node.language === "python",
            ),
          );
          const pythonCall = pythonCallers.edges.find((edge) => edge.kind === "calls");
          assert.ok(pythonCall);
          assert.equal(
            pythonCall.column,
            pythonSource.split("\n")[pythonCall.line! - 1]!.indexOf("greet()"),
          );

          const search = yield* runQuery({ operation: "search", text: "greet", limit: 20 });
          assert.ok(search.matches.some((match) => match.symbol.language === "typescript"));
          assert.ok(search.matches.some((match) => match.symbol.language === "go"));
          assert.ok(search.matches.some((match) => match.symbol.language === "python"));
          assert.ok(search.coverage.languages.includes("typescript"));
          assert.ok(search.coverage.languages.includes("go"));
          assert.ok(search.coverage.languages.includes("python"));
          // The catalog is what the analyzer supports; only these were indexed in the checkout.
          assert.ok(search.coverage.languages.includes("rust"));
          assert.deepEqual(search.coverage.indexedLanguages, ["go", "python", "typescript"]);

          const boundedSearch = yield* runQuery({ operation: "search", text: "greet", limit: 1 });
          assert.equal(boundedSearch.matches.length, 1);
          assert.equal(boundedSearch.coverage.resultLimitReached, true);
          assert.equal(boundedSearch.coverage.state, "partial");

          const dependenciesResult = yield* runQuery({
            operation: "dependencies",
            filePath: "src/use.ts",
            direction: "imports",
          });
          assert.ok(dependenciesResult.files.some((file) => file.path === "src/defs.ts"));

          includeGeneratedInventoryFiles = true;
          const status = yield* runQuery({ operation: "status" });
          assert.equal(status.stats?.files, 4);
          assert.equal(status.coverage.filesListed, 5);
          assert.equal(status.coverage.filesUnsupported, 1);
          const repeatedStatus = yield* runQuery({ operation: "status" });
          assert.equal(repeatedStatus.coverage.filesListed, 5);
          assert.equal(repeatedStatus.coverage.filesUnsupported, 1);
          const graphDirectoryExists = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(indexRootPath, ".codegraph-t3")).then(() => true),
          );
          const checkoutControlExists = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, ".codegraph-t3")).then(
              () => true,
              () => false,
            ),
          );
          const standardIndexExists = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, ".codegraph")).then(
              () => true,
              () => false,
            ),
          );
          const rootGitignoreExists = yield* Effect.promise(() =>
            NodeFSP.stat(NodePath.join(root, ".gitignore")).then(
              () => true,
              () => false,
            ),
          );
          assert.equal(graphDirectoryExists, true);
          assert.equal(checkoutControlExists, false);
          assert.equal(standardIndexExists, false);
          assert.equal(rootGitignoreExists, false);

          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "src/main.go"),
              'package example\nfunc renamed() string { return "changed" }\n',
            ),
          );
          yield* refresh();
          const renamed = yield* runQuery({
            operation: "symbols",
            name: "renamed",
            filePath: "src/main.go",
          });
          assert.ok(renamed.nodes.some((node) => node.name === "renamed"));
          const stale = yield* runQuery({
            operation: "symbols",
            name: "greet",
            filePath: "src/main.go",
          });
          assert.equal(stale.nodes.length, 0);
          yield* Effect.promise(() => NodeFSP.rm(NodePath.join(root, "src/main.py")));
          yield* refresh();
          const afterDelete = yield* runQuery({ operation: "status" });
          assert.equal(afterDelete.stats?.files, 3);

          yield* refresh(worktreeThreadId);
          const worktreeSymbols = yield* runQuery(
            { operation: "symbols", name: "workOnly" },
            worktreeThreadId,
          );
          assert.ok(worktreeSymbols.nodes.some((node) => node.path === "src/work.ts"));
          assert.equal(
            worktreeSymbols.nodes.some((node) => node.name === "greet"),
            false,
          );
          assert.equal(worktreeSymbols.checkoutPath, worktree);

          const sourceDigest = NodeCrypto.createHash("sha256")
            .update(Buffer.from(typescriptDefinition))
            .digest("hex");
          assert.equal(
            callerQuery.sourceDigests.find((source) => source.path === "src/defs.ts")?.digest,
            sourceDigest,
          );
          assert.ok(callerQuery.nodes.length <= 100);
          assert.ok(callerQuery.edges.length <= 100);

          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(root, "src/defs.ts"),
              Buffer.concat([Buffer.from(typescriptDefinition), Buffer.from([0xff])]),
            ),
          );
          const invalidUtf8 = yield* runQuery({
            operation: "dependencies",
            filePath: "src/use.ts",
            direction: "imports",
          });
          assert.equal(
            invalidUtf8.sourceDigests.find((source) => source.path === "src/defs.ts")?.verified,
            false,
          );
          assert.equal(invalidUtf8.coverage.state, "stale");
          // Settles the build that query started.
          yield* refresh();
        }),
    ),
);

it.effect("runs a graph query while the checkout lease is held", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { run, refresh } = yield* checkoutService(fixture.root, () => [
        "src/defs.ts",
        "src/use.ts",
        "src/main.go",
        "src/main.py",
      ]);
      yield* refresh();
      const checkoutLeaseStarted = yield* Deferred.make<void>();
      const releaseCheckoutLease = yield* Deferred.make<void>();
      const checkoutLease = yield* withWorkspaceLease(
        fixture.root,
        Deferred.succeed(checkoutLeaseStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheckoutLease)),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(checkoutLeaseStarted);

      const result = yield* run({ operation: "symbols", name: "greet" });
      yield* Deferred.succeed(releaseCheckoutLease, undefined);
      yield* Fiber.await(checkoutLease);
      assert.ok(result.nodes.some(({ name }) => name === "greet"));
    }),
  ),
);

it.effect("reports index freshness against the checkout and walks usages to reaching tests", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const testSource =
        'import { caller } from "./use";\nexport function checksCaller() { return caller(); }\n';
      const head = yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(fixture.root, "src/defs.test.ts"), testSource);
        const git = (...args: string[]) =>
          NodeChildProcess.execFileSync(
            "git",
            ["-c", "user.email=t3@example.com", "-c", "user.name=T3", ...args],
            { cwd: fixture.root, encoding: "utf8" },
          ).trim();
        git("init", "-q");
        git("add", "src");
        git("commit", "-qm", "fixture");
        return git("rev-parse", "HEAD");
      });
      const gate = buildGate();
      const { run, refresh, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts", "src/use.ts", "src/defs.test.ts"],
        gate,
      );

      // Freshness never indexes: an unindexed checkout stays unindexed.
      assert.equal((yield* run({ operation: "freshness" })).index?.state, "unindexed");
      assert.isFalse(NodeFS.existsSync(indexRoot(fixture.root)));

      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      const indexed = yield* run({ operation: "status" });
      assert.deepInclude(indexed.index, { state: "ready", indexedCommit: head, generation: 1 });
      assert.deepInclude((yield* run({ operation: "freshness" })).index, {
        state: "ready",
        changedFiles: 0,
        indexedCommit: head,
        headCommit: head,
      });

      const name = (result: typeof indexed, id: string) =>
        result.nodes.find((node) => node.id === id)?.name;
      const tests = yield* run({
        operation: "tests",
        symbol: { name: "greet", filePath: "src/defs.ts" },
      });
      assert.deepEqual(
        tests.symbolGroups?.[0]?.tests.map((id) => name(tests, id)),
        ["checksCaller"],
      );
      // The chain through the intermediate caller comes back so a client can show the hops.
      assert.ok(tests.nodes.some((node) => node.name === "caller"));

      const affected = yield* run({
        operation: "affected",
        filePath: "src/defs.ts",
        lineRanges: [{ start: 1, end: 1 }],
      });
      const group = affected.symbolGroups?.find(
        (entry) => name(affected, entry.symbol) === "greet",
      );
      assert.ok(group);
      assert.include(
        group.callers.map((id) => name(affected, id)),
        "caller",
      );
      assert.deepEqual(
        group.tests.map((id) => name(affected, id)),
        ["checksCaller"],
      );
      // Settles the builds those queries started, which find nothing new.
      assert.deepEqual(yield* refresh(), { _tag: "Unchanged" });

      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(fixture.root, "src/defs.ts"),
          'export function greet() { return "changed"; }\n',
        ),
      );
      const staleIndex = {
        state: "stale" as const,
        changedFiles: 1,
        changedPaths: ["src/defs.ts"],
        indexedCommit: head,
        generation: 1,
      };
      assert.deepInclude((yield* run({ operation: "freshness" })).index, staleIndex);

      // While a build is in flight, freshness answers from the published generation.
      const held = yield* gate.holdNext;
      const building = yield* refresh().pipe(Effect.forkScoped);
      yield* Deferred.await(held.entered);
      assert.deepInclude((yield* run({ operation: "freshness" })).index, staleIndex);
      // A query answers from that generation too, and says what it is missing.
      assert.deepInclude((yield* run({ operation: "status" })).index, staleIndex);
      yield* Deferred.succeed(held.release, undefined);
      assert.deepEqual(yield* Fiber.join(building), { _tag: "Published", generation: 2 });

      assert.deepInclude((yield* run({ operation: "status" })).index, {
        state: "ready",
        generation: 2,
      });
      assert.equal((yield* run({ operation: "freshness" })).index?.changedFiles, 0);
    }),
  ),
);

function checkoutService(
  root: string,
  listed: (cwd?: string) => ReadonlyArray<string>,
  {
    beforeListing = () => Effect.void,
    repository = false,
    truncated = false,
    autoCodeIndexEnabled = true,
    worktree,
    config,
    ...serviceOptions
  }: CodeIntelligence.CodeIntelligenceOptions & {
    readonly beforeListing?: () => Effect.Effect<void>;
    /** Lists through git, as a real repository does, instead of the file finder. */
    readonly repository?: boolean;
    readonly truncated?: boolean;
    readonly autoCodeIndexEnabled?: boolean;
    /** A thread whose checkout is `path`, as a worktree thread resolves. */
    readonly worktree?: { readonly threadId: ThreadId; readonly path: string };
    /** Shares one data directory across services, as one server would. */
    readonly config?: CheckoutConfig;
  } = {},
) {
  const project = {
    projectId,
    workspaceRoot: root,
    deletedAt: null,
  } as unknown as ProjectStore.ProjectRow;
  const worktreeThread = {
    id: worktree?.threadId ?? worktreeThreadId,
    projectId,
    worktreePath: worktree?.path ?? root,
  } as unknown as OrchestrationV2AppThread;
  return Effect.gen(function* () {
    const shared = config ?? (yield* checkoutConfig());
    const { layer: configLayer, indexRoot, codeIndexDir } = shared;
    const provided = Layer.provide(
      CodeIntelligence.layerWith(serviceOptions),
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedSome(project) }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: (requestedThreadId) =>
            worktree !== undefined && requestedThreadId === worktree.threadId
              ? Effect.succeed(worktreeThread)
              : Effect.die("unused"),
        }),
        Layer.mock(WorkspacePaths.WorkspacePaths)({
          normalizeWorkspaceRoot: (workspaceRoot) =>
            NodeFS.existsSync(workspaceRoot)
              ? Effect.succeed(workspaceRoot)
              : Effect.fail(
                  new WorkspacePaths.WorkspaceRootNotExistsError({
                    workspaceRoot,
                    normalizedWorkspaceRoot: workspaceRoot,
                  }),
                ),
          resolveRelativePathWithinRoot: ({ relativePath }) =>
            Effect.succeed({ absolutePath: relativePath, relativePath }),
        }),
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({
          refresh: () => Effect.void,
          list: ({ cwd }) =>
            Effect.suspend(beforeListing).pipe(
              Effect.andThen(
                Effect.sync(() => ({
                  entries: listed(cwd).map((path) => ({ path, kind: "file" as const })),
                  truncated,
                })),
              ),
            ),
        }),
        Layer.mock(VcsDriver.VcsDriver)({
          checkpoints: {} as VcsDriver.VcsDriver["Service"]["checkpoints"],
          isInsideWorkTree: () => Effect.succeed(repository),
          listWorkspaceFiles: (cwd) =>
            repository
              ? Effect.sync(
                  () =>
                    ({
                      paths: listed(cwd),
                      truncated,
                    }) as unknown as VcsListWorkspaceFilesResult,
                )
              : Effect.fail(notARepository),
        }),
        ServerSettings.layerTest({ autoCodeIndexEnabled }),
        configLayer,
      ),
    );
    const intelligence = yield* CodeIntelligence.CodeIntelligence.pipe(
      Effect.provide(yield* Layer.build(provided)),
    );
    return {
      indexRoot,
      codeIndexDir,
      hasCheckoutIndex: (checkoutPath: string) => intelligence.hasCheckoutIndex(checkoutPath),
      removeOrphanedIndexes: (isKnown: (checkoutPath: string) => boolean) =>
        intelligence.removeOrphanedIndexes(isKnown),
      run: (query: Query, selectedThreadId?: ThreadId) =>
        intelligence.query({
          projectId,
          ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
          query,
        }),
      refresh: (selectedThreadId?: ThreadId) =>
        intelligence.refresh({
          projectId,
          ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
        }),
      subscribe: (selectedThreadId?: ThreadId) =>
        intelligence.subscribeIndex({
          projectId,
          ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
        }),
      ensureProjectIndexed: () => intelligence.ensureProjectIndexed(projectId),
      refreshForActiveAgent: (selectedThreadId?: ThreadId) =>
        intelligence.refreshForActiveAgent({
          projectId,
          ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
        }),
      refreshIfIndexed: (cwd: string) => intelligence.refreshIfIndexed(cwd),
      removeCheckoutIndex: (checkoutPath: string) => intelligence.removeCheckoutIndex(checkoutPath),
      removeLegacyIndexes: (checkoutPaths: ReadonlyArray<string>) =>
        intelligence.removeLegacyIndexes(checkoutPaths),
      stopBuilds: intelligence.stopBuilds,
    };
  });
}

function indexedSymbolCount(indexRoot: string, name: string) {
  return Effect.promise(async () => {
    const indexDirectory = await publishedDirectory(indexRoot);
    return await new Promise<number>((resolve, reject) => {
      const inspect = new NodeWorkerThreads.Worker(
        `const { parentPort, workerData } = require("node:worker_threads");
         const { createRequire } = require("node:module");
         const sdk = createRequire(workerData.requirePath)("@colbymchenry/codegraph");
         (async () => {
           const graph = await sdk.CodeGraph.open(workerData.root, { sync: false, readOnly: true });
           try { parentPort.postMessage(graph.getNodesByName(workerData.name).length); }
           finally { graph.close(); }
         })().catch((error) => parentPort.postMessage({ error: String(error) }));`,
        {
          eval: true,
          workerData: { requirePath: codeGraphRequirePath, root: indexRoot, name },
          env: { ...process.env, CODEGRAPH_DIR: indexDirectory },
        },
      );
      inspect.once("error", reject);
      inspect.on("message", (message: number | { readonly error: string }) => {
        if (typeof message === "number") resolve(message);
        else reject(new Error(message.error));
      });
    });
  });
}

it.effect("never widens an empty canonical allowlist into a full checkout scan", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.symlink(
          NodePath.join(fixture.worktree, "src/work.ts"),
          NodePath.join(fixture.root, "src/linked-work.ts"),
        ),
      );
      const { run, refresh, indexRoot } = yield* checkoutService(fixture.root, () => [
        "src/linked-work.ts",
      ]);
      assert.deepInclude(yield* refresh(), { _tag: "Published" });
      const status = yield* run({ operation: "status" });
      assert.equal(status.coverage.filesIndexed, 0);
      assert.equal(yield* indexedSymbolCount(indexRoot(fixture.root), "workOnly"), 0);
      assert.equal(yield* indexedSymbolCount(indexRoot(fixture.root), "greet"), 0);
    }),
  ),
);

it.effect("compares oversize and non-UTF-8 sources the way the index hashed them", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const big = NodePath.join(fixture.root, "src/big.ts");
      const latin = NodePath.join(fixture.root, "src/latin.ts");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          big,
          `export function huge() { return 1; }\n/*${"x".repeat(1024 * 1024)}*/\n`,
        );
        await NodeFSP.writeFile(
          latin,
          Buffer.concat([
            Buffer.from("export function latin() { return 1; }\n// "),
            Buffer.from([0xe9, 0xff]),
            Buffer.from("\n"),
          ]),
        );
      });
      const { run, refresh } = yield* checkoutService(fixture.root, () => [
        "src/defs.ts",
        "src/big.ts",
        "src/latin.ts",
      ]);
      yield* refresh();
      yield* Effect.promise(async () => {
        for (const path of [big, latin]) {
          const later = (await NodeFSP.stat(path)).mtimeMs / 1000 + 60;
          await NodeFSP.utimes(path, later, later);
        }
      });
      const freshness = yield* run({ operation: "freshness" });
      assert.deepEqual(freshness.index?.changedPaths, []);
      const affected = yield* run({ operation: "affected", filePath: "src/big.ts" });
      assert.deepEqual(affected.sourceDigests, [
        { path: "src/big.ts", digest: "", verified: true },
      ]);
      assert.notEqual(affected.coverage.state, "stale");
    }),
  ),
);

it.effect("keeps skipped build output partial while detecting newly added source", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(fixture.root, "dist"));
        await NodeFSP.writeFile(
          NodePath.join(fixture.root, "dist/bundle.js"),
          "export const built = 1;\n",
        );
      });
      const files = ["src/defs.ts", "src/use.ts", "dist/bundle.js"];
      const { run, refresh } = yield* checkoutService(fixture.root, () => files);
      yield* refresh();
      const status = yield* run({ operation: "status" });
      assert.equal(status.coverage.filesSkipped, 1);
      const freshness = yield* run({ operation: "freshness" });
      assert.equal(freshness.index?.state, "partial");
      assert.deepEqual(freshness.index?.changedPaths, []);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.root, "src/new.ts"), "export const added = 1;\n"),
      );
      files.push("src/new.ts");
      assert.deepEqual((yield* run({ operation: "freshness" })).index?.changedPaths, [
        "src/new.ts",
      ]);
      yield* refresh();
      assert.equal((yield* run({ operation: "freshness" })).index?.state, "partial");
    }),
  ),
);

it.effect("reports freshness coverage with the same classification as a query", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(fixture.root, "README.md"), "# Fixture\n");
        await NodeFSP.writeFile(NodePath.join(fixture.root, "ci.yaml"), "steps: []\n");
        await NodeFSP.writeFile(NodePath.join(fixture.worktree, "README.md"), "# Fixture\n");
      });
      const { run, refresh } = yield* checkoutService(fixture.root, () => [
        "src/defs.ts",
        "src/use.ts",
        "README.md",
        "ci.yaml",
        // Git lists a tracked file deleted from the working tree, and a submodule as a path.
        "src/deleted.ts",
        "src",
      ]);
      yield* refresh();
      const status = yield* run({ operation: "status" });
      const freshness = yield* run({ operation: "freshness" });
      const counts = (result: typeof status) => ({
        state: result.coverage.state,
        filesUnsupported: result.coverage.filesUnsupported,
        filesSkipped: result.coverage.filesSkipped,
        filesFailed: result.coverage.filesFailed,
      });
      // Docs and assets fill any repository, so they are counted but leave no gap. A file the SDK
      // indexed anyway, such as YAML, is not also unsupported.
      assert.deepEqual(counts(status), {
        state: "complete",
        filesUnsupported: 1,
        filesSkipped: 0,
        filesFailed: 0,
      });
      assert.deepEqual(counts(freshness), counts(status));
      assert.equal(freshness.index?.state, "ready");

      // With nothing else to index, the same files do leave the index empty and incomplete.
      const docsOnly = yield* checkoutService(fixture.worktree, () => ["README.md"]);
      yield* docsOnly.refresh();
      const docsOnlyFreshness = yield* docsOnly.run({ operation: "freshness" });
      assert.equal(docsOnlyFreshness.coverage.state, "partial");
      assert.equal(docsOnlyFreshness.index?.state, "partial");

      // Source in a language the SDK cannot read is a gap, however much else is indexed.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.root, "worker.ex"), "defmodule Worker do\nend\n"),
      );
      const mixed = yield* checkoutService(fixture.root, () => ["src/defs.ts", "worker.ex"]);
      yield* mixed.refresh();
      const mixedFreshness = yield* mixed.run({ operation: "freshness" });
      assert.equal(mixedFreshness.coverage.state, "partial");
      assert.equal(mixedFreshness.index?.state, "partial");

      // One stray script among many sources is not.
      const sources = yield* Effect.promise(() => writeGeneratedSources(fixture.root, 20));
      const stray = yield* checkoutService(fixture.root, () => [...sources, "worker.ex"]);
      yield* stray.refresh();
      assert.equal((yield* stray.run({ operation: "freshness" })).index?.state, "ready");
    }),
  ),
);

it("spends an over-cap listing on first-party sources before anything else", () => {
  assert.deepEqual(
    rankListing(
      [
        ".repos/lib/notes.md",
        ".repos/lib/vendored.ts",
        "README.md",
        "apps/.local/generated.ts",
        "apps/server.ts",
        "packages/shared.ts",
      ],
      (path) => path.endsWith(".ts"),
    ),
    [
      "apps/server.ts",
      "packages/shared.ts",
      ".repos/lib/vendored.ts",
      "apps/.local/generated.ts",
      "README.md",
      ".repos/lib/notes.md",
    ],
  );
});

it.effect("starts over from an index that spent a truncated listing on what sorted first", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(fixture.root, "src/vendored.ts"),
          "export function vendoredOnly() {}\n",
        ),
      );
      let listed = ["src/vendored.ts", "src/defs.ts"];
      const { refresh, indexRoot } = yield* checkoutService(fixture.root, () => listed, {
        truncated: true,
      });
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.equal(yield* indexedSymbolCount(indexRoot(fixture.root), "vendoredOnly"), 1);

      yield* Effect.promise(async () => {
        const root = indexRoot(fixture.root);
        const metaPath = NodePath.join(await publishedDirectory(root), "t3-index.json");
        const absolute = NodePath.join(root, metaPath);
        const { ranked: _ranked, ...legacy } = JSON.parse(await NodeFSP.readFile(absolute, "utf8"));
        await NodeFSP.writeFile(absolute, JSON.stringify(legacy));
      });
      listed = ["src/defs.ts"];
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });
      assert.equal(yield* indexedSymbolCount(indexRoot(fixture.root), "vendoredOnly"), 0);
      assert.equal(yield* indexedSymbolCount(indexRoot(fixture.root), "greet"), 1);
    }),
  ),
);

it.effect("starts a project's first index when a client watches it, and only its first", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const gate = buildGate();
      const { run, subscribe } = yield* checkoutService(fixture.root, () => ["src/defs.ts"], {
        ...gate,
        repository: true,
      });
      const next = <E, R>(events: Stream.Stream<ProjectCodeIndexEvent, E, R>) =>
        events.pipe(Stream.take(1), Stream.runCollect);

      // A watcher does not retry a failed first build, or a persistent failure would repeat for
      // every client that looks.
      const held = yield* gate.holdNext;
      const events = yield* subscribe();
      assert.deepInclude((yield* run({ operation: "freshness" })).index, {
        state: "unindexed",
        refresh: "building",
      });
      const buildPid = yield* Deferred.await(held.entered);
      // Nobody asked for this build, so it yields to work someone is waiting on.
      assert.equal(NodeOS.getPriority(buildPid), NodeOS.constants.priority.PRIORITY_BELOW_NORMAL);
      // The first build announces itself before it starts, so a watching client reads the badge
      // again and shows Indexing while there is no generation to answer from.
      assert.deepEqual(yield* next(events), [{ outcome: "published", generation: null }]);
      process.kill(buildPid, "SIGKILL");
      assert.deepEqual(yield* next(events), [{ outcome: "failed", generation: null }]);
      const firstBuildFailed = { state: "unindexed", refresh: "failed" } as const;
      // The event precedes the build's bookkeeping; this answer proves that bookkeeping finished.
      assert.deepInclude((yield* run({ operation: "freshness" })).index, firstBuildFailed);
      yield* subscribe().pipe(Effect.asVoid);
      assert.deepInclude((yield* run({ operation: "freshness" })).index, firstBuildFailed);

      // A code query still asks for one, and the retry publishes without announcing again.
      yield* run({ operation: "symbols", name: "greet" });
      assert.deepEqual(yield* next(events), [{ outcome: "published", generation: 1 }]);
      assert.equal((yield* run({ operation: "freshness" })).index?.state, "ready");

      // Once indexed, watching observes; refreshes stay with queries and finished turns.
      yield* editDefinition(fixture.root, "edited");
      yield* subscribe().pipe(Effect.asVoid);
      const stale = (yield* run({ operation: "freshness" })).index;
      assert.equal(stale?.state, "stale");
      assert.notProperty(stale, "refresh");

      // A folder outside a repository is not indexed unasked.
      const plainFolder = yield* checkoutService(fixture.worktree, () => ["src/work.ts"]);
      yield* plainFolder.subscribe().pipe(Effect.asVoid);
      const unindexed = (yield* plainFolder.run({ operation: "freshness" })).index;
      assert.equal(unindexed?.state, "unindexed");
      assert.notProperty(unindexed, "refresh");
      // Nor for an agent: a build its request started would leave this one nothing to publish.
      yield* plainFolder.refreshForActiveAgent();
      assert.deepEqual(yield* plainFolder.refresh(), { _tag: "Published", generation: 1 });
    }),
  ),
);

it.effect("indexes a worktree for its active agent and never merely because it is viewed", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const worktree = { threadId: worktreeThreadId, path: fixture.worktree };
      const { run, refresh, subscribe, refreshForActiveAgent, indexRoot } = yield* checkoutService(
        fixture.root,
        (cwd) => (cwd === fixture.worktree ? ["src/work.ts"] : ["src/defs.ts"]),
        { worktree, repository: true },
      );
      const worktreeFreshness = () =>
        run({ operation: "freshness" }, worktreeThreadId).pipe(
          Effect.map((result) => result.index),
        );

      // Viewing a worktree thread subscribes to its events but builds nothing.
      yield* subscribe(worktreeThreadId).pipe(Effect.asVoid);
      assert.equal((yield* worktreeFreshness())?.state, "unindexed");
      assert.isFalse(NodeFS.existsSync(indexRoot(fixture.worktree)));

      // An agent starting in it indexes it.
      yield* refreshForActiveAgent(worktreeThreadId);
      // The request returns at once. Its build publishes, leaving this one nothing to do.
      assert.deepEqual(yield* refresh(worktreeThreadId), { _tag: "Unchanged" });
      const indexed = yield* worktreeFreshness();
      assert.equal(indexed?.state, "ready");
      assert.equal(indexed?.generation, 1);
      const symbols = yield* run({ operation: "symbols", name: "workOnly" }, worktreeThreadId);
      assert.ok(symbols.nodes.some((node) => node.path === "src/work.ts"));
    }),
  ),
);

it.effect("leaves a worktree index stale until its agent acts again", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const worktree = { threadId: worktreeThreadId, path: fixture.worktree };
      const { run, refresh, refreshForActiveAgent } = yield* checkoutService(
        fixture.root,
        (cwd) => (cwd === fixture.worktree ? ["src/work.ts"] : ["src/defs.ts"]),
        { worktree },
      );
      const freshness = () =>
        run({ operation: "freshness" }, worktreeThreadId).pipe(
          Effect.map((result) => result.index),
        );

      yield* refreshForActiveAgent(worktreeThreadId);
      yield* refresh(worktreeThreadId);
      assert.equal((yield* freshness())?.generation, 1);

      // Nothing refreshes an idle worktree.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(fixture.worktree, "src/work.ts"),
          "export function workOnly() { return 3; }\n",
        ),
      );
      const idle = yield* freshness();
      assert.equal(idle?.state, "stale");
      assert.notProperty(idle, "refresh");

      // The next turn's request publishes the successor.
      yield* refreshForActiveAgent(worktreeThreadId);
      yield* refresh(worktreeThreadId);
      const refreshed = yield* freshness();
      assert.equal(refreshed?.state, "ready");
      assert.equal(refreshed?.generation, 2);
    }),
  ),
);

it.effect("indexes only when something asks while automatic indexing is off", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const worktree = { threadId: worktreeThreadId, path: fixture.worktree };
      const {
        run,
        refresh,
        subscribe,
        ensureProjectIndexed,
        refreshForActiveAgent,
        refreshIfIndexed,
        indexRoot,
      } = yield* checkoutService(
        fixture.root,
        (cwd) => (cwd === fixture.worktree ? ["src/work.ts"] : ["src/defs.ts"]),
        { worktree, repository: true, autoCodeIndexEnabled: false },
      );
      const freshness = (threadId?: ThreadId) =>
        run({ operation: "freshness" }, threadId).pipe(Effect.map((result) => result.index));
      const noIndex = () =>
        Effect.sync(
          () =>
            !NodeFS.existsSync(indexRoot(fixture.root)) &&
            !NodeFS.existsSync(indexRoot(fixture.worktree)),
        );

      yield* ensureProjectIndexed();
      yield* refreshForActiveAgent();
      yield* refreshForActiveAgent(worktreeThreadId);
      yield* subscribe().pipe(Effect.asVoid);
      yield* refreshIfIndexed(fixture.root);
      assert.isTrue(yield* noIndex());
      assert.equal((yield* freshness())?.state, "unindexed");
      assert.equal((yield* freshness(worktreeThreadId))?.state, "unindexed");

      // A build any of those started would run first, leaving these nothing to publish.
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.deepEqual(yield* refresh(worktreeThreadId), { _tag: "Published", generation: 1 });

      // Nor does an existing index refresh on its own.
      yield* editDefinition(fixture.root, "edited");
      yield* refreshForActiveAgent();
      yield* refreshIfIndexed(fixture.root);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });

      // A code question always works.
      const answer = yield* run({ operation: "symbols", name: "greet" });
      assert.ok(answer.nodes.some((node) => node.path === "src/defs.ts"));
    }),
  ),
);

it.effect("rejects Windows network checkouts before creating partial source links", (context) =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      if (!(yield* HostProcess.isWindows)) return context.skip();
      for (const checkout of [
        "\\\\server\\share\\repo",
        "//server/share/repo",
        "\\\\?\\UNC\\server\\share\\repo",
      ]) {
        assert.throws(
          () => linkCheckoutSources(fixture.worktree, checkout, ["src/defs.ts"]),
          /network checkout/,
        );
      }
      assert.deepEqual(NodeFS.readdirSync(fixture.worktree), ["src"]);
    }),
  ),
);

it.effect("shares one index between Windows project and thread path case variants", (context) =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      if (!(yield* HostProcess.isWindows)) return context.skip();
      const { refresh, indexRoot, codeIndexDir } = yield* checkoutService(
        fixture.root.toLowerCase(),
        () => ["src/defs.ts"],
        {
          worktree: {
            threadId: worktreeThreadId,
            path: fixture.root.toUpperCase().replaceAll("\\", "/"),
          },
        },
      );
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.deepEqual(yield* refresh(worktreeThreadId), { _tag: "Unchanged" });
      assert.equal(indexRoot(fixture.root.toLowerCase()), indexRoot(fixture.root.toUpperCase()));
      assert.lengthOf(NodeFS.readdirSync(codeIndexDir), 1);
    }),
  ),
);

it.effect("stops a Windows build removed through a different path case", (context) =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      if (!(yield* HostProcess.isWindows)) return context.skip();
      const gate = buildGate();
      const { refresh, removeCheckoutIndex, indexRoot } = yield* checkoutService(
        fixture.root.toLowerCase(),
        () => ["src/defs.ts"],
        gate,
      );
      const held = yield* gate.holdNext;
      const building = yield* refresh().pipe(Effect.forkScoped);
      const pid = yield* Deferred.await(held.entered);
      yield* removeCheckoutIndex(fixture.root.toUpperCase());
      assert.isFalse(isProcessAlive(pid));
      yield* Fiber.await(building);
      assertClearedIndex(indexRoot(fixture.root.toLowerCase()));
      assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.root, "src/defs.ts")));
    }),
  ),
);

it.effect("removes a checkout's index while a build is in flight", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const gate = buildGate();
      const { removeCheckoutIndex, refresh, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
        gate,
      );
      const held = yield* gate.holdNext;
      const building = yield* refresh().pipe(Effect.forkScoped);
      const pid = yield* Deferred.await(held.entered);
      yield* removeCheckoutIndex(fixture.root);
      assert.isFalse(isProcessAlive(pid), "the build process is gone once removal returns");
      yield* Fiber.await(building);
      assertClearedIndex(indexRoot(fixture.root));
      assert.deepEqual(
        yield* Effect.promise(() => generationDirectories(indexRoot(fixture.root))),
        [],
      );
    }),
  ),
);

it.effect("keeps a generation a reader pins while removing the rest of the index", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { run, refresh, removeCheckoutIndex, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
      );
      const root = indexRoot(fixture.root);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      const pin = yield* Effect.sync(() => pinPublishedGeneration(root));
      assert.equal(pin.generation, 1);

      yield* removeCheckoutIndex(fixture.root);
      // The pointer goes first, so queries read unindexed even though the generation survives.
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".codegraph-t3", "published")));
      assert.deepEqual(yield* Effect.promise(() => generationDirectories(root)), [
        ".codegraph-t3-g1",
      ]);
      assert.equal((yield* run({ operation: "freshness" })).index?.state, "unindexed");

      // The next removal, with nobody reading, clears it.
      yield* Effect.sync(pin.release);
      yield* removeCheckoutIndex(fixture.root);
      assert.deepEqual(yield* Effect.promise(() => generationDirectories(root)), []);
      assertClearedIndex(root);
    }),
  ),
);

it.effect("leaves a checkout another server process is building alone", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { refresh, removeCheckoutIndex, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
      );
      const root = indexRoot(fixture.root);
      const other = yield* otherServerProcess(root);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.equal(yield* other.send("lock"), "locked");

      yield* removeCheckoutIndex(fixture.root);
      assert.deepEqual(yield* Effect.promise(() => generationDirectories(root)), [
        ".codegraph-t3-g1",
      ]);
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(root, ".codegraph-t3/published"), "utf8"),
        ),
        "1",
      );
    }),
  ),
);

it.effect("keeps the nearest relations when a traversal hits its budget", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const source = [
        "export function target() { return 1; }",
        ...[1, 2, 3].flatMap((index) => [
          `export function near${index}() { return target(); }`,
          `export function far${index}() { return near${index}(); }`,
        ]),
      ].join("\n");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.root, "src/chain.ts"), `${source}\n`),
      );
      const { run, refresh } = yield* checkoutService(fixture.root, () => ["src/chain.ts"]);
      yield* refresh();
      for (const operation of ["callers", "impact"] as const) {
        const result = yield* run({
          operation,
          symbol: { name: "target", filePath: "src/chain.ts" },
          depth: 2,
          limit: 3,
        });
        assert.deepEqual(
          result.nodes.map((node) => node.name).toSorted(),
          ["near1", "near2", "target"],
          operation,
        );
        assert.equal(result.coverage.resultLimitReached, true, operation);
      }
    }),
  ),
);

async function writeGeneratedSources(root: string, count: number) {
  await NodeFSP.mkdir(NodePath.join(root, "src/generated"), { recursive: true });
  const files = Array.from({ length: count }, (_, index) => `src/generated/g${index}.py`);
  await Promise.all(
    files.map((file, index) =>
      NodeFSP.writeFile(
        NodePath.join(root, file),
        `def generated_${index}():\n    return ${index}\n`,
      ),
    ),
  );
  return files;
}

/** Holds the next build once its analysis process starts, before it receives the build. */
function buildGate() {
  let next: (pid: number) => Effect.Effect<void> = () => Effect.void;
  return {
    beforeBuildCommand: (pid: number) => next(pid),
    holdNext: Effect.gen(function* () {
      const entered = yield* Deferred.make<number>();
      const release = yield* Deferred.make<void>();
      next = (pid) =>
        Effect.sync(() => {
          next = () => Effect.void;
        }).pipe(
          Effect.andThen(Deferred.succeed(entered, pid)),
          Effect.andThen(Deferred.await(release)),
        );
      return { entered, release };
    }),
  };
}

/** Edits every generated source, so the next build reparses all of them. */
async function rewriteGeneratedSources(root: string, files: ReadonlyArray<string>) {
  await Promise.all(
    files.map((file, index) =>
      NodeFSP.writeFile(
        NodePath.join(root, file),
        `def generated_${index}():\n    return ${index + 1}\n`,
      ),
    ),
  );
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.effect("stops a build when the service shuts down and never publishes the cut index", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const files = yield* Effect.promise(() => writeGeneratedSources(fixture.root, 4));
      const listed = ["src/defs.ts", ...files];
      const gate = buildGate();
      const held = yield* gate.holdNext;
      const serviceScope = yield* Scope.make();
      const { refresh } = yield* checkoutService(fixture.root, () => listed, gate).pipe(
        Scope.provide(serviceScope),
      );
      yield* refresh().pipe(Effect.forkScoped);
      const pid = yield* Deferred.await(held.entered);
      yield* Scope.close(serviceScope, Exit.void);
      assert.isFalse(isProcessAlive(pid), "the build process is gone once shutdown returns");

      const restarted = yield* checkoutService(fixture.root, () => listed);
      const afterShutdown = yield* restarted.run({ operation: "freshness" });
      assert.equal(afterShutdown.index?.state, "unindexed");
      assert.deepInclude(yield* restarted.refresh(), { _tag: "Published" });
      const root = restarted.indexRoot(fixture.root);
      assert.deepEqual(yield* Effect.promise(() => generationDirectories(root)), [
        yield* Effect.promise(() => publishedDirectory(root)),
      ]);
      const recovered = yield* restarted.run({ operation: "status" });
      assert.equal(recovered.coverage.filesIndexed, listed.length);
      assert.equal(recovered.coverage.state, "complete");
    }),
  ),
);

it.effect("fails the build, not the server, when the analysis process aborts", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const files = yield* Effect.promise(() => writeGeneratedSources(fixture.root, 4));
      const gate = buildGate();
      const held = yield* gate.holdNext;
      const { refresh, indexRoot } = yield* checkoutService(fixture.root, () => files, gate);
      const building = yield* refresh().pipe(Effect.forkScoped);
      const pid = yield* Deferred.await(held.entered);
      assert.notEqual(pid, process.pid, "analysis runs outside the server process");
      yield* abortProcess(pid);
      assert.deepEqual(yield* Fiber.join(building), { _tag: "Failed", reason: "worker-failed" });
      assert.deepEqual(
        yield* Effect.promise(() => generationDirectories(indexRoot(fixture.root))),
        [],
      );
    }),
  ),
);

it.effect("answers queries when the server itself runs under node --watch", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const hostEnv = yield* HostProcess.Environment;
      const previous = hostEnv.WATCH_REPORT_DEPENDENCIES;
      hostEnv.WATCH_REPORT_DEPENDENCIES = "1";
      const { run, refresh } = yield* checkoutService(fixture.root, () => ["src/defs.ts"]);
      const result = yield* Effect.result(
        refresh().pipe(Effect.andThen(run({ operation: "status" }))),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete hostEnv.WATCH_REPORT_DEPENDENCIES;
            else hostEnv.WATCH_REPORT_DEPENDENCIES = previous;
          }),
        ),
      );
      assert.equal(result._tag, "Success");
      if (result._tag === "Success") assert.equal(result.success.index?.state, "ready");
    }),
  ),
);

it.effect("keeps the index out of the checkout's git status", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const git = (...args: ReadonlyArray<string>) =>
        NodeChildProcess.execFileSync(
          "git",
          ["-c", "user.email=t3@example.com", "-c", "user.name=T3", ...args],
          { cwd: fixture.root, encoding: "utf8" },
        );
      git("init", "--quiet");
      git("add", "--all");
      git("commit", "--quiet", "-m", "fixture");
      const gate = listingGate();
      const { run, refresh, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
        gate,
      );
      const root = indexRoot(fixture.root);
      const before = (yield* Effect.promise(() => NodeFSP.readdir(fixture.root))).toSorted();
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.ok((yield* run({ operation: "symbols", name: "greet" })).nodes.length > 0);
      // Drain the query's background refresh before holding a reader and editing its source.
      yield* refresh();

      // Nothing the index owns is in the checkout: no new entries, and git sees nothing.
      assert.deepEqual(
        (yield* Effect.promise(() => NodeFSP.readdir(fixture.root))).toSorted(),
        before,
      );
      assert.equal(git("status", "--ignored", "--short"), "");

      // A reader keeps generation 1 while generation 2 is published, so both are on disk.
      const held = yield* gate.holdNext;
      const reader = yield* run({ operation: "freshness" }).pipe(Effect.forkScoped);
      yield* Deferred.await(held.entered);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(fixture.root, "src/defs.ts"),
          "export const changed = 1;\n",
        ),
      );
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });
      assert.deepEqual(yield* Effect.promise(() => generationDirectories(root)), [
        ".codegraph-t3-g1",
        ".codegraph-t3-g2",
      ]);
      yield* Deferred.succeed(held.release, undefined);
      yield* Fiber.join(reader);
      // Even with two generations on disk, only the edited source shows.
      assert.equal(git("status", "--ignored", "--short"), " M src/defs.ts\n");
    }),
  ),
);

it.effect("leaves import statements out of symbol search", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { run, refresh } = yield* checkoutService(fixture.root, () => [
        "src/defs.ts",
        "src/use.ts",
      ]);
      yield* refresh();
      const search = yield* run({ operation: "search", text: "defs", limit: 20 });
      assert.deepEqual(
        search.matches.filter((match) => match.symbol.kind === "import"),
        [],
      );
    }),
  ),
);

it.effect("returns index not ready for a cold checkout without synchronizing sources", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { run, refresh } = yield* checkoutService(fixture.root, () => ["src/defs.ts"]);
      const result = yield* run({ operation: "symbols", name: "greet" });
      assert.equal(result.index?.state, "unindexed");
      assert.deepEqual(result.nodes, []);
      // The cold query already scheduled the build, so the refresh behind it finds nothing new.
      assert.deepEqual(yield* refresh(), { _tag: "Unchanged" });
      const indexed = yield* run({ operation: "symbols", name: "greet" });
      assert.equal(indexed.index?.state, "ready");
      assert.ok(indexed.nodes.some((node) => node.name === "greet"));
    }),
  ),
);

it.effect("removes the index folders an older version left in the checkout", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const control = NodePath.join(fixture.root, ".codegraph-t3");
      const legacyGeneration = NodePath.join(fixture.root, ".codegraph-t3-g3");
      const userGeneration = NodePath.join(fixture.root, ".codegraph-t3-g4");
      const before = yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(fixture.root, "top.ts"), "export const top = 1;\n");
        await NodeFSP.symlink("src", NodePath.join(fixture.root, "alias"));
        // A folder that merely shares the name is the user's.
        await NodeFSP.mkdir(userGeneration);
        await NodeFSP.writeFile(NodePath.join(userGeneration, "notes.txt"), "mine");
        const entries = (await NodeFSP.readdir(fixture.root)).toSorted();
        await NodeFSP.mkdir(control);
        await NodeFSP.writeFile(NodePath.join(control, "codegraph.db"), "legacy index");
        await NodeFSP.writeFile(NodePath.join(control, "t3-index.json"), "{}");
        await NodeFSP.mkdir(legacyGeneration);
        await NodeFSP.writeFile(NodePath.join(legacyGeneration, "codegraph.db"), "legacy");
        return entries;
      });
      const { refresh } = yield* checkoutService(fixture.root, () => ["src/defs.ts"]);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      // Every source entry is still there, and nothing of T3's is.
      assert.deepEqual(
        (yield* Effect.promise(() => NodeFSP.readdir(fixture.root))).toSorted(),
        before,
      );
      assert.isTrue(NodeFS.lstatSync(NodePath.join(fixture.root, "alias")).isSymbolicLink());
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(userGeneration, "notes.txt"), "utf8"),
        ),
        "mine",
      );
    }),
  ),
);

it.effect("finds and removes an older version's folders in a checkout with no index yet", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const control = NodePath.join(fixture.root, ".codegraph-t3");
      const { hasCheckoutIndex, removeCheckoutIndex, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
      );
      assert.isFalse(yield* hasCheckoutIndex(fixture.root));
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(control);
        await NodeFSP.writeFile(NodePath.join(control, "published"), "1");
      });
      assert.isFalse(NodeFS.existsSync(indexRoot(fixture.root)));
      assert.isTrue(yield* hasCheckoutIndex(fixture.root));

      // Settling a thread takes this path, so a worktree nothing rebuilds is still cleaned up.
      yield* removeCheckoutIndex(fixture.root);
      assert.isFalse(NodeFS.existsSync(control));
      assert.isFalse(yield* hasCheckoutIndex(fixture.root));
      assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.root, "src/defs.ts")));
    }),
  ),
);

it.effect("clears an older version's folders from checkouts and leaves their indexes", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const control = NodePath.join(fixture.root, ".codegraph-t3");
      const broken = NodePath.join(fixture.root, "broken");
      const { refresh, removeLegacyIndexes, hasCheckoutIndex } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
      );
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(control);
        await NodeFSP.writeFile(NodePath.join(control, "published"), "1");
        // Removing this one fails, which must not stop the sweep reaching the next checkout.
        await NodeFSP.mkdir(NodePath.join(broken, ".codegraph-t3/codegraph.db"), {
          recursive: true,
        });
      });

      yield* removeLegacyIndexes([broken, fixture.root]);

      assert.isFalse(NodeFS.existsSync(control));
      assert.isTrue(yield* hasCheckoutIndex(fixture.root));
    }),
  ),
);

it.effect("leaves a checkout's own .codegraph-t3 directory alone", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const control = NodePath.join(fixture.root, ".codegraph-t3");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(control);
        await NodeFSP.writeFile(NodePath.join(control, "notes.txt"), "mine");
      });
      const { refresh } = yield* checkoutService(fixture.root, () => ["src/defs.ts"]);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(control, "notes.txt"), "utf8")),
        "mine",
      );
    }),
  ),
);

it.effect("leaves a linked .codegraph-t3 and its target alone", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      // Named like T3's own marker, so only the link check can protect it.
      const victim = NodePath.join(fixture.worktree, "published");
      const control = NodePath.join(fixture.root, ".codegraph-t3");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(victim, "untouched");
        await NodeFSP.symlink(fixture.worktree, control);
      });
      const { refresh } = yield* checkoutService(fixture.root, () => ["src/defs.ts"]);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.isTrue(NodeFS.lstatSync(control).isSymbolicLink());
      assert.equal(yield* Effect.promise(() => NodeFSP.readFile(victim, "utf8")), "untouched");
      assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.worktree, "src/work.ts")));
    }),
  ),
);

it.effect("leaves legacy folders for later while another server builds", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const control = NodePath.join(fixture.root, ".codegraph-t3");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(control);
        await NodeFSP.writeFile(NodePath.join(control, "codegraph.db"), "legacy index");
      });
      // An older server still building in the checkout holds the lock this removal would need.
      const other = yield* otherServerProcess(fixture.root);
      assert.equal(yield* other.send("lock"), "locked");
      const { refresh } = yield* checkoutService(fixture.root, () => ["src/defs.ts"]);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.isTrue(NodeFS.existsSync(control));

      // Once that server is gone, the next build removes them.
      assert.equal(yield* other.send("release"), "released");
      yield* editDefinition(fixture.root, "second");
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });
      assert.isFalse(NodeFS.existsSync(control));
    }),
  ),
);

it.effect("removes an index without touching the checkout's sources", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.root, "top.ts"), "export const top = 1;\n"),
      );
      const { refresh, removeCheckoutIndex, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts", "src/use.ts", "top.ts"],
      );
      const root = indexRoot(fixture.root);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.isTrue(NodeFS.lstatSync(NodePath.join(root, "top.ts")).isSymbolicLink());

      yield* removeCheckoutIndex(fixture.root);
      assertClearedIndex(root);
      // Every source is still there, byte for byte.
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(fixture.root, "src/defs.ts"), "utf8"),
        ),
        'const prefix = "🧪é"; export function greet() { return prefix; }\n',
      );
      assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.root, "src/use.ts")));
      assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.root, "src/main.go")));
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(fixture.root, "top.ts"), "utf8"),
        ),
        "export const top = 1;\n",
      );
    }),
  ),
);

it.effect("removes an orphaned index without touching a source checkout", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { refresh, removeOrphanedIndexes, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
      );
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      yield* removeOrphanedIndexes(() => false);
      assertClearedIndex(indexRoot(fixture.root));
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(fixture.root, "src/defs.ts"), "utf8"),
        ),
        'const prefix = "🧪é"; export function greet() { return prefix; }\n',
      );
    }),
  ),
);

it.effect("sweeps indexes for checkouts that are gone or no longer known", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const shared = yield* checkoutConfig();
      const known = yield* checkoutService(fixture.root, () => ["src/defs.ts"], { config: shared });
      const gone = yield* checkoutService(fixture.worktree, () => ["src/work.ts"], {
        config: shared,
      });
      assert.deepInclude(yield* known.refresh(), { _tag: "Published" });
      assert.deepInclude(yield* gone.refresh(), { _tag: "Published" });
      const knownRoot = known.indexRoot(fixture.root);
      const goneRoot = gone.indexRoot(fixture.worktree);
      assert.isTrue(NodeFS.existsSync(knownRoot));
      assert.isTrue(NodeFS.existsSync(goneRoot));

      // A root with no owner record is a leftover, whatever the predicate says.
      const orphanRoot = NodePath.join(known.codeIndexDir, "0".repeat(32));
      yield* Effect.promise(() => NodeFSP.mkdir(orphanRoot, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(orphanRoot, "stray.txt"), "leftover"),
      );

      yield* known.removeOrphanedIndexes((checkoutPath) => checkoutPath === fixture.root);
      // The known checkout is kept, and so are its sources.
      assert.isTrue(NodeFS.existsSync(knownRoot));
      assert.isTrue(NodeFS.existsSync(NodePath.join(fixture.root, "src/defs.ts")));
      // A checkout `isKnown` rejects is removed, leaving its files intact.
      assertClearedIndex(goneRoot);
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(fixture.worktree, "src/work.ts"), "utf8"),
        ),
        "export function workOnly() { return 2; }\n",
      );
      assertClearedIndex(orphanRoot);
    }),
  ),
);

it.effect("removes the index of a checkout that was deleted", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { refresh, removeOrphanedIndexes, indexRoot } = yield* checkoutService(
        fixture.worktree,
        () => ["src/work.ts"],
      );
      assert.deepInclude(yield* refresh(), { _tag: "Published" });
      const root = indexRoot(fixture.worktree);
      assert.isTrue(NodeFS.existsSync(root));
      yield* Effect.promise(() => NodeFSP.rm(fixture.worktree, { recursive: true, force: true }));
      // The checkout is still known by path, but it no longer exists.
      yield* removeOrphanedIndexes(() => true);
      assertClearedIndex(root);
    }),
  ),
);

it.effect("follows a new top-level entry on the next build and drops a removed one", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const listed = ["src/defs.ts"];
      const { run, refresh, indexRoot } = yield* checkoutService(fixture.root, () => listed);
      const root = indexRoot(fixture.root);
      yield* refresh();
      assert.equal((yield* run({ operation: "symbols", name: "tool" })).nodes.length, 0);

      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.root, "tools.ts"), "export function tool() {}\n"),
      );
      listed.push("tools.ts");
      yield* refresh();
      assert.ok((yield* run({ operation: "symbols", name: "tool" })).nodes.length > 0);
      // The link the build added points at the checkout.
      assert.isTrue(NodeFS.existsSync(NodePath.join(root, "tools.ts")));

      // Removing the top-level entry leaves no dangling link in the root.
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(fixture.root, "tools.ts")));
      listed.splice(listed.indexOf("tools.ts"), 1);
      yield* refresh();
      assert.notInclude(yield* Effect.promise(() => NodeFSP.readdir(root)), "tools.ts");
      assert.equal((yield* run({ operation: "symbols", name: "tool" })).nodes.length, 0);
      // The sources it shared the root with are still there.
      assert.isTrue(NodeFS.existsSync(NodePath.join(root, "src/defs.ts")));
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(fixture.root, "src/defs.ts"), "utf8"),
        ),
        'const prefix = "🧪é"; export function greet() { return prefix; }\n',
      );
    }),
  ),
);

it.effect("keeps files the graph holds under a top-level entry a truncated listing dropped", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      let listed = ["src/defs.ts", "src/use.ts"];
      const { run, refresh, indexRoot } = yield* checkoutService(fixture.root, () => listed, {
        truncated: true,
      });
      const root = indexRoot(fixture.root);
      yield* refresh();
      assert.ok((yield* run({ operation: "symbols", name: "greet" })).nodes.length > 0);

      // The cap drops `src` from the listing entirely; the files the graph already holds must
      // still be reachable, so the build links that entry back from the graph's own paths.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(fixture.root, "tools.ts"), "export function tool() {}\n"),
      );
      listed = ["tools.ts"];
      assert.deepInclude(yield* refresh(), { _tag: "Published", generation: 2 });
      assert.isTrue(NodeFS.existsSync(NodePath.join(root, "src")));
      // The index still answers for the files it held under the dropped entry.
      assert.equal(yield* indexedSymbolCount(root, "greet"), 1);
      assert.equal(yield* indexedSymbolCount(root, "tool"), 1);
      assert.equal((yield* run({ operation: "freshness" })).index?.changedFiles, 0);
    }),
  ),
);

it.effect.each(["codegraph.json", ".gitignore"] as const)(
  "honours changed exclude patterns in an unlisted %s",
  (configName) =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const configPath = NodePath.join(fixture.root, configName);
        const excluded =
          configName === "codegraph.json"
            ? JSON.stringify({ exclude: ["src/use.ts"] })
            : "src/use.ts\n";
        yield* Effect.promise(() => NodeFSP.writeFile(configPath, excluded));
        // The listing never mentions the config file; only the link T3 plants reaches it.
        const { run, refresh } = yield* checkoutService(fixture.root, () => [
          "src/defs.ts",
          "src/use.ts",
        ]);
        yield* refresh();
        const status = yield* run({ operation: "status" });
        assert.equal(status.stats?.files, 1);
        assert.equal((yield* run({ operation: "symbols", name: "caller" })).nodes.length, 0);
        yield* refresh();

        yield* Effect.promise(() =>
          NodeFSP.writeFile(configPath, configName === "codegraph.json" ? "{}" : ""),
        );
        assert.equal((yield* run({ operation: "freshness" })).index?.state, "stale");
        assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });
        assert.equal((yield* run({ operation: "status" })).stats?.files, 2);
        assert.equal((yield* run({ operation: "symbols", name: "caller" })).nodes.length, 1);
        yield* refresh();

        yield* Effect.promise(() => NodeFSP.writeFile(configPath, excluded));
        assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 3 });
        assert.equal((yield* run({ operation: "status" })).stats?.files, 1);
        assert.equal((yield* run({ operation: "symbols", name: "caller" })).nodes.length, 0);
        yield* refresh();
        yield* Effect.promise(() => NodeFSP.unlink(configPath));
        assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 4 });
        assert.equal((yield* run({ operation: "symbols", name: "caller" })).nodes.length, 1);
      }),
    ),
);

it.effect.each(["codegraph.json", ".gitignore"] as const)(
  "keeps indexing when %s cannot be read as a file",
  (configName) =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(fixture.root, configName)));
        const { run, refresh } = yield* checkoutService(fixture.root, () => ["src/defs.ts"]);
        assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
        assert.equal((yield* run({ operation: "freshness" })).index?.state, "ready");
      }),
    ),
);

it.effect("answers from the published generation while its successor builds", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const files = yield* Effect.promise(() => writeGeneratedSources(fixture.root, 4));
      const gate = buildGate();
      const { run, refresh } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts", ...files],
        gate,
      );
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      const checkingGate = yield* gate.holdNext;
      const checking = yield* refresh().pipe(Effect.forkScoped);
      yield* Deferred.await(checkingGate.entered);
      const current = yield* run({ operation: "freshness" }).pipe(
        Effect.ensuring(Deferred.succeed(checkingGate.release, undefined)),
      );
      assert.deepInclude(current.index, { state: "ready", generation: 1 });
      assert.notProperty(current.index, "refresh");
      assert.deepEqual(yield* Fiber.join(checking), { _tag: "Unchanged" });
      yield* Effect.promise(() => rewriteGeneratedSources(fixture.root, files));
      const held = yield* gate.holdNext;
      const building = yield* refresh().pipe(Effect.forkScoped);
      // The successor's build is held in flight while these answer.
      yield* Deferred.await(held.entered);
      const [answer, freshness] = yield* Effect.all([
        run({ operation: "symbols", name: "greet" }),
        run({ operation: "freshness" }),
      ]).pipe(Effect.ensuring(Deferred.succeed(held.release, undefined)));
      assert.ok(answer.nodes.some((node) => node.name === "greet"));
      assert.deepInclude(answer.index, { state: "stale", generation: 1, refresh: "building" });
      assert.deepInclude(freshness.index, { state: "stale", generation: 1, refresh: "building" });
      assert.equal(freshness.index?.changedFiles, files.length);

      assert.deepEqual(yield* Fiber.join(building), { _tag: "Published", generation: 2 });
      // Settles the build the symbols query requested.
      assert.deepEqual(yield* refresh(), { _tag: "Unchanged" });
      const settled = yield* run({ operation: "freshness" });
      assert.deepInclude(settled.index, { state: "ready", generation: 2 });
      assert.notProperty(settled.index, "refresh");
    }),
  ),
);

it.effect("keeps the previous generation serving when a build fails, and says so", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const files = yield* Effect.promise(() => writeGeneratedSources(fixture.root, 4));
      const gate = buildGate();
      const { run, refresh, subscribe } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts", ...files],
        gate,
      );
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      const pull = yield* Stream.toPull(yield* subscribe());
      yield* Effect.promise(() => rewriteGeneratedSources(fixture.root, files));
      const held = yield* gate.holdNext;
      const building = yield* refresh().pipe(Effect.forkScoped);
      yield* abortProcess(yield* Deferred.await(held.entered));
      assert.deepEqual(yield* Fiber.join(building), { _tag: "Failed", reason: "worker-failed" });

      const freshness = yield* run({ operation: "freshness" });
      assert.deepInclude(freshness.index, { state: "stale", generation: 1, refresh: "failed" });
      assert.ok(
        freshness.coverage.limitations.some((limitation) => limitation.includes("refresh failed")),
      );
      const answer = yield* run({ operation: "symbols", name: "greet" });
      assert.ok(answer.nodes.some((node) => node.name === "greet"));
      assert.deepInclude(answer.index, { generation: 1 });

      // Settles the build the symbols query requested, which succeeds.
      yield* refresh();
      const received: Array<ProjectCodeIndexEvent> = [];
      while (received.length < 2) received.push(...(yield* pull));
      assert.deepEqual(received, [
        { outcome: "failed", generation: 1 },
        { outcome: "published", generation: 2 },
      ]);
      const recovered = yield* run({ operation: "freshness" });
      assert.deepInclude(recovered.index, { state: "ready", generation: 2 });
      assert.notProperty(recovered.index, "refresh");
    }),
  ),
);

it.effect("notifies a persistent build failure once until a successful refresh", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const gate = buildGate();
      const { run, refresh, subscribe } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
        gate,
      );
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      const events = yield* subscribe();
      const failRefresh = Effect.gen(function* () {
        const held = yield* gate.holdNext;
        const building = yield* refresh().pipe(Effect.forkScoped);
        process.kill(yield* Deferred.await(held.entered), "SIGKILL");
        assert.deepEqual(yield* Fiber.join(building), { _tag: "Failed", reason: "worker-failed" });
      });

      yield* failRefresh;
      yield* failRefresh;
      assert.equal((yield* run({ operation: "freshness" })).index?.refresh, "failed");
      assert.deepEqual(yield* refresh(), { _tag: "Unchanged" });
      assert.notProperty((yield* run({ operation: "symbols", name: "greet" })).index, "refresh");
      assert.deepEqual(yield* refresh(), { _tag: "Unchanged" });
      yield* failRefresh;
      yield* editDefinition(fixture.root, "recovered");
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });

      assert.deepEqual(
        yield* events.pipe(
          Stream.takeUntil((event) => event.outcome === "published" && event.generation === 2),
          Stream.runCollect,
        ),
        [
          { outcome: "failed", generation: 1 },
          { outcome: "published", generation: 1 },
          { outcome: "failed", generation: 1 },
          { outcome: "published", generation: 2 },
        ],
      );
    }),
  ),
);

it.effect("coalesces refresh requests made while a build is in flight into one follow-up", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      // Every query and every build lists the checkout once.
      let listings = 0;
      const gate = buildGate();
      const { run, refresh, indexRoot } = yield* checkoutService(
        fixture.root,
        () => {
          listings += 1;
          return ["src/defs.ts", "src/use.ts"];
        },
        gate,
      );
      const held = yield* gate.holdNext;

      // Starts the first build, which is held in flight.
      yield* run({ operation: "symbols", name: "greet" });
      yield* Deferred.await(held.entered);
      const refreshes = yield* Effect.forEach(Array.from({ length: 5 }), () =>
        refresh().pipe(Effect.forkScoped),
      );
      yield* run({ operation: "search", text: "greet" });
      yield* run({ operation: "status" });
      yield* Deferred.succeed(held.release, undefined);

      for (const fiber of refreshes) {
        assert.deepEqual(yield* Fiber.join(fiber), { _tag: "Unchanged" });
      }
      assert.equal(listings, 3 + 2, "three queries and two builds listed the checkout");
      assert.deepEqual(
        yield* Effect.promise(() => generationDirectories(indexRoot(fixture.root))),
        [".codegraph-t3-g1"],
      );
    }),
  ),
);

/** Holds the next checkout listing, which a query makes after pinning its generation. */
function listingGate() {
  let next: Effect.Effect<void> = Effect.void;
  return {
    beforeListing: () => next,
    holdNext: Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      next = Effect.sync(() => {
        next = Effect.void;
      }).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
      );
      return { entered, release };
    }),
  };
}

it.effect("deletes a retired generation only after its last reader finishes", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const gate = listingGate();
      const { run, refresh, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts", "src/use.ts"],
        gate,
      );
      const generations = () =>
        Effect.promise(() => generationDirectories(indexRoot(fixture.root)));
      const edit = (body: string) =>
        Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(fixture.root, "src/defs.ts"),
            `export function greet() { return "${body}"; }\n`,
          ),
        );
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      const held = yield* gate.holdNext;
      // Freshness requests no build, so the only listing it holds is its own.
      const reader = yield* run({ operation: "freshness" }).pipe(Effect.forkScoped);
      yield* Deferred.await(held.entered);

      yield* edit("second");
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });
      assert.deepEqual(yield* generations(), [".codegraph-t3-g1", ".codegraph-t3-g2"]);
      // Nobody reads generation 2, so it goes as soon as it is superseded.
      yield* edit("third");
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 3 });
      assert.deepEqual(yield* generations(), [".codegraph-t3-g1", ".codegraph-t3-g3"]);

      yield* Deferred.succeed(held.release, undefined);
      const answer = yield* Fiber.join(reader);
      assert.deepInclude(answer.index, { generation: 1, state: "stale" });
      assert.deepEqual(yield* generations(), [".codegraph-t3-g3"]);
    }),
  ),
);

const indexLocksModule = new URL("./codeIndexLocks.ts", import.meta.url).href;

/**
 * Another server process on the same index root. It takes the index locks the way a server does,
 * one stdin command at a time: `lock` the build, `pin` the published generation, or `release`.
 */
function otherServerProcess(indexRoot: string) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          "--input-type=module",
          "-e",
          `const locks = await import(process.argv[1]);
           const indexRoot = process.argv[2];
           const held = [];
           const commands = {
             lock: () => {
               const release = locks.tryLockBuild(indexRoot);
               if (release === null) return "busy";
               held.push(release);
               return "locked";
             },
             pin: () => {
               const pin = locks.pinPublishedGeneration(indexRoot);
               held.push(pin.release);
               return "pinned " + pin.generation;
             },
             release: () => {
               for (const release of held.splice(0)) release();
               return "released";
             },
           };
           const lines = (await import("node:readline")).createInterface({ input: process.stdin });
           lines.on("line", (command) => process.stdout.write(commands[command]() + "\\n"));
           process.stdout.write("ready\\n");`,
          indexLocksModule,
          indexRoot,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const replies: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> =
        [];
      NodeReadline.createInterface({ input: child.stdout }).on("line", (line) =>
        replies.shift()?.resolve(line),
      );
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => {
          for (const reply of replies.splice(0)) reply.reject(new Error(stderr));
          resolve();
        }),
      );
      const nextReply = () =>
        new Promise<string>((resolve, reject) => replies.push({ resolve, reject }));
      assert.equal(await nextReply(), "ready");
      return {
        child,
        exited,
        send: (command: string) => {
          const reply = nextReply();
          child.stdin.write(`${command}\n`);
          return reply;
        },
      };
    }),
    ({ child, exited }) =>
      Effect.promise(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        return exited;
      }),
  ).pipe(
    Effect.map(({ child, exited, send }) => ({
      send: (command: "lock" | "pin" | "release") => Effect.promise(() => send(command)),
      crash: Effect.promise(() => {
        child.kill("SIGKILL");
        return exited;
      }),
    })),
  );
}

function editDefinition(root: string, body: string) {
  return Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(root, "src/defs.ts"),
      `export function greet() { return "${body}"; }\n`,
    ),
  );
}

it.effect("refuses to build while another server process builds the checkout", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { run, refresh, indexRoot } = yield* checkoutService(fixture.root, () => [
        "src/defs.ts",
      ]);
      const root = indexRoot(fixture.root);
      const other = yield* otherServerProcess(root);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      yield* editDefinition(fixture.root, "second");

      assert.equal(yield* other.send("lock"), "locked");
      // The other process never finishes, so a refresh that waited for it would hang here.
      assert.deepEqual(yield* refresh(), { _tag: "BuildingElsewhere" });
      assert.deepInclude((yield* run({ operation: "freshness" })).index, {
        state: "stale",
        generation: 1,
        refresh: "building",
      });
      assert.deepEqual(yield* Effect.promise(() => generationDirectories(root)), [
        ".codegraph-t3-g1",
      ]);

      assert.equal(yield* other.send("release"), "released");
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });
      assert.notProperty((yield* run({ operation: "freshness" })).index, "refresh");
    }),
  ),
);

it.effect("keeps a generation another server process reads until that reader releases it", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { refresh, indexRoot } = yield* checkoutService(fixture.root, () => ["src/defs.ts"]);
      const root = indexRoot(fixture.root);
      const other = yield* otherServerProcess(root);
      const generations = () => Effect.promise(() => generationDirectories(root));
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.equal(yield* other.send("pin"), "pinned 1");

      yield* editDefinition(fixture.root, "second");
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });
      assert.deepEqual(yield* generations(), [".codegraph-t3-g1", ".codegraph-t3-g2"]);
      yield* editDefinition(fixture.root, "third");
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 3 });
      assert.deepEqual(yield* generations(), [".codegraph-t3-g1", ".codegraph-t3-g3"]);

      // The reader's own release removes the generation it was the last to read.
      assert.equal(yield* other.send("release"), "released");
      assert.deepEqual(yield* generations(), [".codegraph-t3-g3"]);
    }),
  ),
);

it.effect("recovers the build lock and reader of a server process that crashed", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { refresh, indexRoot } = yield* checkoutService(fixture.root, () => ["src/defs.ts"]);
      const root = indexRoot(fixture.root);
      const other = yield* otherServerProcess(root);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.equal(yield* other.send("pin"), "pinned 1");
      assert.equal(yield* other.send("lock"), "locked");
      yield* editDefinition(fixture.root, "second");
      assert.deepEqual(yield* refresh(), { _tag: "BuildingElsewhere" });

      yield* other.crash;
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });
      assert.deepEqual(yield* Effect.promise(() => generationDirectories(root)), [
        ".codegraph-t3-g2",
      ]);
    }),
  ),
);

it.effect("announces a checkout's first build once, however many builds follow it", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { run, refresh, subscribe, indexRoot } = yield* checkoutService(fixture.root, () => [
        "src/defs.ts",
      ]);
      const other = yield* otherServerProcess(indexRoot(fixture.root));
      const events = yield* subscribe();
      assert.equal(yield* other.send("lock"), "locked");
      // Each of these queries requests a build that ends at once, another server holding the
      // lock. Signalling every time would restart it forever.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        yield* run({ operation: "symbols", name: "greet" });
      }
      assert.deepEqual(yield* refresh(), { _tag: "BuildingElsewhere" });

      assert.equal(yield* other.send("release"), "released");
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.deepEqual(
        yield* events.pipe(
          Stream.takeUntil((event) => event.outcome === "published" && event.generation === 1),
          Stream.runCollect,
        ),
        [
          { outcome: "published", generation: null },
          { outcome: "published", generation: 1 },
        ],
      );
    }),
  ),
);

it.effect("removes a checkout's index and asks a mounted reader to read again", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { run, refresh, subscribe, removeCheckoutIndex, indexRoot } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
      );
      const root = indexRoot(fixture.root);
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      const events = yield* subscribe();
      yield* removeCheckoutIndex(fixture.root);
      assert.deepEqual(yield* events.pipe(Stream.take(1), Stream.runCollect), [
        { outcome: "published", generation: null },
      ]);
      assertClearedIndex(root);
      assert.deepEqual(yield* Effect.promise(() => generationDirectories(root)), []);
      const freshness = (yield* run({ operation: "freshness" })).index;
      assert.equal(freshness?.state, "unindexed");
      assert.notProperty(freshness, "refresh");

      // The checkout starts over: its rebuild announces itself and restarts the numbering.
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      assert.deepEqual(yield* events.pipe(Stream.take(2), Stream.runCollect), [
        { outcome: "published", generation: null },
        { outcome: "published", generation: 1 },
      ]);
    }),
  ),
);

it.effect("stops a running build and asks a mounted reader to read again", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const gate = buildGate();
      const { run, refresh, subscribe, stopBuilds } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
        gate,
      );
      const events = yield* subscribe();
      const held = yield* gate.holdNext;
      const building = yield* refresh().pipe(Effect.forkScoped);
      const pid = yield* Deferred.await(held.entered);
      yield* stopBuilds;
      assert.isFalse(isProcessAlive(pid), "the build process is gone once stopping returns");
      yield* Fiber.await(building);
      // The first announces the build, the second its end.
      assert.deepEqual(yield* events.pipe(Stream.take(2), Stream.runCollect), [
        { outcome: "published", generation: null },
        { outcome: "published", generation: null },
      ]);
      const freshness = (yield* run({ operation: "freshness" })).index;
      assert.equal(freshness?.state, "unindexed");
      assert.notProperty(freshness, "refresh");

      // The next first build announces itself again.
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
      // A waiter resumes ahead of the build's bookkeeping; this answer proves that finished.
      yield* run({ operation: "freshness" });
      // A stop with nothing running has nothing to say, so the next event is the publication.
      yield* stopBuilds;
      yield* editDefinition(fixture.root, "edited");
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 2 });
      assert.deepEqual(yield* events.pipe(Stream.take(3), Stream.runCollect), [
        { outcome: "published", generation: null },
        { outcome: "published", generation: 1 },
        { outcome: "published", generation: 2 },
      ]);
    }),
  ),
);

it.effect("can build again after a build is stopped before its first step", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { ensureProjectIndexed, refresh, stopBuilds } = yield* checkoutService(
        fixture.root,
        () => ["src/defs.ts"],
        { repository: true },
      );
      yield* ensureProjectIndexed();
      yield* stopBuilds;
      assert.deepEqual(yield* refresh(), { _tag: "Published", generation: 1 });
    }),
  ),
);
