import { assert, describe, it } from "@effect/vitest";
import {
  WorkflowDefinition,
  type WorkflowDefinition as WorkflowDefinitionType,
} from "@t3tools/contracts";
import { AsanaSelector, GithubSelector, JiraSelector } from "@t3tools/contracts/workSource";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { encodeWorkflowDefinitionJson, lintWorkflowDefinition } from "./workflowFile.ts";
import { MAX_PREDICATE_DEPTH } from "./jsonLogicRule.ts";

const base = (lanes: unknown): WorkflowDefinitionType =>
  ({ name: "wf", lanes }) as unknown as WorkflowDefinitionType;

const ctx = {
  providerInstanceExists: (id: string) => id === "claude_main",
  instructionFileExists: (path: string) => path === "prompts/ok.md",
};

const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const decodeWorkflowDefinitionJson = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));

describe("lintWorkflowDefinition", () => {
  it.effect("exports an encoder that serializes decodable workflow JSON", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "implement",
            name: "Implement",
            entry: "auto",
            pipeline: [{ key: "tests", type: "script", run: "pnpm test", timeout: "5 minutes" }],
          },
        ]),
      );
      const contents = encodeWorkflowDefinitionJson(definition);
      const decoded = yield* decodeWorkflowDefinitionJson(contents);
      assert.equal(decoded.name, "wf");
      assert.equal((decoded.lanes[0]?.pipeline?.[0] as any)?.type, "script");
    }),
  );

  it("passes a valid definition", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "s",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: { file: "prompts/ok.md" },
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );
    assert.deepEqual(errors, []);
  });

  it("flags duplicate lane keys", () => {
    const errors = lintWorkflowDefinition(
      base([
        { key: "a", name: "A", entry: "manual" },
        { key: "a", name: "A2", entry: "manual" },
      ]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "duplicate_lane_key"));
  });

  it("flags routing to a missing lane", () => {
    const errors = lintWorkflowDefinition(
      base([{ key: "a", name: "A", entry: "auto", on: { success: "ghost" } }]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "missing_lane_ref"));
  });

  it("flags step routing and transition targets that reference missing lanes", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "review",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "hi",
              on: { failure: "missing-step-target" },
            },
          ],
          transitions: [{ when: { "==": [{ var: "pipeline.result" }, "success"] }, to: "ghost" }],
        },
      ]),
      ctx,
    );

    assert.isTrue(
      errors.some(
        (e) =>
          e.code === "missing_lane_ref" &&
          e.stepKey === "review" &&
          e.message.includes("missing-step-target"),
      ),
    );
    assert.isTrue(
      errors.some(
        (e) =>
          e.code === "missing_lane_ref" &&
          e.message.includes("ghost") &&
          (e as any).transitionIndex === 0,
      ),
    );
  });

  it("accepts well-formed predicate paths and explicit step precedence", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "tests",
              type: "script",
              run: "pnpm test",
              on: { failure: "needs" },
            },
            {
              key: "review",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "hi",
              captureOutput: true,
            },
          ],
          transitions: [
            {
              when: {
                and: [
                  { "!=": [{ var: "steps.tests.exitCode" }, 0] },
                  { "==": [{ var: "steps.review.output.verdict" }, "block"] },
                  { in: [{ var: "pipeline.result" }, ["success", "failure"]] },
                  { "!": { var: "status" } },
                ],
              },
              to: "needs",
            },
          ],
          on: { success: "done", failure: "needs" },
        },
        { key: "needs", name: "Needs", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );

    assert.deepEqual(errors, []);
  });

  it("flags disallowed predicate operators and invalid var forms", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [{ key: "tests", type: "script", run: "pnpm test" }],
          transitions: [
            { when: { cat: ["a", "b"] }, to: "done" },
            { when: { var: ["steps.tests.exitCode", 0] }, to: "done" },
            { when: { var: 123 }, to: "done" },
          ],
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );

    assert.deepEqual(
      errors.filter((e) => e.code === "invalid_json_logic").map((e) => (e as any).transitionIndex),
      [0, 1, 2],
    );
  });

  it("flags a predicate nested deeper than MAX_PREDICATE_DEPTH without throwing", () => {
    // Build a predicate with MAX_PREDICATE_DEPTH + 1 levels of "!" nesting.
    // This must produce an invalid_json_logic lint error and must NOT throw.
    let deepPredicate: unknown = { var: "pipeline.result" };
    for (let i = 0; i < MAX_PREDICATE_DEPTH + 1; i++) {
      deepPredicate = { "!": deepPredicate };
    }
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [{ key: "tests", type: "script", run: "pnpm test" }],
          transitions: [{ when: deepPredicate, to: "done" }],
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );
    assert.isTrue(
      errors.some((e) => e.code === "invalid_json_logic"),
      "too-deep predicate must produce an invalid_json_logic lint error",
    );
  });

  it("accepts a predicate nested at exactly MAX_PREDICATE_DEPTH", () => {
    // A predicate at exactly the limit (not over) must pass lint cleanly.
    let validPredicate: unknown = { var: "pipeline.result" };
    for (let i = 0; i < MAX_PREDICATE_DEPTH; i++) {
      validPredicate = { "!": validPredicate };
    }
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [{ key: "tests", type: "script", run: "pnpm test" }],
          transitions: [{ when: validPredicate, to: "done" }],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );
    assert.isFalse(
      errors.some((e) => e.code === "invalid_json_logic"),
      "predicate at exactly MAX_PREDICATE_DEPTH must not be flagged",
    );
  });

  it("flags unknown and ill-typed predicate paths", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "review",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "hi",
            },
            { key: "approval", type: "approval", prompt: "Ship?" },
          ],
          transitions: [
            { when: { var: "steps.missing.status" }, to: "done" },
            { when: { var: "steps.review.exitCode" }, to: "done" },
            { when: { var: "steps.review.output.verdict" }, to: "done" },
            { when: { var: "steps.approval.output.verdict" }, to: "done" },
            { when: { var: "pipeline.unknown" }, to: "done" },
          ],
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );

    assert.deepEqual(
      errors
        .filter((e) => e.code === "unknown_predicate_path")
        .map((e) => (e as any).transitionIndex),
      [0, 1, 2, 3, 4],
    );
  });

  it("flags path-unsafe step keys when predicates are present", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "bad.key",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "hi",
              captureOutput: true,
            },
          ],
          transitions: [{ when: { var: "steps.bad.key.output.verdict" }, to: "done" }],
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );

    assert.isTrue(
      errors.some(
        (e) =>
          e.code === "unsafe_step_key" &&
          e.stepKey === "bad.key" &&
          (e as any).transitionIndex === 0,
      ),
    );
  });

  it("flags an unknown provider instance", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "s",
              type: "agent",
              agent: { instance: "nope", model: "x" },
              instruction: "hi",
            },
          ],
        },
      ]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "unknown_provider_instance"));
  });

  it("flags a missing instruction file", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "s",
              type: "agent",
              agent: { instance: "claude_main", model: "x" },
              instruction: { file: "prompts/missing.md" },
            },
          ],
        },
      ]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "missing_instruction_file"));
  });

  it("flags unsafe instruction file paths before checking file existence", () => {
    let existenceChecks = 0;
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "s",
              type: "agent",
              agent: { instance: "claude_main", model: "x" },
              instruction: { file: "../escape.md" },
            },
          ],
        },
      ]),
      {
        providerInstanceExists: ctx.providerInstanceExists,
        instructionFileExists: () => {
          existenceChecks += 1;
          return true;
        },
      },
    );

    assert.deepEqual(
      errors.map((error) => ({
        code: error.code,
        laneKey: error.laneKey,
        stepKey: error.stepKey,
      })),
      [{ code: "unsafe_instruction_path", laneKey: "a", stepKey: "s" }],
    );
    assert.equal(existenceChecks, 0);
  });

  it("flags an auto-lane cycle with no human/terminal break", () => {
    const errors = lintWorkflowDefinition(
      base([
        { key: "a", name: "A", entry: "auto", on: { success: "b" } },
        { key: "b", name: "B", entry: "auto", on: { success: "a" } },
      ]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "auto_lane_cycle"));
  });

  it("flags invalid WIP limits and accepts positive limits on non-terminal lanes", () => {
    const invalidErrors = lintWorkflowDefinition(
      base([
        { key: "zero", name: "Zero", entry: "manual", wipLimit: 0 },
        { key: "done", name: "Done", entry: "manual", terminal: true, wipLimit: 1 },
      ]),
      ctx,
    );

    assert.deepEqual(
      invalidErrors
        .filter((error) => error.code === "invalid_wip_limit")
        .map((error) => error.laneKey),
      ["zero", "done"],
    );

    const validErrors = lintWorkflowDefinition(
      base([
        { key: "backlog", name: "Backlog", entry: "manual", wipLimit: 2 },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );
    assert.deepEqual(validErrors, []);
  });

  it.effect("accepts retention only on terminal lanes with positive duration", () =>
    Effect.gen(function* () {
      const valid = yield* decodeWorkflowDefinition(
        base([
          { key: "backlog", name: "Backlog", entry: "manual" },
          {
            key: "done",
            name: "Done",
            entry: "manual",
            terminal: true,
            retention: "7 days",
          },
        ]),
      );
      assert.deepEqual(lintWorkflowDefinition(valid, ctx), []);

      const nonTerminal = yield* decodeWorkflowDefinition(
        base([
          {
            key: "backlog",
            name: "Backlog",
            entry: "manual",
            retention: "7 days",
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      assert.deepEqual(
        lintWorkflowDefinition(nonTerminal, ctx).map((error) => error.code),
        ["invalid_retention"],
      );

      const zeroRetention = yield* decodeWorkflowDefinition(
        base([
          {
            key: "done",
            name: "Done",
            entry: "manual",
            terminal: true,
            retention: "0 millis",
          },
        ]),
      );
      assert.deepEqual(
        lintWorkflowDefinition(zeroRetention, ctx).map((error) => error.code),
        ["invalid_retention"],
      );
    }),
  );
});

describe("lintWorkflowDefinition retry + templates", () => {
  const agentStep = (retry?: unknown, instruction: unknown = "Do the work.") => ({
    key: "s",
    type: "agent",
    agent: { instance: "claude_main", model: "sonnet" },
    instruction,
    ...(retry === undefined ? {} : { retry }),
  });

  const lintLane = (pipeline: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([{ key: "a", name: "A", entry: "manual", pipeline }]),
      );
      return lintWorkflowDefinition(definition, ctx);
    });

  it.effect("accepts retry within 2..5 on agent and script steps", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([
        agentStep({ maxAttempts: 3, escalate: { model: "opus" } }),
        { key: "t", type: "script", run: "pnpm test", retry: { maxAttempts: 2 } },
      ]);
      assert.deepEqual(errors, []);
    }),
  );

  it.effect("rejects maxAttempts outside 2..5", () =>
    Effect.gen(function* () {
      const tooLow = yield* lintLane([agentStep({ maxAttempts: 1 })]);
      assert.deepEqual(
        tooLow.map((error) => error.code),
        ["invalid_retry"],
      );

      const tooHigh = yield* lintLane([agentStep({ maxAttempts: 6 })]);
      assert.deepEqual(
        tooHigh.map((error) => error.code),
        ["invalid_retry"],
      );
    }),
  );

  it.effect("rejects escalation on script steps", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([
        {
          key: "t",
          type: "script",
          run: "pnpm test",
          retry: { maxAttempts: 2, escalate: { model: "opus" } },
        },
      ]);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["invalid_retry"],
      );
    }),
  );

  it.effect("rejects unknown escalation provider instances", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([
        agentStep({ maxAttempts: 2, escalate: { instance: "nope" } }),
      ]);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["unknown_provider_instance"],
      );
      assert.match(errors[0]?.message ?? "", /retry escalation/);
    }),
  );

  it.effect("accepts known ticket placeholders in inline instructions", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([
        agentStep(
          undefined,
          "Review {{ticket.title}} ({{ticket.id}}): {{ticket.description}} vs {{ticket.baseRef}} and {{not.a.template}}",
        ),
      ]);
      assert.deepEqual(errors, []);
    }),
  );

  it.effect("flags unknown ticket placeholders in inline instructions", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([agentStep(undefined, "Check {{ticket.priority}}")]);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["unknown_template_placeholder"],
      );
      assert.match(errors[0]?.message ?? "", /ticket\.priority/);
    }),
  );
});

