import type { FormInfo } from "@opencode-ai/sdk-next/v2";
import { describe, expect, it } from "vite-plus/test";

import { openCode2FormAnswer, openCode2FormQuestions } from "./OpenCode2AdapterV2.ts";

// Shape observed live on next-16570: the question tool emits form.created with
// metadata.kind "question" instead of question.v2.asked.
const QUESTION_FORM = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_1", callID: "call_1" } },
  fields: [
    {
      key: "q0",
      title: "Quick check",
      description: "Is the sky blue?",
      type: "string",
      options: [
        { value: "yes", label: "Yes, proceed", description: "You are ready to proceed" },
        { value: "no", label: "No", description: "You are not ready yet" },
      ],
      custom: true,
    },
  ],
} as FormInfo;

describe("openCode2FormQuestions", () => {
  it("maps a question-kind form onto the question request shape", () => {
    expect(openCode2FormQuestions(QUESTION_FORM)).toEqual({
      questions: [
        {
          header: "Quick check",
          question: "Is the sky blue?",
          options: [
            { label: "Yes, proceed", description: "You are ready to proceed" },
            { label: "No", description: "You are not ready yet" },
          ],
          custom: true,
        },
      ],
      fieldKeys: ["q0"],
      optionValuesByLabel: [{ "Yes, proceed": "yes", No: "no" }],
    });
  });

  it("falls back to the form title and preserves multiselect fields", () => {
    const { questions } = openCode2FormQuestions({
      ...QUESTION_FORM,
      fields: [
        {
          key: "picks",
          type: "multiselect",
          options: [{ value: "a", label: "A" }],
        },
      ],
    } as FormInfo);

    expect(questions).toEqual([
      {
        header: "Questions",
        question: "Questions",
        options: [{ label: "A", description: "" }],
        multiple: true,
      },
    ]);
  });

  it("builds option lookups without inherited property names", () => {
    const { optionValuesByLabel } = openCode2FormQuestions({
      ...QUESTION_FORM,
      fields: [
        {
          key: "q0",
          type: "string",
          options: [
            { value: "prototype-value", label: "__proto__" },
            { value: "constructor-value", label: "constructor" },
          ],
          custom: true,
        },
      ],
    } as FormInfo);
    const valuesByLabel = optionValuesByLabel[0]!;

    expect(Object.getPrototypeOf(valuesByLabel)).toBeNull();
    expect(Object.hasOwn(valuesByLabel, "__proto__")).toBe(true);
    expect(valuesByLabel["__proto__"]).toBe("prototype-value");
    expect(valuesByLabel.constructor).toBe("constructor-value");
    expect(valuesByLabel.toString).toBeUndefined();
  });
});

describe("openCode2FormAnswer", () => {
  // The UI answers with option labels; the wire wants option values, and
  // free-text custom answers pass through untranslated.
  it("translates labels to values and keeps custom answers", () => {
    expect(
      openCode2FormAnswer(
        ["q0", "q1"],
        [["Yes, proceed"], ["something custom"]],
        [{ "Yes, proceed": "yes", No: "no" }, {}],
      ),
    ).toEqual({ q0: "yes", q1: "something custom" });
  });

  it("collapses single selections, keeps multi-values, omits unanswered", () => {
    expect(openCode2FormAnswer(["q0", "picks", "skipped"], [["Yes"], ["a", "b"]])).toEqual({
      q0: "Yes",
      picks: ["a", "b"],
    });
  });

  it("keeps a single multiselect answer as an array", () => {
    expect(openCode2FormAnswer(["picks"], [["A"]], [{ A: "a" }], [true])).toEqual({
      picks: ["a"],
    });
  });

  it("preserves hostile field keys and custom answers as own properties", () => {
    const answer = openCode2FormAnswer(
      ["__proto__", "constructor", "toString", "freeProto"],
      [["prototype", "answer"], ["constructor"], ["toString"], ["__proto__"]],
      [{}, {}, {}, {}],
      [true, false, false, false],
    );

    expect(Object.getPrototypeOf(answer)).toBeNull();
    expect(Object.hasOwn(answer, "__proto__")).toBe(true);
    expect(Object.hasOwn(answer, "constructor")).toBe(true);
    expect(Object.hasOwn(answer, "toString")).toBe(true);
    const expected = {
      ["__proto__"]: ["prototype", "answer"],
      constructor: "constructor",
      freeProto: "__proto__",
      toString: "toString",
    };
    expect({ ...answer }).toEqual(expected);
    expect(JSON.parse(JSON.stringify(answer))).toEqual(expected);
  });
});
