import {
  AgentProfileId,
  AgentProfileRevision,
  type CommandId,
  type AgentProfileDocument,
  type AgentProfileRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AgentCatalog from "./AgentCatalog.ts";
import * as AgentHookRunner from "./AgentHookRunner.ts";
import { compileAgentPrompt } from "./prompt/PromptCompiler.ts";
import { normalizeWorkspaceRelativePath } from "./prompt/RuleMatcher.ts";
import * as AgentRunRepository from "./run/AgentRunRepository.ts";

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const ELEMENT_SOURCE = /^\s*source:\s+(.+?)(?::\d+(?::\d+)?)?\s*$/gm;
const MAX_CONTEXT_FILES = 100;

const normalizeCandidate = (candidate: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURI(candidate);
  } catch {
    decoded = candidate;
  }
  const withoutLocation = decoded.replace(/:\d+(?::\d+)?$/, "").trim();
  if (withoutLocation.length > 512) {
    return null;
  }
  try {
    return normalizeWorkspaceRelativePath(withoutLocation);
  } catch {
    return null;
  }
};

/** Extracts only explicit workspace-relative file references from the user turn. */
export function extractAgentContextFiles(message: string): ReadonlyArray<string> {
  const files = new Set<string>();
  const collect = (candidate: string) => {
    const normalized = normalizeCandidate(candidate);
    if (normalized !== null && files.size < MAX_CONTEXT_FILES) files.add(normalized);
  };
  for (const match of message.matchAll(MARKDOWN_LINK)) {
    if (match[1]) collect(match[1]);
  }
  for (const match of message.matchAll(ELEMENT_SOURCE)) {
    if (match[1]) collect(match[1]);
  }
  return [...files];
}

