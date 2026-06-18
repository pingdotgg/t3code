import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type ProjectScript,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { randomBytes, randomUUID } from "node:crypto";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { normalizeUploadChatAttachments } from "../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ExternalIntegrationRepository } from "../persistence/Services/ExternalIntegrations.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  defaultBaseRefForProfile,
  defaultIntakeProfile,
  type IntakeProjectProfile,
  loadIntakeProfiles,
  profileRoutingAliases,
  setupScriptToProjectScript,
} from "./profiles.ts";
import {
  applyTeamAppMuteCommand,
  mentionsNonTeamAppSlackUser,
  mentionsTeamAppUser,
  shouldIgnoreTeamAppMessage,
  teamAppMuteCommandReaction,
} from "./teamAppMessages.ts";
import {
  buildDefaultSupportEmailTriagePrompt,
  supportEmailContextFromEnv,
} from "./supportEmail.ts";
import { buildSlackUserInputAnswers, derivePendingExternalUserInputs } from "./userInputSlack.ts";

type ResolvedProject = Pick<
  OrchestrationProject | OrchestrationProjectShell,
  "id" | "defaultModelSelection" | "scripts"
>;

export interface ExternalSlackNotificationLink {
  readonly externalThreadId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly primaryExternalMessageId: string;
  readonly url?: string | undefined;
}

export interface ExternalIntakeMessage {
  readonly source: "slack" | "support_email";
  readonly externalThreadId: string;
  readonly externalMessageId: string;
  readonly text: string;
  readonly title: string;
  readonly attachments?: readonly UploadChatAttachment[] | undefined;
  readonly url?: string | undefined;
  readonly receivedAt: string;
  readonly initialPromptContext?: string | undefined;
  readonly profile?: IntakeProjectProfile | undefined;
  readonly projectHintText?: string | undefined;
  readonly slack?:
    | {
        readonly rawText?: string | undefined;
        readonly isMention?: boolean | undefined;
        readonly botUserId?: string | undefined;
        readonly botUserName?: string | undefined;
      }
    | undefined;
  readonly notificationSlackLink?: ExternalSlackNotificationLink | undefined;
}

export type ExternalIntakeResult =
  | {
      readonly status: "ignored";
      readonly reason: string;
      readonly reaction?: string | undefined;
    }
  | {
      readonly status: "continued";
      readonly t3ThreadId: ThreadId;
      readonly acceptedAt: string;
    }
  | {
      readonly status: "created";
      readonly projectId: ProjectId;
      readonly t3ThreadId: ThreadId;
      readonly branch: string;
      readonly worktreePath: string;
      readonly acceptedAt: string;
      readonly projectReaction?: string | undefined;
      readonly environmentId?: string | undefined;
    };

export interface ExternalIntakeShape {
  readonly handleMessage: (
    input: ExternalIntakeMessage,
  ) => Effect.Effect<ExternalIntakeResult, Error>;
}

export class ExternalIntake extends Context.Service<ExternalIntake, ExternalIntakeShape>()(
  "t3/externalIntake/ExternalIntake",
) {}

function claudeModelSelection(input: {
  readonly model: "claude-opus-4-8" | "claude-fable-5";
  readonly effort: "high" | "xhigh" | "ultracode";
}): ModelSelection {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: input.model,
    options: [{ id: "effort", value: input.effort }],
  };
}

function codexModelSelection(input: {
  readonly reasoningEffort: "medium" | "high";
  readonly serviceTier: "default" | "priority";
}): ModelSelection {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
    options: [
      { id: "reasoningEffort", value: input.reasoningEffort },
      { id: "serviceTier", value: input.serviceTier },
    ],
  };
}

