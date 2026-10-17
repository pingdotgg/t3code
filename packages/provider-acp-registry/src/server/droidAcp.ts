import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";

type Form = NonNullable<ReturnType<NonNullable<AcpAdapterV2Flavor["extractElicitationForm"]>>>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Droid 0.243.0 pairs each choice with an optional *_other field. T3's
// question already has a custom-answer input; restore the pair on the wire.
export const extractDroidElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form") return undefined;
  const schema = record(request.requestedSchema);
  const properties = record(schema?.properties);
  if (properties === undefined || !Array.isArray(schema?.required)) return undefined;
  const questions: Array<Form["questions"][number]> = [];
  const consumed = new Set<string>();
  for (const [id, value] of Object.entries(properties)) {
    if (!/^question_[1-9]\d*$/.test(id)) continue;
    const field = record(value);
    const other = record(properties[`${id}_other`]);
    if (
      field?.type !== "string" ||
      !Array.isArray(field.oneOf) ||
      typeof field.title !== "string" ||
      typeof field.description !== "string" ||
      other?.type !== "string"
    )
      return undefined;
    const options: Array<Form["questions"][number]["options"][number]> = [];
    let hasOther = false;
    for (const entry of field.oneOf) {
      const option = record(entry);
      if (typeof option?.const !== "string" || typeof option.title !== "string") return undefined;
      if (option.const === "other") hasOther = true;
      else options.push({ label: option.title, description: option.title, value: option.const });
    }
    if (!hasOther || options.length === 0) return undefined;
    questions.push({ id, header: field.title, question: field.description, options });
    consumed.add(id);
    consumed.add(`${id}_other`);
  }
  // A changed or unrelated form must retain its standard ACP interpretation.
  const required = new Set(schema.required);
  if (
    questions.length === 0 ||
    consumed.size !== Object.keys(properties).length ||
    required.size !== questions.length ||
    questions.some((question) => !required.has(question.id))
  ) {
    return undefined;
  }
  return {
    questions,
    respond: (answers) => {
      const entries: Array<[string, string]> = [];
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        if (typeof answer !== "string" || answer.trim().length === 0) return { action: "cancel" };
        if (question.options.some((option) => option.value === answer)) {
          entries.push([question.id, answer]);
        } else {
          entries.push([question.id, "other"], [`${question.id}_other`, answer]);
        }
      }
      return { action: "accept", content: Object.fromEntries(entries) };
    },
  };
};
