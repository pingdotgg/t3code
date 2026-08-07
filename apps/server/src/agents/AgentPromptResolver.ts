import {
  AgentProfileId,
  type AgentProfileDocument,
  type AgentProfileRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as AgentCatalog from "./AgentCatalog.ts";
import * as AgentHookRunner from "./AgentHookRunner.ts";
import { compileAgentPrompt } from "./prompt/PromptCompiler.ts";
import * as AgentRunRepository from "./run/AgentRunRepository.ts";

const COMPILED_PROMPT_MARKER = "<!-- t3-agent-prompt:v1 -->";
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
  const withoutLocation = decoded
    .replace(/:\d+(?::\d+)?$/, "")
    .replaceAll("\\", "/")
    .trim();
  if (
    withoutLocation.length === 0 ||
    withoutLocation.length > 512 ||
    withoutLocation.startsWith("/") ||
    /^[a-zA-Z]:\//.test(withoutLocation) ||
    withoutLocation.split("/").includes("..")
  ) {
    return null;
  }
  return withoutLocation;
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
  { detail: Schema.String },
) {}

export class AgentPromptResolver extends Context.Service<
  AgentPromptResolver,
  {
    readonly resolve: (input: {
      readonly profileRef: AgentProfileRef | null;
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

  const loadProfile = Effect.fn("AgentPromptResolver.loadProfile")(function* (
    ref: AgentProfileRef,
    workspaceRoot: string,
  ) {
    const snapshot = yield* runs
      .getProfileSnapshot(ref.revision)
      .pipe(Effect.mapError((error) => new AgentPromptResolutionError({ detail: error.message })));
    if (Option.isSome(snapshot)) return snapshot.value;

    const profile = yield* catalog
      .getProfile({ ref, workspaceRoot })
      .pipe(Effect.mapError((error) => new AgentPromptResolutionError({ detail: error.message })));
    if (profile.revision !== ref.revision) {
      return yield* new AgentPromptResolutionError({
        detail: `Agent profile '${ref.scope}/${ref.id}' changed after revision ${ref.revision} was selected. Select the updated profile to continue.`,
      });
    }
    yield* runs
      .putProfileSnapshot(profile)
      .pipe(Effect.mapError((error) => new AgentPromptResolutionError({ detail: error.message })));
    return profile;
  });

  const resolve: AgentPromptResolver["Service"]["resolve"] = Effect.fn(
    "AgentPromptResolver.resolve",
  )(function* (input) {
    if (input.profileRef === null) return { message: input.message, profile: null };
    const profile = yield* loadProfile(input.profileRef, input.workspaceRoot);
    if (input.message.includes(COMPILED_PROMPT_MARKER)) {
      return { message: input.message, profile };
    }
    const hookResult = yield* hooks
      .run({ profile, stage: "promptBuild", workspaceRoot: input.workspaceRoot })
      .pipe(Effect.mapError((error) => new AgentPromptResolutionError({ detail: error.detail })));
    const snapshot = yield* catalog.list({ workspaceRoot: input.workspaceRoot });
    const rules = yield* Effect.forEach(snapshot.rules, (summary) =>
      catalog
        .getRule({
          ref: { id: AgentProfileId.make(summary.id), scope: summary.scope },
          workspaceRoot: input.workspaceRoot,
        })
        .pipe(Effect.result),
    ).pipe(
      Effect.map((results) =>
        results.flatMap((result) => (Result.isSuccess(result) ? [result.success] : [])),
      ),
    );
    const contextFiles = extractAgentContextFiles(input.message);
    const message = compileAgentPrompt({
      profile,
      cleanTask: input.message,
      rules,
      contextFiles,
      files: contextFiles,
      hookContext: hookResult.context,
      toolNames: profile.tools.allowed,
    }).portablePrompt.text;
    return { message, profile };
  });

  return AgentPromptResolver.of({ resolve });
});

export const layer = Layer.effect(AgentPromptResolver, make);