const INTAKE_MODEL_SELECTION_BY_TAG = {
  "codex-fast": codexModelSelection({ reasoningEffort: "medium", serviceTier: "priority" }),
  codex: codexModelSelection({ reasoningEffort: "medium", serviceTier: "default" }),
  "codex-high-fast": codexModelSelection({ reasoningEffort: "high", serviceTier: "priority" }),
  "codex-high": codexModelSelection({ reasoningEffort: "high", serviceTier: "default" }),
  claude: claudeModelSelection({ model: "claude-opus-4-8", effort: "xhigh" }),
  "claude-opus": claudeModelSelection({ model: "claude-opus-4-8", effort: "xhigh" }),
  "claude-opus-high": claudeModelSelection({ model: "claude-opus-4-8", effort: "high" }),
  "claude-opus-ultracode": claudeModelSelection({
    model: "claude-opus-4-8",
    effort: "ultracode",
  }),
  "claude-fable": claudeModelSelection({ model: "claude-fable-5", effort: "high" }),
  "claude-fable-xhigh": claudeModelSelection({ model: "claude-fable-5", effort: "xhigh" }),
  "claude-fable-ultracode": claudeModelSelection({
    model: "claude-fable-5",
    effort: "ultracode",
  }),
} as const satisfies Record<string, ModelSelection>;

const INTAKE_MODEL_ROUTING_TAGS = Object.keys(INTAKE_MODEL_SELECTION_BY_TAG).sort(
  (left, right) => right.length - left.length,
);

const INTAKE_MODEL_ROUTING_TAG_PATTERN = new RegExp(
  `\\[(${INTAKE_MODEL_ROUTING_TAGS.map(escapeRegExp).join("|")})\\]`,
  "gi",
);

const INTAKE_MODEL_ROUTING_PREFIX_PATTERN = new RegExp(
  `^\\s*(${INTAKE_MODEL_ROUTING_TAGS.map(escapeRegExp).join("|")})\\s*:`,
  "i",
);

function isIntakeModelRoutingTag(
  value: string | undefined,
): value is keyof typeof INTAKE_MODEL_SELECTION_BY_TAG {
  return value !== undefined && value in INTAKE_MODEL_SELECTION_BY_TAG;
}

const DEFAULT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-8",
  options: [
    { id: "effort", value: "xhigh" },
    { id: "contextWindow", value: "1m" },
  ],
} as const satisfies ModelSelection;

/**
 * Inline routing tags an intake requester can drop into their message to force
 * the model the new thread runs on:
 *   - `codex-fast:` / `[codex-fast]`           → GPT-5.5, medium reasoning, fast service tier
 *   - `codex:` / `[codex]`                     → GPT-5.5, medium reasoning, standard service tier
 *   - `codex-high-fast:` / `[codex-high-fast]` → GPT-5.5, high reasoning, fast service tier
 *   - `codex-high:` / `[codex-high]`           → GPT-5.5, high reasoning, standard service tier
 *   - `claude:` / `[claude]`                   → Claude Opus 4.8, xhigh effort
 *   - `claude-opus-high:`                      → Claude Opus 4.8, high effort
 *   - `claude-opus-ultracode:`                 → Claude Opus 4.8, ultracode effort
 *   - `claude-fable:`                          → Claude Fable 5, high effort
 *   - `claude-fable-xhigh:`                    → Claude Fable 5, xhigh effort
 *   - `claude-fable-ultracode:`                → Claude Fable 5, ultracode effort
 *
 * Bracketed tags can appear anywhere. Prefix tags must be the leading content
 * in the message.
 *
 * Returns `undefined` when no tag is present so callers fall back to the
 * profile/project default selection. When multiple tags appear, the one that
 * appears first in the message wins.
 */
export function modelSelectionFromIntakeTags(text: string): ModelSelection | undefined {
  INTAKE_MODEL_ROUTING_TAG_PATTERN.lastIndex = 0;
  const prefixMatch = INTAKE_MODEL_ROUTING_PREFIX_PATTERN.exec(text);
  const bracketMatch = INTAKE_MODEL_ROUTING_TAG_PATTERN.exec(text);
  const tag =
    prefixMatch &&
    (!bracketMatch || prefixMatch.index + prefixMatch[0].search(/\S/) <= bracketMatch.index)
      ? prefixMatch[1]?.toLowerCase()
      : bracketMatch?.[1]?.toLowerCase();
  return isIntakeModelRoutingTag(tag) ? INTAKE_MODEL_SELECTION_BY_TAG[tag] : undefined;
}