describe("lintWorkflowDefinition file instruction templates", () => {
  it.effect("flags unknown placeholders inside instruction files when content is available", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "a",
            name: "A",
            entry: "manual",
            pipeline: [
              {
                key: "s",
                type: "agent",
                agent: { instance: "claude_main", model: "sonnet" },
                instruction: { file: "prompts/ok.md" },
              },
            ],
          },
        ]),
      );

      const withBadContent = lintWorkflowDefinition(definition, {
        ...ctx,
        readInstructionFile: (path) =>
          path === "prompts/ok.md" ? "Review {{ticket.titel}}" : null,
      });
      assert.deepEqual(
        withBadContent.map((error) => error.code),
        ["unknown_template_placeholder"],
      );

      const withGoodContent = lintWorkflowDefinition(definition, {
        ...ctx,
        readInstructionFile: (path) =>
          path === "prompts/ok.md" ? "Review {{ticket.title}} vs {{ticket.baseRef}}" : null,
      });
      assert.deepEqual(withGoodContent, []);

      const withoutContent = lintWorkflowDefinition(definition, ctx);
      assert.deepEqual(withoutContent, []);
    }),
  );
});

describe("lintWorkflowDefinition auto self-loop bounds", () => {
  const selfLoopLane = (when: unknown) => [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "review",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "review",
          captureOutput: true,
        },
      ],
      transitions: [{ when, to: "impl" }],
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ];

  it.effect("rejects unbounded auto self-transitions", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base(selfLoopLane({ "==": [{ var: "steps.review.output.verdict" }, "revise"] })),
      );
      const errors = lintWorkflowDefinition(definition, ctx);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["auto_lane_cycle"],
      );
    }),
  );

  it.effect("accepts auto self-transitions bounded by lane.runCount", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base(
          selfLoopLane({
            and: [
              { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
              { "<": [{ var: "lane.runCount" }, 3] },
            ],
          }),
        ),
      );
      assert.deepEqual(lintWorkflowDefinition(definition, ctx), []);
    }),
  );
});

