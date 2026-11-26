import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { toSafeThreadAttachmentSegment } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceFolders from "../../../workspace/WorkspaceFolders.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell, makeAskedThread } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewHandlers from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";
import { filesOutsideThread } from "./uploadPlacement.ts";

const threadId = ThreadId.make("thread:upload");

/**
 * A thread whose project folder, one tracked folder and attachments are real directories, with
 * files inside them and elsewhere, and a page open at `https://forms.example`.
 */
const withThread = <A, E>(
  runtimeMode: RuntimeMode,
  body: (thread: {
    readonly shell: OrchestrationV2ThreadShell;
    readonly paths: {
      readonly inProject: string;
      readonly inTrackedFolder: string;
      readonly ownAttachment: string;
      readonly otherThreadsAttachment: string;
      readonly elsewhere: string;
      readonly linkToElsewhere: string;
      readonly missing: string;
    };
    /** The page operations that reached the browser. */
    readonly operations: ReadonlyArray<string>;
    /** The files each upload that reached the browser carried. */
    readonly uploaded: ReadonlyArray<ReadonlyArray<string>>;
    /** The page the tab shows, and how many times it has been read. */
    readonly page: { url: string; reads: number; onRead: () => void };
    /** One call; a refusal is its result too. */
    readonly act: (
      input: Record<string, unknown>,
    ) => Effect.Effect<
      unknown,
      never,
      FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
    >;
    /** The person behind the thread: what they are asked, and their answers. */
    readonly person: Effect.Success<ReturnType<typeof makeAskedThread>>;
  }) => Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | ProjectStore.ProjectStoreV2
    | WorkspaceFolders.WorkspaceFolders
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const person = yield* makeAskedThread();
    const root = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-preview-upload-" })
      .pipe(Effect.flatMap(fileSystem.realPath));
    const project = path.join(root, "project");
    const tracked = path.join(root, "tracked");
    const outside = path.join(root, "outside");
    const segment = toSafeThreadAttachmentSegment(threadId)!;
    const paths = {
      inProject: path.join(project, "src", "summary.pdf"),
      inTrackedFolder: path.join(tracked, "notes.txt"),
      ownAttachment: path.join(config.attachmentsDir, `${segment}-0b2a.png`),
      otherThreadsAttachment: path.join(config.attachmentsDir, "thread-other-0b2a.png"),
      elsewhere: path.join(outside, "keys.txt"),
      linkToElsewhere: path.join(project, "linked-keys.txt"),
      missing: path.join(project, "not-there.txt"),
    };
    for (const file of [
      paths.inProject,
      paths.inTrackedFolder,
      paths.ownAttachment,
      paths.otherThreadsAttachment,
      paths.elsewhere,
    ]) {
      yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
      yield* fileSystem.writeFileString(file, "contents");
    }
    yield* fileSystem.symlink(paths.elsewhere, paths.linkToElsewhere);

    const shell = { ...liveThreadShell(threadId, { runtimeMode }), worktreePath: null };
    const operations: Array<string> = [];
    const uploaded: Array<ReadonlyArray<string>> = [];
    const page = { url: "https://forms.example/apply?step=2", reads: 0, onRead: () => {} };
    const services = Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        ...person.threads,
        getThreadShell: () => Effect.succeed(shell),
      }),
      Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
        invoke: ((request: {
          readonly operation: string;
          readonly timeoutMs?: number;
          readonly input: { readonly paths?: ReadonlyArray<string> };
        }) =>
          Effect.sync(() => {
            // The short read that places an upload; the one after an action is not counted.
            if (request.operation === "status") {
              if (request.timeoutMs !== 500) return { tabId: null, url: page.url };
              const url = page.url;
              page.reads += 1;
              page.onRead();
              return { tabId: null, url };
            }
            operations.push(request.operation);
            if (request.operation === "upload") uploaded.push(request.input.paths ?? []);
            return {};
          })) as never,
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () => Effect.succeedSome({ workspaceRoot: project } as never),
      }),
      Layer.mock(WorkspaceFolders.WorkspaceFolders)({
        forThread: () =>
          Effect.succeed({
            folders: [{ name: "tracked", path: tracked, isGitRepository: false }],
            extraRoots: [tracked],
          }),
      }),
    );
    const toolkit = yield* PreviewStandardToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(PreviewHandlers.layerStandard)),
    );
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: `provider:${threadId}`,
      thread: {
        threadId,
        providerSessionId: `provider:${threadId}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration", "preview"]),
      issuedAt: 0,
    };
    return yield* body({
      shell,
      paths,
      operations,
      uploaded,
      page,
      person,
      act: (input) =>
        toolkit.handle("preview_act", input as never).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.map(({ result }) => result as unknown),
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          person.provide,
          Effect.provide(services),
          // A refusal is the call's answer too.
          Effect.catch((refused) => Effect.succeed(refused as unknown)),
        ),
    }).pipe(Effect.provide(services));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        McpProviderSessions.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-upload-test-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

it.effect("places a file by what it resolves to, and outside when it cannot be placed", () =>
  withThread("approval-required", ({ shell, paths }) =>
    Effect.gen(function* () {
      const own = [paths.inProject, paths.inTrackedFolder, paths.ownAttachment];
      expect(yield* filesOutsideThread(shell, own)).toEqual({ outside: [], files: own });
      expect(
        yield* filesOutsideThread(shell, [
          paths.inProject,
          paths.elsewhere,
          // A link inside the project to a file elsewhere is that file.
          paths.linkToElsewhere,
          paths.otherThreadsAttachment,
          paths.missing,
          "src/summary.pdf",
          `${paths.inProject}/../../../outside/keys.txt`,
        ]),
      ).toEqual({
        outside: [
          paths.elsewhere,
          paths.elsewhere,
          paths.otherThreadsAttachment,
          paths.missing,
          "src/summary.pdf",
          paths.elsewhere,
        ],
        // What is sent is what was placed: the file a link or a relative step resolves to.
        files: [
          paths.inProject,
          paths.elsewhere,
          paths.elsewhere,
          paths.otherThreadsAttachment,
          paths.missing,
          "src/summary.pdf",
          paths.elsewhere,
        ],
      });
    }),
  ),
);

it.effect("a thread whose folders cannot be read has every file outside", () =>
  withThread("approval-required", ({ shell, paths }) =>
    filesOutsideThread(shell, [paths.inProject, paths.inTrackedFolder, paths.ownAttachment]).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
          Layer.mock(WorkspaceFolders.WorkspaceFolders)({
            forThread: () => Effect.fail({ _tag: "WorkspaceFoldersError" } as never),
          }),
        ),
      ),
      Effect.map(({ outside }) =>
        // Its own attachments are placed by the server's attachment folder alone.
        expect(outside).toEqual([paths.inProject, paths.inTrackedFolder]),
      ),
    ),
  ),
);

it.effect.each(["approval-required", "auto-accept-edits", "auto"] as const)(
  "an upload from outside a %s thread waits for the person, naming the file and the page",
  (runtimeMode) =>
    withThread(runtimeMode, ({ paths, operations, uploaded, act, person }) =>
      Effect.gen(function* () {
        const upload = { action: "upload", paths: [paths.inProject, paths.linkToElsewhere] };
        const call = yield* Effect.forkChild(act(upload));
        const asked = yield* person.asked;
        expect(asked.message).toMatch(
          new RegExp(
            `^Upload "${paths.elsewhere.replaceAll(".", "\\.")}" to https://forms\\.example\\? \\(request [0-9a-f]{8}\\)$`,
          ),
        );
        expect(operations).toEqual([]);

        yield* person.answer(asked, "accept");
        yield* Fiber.join(call);
        expect(operations).toEqual(["upload"]);
        // The link goes as the file the person was asked about.
        expect(uploaded).toEqual([[paths.inProject, paths.elsewhere]]);

        // Other files are another request, and the same ones are asked about again.
        yield* Effect.forkChild(act({ action: "upload", paths: [paths.otherThreadsAttachment] }));
        expect((yield* person.asked).message).toContain(
          `Upload "${paths.otherThreadsAttachment}" to `,
        );
        yield* Effect.forkChild(act(upload));
        expect((yield* person.asked).id).not.toBe(asked.id);
        expect(operations).toEqual(["upload"]);
      }),
    ),
);

