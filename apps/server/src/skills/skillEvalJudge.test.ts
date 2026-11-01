import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SkillEvalJudgeUnavailableError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildSkillTrialTranscript,
  judgeSharesCandidateFamily,
  mapPositionalSkillTrialJudgment,
  resolveSkillEvalJudge,
  skillEvalModelFamily,
} from "./skillEvalJudge.ts";

const isUnavailable = Schema.is(SkillEvalJudgeUnavailableError);
const now = Date.parse("2026-10-29T00:00:00.000Z");

const provider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly models: ReadonlyArray<string>;
  readonly enabled?: boolean;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver),
  enabled: input.enabled ?? true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-29T00:00:00.000Z",
  models: input.models.map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

const claude = provider({
  instanceId: "claude",
  driver: "claudeAgent",
  models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"],
});
const codex = provider({
  instanceId: "codex",
  driver: "codex",
  models: ["gpt-5.6-sol", "gpt-5.6-mini"],
});

describe("resolveSkillEvalJudge", () => {
  it.effect("prefers an available Claude Fable model", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveSkillEvalJudge({
        providers: [codex, claude],
        now,
        explicit: null,
      });
      assert.deepEqual(resolved.modelSelection, {
        instanceId: claude.instanceId,
        model: "claude-fable-5-1",
      });
      assert.equal(resolved.driver, claude.driver);
    }),
  );

  it.effect("falls back to the exact gpt-5.6-sol slug", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveSkillEvalJudge({ providers: [codex], now, explicit: null });
      assert.deepEqual(resolved.modelSelection, {
        instanceId: codex.instanceId,
        model: "gpt-5.6-sol",
      });
    }),
  );

  it.effect("falls through to Sol when Fable has an exhausted usage window", () =>
    Effect.gen(function* () {
      const exhaustedClaude = {
        ...claude,
        usageLimits: {
          checkedAt: "2026-10-29T00:00:00.000Z",
          windows: [
            {
              id: "weekly",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: 100,
              windowDurationMins: 10_080,
              resetsAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        },
      };
      const resolved = yield* resolveSkillEvalJudge({
        providers: [exhaustedClaude, codex],
        now,
        explicit: null,
      });

      assert.deepEqual(resolved.modelSelection, {
        instanceId: codex.instanceId,
        model: "gpt-5.6-sol",
      });
    }),
  );

  it.effect("rejects an explicit judge with an exhausted usage window", () =>
    Effect.gen(function* () {
      const exhaustedClaude = {
        ...claude,
        usageLimits: {
          checkedAt: "2026-10-29T00:00:00.000Z",
          windows: [
            {
              id: "weekly",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: 100,
              windowDurationMins: 10_080,
              resetsAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        },
      };
      const failure = yield* Effect.flip(
        resolveSkillEvalJudge({
          providers: [exhaustedClaude, codex],
          now,
          explicit: {
            instanceId: exhaustedClaude.instanceId,
            model: "claude-fable-5-1",
          },
        }),
      );

      assert.isTrue(isUnavailable(failure));
      assert.include(failure.message, "not available");
    }),
  );

  it.effect.each([
    { model: "claude-haiku-5-5", judgeProvider: claude },
    { model: "claude-sonnet-5-5", judgeProvider: claude },
    { model: "claude-opus-5-5", judgeProvider: claude },
    { model: "gpt-5.6-mini", judgeProvider: codex },
  ] as const)("rejects explicit $model", ({ model, judgeProvider }) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveSkillEvalJudge({
          providers: [judgeProvider],
          now,
          explicit: { instanceId: judgeProvider.instanceId, model },
        }),
      );
      assert.isTrue(isUnavailable(failure));
      assert.include(failure.message, "not allowed");
    }),
  );

  it.effect("does not accept a Fable slug from a non-Claude driver", () =>
    Effect.gen(function* () {
      const nonClaudeFable = provider({
        instanceId: "custom",
        driver: "codex",
        models: ["claude-fable-5-1"],
      });
      const failure = yield* Effect.flip(
        resolveSkillEvalJudge({
          providers: [nonClaudeFable],
          now,
          explicit: { instanceId: nonClaudeFable.instanceId, model: "claude-fable-5-1" },
        }),
      );
      assert.isTrue(isUnavailable(failure));
      assert.include(failure.message, "not allowed");
    }),
  );

  it.effect("rejects unrelated Claude slugs that merely contain Fable", () =>
    Effect.gen(function* () {
      const misleading = provider({
        instanceId: "misleading-claude",
        driver: "claudeAgent",
        models: ["not-fable-model", "claude-fableish-5"],
      });
      for (const model of misleading.models) {
        const failure = yield* Effect.flip(
          resolveSkillEvalJudge({
            providers: [misleading],
            now,
            explicit: { instanceId: misleading.instanceId, model: model.slug },
          }),
        );
        assert.isTrue(isUnavailable(failure));
        assert.include(failure.message, "not allowed");
      }
      const automatic = yield* resolveSkillEvalJudge({
        providers: [misleading, codex],
        now,
        explicit: null,
      });
      assert.equal(automatic.modelSelection.model, "gpt-5.6-sol");
    }),
  );

  it.effect("returns actionable guidance when no eligible judge exists", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveSkillEvalJudge({
          providers: [provider({ instanceId: "other", driver: "codex", models: ["gpt-5.6-mini"] })],
          now,
          explicit: null,
        }),
      );
      assert.isTrue(isUnavailable(failure));
      assert.include(failure.message, "Claude Fable");
      assert.include(failure.message, "gpt-5.6-sol");
    }),
  );
});

