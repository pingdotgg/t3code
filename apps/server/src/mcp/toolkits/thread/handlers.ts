import * as NodeOS from "node:os";
import {
  CommandId,
  ThreadMetadataNotFoundError,
  ThreadMetadataReadError,
  ThreadMetadataRenameError,
  type ModelSelection,
  type ThreadMetadata,
  type ThreadMetadataField,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadTools from "./tools.ts";

const optionValue = (selection: ModelSelection | null, ...ids: ReadonlyArray<string>) =>
  ids.flatMap((id) => selection?.options?.filter((option) => option.id === id) ?? [])[0]?.value ??
  null;

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;

  const requireThread = Effect.fn("ThreadToolkit.requireThread")(function* (
    operation: "read" | "rename",
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("thread");
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(
        Effect.mapError((cause) =>
          operation === "read"
            ? new ThreadMetadataReadError({ cause })
            : new ThreadMetadataRenameError({ cause }),
        ),
      );
    if (Option.isNone(thread)) {
      return yield* new ThreadMetadataNotFoundError({ threadId: scope.threadId });
    }
    return { scope, thread: thread.value };
  });

  return ThreadTools.ThreadToolkit.of({
    get_thread_metadata: Effect.fn("ThreadToolkit.getThreadMetadata")(function* (input) {
      const { scope, thread } = yield* requireThread("read");
      const wants = (field: ThreadMetadataField) =>
        input.fields === undefined || input.fields.includes(field);
      const requested = scope.requestedModelSelection ?? null;
      const saved = thread.modelSelection;
      const selectedOption = (...ids: ReadonlyArray<string>) => ({
        saved: optionValue(saved, ...ids),
        requested: optionValue(requested, ...ids),
        providerConfirmed: null,
      });
      const project =
        wants("project") || (wants("runtime") && thread.worktreePath === null)
          ? Option.getOrNull(
              yield* snapshots
                .getProjectShellById(thread.projectId)
                .pipe(Effect.mapError((cause) => new ThreadMetadataReadError({ cause }))),
            )
          : null;
      const provider =
        wants("provider") || wants("model") || wants("daybreak")
          ? (yield* providers.getProviders).find(
              (entry) => entry.instanceId === scope.providerInstanceId,
            )
          : undefined;
      const model = requested
        ? provider?.models.find((entry) => entry.slug === requested.model)
        : undefined;
      const descriptor =
        wants("environment") || wants("host") ? yield* environment.getDescriptor : undefined;
      const programDescriptor = model?.capabilities?.optionDescriptors?.find(
        (entry) => entry.id === "cyberAccessProgram",
      );
      // Custom models and aliases are not evidence of access to a Codex program.
      const accessKnown =
        provider?.driver === "codex" &&
        provider.auth.status === "authenticated" &&
        model !== undefined &&
        !model.isCustom &&
        programDescriptor?.type === "select";
      const programs = accessKnown
        ? programDescriptor?.type === "select"
          ? programDescriptor.options
              .filter((entry) => entry.id === "daybreakBlue" || entry.id === "daybreakRed")
              .map((entry) => entry.id)
          : []
        : null;
      return {
        ...(wants("id") ? { id: thread.id } : {}),
        ...(wants("name") ? { name: thread.title } : {}),
        ...(wants("project")
          ? {
              project: project
                ? { id: project.id, name: project.title, workspaceRoot: project.workspaceRoot }
                : null,
            }
          : {}),
        ...(wants("runtime")
          ? {
              runtime: {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                cwd: thread.worktreePath ?? project?.workspaceRoot ?? null,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                sessionStatus: thread.session?.status ?? null,
              },
            }
          : {}),
        ...(wants("provider")
          ? {
              provider: {
                instanceId: scope.providerInstanceId,
                kind: provider?.driver ?? null,
                name: provider?.displayName ?? null,
              },
            }
          : {}),
        ...(wants("model")
          ? {
              model: {
                savedSelection: saved,
                requestedSelection: requested,
                catalog: model
                  ? { slug: model.slug, name: model.name, capabilities: model.capabilities }
                  : null,
                providerConfirmed: null,
              },
            }
          : {}),
        ...(wants("serviceTier") ? { serviceTier: selectedOption("serviceTier") } : {}),
        ...(wants("reasoningEffort")
          ? { reasoningEffort: selectedOption("reasoningEffort", "effort") }
          : {}),
        ...(wants("daybreak")
          ? {
              daybreak: {
                access:
                  provider && provider.driver !== "codex"
                    ? ("unsupported" as const)
                    : programs === null
                      ? ("unknown" as const)
                      : programs.length > 0
                        ? ("available" as const)
                        : ("unavailable" as const),
                availablePrograms: programs,
                ...selectedOption("cyberAccessProgram"),
              },
            }
          : {}),
        ...(wants("host") && descriptor
          ? { host: { hostname: NodeOS.hostname(), platform: descriptor.platform } }
          : {}),
        ...(wants("environment") && descriptor
          ? {
              environment: {
                id: descriptor.environmentId,
                name: descriptor.label,
                serverVersion: descriptor.serverVersion,
              },
            }
          : {}),
      } satisfies ThreadMetadata;
    }),
    set_thread_name: Effect.fn("ThreadToolkit.setThreadName")(function* ({ name }) {
      const { thread } = yield* requireThread("rename");
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      // Even an unchanged name must invalidate pending automatic title generation.
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`server:mcp-thread-name:${uuid}`),
          threadId: thread.id,
          title: name,
        })
        .pipe(Effect.mapError((cause) => new ThreadMetadataRenameError({ cause })));
      return { id: thread.id, name };
    }),
  });
});

export const ThreadToolkitHandlersLive = ThreadTools.ThreadToolkit.toLayer(make);
