import { MAX_WEBHOOK_DELIVERY_AGE_MINUTES } from "@t3tools/contracts";

/** Prompt a new webhook task starts with: just the body, so request headers stay out unless the user adds them. */
export const DEFAULT_WEBHOOK_PROMPT = "Handle this webhook:\n{{body}}";

/** Blank means "no limit"; undefined means the input is not a valid limit, which blocks saving. */
export function parseMaxDeliveryAge(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const minutes = Number(value.trim());
  return Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_WEBHOOK_DELIVERY_AGE_MINUTES
    ? minutes
    : undefined;
}