const EXTERNAL_INTAKE_AGENT_PROMPT = [
  "System context and operating rules:",
  "You are the coding agent behind an internal task intake agent that lets team members request product and code work from Slack and other intake sources. The requester will only see selected relayed responses, so keep responses clear, concrete, and include important URLs when they become available.",
  "",
  "Operational rules:",
  "- Before making code changes or running project commands in a task worktree, first make sure your worktree has the latest commits from origin/dev and then run the worktree setup script from the worktree root when it exists. Prefer `bash scripts/worktree-setup.sh`; if that file is not present, use `bash .t3code/worktree-setup.sh`. If the setup script fails, inspect the script, perform its setup steps manually from the worktree root, report the workaround you used, and continue with the task once the equivalent setup is complete.",
  "- For data questions, use production data when available: PlanetScale MCP for SQL-backed data and Convex prod for Convex-backed data. Start read-only; ask before writes or destructive operations.",
  "- PostHog CLI is available as `posthog-cli`.",
  "- If you make code changes, commit them and push the branch before finishing.",
  "- As soon as there are code changes, create or update a GitHub pull request targeting `dev`.",
  "- When you first create the pull request, include the PR URL and the relevant Vercel preview deployment URL in that response.",
  "- If you cannot commit, push, create the PR, or find the preview URL, say exactly why in the response where that failure occurs.",
].join("\n");

const DEFAULT_SUPPORT_EMAIL_AGENT_PROMPT = [
  "- This task was started from a support email intake.",
  "- The user request below contains the received email content, including headers, body, and attachment links.",
  "- Use the received email content as the source message for this task.",
].join("\n");

function currentIsoTimestamp() {
  return DateTime.formatIso(DateTime.toUtc(DateTime.nowUnsafe()));
}

