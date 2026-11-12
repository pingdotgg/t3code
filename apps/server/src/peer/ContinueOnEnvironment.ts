import {
  type EnvironmentId,
  ModelSelection,
  type OrchestratorMcpFailure,
  type ProjectId,
  type ThreadContinueOnEnvironmentInput,
  type ThreadContinueOnEnvironmentResult,
  type ThreadId,
  WorkFilesReceiveResult,
  WorkFilesTransferError,
  type WorkFilesSummary,
} from "@t3tools/contracts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  historicalMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { WorkFilesReceiveTool } from "../mcp/toolkits/workFiles/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import { findRemoteProject, RemoteCapabilitiesTool } from "./RemoteDelegation.ts";
import * as WorkFilesTransfer from "./WorkFilesTransfer.ts";

/**
 * Continues a thread's work on a linked environment for the user: the
 * thread's files go to the same repository's checkout there if asked, and a
 * new thread there starts from a handoff of this one's conversation. This
 * thread stays as it is.
 */
export class ContinueOnEnvironment extends Context.Service<
  ContinueOnEnvironment,
  {
    /** What the thread's working directory would carry. */
    readonly summarize: (
      threadId: ThreadId,
    ) => Effect.Effect<WorkFilesSummary, WorkFilesTransferError>;
    readonly continueThread: (
      input: ThreadContinueOnEnvironmentInput,
    ) => Effect.Effect<ThreadContinueOnEnvironmentResult, WorkFilesTransferError>;
  }
>()("t3/peer/ContinueOnEnvironment") {}

const refused = (message: string) => new WorkFilesTransferError({ message });

const LaunchResult = ProjectToolkit.tools.t3_thread_launch.successSchema;
const ProjectListResult = ProjectToolkit.tools.t3_project_list.successSchema;
const CapabilitiesResult = RemoteCapabilitiesTool.successSchema;
const encodeModelSelection = Schema.encodeSync(ModelSelection);
const encodeReceiveInput = Schema.encodeSync(WorkFilesReceiveTool.parametersSchema);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const transfer = yield* WorkFilesTransfer.WorkFilesTransfer;
  const random = yield* SecureRandom.SecureRandom;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const loadThread = Effect.fn("ContinueOnEnvironment.loadThread")(function* (threadId: ThreadId) {
    const records = yield* threads
      .getThreadRecords(threadId, ["turnItems", "runs"])
      .pipe(Effect.mapError(() => refused("This thread was not found.")));
    const project = yield* projects.getById(records.thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    const cwd = records.thread.worktreePath ?? project?.workspaceRoot;
    if (cwd === undefined) return yield* refused("This thread has no working directory.");
    return { records, project, cwd };
  });

  const summarize: ContinueOnEnvironment["Service"]["summarize"] = Effect.fn(
    "ContinueOnEnvironment.summarize",
  )(function* (threadId) {
    const { cwd } = yield* loadThread(threadId);
    const selection = yield* transfer
      .select(cwd)
      .pipe(Effect.mapError((error) => refused(error.message)));
    return WorkFilesTransfer.summaryOf(selection);
  });

  const continueThread: ContinueOnEnvironment["Service"]["continueThread"] = Effect.fn(
    "ContinueOnEnvironment.continueThread",
  )(function* (input) {
    if (!(yield* links.enabled)) {
      return yield* refused("Linked environments is off here. Turn it on in Settings → Labs.");
    }
    const link = yield* links.get(input.environmentId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (link === undefined) return yield* refused("This environment is not linked to that one.");
    const { records, project, cwd } = yield* loadThread(input.threadId);
    const { thread } = records;
    const here = yield* environment.getDescriptor;
    // Calls there carry this thread's modes and name it, as its own agent's calls would.
    const call = <S extends Schema.Decoder<unknown>>(
      tool: string,
      args: Record<string, unknown>,
      success: S,
    ) =>
      peers.call({
        environmentId: input.environmentId,
        tool,
        arguments: args,
        limits: { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode },
        sender: { environmentId: here.environmentId, threadId: thread.id, title: thread.title },
        success,
      });
    const there = (error: OrchestratorMcpFailure) => refused(`${link.label}: ${error.message}`);

    const key =
      project === undefined
        ? undefined
        : (yield* repositoryIdentities.resolve(project.workspaceRoot))?.canonicalKey;
    if (key === undefined) {
      return yield* refused(
        "This thread's project has no git remote, so no project there can be matched to it.",
      );
    }
    const projectId: ProjectId = yield* findRemoteProject(
      key,
      (cursor) =>
        call("t3_project_list", { cursor, limit: 100 }, ProjectListResult) as Effect.Effect<
          Tool.Success<typeof ProjectToolkit.tools.t3_project_list>,
          OrchestratorMcpFailure
        >,
    ).pipe(
      Effect.mapError((error) =>
        error.code === "invalid_request"
          ? refused(
              `No single project on ${link.label} has this repository (${key}). Add it there, then try again.`,
            )
          : there(error),
      ),
    );

    const transferred =
      input.workFiles === "transfer"
        ? yield* transfer
            .send({
              cwd,
              environmentId: input.environmentId,
              projectId,
              receive: (request) =>
                call(
                  WorkFilesReceiveTool.name,
                  encodeReceiveInput(request) as Record<string, unknown>,
                  WorkFilesReceiveResult,
                ),
            })
            .pipe(Effect.mapError(there))
        : { files: 0, deletions: 0 };

    // The same instance there keeps the thread's model; otherwise the project there picks one.
    const capabilities = yield* call("orchestrator_capabilities", {}, CapabilitiesResult).pipe(
      Effect.mapError(there),
    );
    const sameInstance = capabilities.providers.some(
      (provider) => provider.providerInstanceId === thread.modelSelection.instanceId,
    );

    const filesLine =
      input.workFiles === "transfer"
        ? `Its working files were copied into this checkout (${transferred.files} files written, ${transferred.deletions} deleted).`
        : "Its working files were not copied; this checkout has only what is committed.";
    const selected = selectHistory({
      messages: records.turnItems.flatMap((item) => {
        const message = historicalMessage(item);
        return message === null ? [] : [message];
      }),
      coverage: [
        `This thread continues thread "${thread.title}" (${thread.id}) from ${here.label} (environment ${here.environmentId}), moved here by the user.`,
        filesLine,
      ].join("\n"),
      budget: DEFAULT_HANDOFF_TOKEN_CAP,
    });
    const message = `${renderHistory(selected.messages, selected.context)}\n\nContinue the work from where it stopped.`;

    const launched = yield* call(
      "t3_thread_launch",
      {
        projectId,
        title: thread.title,
        ...(sameInstance ? { modelSelection: encodeModelSelection(thread.modelSelection) } : {}),
        message,
        clientRequestId: `continue:${thread.id}:${yield* random.uuidV4()}`,
      },
      LaunchResult,
    ).pipe(Effect.mapError(there));
    return {
      environmentId: input.environmentId as EnvironmentId,
      threadId: launched.threadId,
      projectId: launched.projectId,
      label: link.label,
      transferredFiles: transferred.files,
    };
  });

  return ContinueOnEnvironment.of({ summarize, continueThread });
});

export const layer = Layer.effect(ContinueOnEnvironment, make);
