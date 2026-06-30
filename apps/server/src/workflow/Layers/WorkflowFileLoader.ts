// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { ProviderInstanceId, WorkflowDefinition, WorkflowRpcError } from "@t3tools/contracts";
import { AsanaSelector, GithubSelector, JiraSelector } from "@t3tools/contracts/workSource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import {
  WorkflowFileLoader,
  WorkflowFilePort,
  WorkflowProviderInstancePort,
  type WorkflowFileLoaderShape,
  type WorkflowFilePortShape,
  type WorkflowProviderInstancePortShape,
} from "../Services/WorkflowFileLoader.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import {
  isSafeWorkflowInstructionPath,
  resolveWorkflowInstructionPath,
} from "../instructionPath.ts";
import { sha256Hex } from "../workflowVersionHash.ts";
import {
  MAX_IMPORT_DEFINITION_CHARS,
  definitionLaneCapViolation,
  exceedsDefinitionCharCap,
} from "../definitionCaps.ts";
import { lintWorkflowDefinition, type LintContext } from "../workflowFile.ts";

const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeProviderInstanceId = Schema.decodeUnknownEffect(ProviderInstanceId);

const toWorkflowRpcError = (message: string) => (cause: unknown) =>
  new WorkflowRpcError({ message, cause });

const unique = (values: ReadonlyArray<string>) => Array.from(new Set(values));

const make = Effect.gen(function* () {
  const files = yield* WorkflowFilePort;
  const providers = yield* WorkflowProviderInstancePort;
  const boardRegistry = yield* BoardRegistry;
  const readModel = yield* WorkflowReadModel;

  const lintContextForDefinition = (
    definition: WorkflowDefinition,
    workspaceRoot: string,
  ): Effect.Effect<LintContext, WorkflowRpcError> =>
    Effect.gen(function* () {
      const agentSteps = definition.lanes.flatMap((lane) =>
        (lane.pipeline ?? []).flatMap((step) => (step.type === "agent" ? [step] : [])),
      );
      const providerEntries = yield* Effect.forEach(
        unique(
          agentSteps.flatMap((step) => [
            step.agent.instance as string,
            ...(step.retry?.escalate?.instance === undefined
              ? []
              : [step.retry.escalate.instance as string]),
          ]),
        ),
        (instanceId) =>
          providers
            .providerInstanceExists(instanceId)
            .pipe(Effect.map((exists) => [instanceId, exists] as const)),
        { concurrency: "unbounded" },
      );
      // Resume support only matters for steps that opt into continueSession. A
      // retry can escalate to a different instance that still runs with
      // continueSession, so both base and escalation instances must be probed —
      // the lint in workflowFile.ts checks resume support for both.
      const resumeEntries = yield* Effect.forEach(
        unique(
          agentSteps.flatMap((step) =>
            step.continueSession === true
              ? [
                  step.agent.instance as string,
                  ...(step.retry?.escalate?.instance === undefined
                    ? []
                    : [step.retry.escalate.instance as string]),
                ]
              : [],
          ),
        ),
        (instanceId) =>
          providers
            .providerInstanceSupportsResume(instanceId)
            .pipe(Effect.map((supports) => [instanceId, supports] as const)),
        { concurrency: "unbounded" },
      );
      const instructionEntries = yield* Effect.forEach(
        unique(
          agentSteps.flatMap((step) =>
            typeof step.instruction === "object" &&
            isSafeWorkflowInstructionPath(step.instruction.file as string)
              ? [step.instruction.file as string]
              : [],
          ),
        ),
        (repoRelativePath) =>
          files
            .instructionFileExists({ repoRoot: workspaceRoot, repoRelativePath })
            .pipe(Effect.map((exists) => [repoRelativePath, exists] as const)),
        { concurrency: "unbounded" },
      );
      const providerExists = new Map(providerEntries);
      const providerResumeSupport = new Map(resumeEntries);
      const instructionExists = new Map(instructionEntries);
      const instructionContentEntries = yield* Effect.forEach(
        instructionEntries.flatMap(([repoRelativePath, exists]) =>
          exists ? [repoRelativePath] : [],
        ),
        (repoRelativePath) => {
          const instructionPath = resolveWorkflowInstructionPath(workspaceRoot, repoRelativePath);
          return instructionPath === null
            ? Effect.succeed([repoRelativePath, null] as const)
            : files.readFileString(instructionPath).pipe(
                Effect.map((content) => [repoRelativePath, content] as const),
                Effect.orElseSucceed(() => [repoRelativePath, null] as const),
              );
        },
        { concurrency: "unbounded" },
      );
      const instructionContents = new Map(instructionContentEntries);

      return {
        providerInstanceExists: (instanceId) => providerExists.get(instanceId) ?? false,
        providerInstanceSupportsResume: (instanceId) =>
          providerResumeSupport.get(instanceId) ?? false,
        instructionFileExists: (repoRelativePath) =>
          instructionExists.get(repoRelativePath) ?? false,
        readInstructionFile: (repoRelativePath) =>
          instructionContents.get(repoRelativePath) ?? null,
        selectorSchemaFor: (p) =>
          p === "github" ? GithubSelector : p === "asana" ? AsanaSelector : p === "jira" ? JiraSelector : null,
      };
    });

  const lintDefinition: WorkflowFileLoaderShape["lintDefinition"] = (input) =>
    Effect.gen(function* () {
      const lintContext = yield* lintContextForDefinition(input.definition, input.workspaceRoot);
      return lintWorkflowDefinition(input.definition, lintContext);
    });

  const loadAndRegister: WorkflowFileLoaderShape["loadAndRegister"] = (input) =>
    Effect.gen(function* () {
      const raw = yield* files.readFileString(
        NodePath.resolve(input.workspaceRoot, input.relativePath),
      );
      // DoS backstop on the raw file BEFORE decode — recovery/discovery can load
      // a hand-edited on-disk definition that never went through the import/save
      // caps; apply the SAME shared caps here so a huge file is rejected, not
      // registered. Char cap on the raw string; lane caps after decode below.
      if (exceedsDefinitionCharCap(raw.length)) {
        return yield* new WorkflowRpcError({
          message: `Workflow file too large (exceeds ${MAX_IMPORT_DEFINITION_CHARS} characters)`,
        });
      }
      const encodedDefinition = yield* decodeUnknownJsonString(raw).pipe(
        Effect.mapError(toWorkflowRpcError("workflow file decode failed")),
      );
      const definition = yield* decodeWorkflowDefinition(encodedDefinition).pipe(
        Effect.mapError(toWorkflowRpcError("workflow file decode failed")),
      );
      const laneCapViolation = definitionLaneCapViolation(definition);
      if (laneCapViolation !== null) {
        return yield* new WorkflowRpcError({ message: laneCapViolation });
      }

      if (input.lintMode !== "skip") {
        const lintErrors = yield* lintDefinition({
          definition,
          projectId: input.projectId,
          workspaceRoot: input.workspaceRoot,
        });
        if (lintErrors.length > 0) {
          return yield* new WorkflowRpcError({
            message: `Workflow lint failed: ${lintErrors.map((error) => error.code).join(", ")}`,
          });
        }
      }

      yield* boardRegistry
        .register(input.boardId, encodedDefinition)
        .pipe(Effect.mapError(toWorkflowRpcError("workflow board registration failed")));
      yield* readModel
        .registerBoard({
          boardId: input.boardId,
          projectId: input.projectId,
          name: definition.name,
          workflowFilePath: input.relativePath,
          workflowVersionHash: sha256Hex(raw),
          maxConcurrentTickets: definition.settings?.maxConcurrentTickets ?? 3,
        })
        .pipe(Effect.mapError(toWorkflowRpcError("workflow board projection registration failed")));
      return input.boardId;
    });

  return { lintDefinition, loadAndRegister } satisfies WorkflowFileLoaderShape;
});