describe("judge model family", () => {
  it.each([
    ["claude-fable-5-1", "anthropic"],
    ["opus-5.5", "anthropic"],
    ["gpt-5.6-luna", "openai"],
    ["o3", "openai"],
    ["codex-mini", "openai"],
    ["gemini-2.5-pro", "google"],
    ["grok-4", "xai"],
    ["custom-model", null],
  ] as const)("classifies %s as %s", (model, expected) => {
    assert.equal(skillEvalModelFamily(model), expected);
  });

  it("uses model slugs instead of harness drivers", () => {
    assert.isFalse(
      judgeSharesCandidateFamily({
        judge: { instanceId: claude.instanceId, model: "claude-fable-5-1" },
        candidate: { instanceId: claude.instanceId, model: "gpt-5.6-luna" },
      }),
    );
    assert.isTrue(
      judgeSharesCandidateFamily({
        judge: { instanceId: claude.instanceId, model: "claude-fable-5-1" },
        candidate: { instanceId: codex.instanceId, model: "claude-opus-5-5" },
      }),
    );
    assert.isFalse(
      judgeSharesCandidateFamily({
        judge: { instanceId: claude.instanceId, model: "custom-model" },
        candidate: { instanceId: codex.instanceId, model: "custom-model" },
      }),
    );
  });
});

describe("mapPositionalSkillTrialJudgment", () => {
  it("maps treatment-first A/B positions to treatment and control", () => {
    assert.deepEqual(
      mapPositionalSkillTrialJudgment("treatment-first", {
        preferred: "A",
        scoreA: 5,
        scoreB: 2,
        rationale: " treatment wins ",
      }),
      {
        preferred: "treatment",
        treatmentScore: 1,
        controlScore: 0.25,
        rationale: "treatment wins",
      },
    );
  });

  it("maps control-first A/B positions back to treatment and control", () => {
    assert.deepEqual(
      mapPositionalSkillTrialJudgment("control-first", {
        preferred: "B",
        scoreA: 2,
        scoreB: 5,
        rationale: "treatment wins",
      }),
      {
        preferred: "treatment",
        treatmentScore: 1,
        controlScore: 0.25,
        rationale: "treatment wins",
      },
    );
  });
});

describe("buildSkillTrialTranscript", () => {
  it("bounds final messages and file diffs exactly", () => {
    const transcript = buildSkillTrialTranscript({
      status: "completed",
      turnItems: [
        {
          type: "assistant_message",
          text: "m".repeat(9_000),
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          type: "file_change" as const,
          fileName: `file-${index}.ts`,
          diffStr: "d".repeat(5_000),
        })),
      ] as unknown as Parameters<typeof buildSkillTrialTranscript>[0]["turnItems"],
    });

    assert.lengthOf(transcript.finalMessage, 8_000);
    assert.deepEqual(
      transcript.changedFiles.map(({ diff }) => diff.length),
      [4_000, 4_000, 4_000],
    );
  });
});
