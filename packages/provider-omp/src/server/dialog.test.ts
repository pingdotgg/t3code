import { expect, it } from "vite-plus/test";
import { dialogAnswer, readQuestions } from "./dialog.ts";

it("shows OMP's checked rows while returning one native toggle or continue action", () => {
  const questions = readQuestions(
    {
      method: "select",
      title: "Choose tasks",
      options: ["Lint", "Build", "Continue"],
      optionDetails: [{ description: "Check code style" }],
      checkedIndices: [1],
      selectionMarker: "checkbox",
      markableCount: 2,
    },
    "selection",
  ).filter((question) => question !== undefined);
  expect(questions[0]?.options).toEqual([
    { label: "☐ Lint", value: "Lint", description: "Check code style" },
    { label: "☑ Build", value: "Build", description: "Build" },
    { label: "Continue", value: "Continue", description: "Continue" },
  ]);
  expect(dialogAnswer("select", questions, { selection: "Build" })).toEqual({ value: "Build" });
  expect(dialogAnswer("select", questions, { selection: "Continue" })).toEqual({
    value: "Continue",
  });
  expect(dialogAnswer("select", questions, { selection: ["Lint", "Build"] })).toBeUndefined();
});
