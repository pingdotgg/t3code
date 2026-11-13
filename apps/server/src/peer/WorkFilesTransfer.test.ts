// @effect-diagnostics nodeBuiltinImport:off - Fixtures drive git directly on real folders.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthMcpClientAccess,
  ProjectId,
  WorkFilesReceiveInput,
  WorkFilesReceiveResult,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as WorkFilesTransfer from "./WorkFilesTransfer.ts";

// The laptop sends a thread's files to the box over a real link: the box's
// real /mcp issues the upload and its real route applies it to a checkout.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxProject = ProjectId.make("project:box");

const tempDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-work-files-e2e-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();

const write = (root: string, path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), content);
};

/** The same commit checked out on both machines. */
const checkouts = Effect.gen(function* () {
  const source = yield* tempDir;
  const target = yield* tempDir;
  git(source, "init", "-q", "-b", "main");
  write(source, "app.ts", "v1");
  write(source, "old.ts", "old");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "initial");
  // A clone, not a copy: git may still be writing objects after the commit.
  git(target, "clone", "-q", source, ".");
  return { source, target };
});

/** One environment's WorkFilesTransfer, with its own state directory and signing key. */
const layerTransfer = (stateRoot: string, workspaceRoot: string) =>
  WorkFilesTransfer.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            id === boxProject
              ? Option.some({ id, workspaceRoot, deletedAt: null } as never)
              : Option.none(),
          ),
      }),
    ),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(stateRoot, { prefix: "t3-work-files-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/** The box: /mcp with the receive tool, and the upload route, sharing one transfer service. */
const serveBox = (target: string) =>
  Effect.gen(function* () {
    const stateRoot = yield* tempDir;
    const transfer = yield* layerTransfer(stateRoot, target).pipe(
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
      Layer.provide(FetchHttpClient.layer),
      Layer.build,
    );
    const shared = Layer.succeedContext(transfer);
    const peer = yield* servePeer(
      box,
      McpHttpServer.layerWorkFilesToolkit.pipe(
        Layer.provide(shared),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
      ),
      WorkFilesTransfer.layerReceiveRoute.pipe(Layer.provide(shared)),
    );
    const config = Context.get(transfer, ServerConfig.ServerConfig);
    return { peer, receiveDir: NodePath.join(config.stateDir, "work-files") };
  });

/** The laptop, linked to the box with `access`, sending from `source`. */
const laptopSending = (
  peer: Effect.Success<ReturnType<typeof serveBox>>["peer"],
  source: string,
  access: AuthMcpClientAccess,
) =>
  Effect.gen(function* () {
    const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const stateRoot = yield* tempDir;
    const here = yield* layerTransfer(stateRoot, source).pipe(
      Layer.provide(Layer.succeedContext(linking)),
      Layer.provide(FetchHttpClient.layer),
      Layer.build,
    );
    yield* linkTo(Context.get(linking, PeerLinks.PeerLinks), peer, access);
    const peers = Context.get(linking, PeerMcpClient.PeerMcpClient);
    const transfer = Context.get(here, WorkFilesTransfer.WorkFilesTransfer);
    return transfer.send({
      cwd: source,
      environmentId: box.environmentId,
      projectId: boxProject,
      receive: (request) =>
        peers.call({
          environmentId: box.environmentId,
          tool: "t3_work_files_receive",
          arguments: encodeReceiveInput(request) as Record<string, unknown>,
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: WorkFilesReceiveResult,
        }),
    });
  });

const encodeReceiveInput = Schema.encodeSync(WorkFilesReceiveInput);

const leftovers = (dir: string) => (NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir) : []);

it.live("sends a checkout's work to the same commit on the box, leaving no archive", () =>
  Effect.gen(function* () {
    const { source, target } = yield* checkouts;
    const { peer, receiveDir } = yield* serveBox(target);
    write(source, "app.ts", "v2");
    write(source, "src/new.ts", "new");
    write(source, ".env.local", "TOKEN=1");
    NodeFS.rmSync(NodePath.join(source, "old.ts"));

    const send = yield* laptopSending(peer, source, "auto");
    expect(yield* send).toEqual({ files: 3, deletions: 1 });
    expect(NodeFS.readFileSync(NodePath.join(target, "app.ts"), "utf8")).toBe("v2");
    expect(NodeFS.readFileSync(NodePath.join(target, "src/new.ts"), "utf8")).toBe("new");
    expect(NodeFS.existsSync(NodePath.join(target, "old.ts"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(target, ".env.local"), "utf8")).toBe("TOKEN=1");
    expect(leftovers(receiveDir)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("a refusal there changes nothing and still removes the archive and staging", () =>
  Effect.gen(function* () {
    const { source, target } = yield* checkouts;
    const { peer, receiveDir } = yield* serveBox(target);
    write(source, "app.ts", "from laptop");
    write(target, "app.ts", "edited on the box");

    const send = yield* laptopSending(peer, source, "auto");
    const refused = yield* send.pipe(Effect.flip);
    expect(refused.message).toContain("app.ts (it has local changes there)");
    expect(NodeFS.readFileSync(NodePath.join(target, "app.ts"), "utf8")).toBe("edited on the box");
    expect(leftovers(receiveDir)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("a receive folder the box cannot write to refuses the files and keeps it running", () =>
  Effect.gen(function* () {
    const { source, target } = yield* checkouts;
    const { peer, receiveDir } = yield* serveBox(target);
    NodeFS.mkdirSync(receiveDir, { recursive: true });
    NodeFS.chmodSync(receiveDir, 0o500);
    yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.chmodSync(receiveDir, 0o700)));
    write(source, "app.ts", "v2");

    const send = yield* laptopSending(peer, source, "auto");
    const refused = yield* send.pipe(Effect.flip);
    expect(refused.message).toContain("The linked environment refused the work files");
    expect(NodeFS.readFileSync(NodePath.join(target, "app.ts"), "utf8")).toBe("v1");

    // The box still answers, and a writable folder takes the same work.
    NodeFS.chmodSync(receiveDir, 0o700);
    expect(yield* send).toEqual({ files: 1, deletions: 0 });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("refuses before sending anything when the box is on another commit", () =>
  Effect.gen(function* () {
    const { source, target } = yield* checkouts;
    const { peer, receiveDir } = yield* serveBox(target);
    write(target, "extra.ts", "x");
    git(target, "add", "extra.ts");
    git(target, "commit", "-q", "-m", "ahead");
    write(source, "app.ts", "v2");

    const send = yield* laptopSending(peer, source, "auto");
    const refused = yield* send.pipe(Effect.flip);
    expect(refused.message).toContain(git(source, "rev-parse", "HEAD"));
    expect(refused.message).toContain(git(target, "rev-parse", "HEAD"));
    expect(leftovers(receiveDir)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live.each(["read-only", "approval-required"] as const)(
  "refuses files from a link with %s access",
  (access) =>
    Effect.gen(function* () {
      const { source, target } = yield* checkouts;
      const { peer } = yield* serveBox(target);
      write(source, "app.ts", "v2");

      const send = yield* laptopSending(peer, source, access);
      const refused = yield* send.pipe(Effect.flip);
      expect(refused.code).toBe("capability_denied");
      if (access !== "read-only") expect(refused.message).toContain(access);
      expect(NodeFS.readFileSync(NodePath.join(target, "app.ts"), "utf8")).toBe("v1");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("the upload route takes nothing without a link session and its own token", () =>
  Effect.gen(function* () {
    const { target } = yield* checkouts;
    const { peer } = yield* serveBox(target);
    const client = yield* HttpClient.HttpClient;
    const anonymous = yield* client.execute(
      HttpClientRequest.post(
        `${peer.url}${WorkFilesTransfer.WORK_FILES_RECEIVE_ROUTE_PREFIX}/forged.token`,
      ).pipe(HttpClientRequest.setBody(HttpBody.text("x"))),
    );
    expect(anonymous.status).toBe(401);

    // A supervised link may read, but receiving files edits the checkout.
    const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
    const links = Context.get(linking, PeerLinks.PeerLinks);
    yield* linkTo(links, peer, "approval-required");
    const resolved = yield* links.resolve(box.environmentId);
    const supervised = yield* client.execute(
      HttpClientRequest.post(
        `${resolved.url}${WorkFilesTransfer.WORK_FILES_RECEIVE_ROUTE_PREFIX}/forged.token`,
      ).pipe(
        HttpClientRequest.setHeaders({ authorization: `Bearer ${resolved.token}` }),
        HttpClientRequest.setBody(HttpBody.text("x")),
      ),
    );
    expect(supervised.status).toBe(403);
    expect(yield* supervised.text).toContain("approval-required");
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeHttpServer.layerTest, FetchHttpClient.layer)),
  ),
);
