import { describe, expect, it } from "vite-plus/test";

import type { AcpAdapterV2Flavor } from "./adapter.ts";
import { extractAntigravityElicitationForm } from "./antigravityElicitation.ts";

type ElicitationRequest = Parameters<NonNullable<AcpAdapterV2Flavor["extractElicitationForm"]>>[0];

const formRequest = (
  properties: Record<string, unknown>,
  required?: ReadonlyArray<string>,
): ElicitationRequest =>
  ({
    mode: "form",
    sessionId: "session-1",
    message: "The agent has questions.",
    requestedSchema: {
      type: "object",
      properties,
      ...(required === undefined ? {} : { required }),
    },
  }) as ElicitationRequest;

const singleQuestion = (title: string) => ({
  type: "string",
  title,
  oneOf: [
    { const: "1", title: "(Recommended) Skip research" },
    { const: "2", title: "Run research first", description: "Compare alternatives before coding" },
  ],
});

const multiQuestion = (title: string) => ({
  type: "array",
  title,
  items: {
    anyOf: [
      { const: "1", title: "Typecheck" },
      { const: "2", title: "Unit tests" },
      { const: "3", title: "Fuzzing" },
    ],
  },
});

const otherField = (question: string) => ({
  type: "string",
  title: "Other",
  description: `Optional free-form answer to: ${question}`,
});

const attachment = 'Attached image "shot.png": "/tmp/shot.png"';