function envValue(name: string) {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function defaultModelSelectionFromEnv(): ModelSelection | undefined {
  const instanceId = envValue("T3_DEFAULT_PROVIDER_INSTANCE_ID");
  const model = envValue("T3_DEFAULT_MODEL");
  if (instanceId === undefined || model === undefined) return undefined;
  return { instanceId: ProviderInstanceId.make(instanceId), model };
}

function projectTitleFromWorkspace(workspaceRoot: string) {
  const segments = workspaceRoot.split(/[/\\]/).filter(Boolean);
  return segments.at(-1) ?? "Project";
}

function resolvedProfileProject(
  profile: IntakeProjectProfile,
  existing: Option.Option<ResolvedProject>,
) {
  return {
    profile,
    existing,
    workspaceRoot: profile.workspaceRoot,
    title: profile.title ?? projectTitleFromWorkspace(profile.workspaceRoot),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMentionsAlias(text: string, alias: string) {
  const normalized = alias.trim().toLowerCase();
  if (!normalized) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`, "i").test(text);
}

function projectChoiceLabel(profile: IntakeProjectProfile) {
  return profile.title ?? profile.id;
}

function projectResolutionErrorMessage(input: {
  readonly profiles: readonly IntakeProjectProfile[];
  readonly projects: readonly OrchestrationProjectShell[];
}) {
  if (input.projects.length === 0 && input.profiles.length === 0) {
    return "No T3 projects are configured yet.";
  }

  const choices = [
    ...input.profiles.map(projectChoiceLabel),
    ...input.projects.map((project) => project.title),
  ];
  const uniqueChoices = [...new Set(choices)].filter(Boolean);
  const suffix =
    uniqueChoices.length > 0 ? ` Available projects: ${uniqueChoices.slice(0, 8).join(", ")}.` : "";
  return `Could not resolve a project from the request. Mention a configured project name or set T3_INTAKE_DEFAULT_PROFILE_ID.${suffix}`;
}

function scriptListWithProfileScript(
  existing: readonly ProjectScript[],
  profile: IntakeProjectProfile | null,
): ProjectScript[] {
  const setupScript = profile === null ? null : setupScriptToProjectScript(profile);
  if (setupScript === null) return [...existing];
  const index = existing.findIndex((script) => script.id === setupScript.id);
  if (index < 0) return [...existing, setupScript];
  return existing.map((script) => (script.id === setupScript.id ? setupScript : script));
}

function scriptsEqual(left: readonly ProjectScript[], right: readonly ProjectScript[]) {
  if (left.length !== right.length) return false;
  return left.every((script, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      script.id === other.id &&
      script.name === other.name &&
      script.command === other.command &&
      script.icon === other.icon &&
      script.runOnWorktreeCreate === other.runOnWorktreeCreate
    );
  });
}

function buildInitialPrompt(input: ExternalIntakeMessage) {
  const profile = input.profile;
  const supportContext = supportEmailContextFromEnv({
    ...profile?.supportEmail,
    ...(profile?.id !== undefined ? { repoName: profile.id } : {}),
  });
  const supportPrompt =
    profile?.supportEmail?.triagePrompt ??
    envValue("SUPPORT_EMAIL_TRIAGE_PROMPT") ??
    buildDefaultSupportEmailTriagePrompt(supportContext);
  const supportAgentPrompt =
    profile?.supportEmail?.agentPrompt ?? envValue("SUPPORT_EMAIL_AGENT_PROMPT");

  if (input.source === "support_email") {
    return buildExternalIntakeInitialPrompt(input, {
      agentPrompt: supportAgentPrompt ?? DEFAULT_SUPPORT_EMAIL_AGENT_PROMPT,
      triagePrompt: supportPrompt,
    });
  }

  return buildExternalIntakeInitialPrompt(
    input,
    input.initialPromptContext !== undefined ? { agentPrompt: input.initialPromptContext } : {},
  );
}

function buildExternalIntakeInitialPrompt(
  input: ExternalIntakeMessage,
  options: {
    readonly agentPrompt?: string | undefined;
    readonly triagePrompt?: string | undefined;
  } = {},
) {
  const relayPrompt = buildExternalIntakeRelayPrompt(input);
  const triagePrompt = options.triagePrompt?.trim();
  const sourceContext = options.agentPrompt?.trim();
  const agentPrompt = [EXTERNAL_INTAKE_AGENT_PROMPT, sourceContext]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
  const promptSections = [
    ...(triagePrompt ? [["<triage_prompt>", triagePrompt, "</triage_prompt>"].join("\n")] : []),
    ["<agent_prompt>", agentPrompt, "</agent_prompt>"].join("\n"),
  ];
  return [...promptSections, "", "User request:", relayPrompt].join("\n");
}

function buildExternalIntakeRelayPrompt(input: ExternalIntakeMessage) {
  const text = input.text.trim();
  if (text.length > 0) return text;

  const nativeImageCount =
    input.attachments?.filter((attachment) => attachment.type === "image").length ?? 0;
  return nativeImageCount > 0 ? "(image attachment)" : "(empty message body)";
}

function buildFollowUpPrompt(input: ExternalIntakeMessage) {
  return buildExternalIntakeRelayPrompt(input);
}

function mapUnknownToError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause));
}

const makeExternalIntake = Effect.gen(function* () {
  const repository = yield* ExternalIntegrationRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const git = yield* GitVcsDriver;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const serverEnvironment = yield* ServerEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  const profiles = loadIntakeProfiles();
  const normalizeMessageAttachments = (input: {
    readonly threadId: ThreadId | string;
    readonly attachments: readonly UploadChatAttachment[];
  }) =>
    normalizeUploadChatAttachments(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
    );

  const resolveProject = (input: ExternalIntakeMessage) =>
    Effect.gen(function* () {
      if (input.profile !== undefined) {
        const existing = yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
          input.profile.workspaceRoot,
        );
        return resolvedProfileProject(input.profile, existing);
      }

      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const hintText = `${input.projectHintText ?? ""}\n${input.text}`.toLowerCase();
      const profile = profiles.find((candidate) =>
        profileRoutingAliases(candidate).some((alias) => textMentionsAlias(hintText, alias)),
      );
      if (profile !== undefined) {
        const existing = yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
          profile.workspaceRoot,
        );
        return resolvedProfileProject(profile, existing);
      }

      const mentionedProject = snapshot.projects.find((project) => {
        const aliases = [
          project.title,
          project.repositoryIdentity?.displayName,
          project.repositoryIdentity?.name,
          project.repositoryIdentity?.locator.remoteName,
        ].flatMap((alias) => (alias ? [alias] : []));
        return aliases.some((alias) => textMentionsAlias(hintText, alias));
      });
      if (mentionedProject !== undefined) {
        return {
          profile: null,
          existing: Option.some(mentionedProject),
          workspaceRoot: mentionedProject.workspaceRoot,
          title: mentionedProject.title,
        };
      }

      const fallbackProfile = defaultIntakeProfile(profiles);
      if (fallbackProfile !== undefined) {
        const existing = yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(
          fallbackProfile.workspaceRoot,
        );
        return resolvedProfileProject(fallbackProfile, existing);
      }

      if (snapshot.projects.length === 1) {
        const onlyProject = snapshot.projects[0]!;
        return {
          profile: null,
          existing: Option.some(onlyProject),
          workspaceRoot: onlyProject.workspaceRoot,
          title: onlyProject.title,
        };
      }

      throw new Error(
        projectResolutionErrorMessage({
          profiles,
          projects: snapshot.projects,
        }),
      );
    });

  const ensureProject = (input: {
    readonly profile: IntakeProjectProfile | null;
    readonly existing: Option.Option<ResolvedProject>;
    readonly workspaceRoot: string;
    readonly title: string;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      const modelSelection =
        input.profile?.modelSelection ??
        (Option.isSome(input.existing) ? input.existing.value.defaultModelSelection : null) ??
        defaultModelSelectionFromEnv() ??
        DEFAULT_MODEL_SELECTION;

      const projectId = Option.isSome(input.existing)
        ? input.existing.value.id
        : ProjectId.make(randomUUID());

      if (Option.isNone(input.existing)) {
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`external-intake:project:create:${projectId}`),
          projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: modelSelection,
          createdAt: input.now,
        });
      }

      const projectShell = Option.isSome(input.existing)
        ? input.existing.value
        : yield* projectionSnapshotQuery
            .getProjectShellById(projectId)
            .pipe(Effect.map((project) => Option.getOrUndefined(project) ?? null));
      const currentScripts = projectShell?.scripts ?? [];
      const nextScripts = scriptListWithProfileScript(currentScripts, input.profile);
      if (input.profile !== null && !scriptsEqual(currentScripts, nextScripts)) {
        yield* orchestrationEngine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(`external-intake:project:scripts:${projectId}`),
          projectId,
          scripts: nextScripts,
        });
      }

      return { projectId, modelSelection };
    });

  const continueLinkedThread = (input: {
    readonly message: ExternalIntakeMessage;
    readonly threadId: ThreadId;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      const detail = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId);
      const thread = Option.getOrNull(detail);
      const pendingUserInput =
        thread === null ? undefined : derivePendingExternalUserInputs(thread.activities)[0];
      if (pendingUserInput !== undefined) {
        const answers = buildSlackUserInputAnswers(pendingUserInput.questions, input.message.text);
        if (answers !== null) {
          yield* orchestrationEngine.dispatch({
            type: "thread.user-input.respond",
            commandId: CommandId.make(
              `external-intake:user-input:respond:${input.message.externalMessageId}`,
            ),
            threadId: input.threadId,
            requestId: ApprovalRequestId.make(String(pendingUserInput.requestId)),
            answers,
            createdAt: input.now,
          });
          return {
            status: "continued" as const,
            t3ThreadId: input.threadId,
            acceptedAt: input.now,
          };
        }
      }

      const messageNonce = randomUUID();
      const attachments = yield* normalizeMessageAttachments({
        threadId: input.threadId,
        attachments: [...(input.message.attachments ?? [])],
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(
          `external-intake:thread:continue:${input.message.externalMessageId}:${messageNonce}`,
        ),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(`external:${input.message.externalMessageId}:${messageNonce}`),
          role: "user",
          text: buildFollowUpPrompt(input.message),
          attachments,
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: input.now,
      });
      return {
        status: "continued" as const,
        t3ThreadId: input.threadId,
        acceptedAt: input.now,
      };
    });

  const createLinkedThread = (message: ExternalIntakeMessage, now: string) =>
    Effect.gen(function* () {
      const resolvedProject = yield* resolveProject(message);
      const { projectId, modelSelection: projectModelSelection } = yield* ensureProject({
        ...resolvedProject,
        now,
      });
      // An inline [codex]/[claude] tag in the requester's message overrides the
      // project/profile default for this thread.
      const modelSelection = modelSelectionFromIntakeTags(message.text) ?? projectModelSelection;
      const baseRef = defaultBaseRefForProfile(resolvedProject.profile);
      const branch = buildTemporaryWorktreeBranchName((byteLength) =>
        randomBytes(byteLength).toString("hex"),
      );
      const worktree = yield* git.createWorktree({
        cwd: resolvedProject.workspaceRoot,
        refName: baseRef,
        newRefName: branch,
        path: null,
        refreshBaseFromOrigin: true,
      });
      const threadId = ThreadId.make(randomUUID());
      const attachments = yield* normalizeMessageAttachments({
        threadId,
        attachments: [...(message.attachments ?? [])],
      });

      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`external-intake:thread:create:${message.externalMessageId}`),
        threadId,
        projectId,
        title: message.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: worktree.worktree.refName,
        worktreePath: worktree.worktree.path,
        createdAt: now,
      });

      yield* projectSetupScriptRunner
        .runForThread({
          threadId,
          projectId,
          projectCwd: resolvedProject.workspaceRoot,
          worktreePath: worktree.worktree.path,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("external intake failed to launch setup script", {
              source: message.source,
              externalThreadId: message.externalThreadId,
              threadId: String(threadId),
              projectId: String(projectId),
              message: error.message,
            }),
          ),
        );

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`external-intake:turn:start:${message.externalMessageId}`),
        threadId,
        message: {
          messageId: MessageId.make(`external:${message.externalMessageId}`),
          role: "user",
          text: buildInitialPrompt(message),
          attachments,
        },
        modelSelection,
        titleSeed: message.title,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      });

      yield* repository.upsertThreadLink({
        source: message.source,
        externalThreadId: message.externalThreadId,
        t3ThreadId: threadId,
        projectId,
        primaryExternalMessageId: message.externalMessageId,
        url: message.url ?? null,
        muted: false,
        metadata: {
          title: message.title,
          profileId: resolvedProject.profile?.id,
        },
        createdAt: now,
        updatedAt: now,
      });

      if (message.notificationSlackLink !== undefined) {
        yield* repository.upsertThreadLink({
          source: "slack",
          externalThreadId: message.notificationSlackLink.externalThreadId,
          t3ThreadId: threadId,
          projectId,
          primaryExternalMessageId: message.notificationSlackLink.primaryExternalMessageId,
          url: message.notificationSlackLink.url ?? null,
          muted: false,
          metadata: {
            source: message.source,
            channelId: message.notificationSlackLink.channelId,
            threadTs: message.notificationSlackLink.threadTs,
          },
          createdAt: now,
          updatedAt: now,
        });
      }

      const environment = yield* serverEnvironment.getDescriptor;
      return {
        status: "created" as const,
        projectId,
        t3ThreadId: threadId,
        branch: worktree.worktree.refName,
        worktreePath: worktree.worktree.path,
        acceptedAt: now,
        projectReaction: resolvedProject.profile?.slackEmoji,
        environmentId: String(environment.environmentId),
      };
    });

  const handleSlackPolicy = (input: {
    readonly message: ExternalIntakeMessage;
    readonly existingMuted: boolean;
    readonly hasExistingLink: boolean;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      if (input.message.source !== "slack") return null;
      const body = input.message.text;
      const mentionsBot =
        mentionsTeamAppUser({
          body,
          botUserId: input.message.slack?.botUserId ?? envValue("SLACK_BOT_USER_ID"),
          botUserName: input.message.slack?.botUserName ?? envValue("SLACK_BOT_USERNAME"),
        }) ||
        input.message.slack?.isMention === true ||
        (input.message.slack?.rawText !== undefined &&
          mentionsTeamAppUser({
            body: input.message.slack.rawText,
            botUserId: input.message.slack?.botUserId ?? envValue("SLACK_BOT_USER_ID"),
            botUserName: input.message.slack?.botUserName ?? envValue("SLACK_BOT_USERNAME"),
          }));
      const muteCommand = applyTeamAppMuteCommand({
        body,
        isThreadMuted: input.existingMuted,
        mentionsAiEngineer: mentionsBot,
      });
      if (muteCommand.command !== undefined) {
        if (input.hasExistingLink && muteCommand.changed) {
          yield* repository.setThreadMuted({
            source: "slack",
            externalThreadId: input.message.externalThreadId,
            muted: muteCommand.muted,
            updatedAt: input.now,
          });
        }
        return {
          status: "ignored" as const,
          reason: `slack_thread_${muteCommand.command}`,
          reaction: teamAppMuteCommandReaction(muteCommand.command),
        };
      }

      const decision = shouldIgnoreTeamAppMessage({
        body,
        isThreadMuted: input.existingMuted,
        mentionsAiEngineer: mentionsBot,
      });
      if (decision.ignore) {
        return {
          status: "ignored" as const,
          reason: `slack_thread_${decision.reason}`,
        };
      }

      if (
        mentionsNonTeamAppSlackUser({
          body,
          botUserId: input.message.slack?.botUserId ?? envValue("SLACK_BOT_USER_ID"),
        }) ||
        (input.message.slack?.rawText !== undefined &&
          mentionsNonTeamAppSlackUser({
            body: input.message.slack.rawText,
            botUserId: input.message.slack?.botUserId ?? envValue("SLACK_BOT_USER_ID"),
          }))
      ) {
        return {
          status: "ignored" as const,
          reason: "slack_thread_other_user_mention",
        };
      }

      if (!input.hasExistingLink && !mentionsBot) {
        return {
          status: "ignored" as const,
          reason: "slack_ambient_without_thread",
        };
      }

      return null;
    });

  const handleMessage: ExternalIntakeShape["handleMessage"] = (message) =>
    Effect.gen(function* () {
      const now = currentIsoTimestamp();
      const existing = yield* repository.getThreadLink({
        source: message.source,
        externalThreadId: message.externalThreadId,
      });
      const policyDecision = yield* handleSlackPolicy({
        message,
        existingMuted: Option.isSome(existing) ? existing.value.muted : false,
        hasExistingLink: Option.isSome(existing),
        now,
      });
      if (policyDecision !== null) {
        return policyDecision;
      }

      if (Option.isSome(existing)) {
        return yield* continueLinkedThread({
          message,
          threadId: existing.value.t3ThreadId,
          now,
        });
      }

      return yield* createLinkedThread(message, now);
    }).pipe(Effect.mapError(mapUnknownToError));

  return { handleMessage } satisfies ExternalIntakeShape;
});

export const ExternalIntakeLive = Layer.effect(ExternalIntake, makeExternalIntake);
