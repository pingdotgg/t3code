import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isNonEmpty());

const Lane = Schema.Struct({
  skill: Text,
  runsWhen: Text,
  mode: Schema.optionalKey(Text),
});

export const ReviewTemplate = Schema.Struct({
  name: Text,
  authorChecks: Schema.Array(Text),
  lanes: Schema.Array(Lane),
});
export type ReviewTemplate = typeof ReviewTemplate.Type;

export const EVERY_TICKET = "on every ticket";

/** The `review-loop` skill as written. Every board starts on it, and nobody can edit or delete it. */
export const SYSTEM_TEMPLATE: ReviewTemplate = {
  name: "Review loop",
  authorChecks: ["simplify", "no-comments", "unslop", "pre-pr-reviewer"],
  lanes: [
    { skill: "ponytail-review", runsWhen: "always" },
    { skill: "test-evidence-review", runsWhen: "when the diff adds or changes tests" },
    {
      skill: "security-audit",
      mode: "guidance mode",
      runsWhen:
        "when the diff renders outside content, handles a key or token, or writes outside the app",
    },
    {
      skill: "receipts",
      runsWhen:
        "when the work claims test runs, screenshots, or other evidence; check each claim against its file",
    },
  ],
};

/** A custom template of the saved name, or the system template when the board has no pick or the pick is gone. */
export function pickTemplate(
  name: string | undefined,
  custom: ReadonlyArray<ReviewTemplate>,
): ReviewTemplate {
  return custom.find((template) => template.name === name) ?? SYSTEM_TEMPLATE;
}

const skills = (names: ReadonlyArray<string>) =>
  names.length === 0 ? "none" : names.map((name) => `\`${name}\``).join(", ");

/** The template as the board facts and the change message state it. */
export function templateFacts(template: ReviewTemplate): string {
  return [
    `- The review template is \`${template.name}\`. Run it on every ticket, with the review-loop skill's rules.`,
    `  - Author checks, which the builder runs before it reports code-ready: ${skills(template.authorChecks)}.`,
    "  - Reviewer lanes, which you start after it, each as its own child:",
    ...(template.lanes.length === 0
      ? ["    - none."]
      : template.lanes.map(
          (lane) =>
            `    - \`${lane.skill}\`${lane.mode === undefined ? "" : ` in ${lane.mode}`}: ${lane.runsWhen}.`,
        )),
  ].join("\n");
}
