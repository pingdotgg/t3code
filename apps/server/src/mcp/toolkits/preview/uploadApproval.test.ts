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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/ai";

import { toSafeThreadAttachmentSegment } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceFolders from "../../../workspace/WorkspaceFolders.ts";
import * as McpClientInput from "../../McpClientInput.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewHandlers from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";
import { filesOutsideThread } from "./uploadPlacement.ts";

const threadId = ThreadId.make("thread:upload");
const KEY = "outside-action";

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
    readonly act: (
      input: Record<string, unknown>,
      reply?: { readonly action: string; readonly state: string },
    ) => Effect.Effect<
      { readonly result: unknown; readonly asked: McpSchema.InputRequired | undefined },
      never,
      FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
    >;
    /** The person's answer in the app, for the request asking `message`. */
    readonly answer: (message: string, approved: boolean) => Effect.Effect<void>;
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
    const sessions = yield* McpProviderSessions.McpProviderSessions;
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
    // The thread's adapter passes on what the person answers, so the question is observable
    // as the request the call is answered with.
    yield* sessions.showsApprovalRequests(ProviderInstanceId.make("codex"));

    return yield* body({
      shell,
      paths,
      operations,
      uploaded,
      page,
      act: (input, reply) =>
        Effect.gen(function* () {
          const request = Ref.makeUnsafe<McpSchema.InputRequired | undefined>(undefined);
          const { result } = yield* toolkit.handle("preview_act", input as never).pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpClientInput.McpClientInput, { request, sessions }),
            Effect.provideService(
              McpSchema.McpRequestContext,
              McpSchema.McpRequestContext.of({
                clientId: 1,
                protocolVersion: "2026-07-28",
                clientCapabilities: new McpSchema.ClientCapabilities({ elicitation: {} }),
                ...(reply === undefined
                  ? {}
                  : {
                      inputResponses: { [KEY]: { action: reply.action } },
                      requestState: reply.state,
                    }),
              }),
            ),
            Effect.provide(services),
            // A refusal is the call's answer too.
            Effect.catch((refused) => Effect.succeed({ result: refused as unknown })),
          );
          return { result, asked: Ref.getUnsafe(request) };
        }),
      answer: (message, approved) => sessions.answerApprovalRequests(threadId, message, approved),
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

const messageOf = (asked: McpSchema.InputRequired | undefined) =>
  (asked?.inputRequests?.[KEY] as { readonly params: { readonly message: string } } | undefined)
    ?.params.message;

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
    withThread(runtimeMode, ({ paths, operations, uploaded, act, answer }) =>
      Effect.gen(function* () {
        const upload = { action: "upload", paths: [paths.inProject, paths.linkToElsewhere] };
        const first = yield* act(upload);
        const message = messageOf(first.asked)!;
        expect(message).toMatch(
          new RegExp(
            `^Upload "${paths.elsewhere.replaceAll(".", "\\.")}" to https://forms\\.example\\? \\(request [0-9a-f]{8}\\)$`,
          ),
        );
        expect(operations).toEqual([]);

        // The client's own "accept" uploads nothing.
        const state = first.asked!.requestState!;
        const unconfirmed = yield* act(upload, { action: "accept", state });
        expect(unconfirmed.result).toMatchObject({ code: "capability_denied" });
        expect(operations).toEqual([]);

        const again = yield* act(upload);
        yield* answer(messageOf(again.asked)!, true);
        yield* act(upload, { action: "accept", state: again.asked!.requestState! });
        expect(operations).toEqual(["upload"]);
        // The link goes as the file the person was asked about.
        expect(uploaded).toEqual([[paths.inProject, paths.elsewhere]]);

        // Other files are another request.
        const other = yield* act(
          { action: "upload", paths: [paths.otherThreadsAttachment] },
          { action: "accept", state: again.asked!.requestState! },
        );
        expect(messageOf(other.asked)).toContain(`Upload "${paths.otherThreadsAttachment}" to `);
        expect(operations).toEqual(["upload"]);
      }),
    ),
);