describe("lintWorkflowDefinition pullRequest steps", () => {
  const lintLane = (pipeline: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          { key: "a", name: "A", entry: "manual", pipeline },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      return lintWorkflowDefinition(definition, ctx);
    });

  it.effect("lints pullRequest steps", () =>
    Effect.gen(function* () {
      // open step with land-only fields → invalid_step
      const openWithLandFields = yield* lintLane([
        { key: "pr", type: "pullRequest", action: "open", strategy: "squash", deleteBranch: true },
      ]);
      assert.isTrue(openWithLandFields.some((e) => e.code === "invalid_step"));

      // land step with open-only fields → invalid_step
      const landWithOpenFields = yield* lintLane([
        {
          key: "pr",
          type: "pullRequest",
          action: "land",
          base: "main",
          draft: false,
          titleTemplate: "My PR",
          bodyTemplate: "Body",
        },
      ]);
      assert.isTrue(landWithOpenFields.some((e) => e.code === "invalid_step"));

      // open step with unknown placeholder in titleTemplate → unknown_template_placeholder
      const badTitle = yield* lintLane([
        {
          key: "pr",
          type: "pullRequest",
          action: "open",
          titleTemplate: "PR: {{ticket.bogus.path}}",
        },
      ]);
      assert.isTrue(badTitle.some((e) => e.code === "unknown_template_placeholder"));

      // open step with unknown placeholder in bodyTemplate → unknown_template_placeholder
      const badBody = yield* lintLane([
        {
          key: "pr",
          type: "pullRequest",
          action: "open",
          bodyTemplate: "Fixes {{ticket.unknown}}",
        },
      ]);
      assert.isTrue(badBody.some((e) => e.code === "unknown_template_placeholder"));

      // clean open step → no errors
      const cleanOpen = yield* lintLane([
        {
          key: "pr",
          type: "pullRequest",
          action: "open",
          base: "main",
          titleTemplate: "PR: {{ticket.title}}",
          bodyTemplate: "{{ticket.description}}",
        },
      ]);
      assert.deepEqual(cleanOpen, []);

      // clean land step → no errors
      const cleanLand = yield* lintLane([
        { key: "pr", type: "pullRequest", action: "land", strategy: "squash", deleteBranch: true },
      ]);
      assert.deepEqual(cleanLand, []);
    }),
  );

  it.effect("allows steps.<key>.output for pullRequest open steps", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "a",
            name: "A",
            entry: "auto",
            pipeline: [
              { key: "openPr", type: "pullRequest", action: "open" },
              { key: "landPr", type: "pullRequest", action: "land" },
            ],
            transitions: [{ when: { var: "steps.openPr.output.prNumber" }, to: "done" }],
            on: { success: "done" },
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      const errors = lintWorkflowDefinition(definition, ctx);
      // reading output from open step is fine
      assert.isFalse(
        errors.some((e) => e.code === "unknown_predicate_path" && e.message?.includes("openPr")),
      );

      // reading output from land step → error
      const definitionWithLandOutput = yield* decodeWorkflowDefinition(
        base([
          {
            key: "a",
            name: "A",
            entry: "auto",
            pipeline: [{ key: "landPr", type: "pullRequest", action: "land" }],
            transitions: [{ when: { var: "steps.landPr.output.prNumber" }, to: "done" }],
            on: { success: "done" },
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      const landOutputErrors = lintWorkflowDefinition(definitionWithLandOutput, ctx);
      assert.isTrue(
        landOutputErrors.some(
          (e) => e.code === "unknown_predicate_path" && e.message?.includes("can only read output"),
        ),
      );
    }),
  );

  it.effect("allows pr.* in onEvent.when", () =>
    Effect.gen(function* () {
      // pr.ciState and pr.reviewDecision lint clean
      const definitionClean = yield* decodeWorkflowDefinition(
        base([
          {
            key: "review",
            name: "Review",
            entry: "manual",
            onEvent: [
              { name: "pr_update", when: { var: "pr.ciState" }, to: "done" },
              { name: "pr_review", when: { var: "pr.reviewDecision" }, to: "done" },
            ],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      assert.deepEqual(lintWorkflowDefinition(definitionClean, ctx), []);

      // pr.bogus → unknown_predicate_path
      const definitionBogus = yield* decodeWorkflowDefinition(
        base([
          {
            key: "review",
            name: "Review",
            entry: "manual",
            onEvent: [{ name: "pr_update", when: { var: "pr.bogus" }, to: "done" }],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      const bogusErrors = lintWorkflowDefinition(definitionBogus, ctx);
      assert.isTrue(bogusErrors.some((e) => e.code === "unknown_predicate_path"));
      // error message mentions the allowed pr.* paths
      const prError = bogusErrors.find((e) => e.code === "unknown_predicate_path");
      assert.match(prError?.message ?? "", /pr\.ciState/);
      assert.match(prError?.message ?? "", /pr\.reviewDecision/);
    }),
  );
});

describe("lintWorkflowDefinition lane actions", () => {
  it.effect("rejects actions targeting missing lanes", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "review",
            name: "Review",
            entry: "manual",
            actions: [{ label: "Land it", to: "nope" }],
          },
        ]),
      );
      const errors = lintWorkflowDefinition(definition, ctx);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["missing_lane_ref"],
      );
      assert.match(errors[0]?.message ?? "", /Land it/);
    }),
  );

  it.effect("accepts actions targeting real lanes", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "review",
            name: "Review",
            entry: "manual",
            actions: [{ label: "Land it", to: "done", hint: "Merge the work." }],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      assert.deepEqual(lintWorkflowDefinition(definition, ctx), []);
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Source lint tests
// ─────────────────────────────────────────────────────────────────────────────

const baseWithSources = (lanes: unknown, sources: unknown): WorkflowDefinitionType =>
  ({ name: "wf", lanes, sources }) as unknown as WorkflowDefinitionType;

const selectorCtx = {
  providerInstanceExists: () => true,
  instructionFileExists: () => true,
  selectorSchemaFor: (p: string) =>
    p === "github" ? GithubSelector : p === "asana" ? AsanaSelector : p === "jira" ? JiraSelector : null,
};

const twoLanes = [
  { key: "backlog", name: "Backlog", entry: "manual" },
  { key: "done", name: "Done", entry: "manual", terminal: true },
];

describe("lintWorkflowDefinition sources", () => {
  it("flags destinationLane referencing a missing lane", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api" },
        destinationLane: "nonexistent",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(
      errors.some((e) => e.code === "missing_lane_ref" && /destinationLane/.test(e.message)),
    );
  });

  it("flags closedLane referencing a missing lane", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api" },
        destinationLane: "backlog",
        closedLane: "ghost",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(
      errors.some((e) => e.code === "missing_lane_ref" && /closedLane/.test(e.message)),
    );
  });

  it("flags closedLane that exists but is not terminal", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api" },
        destinationLane: "backlog",
        closedLane: "backlog", // exists but not terminal
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "invalid_source" && /terminal/.test(e.message)));
  });

  it("flags a github selector missing required fields (owner/repo)", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { labels: ["bug"] }, // missing owner and repo
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "invalid_source"));
  });

  it("flags an unknown provider", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "trello1",
        provider: "trello" as any,
        connectionRef: "conn-1",
        selector: {},
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(
      errors.some((e) => e.code === "invalid_source" && /unknown provider/.test(e.message)),
    );
  });

  it("accepts a valid Jira source without invalid_source error", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "jira1",
        provider: "jira",
        connectionRef: "conn-1",
        selector: { projectKey: "ENG" },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isFalse(errors.some((e) => e.code === "invalid_source"));
  });

  it("flags duplicate source ids", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api" },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
      {
        id: "gh1", // duplicate
        provider: "github",
        connectionRef: "conn-2",
        selector: { owner: "acme", repo: "web" },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "duplicate_source_id"));
  });

  it("flags an asana source with sectionGid set", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "asana1",
        provider: "asana",
        connectionRef: "conn-1",
        selector: { projectGid: "1234567890", sectionGid: "999", includeCompleted: false },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "invalid_source" && /sectionGid/.test(e.message)));
  });

  it("flags an asana source with tagGid set", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "asana1",
        provider: "asana",
        connectionRef: "conn-1",
        selector: { projectGid: "1234567890", tagGid: "777", includeCompleted: true },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "invalid_source" && /tagGid/.test(e.message)));
  });

  it("accepts a valid github source and a valid asana source", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api", labels: ["bug"], state: "open" },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
      {
        id: "asana1",
        provider: "asana",
        connectionRef: "conn-2",
        selector: { projectGid: "1234567890", includeCompleted: false },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.deepEqual(errors, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Outbound rule lint tests
// ─────────────────────────────────────────────────────────────────────────────

const baseWithOutbound = (lanes: unknown, outbound: unknown): WorkflowDefinitionType =>
  ({ name: "wf", lanes, outbound }) as unknown as WorkflowDefinitionType;

const minimalLanes = [
  { key: "backlog", name: "Backlog", entry: "manual" },
  { key: "done", name: "Done", entry: "manual", terminal: true },
];

const validOutboundRule = {
  id: "rule-1",
  on: "done",
  to: "https://hooks.example.com/notify",
  as: "generic",
  enabled: true,
};

describe("lintWorkflowDefinition outbound rules", () => {
  it("flags invalid_outbound for an unknown on trigger", () => {
    const def = baseWithOutbound(minimalLanes, [
      { ...validOutboundRule, id: "r1", on: "unknown_trigger" },
    ]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isTrue(
      errors.some((e) => e.code === "invalid_outbound" && /unknown.*trigger/.test(e.message)),
    );
  });

  it("flags invalid_outbound for an unknown as formatter", () => {
    const def = baseWithOutbound(minimalLanes, [{ ...validOutboundRule, id: "r1", as: "teams" }]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isTrue(errors.some((e) => e.code === "invalid_outbound" && /formatter/.test(e.message)));
  });

  it("flags invalid_outbound for an empty to", () => {
    const def = baseWithOutbound(minimalLanes, [{ ...validOutboundRule, id: "r1", to: "   " }]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isTrue(
      errors.some((e) => e.code === "invalid_outbound" && /to must not be empty/.test(e.message)),
    );
  });

  it("flags duplicate_outbound_id for two rules sharing an id", () => {
    const def = baseWithOutbound(minimalLanes, [
      { ...validOutboundRule, id: "dup-id" },
      { ...validOutboundRule, id: "dup-id", to: "https://other.example.com" },
    ]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isTrue(errors.some((e) => e.code === "duplicate_outbound_id"));
  });

  it("flags invalid_outbound for a when referencing an unknown path", () => {
    const def = baseWithOutbound(minimalLanes, [
      {
        ...validOutboundRule,
        id: "r1",
        when: { "==": [{ var: "stepKey" }, "x"] },
      },
    ]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isTrue(
      errors.some(
        (e) => e.code === "invalid_outbound" && /unknown predicate path.*stepKey/.test(e.message),
      ),
    );
  });

  it("flags invalid_outbound for a when using a disallowed operator", () => {
    const def = baseWithOutbound(minimalLanes, [
      {
        ...validOutboundRule,
        id: "r1",
        when: { cat: ["needs-attention", "!"] },
      },
    ]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isTrue(
      errors.some(
        (e) => e.code === "invalid_outbound" && /unsupported JSONLogic operator/.test(e.message),
      ),
    );
  });

  it("accepts a valid rule with when using an allowed outbound path", () => {
    const def = baseWithOutbound(minimalLanes, [
      {
        ...validOutboundRule,
        id: "r1",
        when: { "==": [{ var: "toLane" }, "needs-attention"] },
      },
    ]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isFalse(
      errors.some((e) => e.code === "invalid_outbound" || e.code === "duplicate_outbound_id"),
    );
  });

  it("accepts a valid rule with no when", () => {
    const def = baseWithOutbound(minimalLanes, [validOutboundRule]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isFalse(
      errors.some((e) => e.code === "invalid_outbound" || e.code === "duplicate_outbound_id"),
    );
  });

  it("accepts a valid rule with when referencing occurredAt", () => {
    const def = baseWithOutbound(minimalLanes, [
      {
        ...validOutboundRule,
        id: "r1",
        when: { "<": [{ var: "occurredAt" }, "2026-01-01T00:00:00.000Z"] },
      },
    ]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isFalse(
      errors.some((e) => e.code === "invalid_outbound" || e.code === "duplicate_outbound_id"),
    );
  });

  it("emits one error per failing check (no early continue)", () => {
    const def = baseWithOutbound(minimalLanes, [
      { ...validOutboundRule, id: "r1", on: "bogus_trigger", to: "   " },
    ]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.equal(errors.filter((e) => e.code === "invalid_outbound").length, 2);
  });

  it("accepts all valid trigger and formatter combinations", () => {
    const rules = [
      { ...validOutboundRule, id: "r1", on: "needs_attention", as: "generic" },
      { ...validOutboundRule, id: "r2", on: "blocked", as: "slack" },
      { ...validOutboundRule, id: "r3", on: "done", as: "generic" },
      { ...validOutboundRule, id: "r4", on: "lane_entered", as: "slack" },
    ];
    const def = baseWithOutbound(minimalLanes, rules);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isFalse(
      errors.some((e) => e.code === "invalid_outbound" || e.code === "duplicate_outbound_id"),
    );
  });

  it("flags invalid_outbound for a rule id containing a space", () => {
    const def = baseWithOutbound(minimalLanes, [{ ...validOutboundRule, id: "bad id" }]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isTrue(errors.some((e) => e.code === "invalid_outbound" && /bad id/.test(e.message)));
  });

  it("flags invalid_outbound for a rule id containing a newline", () => {
    const def = baseWithOutbound(minimalLanes, [{ ...validOutboundRule, id: "bad\nid" }]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isTrue(errors.some((e) => e.code === "invalid_outbound"));
  });

  it("flags invalid_outbound for a rule id longer than 64 chars", () => {
    const longId = "a".repeat(65);
    const def = baseWithOutbound(minimalLanes, [{ ...validOutboundRule, id: longId }]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isTrue(errors.some((e) => e.code === "invalid_outbound" && e.message.includes(longId)));
  });

  it("does not flag invalid_outbound for a valid slug rule id", () => {
    const def = baseWithOutbound(minimalLanes, [
      { ...validOutboundRule, id: "notify-blocked_1:v2" },
    ]);
    const errors = lintWorkflowDefinition(def, ctx);
    assert.isFalse(
      errors.some((e) => e.code === "invalid_outbound" && /notify-blocked_1:v2/.test(e.message)),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Source autoPull rule lint tests (B3)
// ─────────────────────────────────────────────────────────────────────────────

const defWithSource = (sourceOverrides: Record<string, unknown>): WorkflowDefinitionType =>
  baseWithSources(twoLanes, [
    {
      id: "gh1",
      provider: "github",
      connectionRef: "conn-1",
      selector: { owner: "acme", repo: "api" },
      destinationLane: "backlog",
      closedLane: "done",
      ...sourceOverrides,
    },
  ]);

describe("lintWorkflowDefinition source autoPull rules", () => {
  it("source autoPull: unknown var path → unknown_predicate_path", () => {
    const errors = lintWorkflowDefinition(
      defWithSource({ autoPull: { rule: { in: ["XS", { var: "label" }] } } }),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "unknown_predicate_path"));
  });
  it("source autoPull: disallowed operator → invalid_json_logic", () => {
    const errors = lintWorkflowDefinition(
      defWithSource({ autoPull: { rule: { some: [{ var: "labels" }, true] } } }),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "invalid_json_logic"));
  });
  it("source autoPull: valid labels/state rule passes", () => {
    const errors = lintWorkflowDefinition(
      defWithSource({
        autoPull: {
          rule: { and: [{ in: ["XS", { var: "labels" }] }, { "==": [{ var: "state" }, "open"] }] },
        },
      }),
      ctx,
    );
    assert.isFalse(
      errors.some((e) => e.code === "invalid_json_logic" || e.code === "unknown_predicate_path"),
    );
  });
  it("source autoPull: two disallowed operators → two invalid_json_logic errors", () => {
    // Rule uses both `some` and `all`, each disallowed — must produce two errors, not one.
    const errors = lintWorkflowDefinition(
      defWithSource({
        autoPull: {
          rule: { and: [{ some: [{ var: "labels" }, true] }, { all: [{ var: "labels" }, true] }] },
        },
      }),
      ctx,
    );
    const jsonLogicErrors = errors.filter((e) => e.code === "invalid_json_logic");
    assert.equal(jsonLogicErrors.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3: Legacy round-trip — decode + lint (step 1)
// ─────────────────────────────────────────────────────────────────────────────

describe("A3: legacy enabled → autoPull decode + lint round-trip", () => {
  it.effect(
    "legacy sources (enabled:true + enabled:false, no autoPull) decode and produce no autoPull-related lint errors",
    () =>
      Effect.gen(function* () {
        const rawDef = {
          name: "legacy-board",
          lanes: [
            { key: "inbox", name: "Inbox", entry: "manual" },
            { key: "done", name: "Done", entry: "manual", terminal: true },
          ],
          sources: [
            {
              id: "src-enabled",
              provider: "github",
              connectionRef: "conn-1",
              selector: { owner: "acme", repo: "api", state: "all" },
              destinationLane: "inbox",
              closedLane: "done",
              enabled: true,
              // no autoPull
            },
            {
              id: "src-disabled",
              provider: "github",
              connectionRef: "conn-2",
              selector: { owner: "acme", repo: "web", state: "all" },
              destinationLane: "inbox",
              closedLane: "done",
              enabled: false,
              // no autoPull
            },
          ],
        };
        const definition = yield* decodeWorkflowDefinition(rawDef);
        // Both sources decoded: enabled field preserved, autoPull absent.
        assert.equal(definition.sources?.[0]?.enabled, true);
        assert.equal(definition.sources?.[0]?.autoPull, undefined);
        assert.equal(definition.sources?.[1]?.enabled, false);
        assert.equal(definition.sources?.[1]?.autoPull, undefined);

        // Lint must produce zero autoPull-related errors (legacy enabled is not flagged).
        const errors = lintWorkflowDefinition(definition, selectorCtx);
        assert.isFalse(
          errors.some(
            (e) => e.code === "invalid_json_logic" || e.code === "unknown_predicate_path",
          ),
          "unexpected autoPull-related lint errors on legacy enabled sources",
        );
      }),
  );
});

describe("lintWorkflowDefinition continueSession", () => {
  // Both provider instances exist; only resumability differs. claude_main is a
  // resumable provider; opencode_main is not (OpenCode lacks supportsSessionResume).
  const resumeCtx = {
    providerInstanceExists: (id: string) => id === "claude_main" || id === "opencode_main",
    instructionFileExists: (path: string) => path === "prompts/ok.md",
    providerInstanceSupportsResume: (id: string) => id === "claude_main",
  };

  const lint = (lanes: unknown, lintCtx = resumeCtx) =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(base(lanes));
      return lintWorkflowDefinition(definition, lintCtx);
    });

  it("rejects continueSession on a non-agent step", () => {
    // `continueSession` is only on AgentStep, so decode strips it from a script
    // step. The lint still defends against a hand-rolled/undecoded definition
    // carrying the flag on a non-agent step — so lint the raw (un-decoded) shape.
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [{ key: "s", type: "script", run: "echo hi", continueSession: true }],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      resumeCtx,
    );
    assert.deepEqual(
      errors.map((e) => ({ code: e.code, laneKey: e.laneKey, stepKey: e.stepKey })),
      [{ code: "invalid_continue_session", laneKey: "a", stepKey: "s" }],
    );
  });

  it.effect("rejects continueSession on a panel step", () =>
    Effect.gen(function* () {
      const errors = yield* lint([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "review",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "Review {{ticket.title}}.",
              captureOutput: true,
              panel: 2,
              continueSession: true,
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]);
      assert.deepEqual(
        errors.map((e) => ({ code: e.code, laneKey: e.laneKey, stepKey: e.stepKey })),
        [{ code: "invalid_continue_session", laneKey: "a", stepKey: "review" }],
      );
    }),
  );

  it.effect("rejects continueSession on a non-resumable provider (OpenCode)", () =>
    Effect.gen(function* () {
      const errors = yield* lint([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "implement",
              type: "agent",
              agent: { instance: "opencode_main", model: "sonnet" },
              instruction: "Implement {{ticket.title}}.",
              continueSession: true,
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]);
      assert.deepEqual(
        errors.map((e) => ({ code: e.code, laneKey: e.laneKey, stepKey: e.stepKey })),
        [{ code: "invalid_continue_session", laneKey: "a", stepKey: "implement" }],
      );
    }),
  );

  it.effect("rejects continueSession when a retry escalates to a non-resumable provider", () =>
    Effect.gen(function* () {
      const errors = yield* lint([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "implement",
              type: "agent",
              // Base provider resumes; the escalation target does NOT — and the
              // escalated attempt still applies continueSession, so lint must reject.
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "Implement {{ticket.title}}.",
              continueSession: true,
              retry: { maxAttempts: 2, escalate: { instance: "opencode_main" } },
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]);
      assert.deepEqual(
        errors.map((e) => ({ code: e.code, laneKey: e.laneKey, stepKey: e.stepKey })),
        [{ code: "invalid_continue_session", laneKey: "a", stepKey: "implement" }],
      );
    }),
  );

  it.effect("accepts continueSession on a resumable agent step", () =>
    Effect.gen(function* () {
      const errors = yield* lint([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "implement",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "Implement {{ticket.title}}.",
              continueSession: true,
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]);
      assert.deepEqual(errors, []);
    }),
  );

  it.effect("rejects continueSession on a non-resumable provider with file instruction", () =>
    Effect.gen(function* () {
      const errors = yield* lint([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "implement",
              type: "agent",
              agent: { instance: "opencode_main", model: "sonnet" },
              instruction: { file: "prompts/ok.md" },
              continueSession: true,
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]);
      assert.deepEqual(
        errors.map((e) => ({ code: e.code, laneKey: e.laneKey, stepKey: e.stepKey })),
        [{ code: "invalid_continue_session", laneKey: "a", stepKey: "implement" }],
      );
    }),
  );
});

describe("lintWorkflowDefinition handoff references", () => {
  const lint = (lanes: unknown, lintCtx: Record<string, unknown> = ctx) =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(base(lanes));
      return lintWorkflowDefinition(definition, lintCtx as never);
    });

  it.effect("flags {{step.<key>.output}} referencing a key not in the lane pipeline", () =>
    Effect.gen(function* () {
      const errors = yield* lint([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "implement",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "Use {{step.ghost.output}} please.",
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]);
      assert.deepEqual(
        errors.map((e) => ({ code: e.code, laneKey: e.laneKey, stepKey: e.stepKey })),
        [{ code: "invalid_handoff_reference", laneKey: "a", stepKey: "implement" }],
      );
    }),
  );

  it.effect("allows a forward reference to a step key that exists later in the lane", () =>
    Effect.gen(function* () {
      const errors = yield* lint([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "implement",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "Consider {{step.review.output}} from the reviewer.",
            },
            {
              key: "review",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "Review it.",
              captureOutput: true,
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]);
      assert.deepEqual(errors, []);
    }),
  );

  it.effect("flags {{prev.output}} on the first step of a lane", () =>
    Effect.gen(function* () {
      const errors = yield* lint([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "implement",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "Build on {{prev.output}}.",
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]);
      assert.deepEqual(
        errors.map((e) => ({ code: e.code, laneKey: e.laneKey, stepKey: e.stepKey })),
        [{ code: "invalid_handoff_reference", laneKey: "a", stepKey: "implement" }],
      );
    }),
  );

  it.effect("allows {{prev.output}} on a non-first step", () =>
    Effect.gen(function* () {
      const errors = yield* lint([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "implement",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "Implement it.",
              captureOutput: true,
            },
            {
              key: "review",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "Review {{prev.output}}.",
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]);
      assert.deepEqual(errors, []);
    }),
  );

  it.effect("lints handoff references inside a file instruction", () =>
    Effect.gen(function* () {
      const errors = yield* lint(
        [
          {
            key: "a",
            name: "A",
            entry: "auto",
            pipeline: [
              {
                key: "implement",
                type: "agent",
                agent: { instance: "claude_main", model: "sonnet" },
                instruction: { file: "prompts/ok.md" },
              },
            ],
            on: { success: "done" },
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
        {
          ...ctx,
          readInstructionFile: (path: string) =>
            path === "prompts/ok.md" ? "Use {{step.ghost.output}}." : null,
        },
      );
      assert.deepEqual(
        errors.map((e) => ({ code: e.code, laneKey: e.laneKey, stepKey: e.stepKey })),
        [{ code: "invalid_handoff_reference", laneKey: "a", stepKey: "implement" }],
      );
    }),
  );
});
