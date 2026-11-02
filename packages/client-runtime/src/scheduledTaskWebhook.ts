import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  ScheduledTaskWebhookFilter,
  type ScheduledTaskWebhookFilterOp,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const DEFAULT_WEBHOOK_PROMPT = "Handle this webhook:\n{{body}}";

/** Blank means "no limit"; undefined means the input is not a valid limit, which blocks saving. */
export function parseMaxDeliveryAge(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const minutes = Number(value.trim());
  return Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_WEBHOOK_DELIVERY_AGE_MINUTES
    ? minutes
    : undefined;
}

/**
 * One editable filter row. `in` takes a comma-separated list, which is
 * lossless because list values can't contain commas; `exists` ignores the value.
 */
export interface WebhookFilterDraft {
  /** Stable row identity for the form; never sent to the server. */
  readonly id: string;
  readonly path: string;
  readonly op: ScheduledTaskWebhookFilterOp;
  readonly value: string;
}

export const WEBHOOK_FILTER_OPS: ReadonlyArray<{
  readonly op: ScheduledTaskWebhookFilterOp;
  readonly label: string;
}> = [
  { op: "equals", label: "equals" },
  { op: "notEquals", label: "does not equal" },
  { op: "in", label: "is one of" },
  { op: "startsWith", label: "starts with" },
  { op: "exists", label: "exists" },
];

let lastWebhookFilterDraftId = 0;
const nextWebhookFilterDraftId = () => `filter-${++lastWebhookFilterDraftId}`;

export function emptyWebhookFilterDraft(): WebhookFilterDraft {
  return { id: nextWebhookFilterDraftId(), path: "", op: "equals", value: "" };
}

/** By id, so a removed row's identity never passes to the row after it. */
export function removeWebhookFilterDraft(
  drafts: ReadonlyArray<WebhookFilterDraft>,
  id: string,
): ReadonlyArray<WebhookFilterDraft> {
  return drafts.filter((draft) => draft.id !== id);
}

export function webhookFilterDrafts(
  filters: ReadonlyArray<ScheduledTaskWebhookFilter> | undefined,
): ReadonlyArray<WebhookFilterDraft> {
  return (filters ?? []).map((filter) => ({
    id: nextWebhookFilterDraftId(),
    path: filter.path,
    op: filter.op,
    value:
      filter.op === "exists" ? "" : filter.op === "in" ? filter.value.join(", ") : filter.value,
  }));
}

const decodeFilter = Schema.decodeUnknownOption(ScheduledTaskWebhookFilter);

/**
 * Checks each row with the server's own schema, so a draft that parses here
 * also saves. The error names the first row that would not.
 */
export function parseWebhookFilterDrafts(
  drafts: ReadonlyArray<WebhookFilterDraft>,
): { readonly filters: ReadonlyArray<ScheduledTaskWebhookFilter> } | { readonly error: string } {
  if (drafts.length > MAX_WEBHOOK_FILTERS) {
    return { error: `Use at most ${MAX_WEBHOOK_FILTERS} filters.` };
  }
  const filters: ScheduledTaskWebhookFilter[] = [];
  for (const [index, draft] of drafts.entries()) {
    const path = draft.path.trim();
    const filter = decodeFilter(
      draft.op === "exists"
        ? { path, op: draft.op }
        : draft.op === "in"
          ? {
              path,
              op: draft.op,
              value: draft.value
                .split(",")
                .map((item) => item.trim())
                .filter((item) => item !== ""),
            }
          : { path, op: draft.op, value: draft.value },
    );
    if (Option.isNone(filter)) {
      return {
        error: `Filter ${index + 1} needs a path under body, headers or query${
          draft.op === "exists"
            ? "."
            : draft.op === "in"
              ? ", and at least one value."
              : ", and a value."
        }`,
      };
    }
    filters.push(filter.value);
  }
  return { filters };
}

/**
 * Whether a form's filter rows differ from the ones it opened with. A save
 * leaves `filters` out unless they did, so editing only the title can't
 * overwrite filters another device changed in the meantime.
 */
export function webhookFilterDraftsChanged(
  saved: ReadonlyArray<WebhookFilterDraft>,
  current: ReadonlyArray<WebhookFilterDraft>,
): boolean {
  return (
    saved.length !== current.length ||
    saved.some(
      (filter, index) =>
        filter.path !== current[index]?.path ||
        filter.op !== current[index]?.op ||
        (filter.op !== "exists" && filter.value !== current[index]?.value),
    )
  );
}