it.effect("a declined upload sends nothing", () =>
  withThread("approval-required", ({ paths, operations, act, person }) =>
    Effect.gen(function* () {
      const call = yield* Effect.forkChild(act({ action: "upload", paths: [paths.elsewhere] }));
      yield* person.answer(yield* person.asked, "decline");
      expect(yield* Fiber.join(call)).toMatchObject({
        code: "capability_denied",
        message: `Not done: the user declined "Upload "${paths.elsewhere}" to https://forms.example".`,
      });
      expect(operations).toEqual([]);
    }),
  ),
);

it.effect("uploads of the thread's own files, and other page actions, run unasked", () =>
  withThread("approval-required", ({ paths, operations, act, person }) =>
    Effect.gen(function* () {
      yield* act({
        action: "upload",
        paths: [paths.inProject, paths.inTrackedFolder, paths.ownAttachment],
      });
      yield* act({ action: "click", locator: "text=Send" });
      expect(yield* person.raised).toEqual([]);
      expect(operations).toEqual(["upload", "click"]);
    }),
  ),
);

it.effect("a Full access thread uploads any file unasked", () =>
  withThread("full-access", ({ paths, operations, act, person }) =>
    Effect.gen(function* () {
      yield* act({ action: "upload", paths: [paths.elsewhere] });
      expect(yield* person.raised).toEqual([]);
      expect(operations).toEqual(["upload"]);
    }),
  ),
);

