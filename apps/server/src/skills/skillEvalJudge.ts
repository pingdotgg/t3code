import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type ModelSelection,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  SkillEvalJudgeUnavailableError,
  type ServerProvider,
} from "@t3tools/contracts";
import type {
  SkillTrialJudgeResult,
  TrialTranscript,
} from "@t3tools/provider-core/server/textGeneration";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_FABLE_SLUG = /^(?:claude-)?fable(?:-\d+(?:[.-]\d+)*)?(?:\[\d+[km]\])?$/i;

const isSkillEvalJudgeModel = (input: {
  readonly driver: ProviderDriverKind;
  readonly model: string;
}): boolean =>
  (input.driver === CLAUDE_DRIVER && CLAUDE_FABLE_SLUG.test(input.model)) ||
  input.model === "gpt-5.6-sol";

export interface ResolvedSkillEvalJudge {
  readonly modelSelection: ModelSelection;
  readonly driver: ProviderDriverKind;
}

const availableJudgeProvider = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.auth.status !== "unauthenticated" &&
  isProviderAvailable(provider) &&
  isProviderTextGenerationCapable(provider);

const unavailable = (message: string) => new SkillEvalJudgeUnavailableError({ message });

export const resolveSkillEvalJudge = Effect.fn("SkillEvalJudge.resolve")(function* (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly explicit: ModelSelection | null;
  readonly now: number;
}) {
  if (input.explicit !== null) {
    const provider = input.providers.find(
      (candidate) => candidate.instanceId === input.explicit?.instanceId,
    );
    if (
      provider === undefined ||
      !availableJudgeProvider(provider) ||
      !provider.models.some((model) => model.slug === input.explicit?.model) ||
      exhaustedUsageWindow(provider, input.now, input.explicit.model) !== undefined
    ) {
      return yield* unavailable(
        `Judge model '${input.explicit.model}' is not available on provider instance '${input.explicit.instanceId}'. Select an available Fable model or gpt-5.6-sol.`,
      );
    }
    if (!isSkillEvalJudgeModel({ driver: provider.driver, model: input.explicit.model })) {
      return yield* unavailable(
        `Judge model '${input.explicit.model}' is not allowed. Select a Claude Fable model or the exact model slug 'gpt-5.6-sol'.`,
      );
    }
    return { modelSelection: input.explicit, driver: provider.driver };
  }

  const eligible = input.providers.flatMap((provider) =>
    availableJudgeProvider(provider)
      ? provider.models
          .filter(
            (model) =>
              isSkillEvalJudgeModel({ driver: provider.driver, model: model.slug }) &&
              exhaustedUsageWindow(provider, input.now, model.slug) === undefined,
          )
          .map((model) => ({ provider, model }))
      : [],
  );
  const selected =
    eligible.find(({ provider }) => provider.driver === CLAUDE_DRIVER) ??
    eligible.find(({ model }) => model.slug === "gpt-5.6-sol");
  if (selected !== undefined) {
    return {
      modelSelection: {
        instanceId: selected.provider.instanceId,
        model: selected.model.slug,
      },
      driver: selected.provider.driver,
    };
  }

  return yield* unavailable(
    "No eligible skill-evaluation judge is available. Connect an available Claude Fable provider or a provider exposing the exact model slug 'gpt-5.6-sol'.",
  );
});

export type SkillEvalModelFamily = "anthropic" | "openai" | "google" | "xai";

export function skillEvalModelFamily(model: string): SkillEvalModelFamily | null {
  if (/claude|fable|opus|sonnet|haiku/i.test(model)) return "anthropic";
  if (/^gpt|^o\d|codex/i.test(model)) return "openai";
  if (/gemini/i.test(model)) return "google";
  if (/grok/i.test(model)) return "xai";
  return null;
}

export const judgeSharesCandidateFamily = (input: {
  readonly judge: ModelSelection;
  readonly candidate: ModelSelection;
}): boolean => {
  const judgeFamily = skillEvalModelFamily(input.judge.model);
  return judgeFamily !== null && judgeFamily === skillEvalModelFamily(input.candidate.model);
};

export interface MappedSkillTrialJudgment {
  readonly preferred: "treatment" | "control" | "tie" | "unknown";
  readonly treatmentScore: number | null;
  readonly controlScore: number | null;
  readonly rationale: string;
}

const normalizedScore = (score: number | null): number | null =>
  score === null ? null : (score - 1) / 4;

export function mapPositionalSkillTrialJudgment(
  orderLabel: "treatment-first" | "control-first",
  judgment: SkillTrialJudgeResult,
): MappedSkillTrialJudgment {
  const treatmentIsA = orderLabel === "treatment-first";
  const preferred =
    judgment.preferred === "tie" || judgment.preferred === "unknown"
      ? judgment.preferred
      : judgment.preferred === (treatmentIsA ? "A" : "B")
        ? "treatment"
        : "control";
  return {
    preferred,
    treatmentScore: normalizedScore(treatmentIsA ? judgment.scoreA : judgment.scoreB),
    controlScore: normalizedScore(treatmentIsA ? judgment.scoreB : judgment.scoreA),
    rationale: judgment.rationale.trim().slice(0, 2_000),
  };
}

const isToolFailure = (item: OrchestrationV2TurnItem): boolean => {
  if (
    item.type !== "command_execution" &&
    item.type !== "dynamic_tool" &&
    item.type !== "file_change" &&
    item.type !== "web_search"
  ) {
    return false;
  }
  return (
    item.status === "failed" ||
    (item.type === "command_execution" &&
      (item.outputIndicatesFailure === true || (item.exitCode ?? 0) !== 0))
  );
};

export function buildSkillTrialTranscript(input: {
  readonly status: string;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): TrialTranscript {
  const finalMessage = input.turnItems
    .filter(
      (item): item is Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }> =>
        item.type === "assistant_message",
    )
    .at(-1)?.text;
  let remainingDiffChars = 12_000;
  const changedFiles = input.turnItems.flatMap((item) => {
    if (item.type !== "file_change" || item.diffStr === undefined || remainingDiffChars <= 0) {
      return [];
    }
    const diff = item.diffStr.slice(0, Math.min(4_000, remainingDiffChars));
    remainingDiffChars -= diff.length;
    return [{ path: item.fileName, diff }];
  });
  return {
    status: input.status,
    finalMessage: (finalMessage ?? "").slice(0, 8_000),
    changedFiles,
    toolFailures: input.turnItems.reduce((count, item) => count + (isToolFailure(item) ? 1 : 0), 0),
  };
}