it.effect("a declined upload sends nothing", () =>
  withThread("approval-required", ({ paths, operations, act, answer }) =>
    Effect.gen(function* () {
      const upload = { action: "upload", paths: [paths.elsewhere] };
      const first = yield* act(upload);
      yield* answer(messageOf(first.asked)!, false);
      const declined = yield* act(upload, {
        action: "decline",
        state: first.asked!.requestState!,
      });
      expect(declined.result).toMatchObject({
        code: "capability_denied",
        message: `Not done: the user declined "Upload "${paths.elsewhere}" to https://forms.example".`,
      });
      expect(operations).toEqual([]);
    }),
  ),
);

it.effect("uploads of the thread's own files, and other page actions, run unasked", () =>
  withThread("approval-required", ({ paths, operations, act }) =>
    Effect.gen(function* () {
      const own = yield* act({
        action: "upload",
        paths: [paths.inProject, paths.inTrackedFolder, paths.ownAttachment],
      });
      expect(own.asked).toBeUndefined();
      const click = yield* act({ action: "click", locator: "text=Send" });
      expect(click.asked).toBeUndefined();
      expect(operations).toEqual(["upload", "click"]);
    }),
  ),
);

it.effect("a Full access thread uploads any file unasked", () =>
  withThread("full-access", ({ paths, operations, act }) =>
    Effect.gen(function* () {
      const sent = yield* act({ action: "upload", paths: [paths.elsewhere] });
      expect(sent.asked).toBeUndefined();
      expect(operations).toEqual(["upload"]);
    }),
  ),
);

it.effect.each([
  ["while the person reads", "before"],
  ["after their answer is read", "between"],
] as const)("a page that moves on %s gets no file", ([, when]) =>
  withThread("auto", ({ paths, operations, page, act, answer }) =>
    Effect.gen(function* () {
      const upload = { action: "upload", paths: [paths.elsewhere] };
      const first = yield* act(upload);
      yield* answer(messageOf(first.asked)!, true);
      const moveOn = () => void (page.url = "https://elsewhere.example/drop");
      // The answering call reads the page twice: for the answer, and again before it sends.
      const from = page.reads;
      if (when === "before") moveOn();
      else page.onRead = () => (page.reads === from + 1 ? moveOn() : undefined);
      const moved = yield* act(upload, { action: "accept", state: first.asked!.requestState! });
      expect(operations).toEqual([]);
      if (when === "before") {
        // Another page is another request.
        expect(messageOf(moved.asked)).toContain(" to https://elsewhere.example? (request ");
      } else {
        expect(moved.result).toMatchObject({
          code: "capability_denied",
          message: `Not done: what "Upload "${paths.elsewhere}" to https://forms.example" would do changed while the user was asked. Call again to ask.`,
        });
      }
    }),
  ),
);

it.effect("a link pointed elsewhere after it was placed sends the file that was placed", () =>
  withThread("auto", ({ paths, uploaded, act }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A link in the project to one of its own files: placed inside, so nobody is asked.
      const link = path.join(path.dirname(paths.inProject), "latest.pdf");
      yield* fileSystem.symlink(paths.inProject, link);
      const sent = yield* act({ action: "upload", paths: [link] });
      expect(sent.asked).toBeUndefined();
      // What is sent is named by where the link led when it was placed, not by the link.
      expect(uploaded).toEqual([[paths.inProject]]);
    }),
  ),
);

it.effect("a page with no origin of its own is named by its address, as data", () =>
  withThread("auto", ({ paths, page, act }) =>
    Effect.gen(function* () {
      page.url = "data:text/html,<p>forms.example\u202e</p>";
      const asked = yield* act({ action: "upload", paths: [paths.elsewhere] });
      expect(messageOf(asked.asked)).toContain(
        ' to "data:text/html,<p>forms.example\\u{202e}</p>"? (request ',
      );
    }),
  ),
);
