// The weight client-metrics and mobile-metrics seed: a branch changing many files, and its pull
// request on the fake GitHub with a long body, files, commits and comments.
import type { FakePullRequestDetail } from "./forge.ts";

/** Many files with many lines, so the Diff panel and the PR's files have real weight. */
export const DIFF_FILES = 40;
const DIFF_LINES = 60;
export const sourceFile = (index: number, variant: "before" | "after") =>
  Array.from({ length: DIFF_LINES }, (_, line) =>
    line % 10 === 0
      ? `export function helper${index}_${line}(input: ReadonlyArray<number>) {`
      : line % 10 === 9
        ? "}"
        : variant === "after" && line % 3 === 0
          ? `  const value${line} = input.map((entry) => entry ** ${line}).filter(Boolean); // changed`
          : `  const value${line} = input.map((entry) => entry * ${line}).filter(Boolean);`,
  ).join("\n") + "\n";

export const pullRequestDetail = (): FakePullRequestDetail => {
  const files = Array.from({ length: DIFF_FILES }, (_, index) => {
    const changed = Array.from({ length: DIFF_LINES }, (_, line) => line).filter(
      (line) => line % 10 !== 0 && line % 10 !== 9 && line % 3 === 0,
    );
    const patch = [
      `@@ -1,${DIFF_LINES} +1,${DIFF_LINES} @@`,
      ...changed.flatMap((line) => [
        `-  const value${line} = input.map((entry) => entry * ${line}).filter(Boolean);`,
        `+  const value${line} = input.map((entry) => entry ** ${line}).filter(Boolean); // changed`,
      ]),
    ].join("\n");
    return {
      path: `src/module${index}.ts`,
      additions: changed.length,
      deletions: changed.length,
      patch,
    };
  });
  const section = (title: string) =>
    `## ${title}\n\nThis part of the change moves the helpers behind one entry point. Callers keep their signatures; each module now **squares** its inputs before filtering, and the filters skip falsy values.\n\n- \`src/module0.ts\` through \`src/module9.ts\` read the new helpers\n- the tests cover the empty input and the largest one\n- nothing outside \`src/\` moves\n\n\`\`\`ts\nexport function helper0_0(input: ReadonlyArray<number>) {\n  return input.map((entry) => entry ** 2).filter(Boolean);\n}\n\`\`\`\n`;
  return {
    body: [
      "Squares every helper's input and moves them behind one entry point.",
      ...["Why", "What changed", "How it was tested", "Follow-ups", "Risks"].map(section),
      "| module | before | after |\n| :-- | --: | --: |\n" +
        Array.from(
          { length: 12 },
          (_, index) => `| module${index} | ${index * 3} ms | ${index * 2} ms |`,
        ).join("\n"),
    ].join("\n\n"),
    files,
    comments: Array.from(
      { length: 12 },
      (_, index) =>
        `Comment ${index + 1}: the helper in \`src/module${index}.ts\` reads better now. Could the filter keep zero?\n\n> ${"Quoted context from the review. ".repeat(3)}`,
    ),
    commits: 8,
  };
};