export class AgentPromptResolutionError extends Schema.TaggedErrorClass<AgentPromptResolutionError>()(
  "AgentPromptResolutionError",
  {
    stage: Schema.Literals([
      "profile-snapshot",
      "profile-catalog",
      "profile-revision",
      "profile-persist",
      "prompt-hook",
      "catalog",
      "rule",
      "compile",
      "agent-run",
    ]),
    detail: Schema.String,
    profileScope: Schema.optional(Schema.Literals(["environment", "project"])),
    profileId: Schema.optional(Schema.String),
    profileRevision: Schema.optional(AgentProfileRevision),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Agent prompt resolution failed during ${this.stage}: ${this.detail}`;
  }
}

const resolutionError = (
  stage: AgentPromptResolutionError["stage"],
  detail: string,
  cause: unknown | undefined,
  profile?: Pick<AgentProfileRef, "scope" | "id" | "revision">,
) =>
  new AgentPromptResolutionError({
    stage,
    detail: detail.slice(0, 4_000),
    ...(profile === undefined
      ? {}
      : {
          profileScope: profile.scope,
          profileId: String(profile.id),
          profileRevision: profile.revision,
        }),
    ...(cause === undefined ? {} : { cause }),
  });

export class AgentPromptResolver extends Context.Service<
  AgentPromptResolver,
  {
    readonly loadProfile: (input: {
      readonly profileRef: AgentProfileRef;
      readonly workspaceRoot: string;
    }) => Effect.Effect<AgentProfileDocument, AgentPromptResolutionError>;
    readonly resolve: (input: {
      readonly profileRef: AgentProfileRef | null;
      readonly threadId: ThreadId;
      readonly commandId: CommandId | null;
      readonly workspaceRoot: string;
      readonly message: string;
    }) => Effect.Effect<
      { readonly message: string; readonly profile: AgentProfileDocument | null },
      AgentPromptResolutionError
    >;
  }
>()("t3/agents/AgentPromptResolver") {}

export const make = Effect.gen(function* () {
  const catalog = yield* AgentCatalog.AgentCatalog;
  const hooks = yield* AgentHookRunner.AgentHookRunner;
  const runs = yield* AgentRunRepository.AgentRunRepository;

  const loadProfileDocument = Effect.fn("AgentPromptResolver.loadProfileDocument")(function* (
    ref: AgentProfileRef,
    workspaceRoot: string,
  ) {
    const snapshot = yield* runs
      .getProfileSnapshot(ref.revision)
      .pipe(
        Effect.mapError((error) => resolutionError("profile-snapshot", error.message, error, ref)),
      );
    if (Option.isSome(snapshot)) {
      const cached = snapshot.value;
      if (cached.id !== ref.id || cached.scope !== ref.scope || cached.revision !== ref.revision) {
        const detail = `Cached agent profile revision ${ref.revision} belongs to '${cached.scope}/${cached.id}', not '${ref.scope}/${ref.id}'.`;
        return yield* resolutionError("profile-snapshot", detail, undefined, ref);
      }
      return cached;
    }

    const profile = yield* catalog
      .getProfile({ ref, workspaceRoot })
      .pipe(
        Effect.mapError((error) => resolutionError("profile-catalog", error.message, error, ref)),
      );
    if (profile.revision !== ref.revision) {
      const detail = `Agent profile '${ref.scope}/${ref.id}' changed after revision ${ref.revision} was selected. Select the updated profile to continue.`;
      return yield* resolutionError("profile-revision", detail, undefined, ref);
    }
    yield* runs
      .putProfileSnapshot(profile)
      .pipe(
        Effect.mapError((error) => resolutionError("profile-persist", error.message, error, ref)),
      );
    return profile;
  });

  const loadProfile: AgentPromptResolver["Service"]["loadProfile"] = ({
    profileRef,
    workspaceRoot,
  }) => loadProfileDocument(profileRef, workspaceRoot);

  const isCompiledAgentTurn = Effect.fn("AgentPromptResolver.isCompiledAgentTurn")(
    function* (input: { readonly threadId: ThreadId; readonly commandId: CommandId | null }) {
      if (input.commandId === null) return false;
      const run = yield* runs
        .getByChildThread(input.threadId)
        .pipe(Effect.mapError((error) => resolutionError("agent-run", error.message, error)));
      return (
        Option.isSome(run) && String(input.commandId) === `agent-spawn:${String(run.value.id)}`
      );
    },
  );

  const resolve: AgentPromptResolver["Service"]["resolve"] = Effect.fn(
    "AgentPromptResolver.resolve",
  )(function* (input) {
    const profileRef = input.profileRef;
    if (profileRef === null) return { message: input.message, profile: null };
    const profile = yield* loadProfile({ profileRef, workspaceRoot: input.workspaceRoot });
    if (yield* isCompiledAgentTurn({ threadId: input.threadId, commandId: input.commandId })) {
      return { message: input.message, profile };
    }
    const hookResult = yield* hooks
      .run({ profile, stage: "promptBuild", workspaceRoot: input.workspaceRoot })
      .pipe(
        Effect.mapError((error) => resolutionError("prompt-hook", error.detail, error, profileRef)),
      );
    const snapshot = yield* catalog.list({ workspaceRoot: input.workspaceRoot });
    const rules = yield* Effect.forEach(snapshot.rules, (summary) =>
      catalog
        .getRule({
          ref: { id: AgentProfileId.make(summary.id), scope: summary.scope },
          workspaceRoot: input.workspaceRoot,
        })
        .pipe(
          Effect.mapError((error) =>
            resolutionError(
              "rule",
              `Could not load rule '${summary.scope}/${summary.id}': ${error.message}`,
              error,
              profileRef,
            ),
          ),
        ),
    );
    const contextFiles = extractAgentContextFiles(input.message);
    const message = yield* Effect.try({
      try: () =>
        compileAgentPrompt({
          profile,
          cleanTask: input.message,
          rules,
          contextFiles,
          files: contextFiles,
          hookContext: hookResult.context,
          toolNames: profile.tools.allowed,
        }).portablePrompt.text,
      catch: (error) =>
        resolutionError(
          "compile",
          error instanceof Error ? error.message : "Could not compile the agent prompt.",
          error,
          profileRef,
        ),
    });
    return { message, profile };
  });

  return AgentPromptResolver.of({ loadProfile, resolve });
});

export const layer = Layer.effect(AgentPromptResolver, make);