it.effect("a page that moves on while the person reads gets no file", () =>
  withThread("auto", ({ paths, operations, page, act, person }) =>
    Effect.gen(function* () {
      const upload = { action: "upload", paths: [paths.elsewhere] };
      const call = yield* Effect.forkChild(act(upload));
      const asked = yield* person.asked;
      page.url = "https://elsewhere.example/drop";
      yield* person.answer(asked, "accept");
      expect(yield* Fiber.join(call)).toMatchObject({
        code: "capability_denied",
        message: `Not done: what "Upload "${paths.elsewhere}" to https://forms.example" would do changed while the user was asked. Call again to ask.`,
      });
      expect(operations).toEqual([]);
      // Called again, it asks about the page that is there now.
      yield* Effect.forkChild(act(upload));
      expect((yield* person.asked).message).toContain(" to https://elsewhere.example? (request ");
      expect(operations).toEqual([]);
    }),
  ),
);

it.effect("an upload left unanswered ends with the turn, and sends nothing", () =>
  withThread("auto", ({ paths, operations, act, person }) =>
    Effect.gen(function* () {
      const call = yield* Effect.forkChild(act({ action: "upload", paths: [paths.elsewhere] }));
      yield* person.asked;
      yield* person.endTurn("interrupted");
      expect(yield* Fiber.join(call)).toMatchObject({
        code: "capability_denied",
        message: expect.stringMatching(/^Cancelled, nothing was done: /),
      });
      expect(operations).toEqual([]);
    }),
  ),
);

it.effect("a link pointed elsewhere after it was placed sends the file that was placed", () =>
  withThread("auto", ({ paths, uploaded, act, person }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A link in the project to one of its own files: placed inside, so nobody is asked.
      const link = path.join(path.dirname(paths.inProject), "latest.pdf");
      yield* fileSystem.symlink(paths.inProject, link);
      yield* act({ action: "upload", paths: [link] });
      expect(yield* person.raised).toEqual([]);
      // What is sent is named by where the link led when it was placed, not by the link.
      expect(uploaded).toEqual([[paths.inProject]]);
    }),
  ),
);

it.effect("a page with no origin of its own is named by its address, as data", () =>
  withThread("auto", ({ paths, page, act, person }) =>
    Effect.gen(function* () {
      page.url = "data:text/html,<p>forms.example‮</p>";
      yield* Effect.forkChild(act({ action: "upload", paths: [paths.elsewhere] }));
      expect((yield* person.asked).message).toContain(
        ' to "data:text/html,<p>forms.example\\u{202e}</p>"? (request ',
      );
    }),
  ),
);
