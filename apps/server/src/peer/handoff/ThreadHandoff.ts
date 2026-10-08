import {
  CommandId,
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadHandoff,
  type OrchestratorMcpImportedMessage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";

import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { AttachmentToolkit } from "../../mcp/toolkits/attachment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PeerForwarding from "../PeerForwarding.ts";
import * as PeerLinks from "../PeerLinks.ts";
import * as HandoffGit from "./HandoffGit.ts";

/** What the thread there starts with, unless the move names its own. */
const DEFAULT_CONTINUATION =
  "This thread was just moved here from another machine, with its conversation and its uncommitted work. Continue where it left off.";

type HandoffState = OrchestrationV2ThreadHandoff["state"];

/**
 * Moves a thread to a linked environment: its conversation, and its git work
 * (unpushed commits, uncommitted edits, new files). Exactly one copy stays
 * live: the thread here takes no new turns once it starts moving, and reads
 * only once it has moved. A failed move releases it with the reason.
 *
 * An agent can ask to move its own thread mid-turn; the move then waits for
 * that turn to end (`pending`), and a message to the thread before then cancels it.
 */
export class ThreadHandoff extends Context.Service<
  ThreadHandoff,
  {
    /** Where the thread can go: linked environments with a project of its repository. */
    readonly options: (threadId: ThreadId) => Effect.Effect<
      ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly label: string;
        readonly projectId: ProjectId | null;
        readonly reason: string | null;
      }>,
      OrchestratorMcpFailure
    >;
    /**
     * Moves `threadId` to `environmentId` now, or once its live turn ends when
     * `whenTurnEnds` is set. Returns the state the move is in.
     */
    readonly start: (input: {
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId;
      readonly projectId?: ProjectId | undefined;
      readonly continuationPrompt?: string | undefined;
      readonly whenTurnEnds?: boolean | undefined;
    }) => Effect.Effect<OrchestrationV2ThreadHandoff, OrchestratorMcpFailure>;
    /** Cancels a move that is still waiting for the turn to end. */
    readonly cancel: (threadId: ThreadId) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Runs moves whose turn ended, and settles any a restart cut short. */
    readonly start_: () => Effect.Effect<void, never, Scope.Scope>;
    /** Settles one thread's move now: what the follower does when its turn ends. */
    readonly settle: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/peer/handoff/ThreadHandoff") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const git = yield* HandoffGit.HandoffGit;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );

  /** The thread's agent, acting on its own behalf there through the link. */
  const scopeFor = (thread: {
    readonly id: ThreadId;
    readonly providerInstanceId: string;
  }): McpInvocationContext.McpThreadInvocationScope => ({
    environmentId: hereId,
    requestNamespace: `handoff:${thread.id}`,
    thread: {
      threadId: thread.id,
      providerSessionId: `handoff:${thread.id}`,
      providerInstanceId: thread.providerInstanceId as never,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  const setHandoff = (
    threadId: ThreadId,
    expected: HandoffState | null,
    handoff: OrchestrationV2ThreadHandoff | null,
    step: string,
  ) =>
    threads
      .dispatch({
        type: "thread.handoff.update",
        commandId: CommandId.make(
          `command:handoff:${threadId}:${handoff?.handoffId ?? "clear"}:${step}`,
        ),
        threadId,
        expected,
        handoff,
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError((error) => failure("invalid_request", error.message)),
      );

  /** The project there with this thread's repository, or the one named. */
  const remoteProject = (
    scope: McpInvocationContext.McpThreadInvocationScope,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    requested: ProjectId | undefined,
  ) =>
    Effect.gen(function* () {
      if (requested !== undefined) return requested;
      const here = yield* projects.getById(projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      // The project's own identity reads blank while its cache is cold.
      const key =
        here === undefined
          ? undefined
          : (yield* repositoryIdentities.resolve(here.workspaceRoot))?.canonicalKey;
      if (key === undefined) {
        return yield* failure(
          "target_required",
          "This thread's project has no repository to match there. Pick the project there.",
        );
      }
      const listed = yield* forwarding.call(
        scope,
        ProjectToolkit.tools.t3_project_list,
        environmentId,
        {
          limit: 100,
        },
      );
      const matches = listed.projects.filter(
        (project) => project.repositoryIdentity?.canonicalKey === key,
      );
      if (matches.length !== 1) {
        return yield* failure(
          "invalid_request",
          matches.length === 0
            ? `No project there has this repository (${key}). Add it there first.`
            : `Several projects there have this repository; pick one: ${matches.map((p) => p.title).join(", ")}.`,
        );
      }
      return matches[0]!.id;
    });

  /** The conversation as the thread there will see it. */
  const conversation = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["messages"], { messageRoles: ["user", "assistant"] }).pipe(
      Effect.map((records) =>
        records.messages
          .filter(
            (message) =>
              !message.streaming &&
              message.notification === undefined &&
              message.delegatedCompletion === undefined &&
              message.text.trim() !== "",
          )
          .slice(-2_000)
          .map((message): OrchestratorMcpImportedMessage => ({
            role: message.role === "user" ? "user" : "assistant",
            text: message.text.slice(0, 200_000),
            createdAt: DateTime.formatIso(message.createdAt),
          })),
      ),
      Effect.mapError(() => failure("orchestration_error", "The conversation could not be read.")),
    );

  /** Uploads the bundle there through its signed upload route. */
  const upload = (
    scope: McpInvocationContext.McpThreadInvocationScope,
    environmentId: EnvironmentId,
    packed: HandoffGit.HandoffPackage,
  ) =>
    Effect.gen(function* () {
      const prepared = yield* forwarding.call(
        scope,
        AttachmentToolkit.tools.t3_attachment_prepare_upload,
        environmentId,
        {
          upload: {
            type: "file",
            name: `${packed.snapshot.slice(0, 12)}.bundle`,
            mimeType: "application/x-git-bundle",
            sizeBytes: packed.bundleBytes,
          },
        },
      );
      const resolved = yield* links
        .resolve(environmentId)
        .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
      const bytes = yield* fileSystem
        .readFile(packed.bundlePath)
        .pipe(
          Effect.mapError(() => failure("orchestration_error", "The bundle could not be read.")),
        );
      const response = yield* httpClient
        .execute(
          HttpClientRequest.post(`${resolved.url}${prepared.relativeUrl}`).pipe(
            HttpClientRequest.setBody(HttpBody.uint8Array(bytes, "application/x-git-bundle")),
          ),
        )
        .pipe(
          Effect.mapError(() =>
            failure("orchestration_error", "The linked environment stopped answering mid-upload."),
          ),
        );
      if (response.status !== 204) {
        return yield* failure(
          "orchestration_error",
          `The linked environment refused the upload (HTTP ${response.status}).`,
        );
      }
      return prepared.attachmentId;
    });

  /** The move itself, from `departing`: package, send, import, then mark departed. */
  const depart = (threadId: ThreadId, projectHint?: ProjectId | undefined) =>
    Effect.gen(function* () {
      const records = yield* threads
        .getThreadRecords(threadId, [])
        .pipe(Effect.mapError(() => failure("thread_not_found", "The thread was not found.")));
      const thread = records.thread;
      const handoff = thread.handoff;
      if (handoff?.state !== "departing") return handoff;
      const scope = scopeFor(thread);
      const result = yield* Effect.gen(function* () {
        const projectId = yield* remoteProject(
          scope,
          handoff.environmentId,
          thread.projectId,
          projectHint,
        );
        const project = yield* projects.getById(thread.projectId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
        const cwd = thread.worktreePath ?? project?.workspaceRoot;
        const tempDir = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3-handoff-" })
          .pipe(
            Effect.mapError(() => failure("orchestration_error", "No temp space for the move.")),
          );
        const packed =
          cwd === undefined
            ? undefined
            : yield* git.pack({ cwd, handoffId: handoff.handoffId, outDir: tempDir }).pipe(
                Effect.catchTags({
                  // A thread outside git moves with its conversation only.
                  HandoffGitError: (error) =>
                    error.reason === "not_a_repository"
                      ? Effect.succeed(undefined)
                      : Effect.fail(failure("invalid_request", error.message)),
                }),
              );
        const attachmentId =
          packed === undefined ? undefined : yield* upload(scope, handoff.environmentId, packed);
        return yield* forwarding.call(
          scope,
          ProjectToolkit.tools.t3_thread_import,
          handoff.environmentId,
          {
            source: {
              environmentId: hereId,
              threadId,
              handoffId: handoff.handoffId,
            },
            projectId,
            title: thread.title,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            messages: yield* conversation(threadId),
            continuationPrompt: handoff.continuationPrompt ?? DEFAULT_CONTINUATION,
            ...(packed === undefined || attachmentId === undefined
              ? {}
              : {
                  bundle: {
                    attachmentId,
                    branch: packed.branch,
                    tip: packed.tip,
                    snapshot: packed.snapshot,
                  },
                }),
          },
        );
      }).pipe(Effect.scoped, Effect.result);
      if (result._tag === "Failure") {
        yield* setHandoff(
          threadId,
          "departing",
          {
            state: "failed",
            handoffId: handoff.handoffId,
            environmentId: handoff.environmentId,
            label: handoff.label,
            lastError: result.failure.message,
          },
          "failed",
        ).pipe(Effect.ignore);
        return yield* Effect.fail(result.failure);
      }
      const departed: OrchestrationV2ThreadHandoff = {
        state: "departed",
        handoffId: handoff.handoffId,
        environmentId: handoff.environmentId,
        label: handoff.label,
        threadId: result.success.threadId,
      };
      yield* setHandoff(threadId, "departing", departed, "departed");
      return departed;
    });

  const options: ThreadHandoff["Service"]["options"] = (threadId) =>
    Effect.gen(function* () {
      const records = yield* threads
        .getThreadRecords(threadId, [])
        .pipe(Effect.mapError(() => failure("thread_not_found", "The thread was not found.")));
      const listed = yield* links.list.pipe(Effect.orElseSucceed(() => []));
      return yield* Effect.forEach(
        listed,
        (link) =>
          link.status !== "reachable"
            ? Effect.succeed({
                environmentId: link.environmentId,
                label: link.label,
                projectId: null,
                reason:
                  link.status === "expired" ? "The link expired." : "Not answering right now.",
              })
            : remoteProject(
                scopeFor(records.thread),
                link.environmentId,
                records.thread.projectId,
                undefined,
              ).pipe(
                Effect.map((projectId) => ({
                  environmentId: link.environmentId,
                  label: link.label,
                  projectId,
                  reason: null,
                })),
                Effect.catch((error) =>
                  Effect.succeed({
                    environmentId: link.environmentId,
                    label: link.label,
                    projectId: null,
                    reason: error.message,
                  }),
                ),
              ),
        { concurrency: 4 },
      );
    });

  const start: ThreadHandoff["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      const records = yield* threads
        .getThreadRecords(input.threadId, ["runs"])
        .pipe(Effect.mapError(() => failure("thread_not_found", "The thread was not found.")));
      const thread = records.thread;
      if (thread.archivedAt !== null) {
        return yield* failure("invalid_request", "Unarchive the thread to move it.");
      }
      const current = thread.handoff?.state ?? null;
      if (current === "pending" || current === "departing" || current === "departed") {
        return yield* failure("invalid_request", `This thread's move is already ${current}.`);
      }
      const link = (yield* links.list.pipe(Effect.orElseSucceed(() => []))).find(
        (candidate) => candidate.environmentId === input.environmentId,
      );
      if (link === undefined) {
        return yield* failure("invalid_request", "That environment is not linked.");
      }
      // Fails now, while the asking agent can still say so, rather than after its turn.
      yield* remoteProject(
        scopeFor(thread),
        input.environmentId,
        thread.projectId,
        input.projectId,
      );
      const handoffId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "");
      const busy = records.runs.some(
        (run) =>
          run.status === "running" ||
          run.status === "starting" ||
          run.status === "waiting" ||
          run.status === "queued" ||
          run.status === "preparing",
      );
      const base = {
        handoffId,
        environmentId: input.environmentId,
        label: link.label,
        ...(input.continuationPrompt === undefined
          ? {}
          : { continuationPrompt: input.continuationPrompt }),
      };
      if (busy) {
        if (input.whenTurnEnds !== true) {
          return yield* failure(
            "invalid_request",
            "The thread is running a turn. Stop it, or let it move when the turn ends.",
          );
        }
        const pending: OrchestrationV2ThreadHandoff = { state: "pending", ...base };
        yield* setHandoff(input.threadId, current, pending, "pending");
        return pending;
      }
      yield* setHandoff(input.threadId, current, { state: "departing", ...base }, "departing");
      return (yield* depart(input.threadId, input.projectId)) ?? { state: "departing", ...base };
    });

  const cancel: ThreadHandoff["Service"]["cancel"] = (threadId) =>
    setHandoff(threadId, "pending", null, "cancel");

  /** A pending move whose turn ended departs; one a restart cut short is settled. */
  const settle = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const records = yield* threads.getThreadRecords(threadId, ["runs", "messages"], {
        messageRoles: ["user"],
      });
      const handoff = records.thread.handoff;
      if (handoff === undefined) return;
      if (handoff.state === "pending") {
        const live = records.runs.some(
          (run) =>
            run.status === "running" ||
            run.status === "starting" ||
            run.status === "waiting" ||
            run.status === "preparing",
        );
        if (live) return;
        // Someone wrote during the turn the agent asked in, steered into it or
        // queued after it: new instructions win. That is the user, or an agent
        // the user works through, such as an orchestrator.
        const asked = records.runs.at(-1)?.requestedAt;
        const writtenSince = records.messages.some(
          (message) => asked !== undefined && DateTime.isGreaterThan(message.createdAt, asked),
        );
        if (writtenSince || records.runs.some((run) => run.status === "queued")) {
          yield* setHandoff(threadId, "pending", null, "cancel-by-user");
          return;
        }
        yield* setHandoff(threadId, "pending", { ...handoff, state: "departing" }, "departing");
      }
      const now = yield* threads.getThreadRecords(threadId, []);
      if (now.thread.handoff?.state === "departing") {
        yield* depart(threadId).pipe(Effect.ignoreCause({ log: true }));
      }
    }).pipe(Effect.ignoreCause({ log: true }));

  const start_: ThreadHandoff["Service"]["start_"] = () =>
    forkParked(
      Effect.gen(function* () {
        // Moves a restart cut short, or that were waiting for a turn that ended meanwhile.
        const shells = yield* projections.getShellSnapshot().pipe(
          Effect.map((snapshot) => snapshot.threads),
          Effect.orElseSucceed(() => []),
        );
        yield* Effect.forEach(
          shells.filter(
            (shell) => shell.handoff?.state === "pending" || shell.handoff?.state === "departing",
          ),
          (shell) => settle(shell.id),
          { discard: true },
        );
        yield* threads.streamStoredEvents.pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                stored.event.payload.status,
              ),
          ),
          Stream.runForEach((stored) => settle(stored.event.threadId)),
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return ThreadHandoff.of({ options, start, cancel, start_, settle });
});

export const layer = Layer.effect(ThreadHandoff, make).pipe(Layer.provide(HandoffGit.layer));
