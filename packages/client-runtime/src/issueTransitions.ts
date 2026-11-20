import type { IssueTransition } from "@t3tools/contracts";

export type IssueTransitionDrafts = Readonly<Record<string, string | ReadonlyArray<string>>>;

export function issueTransitionSubmission(
  transition: IssueTransition,
  drafts: IssueTransitionDrafts,
) {
  const fields: Record<string, string | number | ReadonlyArray<string>> = {};
  const errors: Record<
    string,
    | "required"
    | "invalid-choice"
    | "invalid-number"
    | "invalid-date"
    | "invalid-datetime"
    | "invalid-value"
  > = {};
  let blocked = false;
  for (const field of transition.fields) {
    if (field.type === "unsupported") {
      if (field.required) blocked = true;
      continue;
    }
    const draft = drafts[field.id];
    const empty =
      draft === undefined ||
      (typeof draft === "string" ? draft.trim().length === 0 : draft.length === 0);
    if (empty) {
      if (field.required) errors[field.id] = "required";
      continue;
    }
    const known = new Set(field.options.map((option) => option.value));
    if (field.type === "multiselect") {
      if (!Array.isArray(draft) || draft.some((value) => !known.has(value)))
        errors[field.id] = "invalid-choice";
      else fields[field.id] = draft;
      continue;
    }
    if (typeof draft !== "string") {
      errors[field.id] = "invalid-value";
      continue;
    }
    if (field.type === "number") {
      const number = Number(draft);
      if (!Number.isFinite(number)) errors[field.id] = "invalid-number";
      else fields[field.id] = number;
    } else if (field.type === "select" && !known.has(draft)) {
      errors[field.id] = "invalid-choice";
    } else if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(draft)) {
      errors[field.id] = "invalid-date";
    } else if (field.type === "datetime") {
      // @effect-diagnostics-next-line globalDate:off - A zoneless datetime-local value is local time; DateTime would read UTC.
      const parsed = new Date(draft);
      if (Number.isNaN(parsed.getTime())) errors[field.id] = "invalid-datetime";
      else fields[field.id] = parsed.toISOString();
    } else {
      fields[field.id] = draft;
    }
  }
  return { fields, errors, blocked };
}
