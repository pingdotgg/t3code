import { assert, it } from "@effect/vitest";

import { formatAsyncUserInputAnswer } from "./asyncUserInputAnswer.ts";

const options = [
  { label: "Blue", description: "Use blue" },
  { label: "Red", description: "Use red" },
];

it.each([
  { scenario: "free text", options: [], answer: "  Blue  ", label: "User answer", text: "Blue" },
  {
    scenario: "selected option",
    options,
    answer: " Blue ",
    label: "Selected option",
    text: "Blue",
  },
  {
    scenario: "opaque option value",
    options: [{ label: "Blue", description: "Use blue", value: "blue-value" }],
    answer: "blue-value",
    label: "Selected option",
    text: "blue-value",
  },
  {
    scenario: "multiple selected options",
    options,
    answer: ["Blue", "Red"],
    label: "Selected options",
    text: "Blue, Red",
  },
  {
    scenario: "custom alternative",
    options,
    answer: "Green",
    label: "Custom answer (instead of the listed options)",
    text: "Green",
  },
  {
    scenario: "custom value mixed with an option",
    options,
    answer: ["Blue", "Green"],
    label: "Custom answer (instead of the listed options)",
    text: "Blue, Green",
  },
])("labels a $scenario reply", ({ options, answer, label, text }) => {
  assert.equal(
    formatAsyncUserInputAnswer(
      { id: "color", header: "Color", question: "Which color?", options },
      answer,
    ),
    `Question (from assistant):\nWhich color?\n\n${label}:\n${text}`,
  );
});