export const WorkflowFileLoaderLive = Layer.effect(WorkflowFileLoader, make);

export const WorkflowFilePortLive = Layer.effect(
  WorkflowFilePort,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      readFileString: (filePath) =>
        fileSystem
          .readFileString(filePath)
          .pipe(Effect.mapError(toWorkflowRpcError("workflow file read failed"))),
      instructionFileExists: ({ repoRoot, repoRelativePath }) =>
        Effect.gen(function* () {
          const instructionPath = resolveWorkflowInstructionPath(repoRoot, repoRelativePath);
          if (instructionPath === null) {
            return false;
          }
          return yield* fileSystem.exists(instructionPath).pipe(
            Effect.map((exists): boolean => exists),
            Effect.orElseSucceed(() => false),
          );
        }),
    } satisfies WorkflowFilePortShape;
  }),
);

export const WorkflowProviderInstancePortLive = Layer.effect(
  WorkflowProviderInstancePort,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    return {
      providerInstanceExists: (instanceId) =>
        decodeProviderInstanceId(instanceId).pipe(
          Effect.flatMap((decoded) => registry.getInstance(decoded)),
          Effect.map((instance) => instance !== undefined),
          Effect.orElseSucceed(() => false),
        ),
      providerInstanceSupportsResume: (instanceId) =>
        decodeProviderInstanceId(instanceId).pipe(
          Effect.flatMap((decoded) => registry.getInstance(decoded)),
          Effect.map((instance) => instance?.adapter.capabilities.supportsSessionResume === true),
          Effect.orElseSucceed(() => false),
        ),
    } satisfies WorkflowProviderInstancePortShape;
  }),
);