describe("extractAntigravityElicitationForm", () => {
  it("folds single- and multi-select qN/qN_other pairs with custom answers enabled", () => {
    const form = extractAntigravityElicitationForm(
      formRequest({
        q1: singleQuestion("Should research run before implementation?"),
        q1_other: otherField("Should research run before implementation?"),
        q2: multiQuestion("Which verification steps should run?"),
        q2_other: otherField("Which verification steps should run?"),
      }),
    );

    expect(form?.questions).toEqual([
      {
        id: "q1",
        header: "Question 1",
        question: "Should research run before implementation?",
        options: [
          {
            value: "1",
            label: "(Recommended) Skip research",
            description: "(Recommended) Skip research",
          },
          {
            value: "2",
            label: "Run research first",
            description: "Compare alternatives before coding",
          },
        ],
      },
      {
        id: "q2",
        header: "Question 2",
        question: "Which verification steps should run?",
        multiSelect: true,
        options: [
          { value: "1", label: "Typecheck", description: "Typecheck" },
          { value: "2", label: "Unit tests", description: "Unit tests" },
          { value: "3", label: "Fuzzing", description: "Fuzzing" },
        ],
      },
    ]);

    expect(form?.respond({ q1: "1", q2: ["1", "3"] })).toEqual({
      action: "accept",
      content: { q1: "1", q2: ["1", "3"] },
    });
  });

  it("restores numeric order from Go's lexicographic map serialization", () => {
    const form = extractAntigravityElicitationForm(
      formRequest({
        q1: singleQuestion("First?"),
        q10: singleQuestion("Tenth?"),
        q10_other: otherField("Tenth?"),
        q1_other: otherField("First?"),
        q2: singleQuestion("Second?"),
        q2_other: otherField("Second?"),
      }),
    );

    expect(
      form?.questions.map((question) => [question.id, question.header, question.question]),
    ).toEqual([
      ["q1", "Question 1", "First?"],
      ["q2", "Question 2", "Second?"],
      ["q10", "Question 3", "Tenth?"],
    ]);
  });

  it("routes custom free-form answers to qN_other for both single- and multi-select", () => {
    const form = extractAntigravityElicitationForm(
      formRequest({
        q1: singleQuestion("Approach?"),
        q1_other: otherField("Approach?"),
        q2: multiQuestion("Checks?"),
        q2_other: otherField("Checks?"),
      }),
    );

    expect(form?.respond({ q1: "Run a quick spike first", q2: "Benchmark latency too" })).toEqual({
      action: "accept",
      content: {
        q1_other: "Run a quick spike first",
        q2_other: "Benchmark latency too",
      },
    });
  });

  it("routes appended attachments alongside selected choices or standalone", () => {
    const form = extractAntigravityElicitationForm(
      formRequest({
        q1: singleQuestion("Approach?"),
        q1_other: otherField("Approach?"),
        q2: multiQuestion("Checks?"),
        q2_other: otherField("Checks?"),
      }),
    );

    expect(
      form?.respond({
        q1: `2\n\n${attachment}`,
        q2: ["1", "3", attachment],
      }),
    ).toEqual({
      action: "accept",
      content: {
        q1: "2",
        q1_other: attachment,
        q2: ["1", "3"],
        q2_other: attachment,
      },
    });

    expect(
      form?.respond({
        q1: `Custom note\n\n${attachment}`,
        q2: attachment,
      }),
    ).toEqual({
      action: "accept",
      content: {
        q1_other: `Custom note\n\n${attachment}`,
        q2_other: attachment,
      },
    });

    expect(
      form?.respond({
        q1: attachment,
        q2: [attachment],
      }),
    ).toEqual({
      action: "accept",
      content: {
        q1_other: attachment,
        q2_other: attachment,
      },
    });
  });

  it("bounds long question and option text without splitting UTF-16 surrogate pairs", () => {
    const longQuestion = `${"a".repeat(7_996)}🚀tail`;
    const longOption = `${"b".repeat(508)}🚀tail`;
    const form = extractAntigravityElicitationForm(
      formRequest({
        q1: {
          type: "string",
          title: longQuestion,
          oneOf: [{ const: "1", title: longOption }],
        },
        q1_other: otherField(longQuestion),
      }),
    );

    const question = form?.questions[0];
    expect(question?.question.length).toBeLessThanOrEqual(8_000);
    expect(question?.question.endsWith("...")).toBe(true);
    expect(question?.question.isWellFormed()).toBe(true);
    expect(question?.options[0]?.label.length).toBeLessThanOrEqual(512);
    expect(question?.options[0]?.label.endsWith("...")).toBe(true);
    expect(question?.options[0]?.label.isWellFormed()).toBe(true);
  });

  it.each([
    ["missing answer", {}],
    ["blank single-select answer", { q1: "   ", q2: ["1"] }],
    ["array for single-select", { q1: ["1"], q2: ["1"] }],
    ["empty array for multi-select", { q1: "1", q2: [] }],
    ["blank string for multi-select", { q1: "1", q2: "  " }],
    ["unknown option in multi-select", { q1: "1", q2: ["1", "unknown"] }],
    ["non-string entry in multi-select", { q1: "1", q2: ["1", 2] }],
  ])("cancels on %s", (_, answers) => {
    const form = extractAntigravityElicitationForm(
      formRequest({
        q1: singleQuestion("Approach?"),
        q1_other: otherField("Approach?"),
        q2: multiQuestion("Checks?"),
        q2_other: otherField("Checks?"),
      }),
    );

    expect(form?.respond(answers as never)).toEqual({ action: "cancel" });
  });

  it.each<{
    readonly label: string;
    readonly properties: Record<string, unknown>;
    readonly required?: ReadonlyArray<string>;
  }>([
    { label: "empty properties", properties: {} },
    {
      label: "unrelated field",
      properties: {
        q1: singleQuestion("A?"),
        q1_other: otherField("A?"),
        extra: { type: "string" },
      },
    },
    { label: "missing companion", properties: { q1: singleQuestion("A?") } },
    { label: "orphan companion", properties: { q1_other: otherField("A?") } },
    {
      label: "wrong companion title",
      properties: { q1: singleQuestion("A?"), q1_other: { type: "string", title: "Notes" } },
    },
    {
      label: "choice companion",
      properties: {
        q1: singleQuestion("A?"),
        q1_other: { type: "string", title: "Other", enum: ["x"] },
      },
    },
    { label: "q0 index", properties: { q0: singleQuestion("A?"), q0_other: otherField("A?") } },
    {
      label: "duplicate option const",
      properties: {
        q1: {
          type: "string",
          title: "A?",
          oneOf: [
            { const: "1", title: "One" },
            { const: "1", title: "Also one" },
          ],
        },
        q1_other: otherField("A?"),
      },
    },
    {
      label: "empty choices",
      properties: { q1: { type: "string", title: "A?", oneOf: [] }, q1_other: otherField("A?") },
    },
    {
      label: "constrained multi-select",
      properties: {
        q1: { ...multiQuestion("A?"), minItems: 1 },
        q1_other: otherField("A?"),
      },
    },
    {
      label: "non-empty required list",
      properties: { q1: singleQuestion("A?"), q1_other: otherField("A?") },
      required: ["q1"],
    },
  ])("falls back to generic parsing for $label", ({ properties, required }) => {
    expect(extractAntigravityElicitationForm(formRequest(properties, required))).toBeUndefined();
  });
});
