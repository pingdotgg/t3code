import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Account } from "../Account/Account.aggregate.ts";
import { Cents } from "../Money.ts";

/** Daily outflow above which an account's activity is reviewed, in cents. */
export const REVIEW_THRESHOLD = 50_000;

/** An account's money out today crossed {@link REVIEW_THRESHOLD}. */
export class DailyOutflowExceeded extends Domain.Event("DailyOutflowExceeded", {
  day: Schema.String,
  total: Cents,
}) {}

const add = (
  s: { readonly day: string; readonly total: number },
  amount: number,
  at: DateTime.Utc,
) => {
  const day = DateTime.formatIsoDateUtc(at);
  return { day, total: (s.day === day ? s.total : 0) + amount };
};

const crossed = (
  _: unknown,
  {
    before,
    after,
  }: {
    readonly before: { readonly total: number };
    readonly after: { readonly day: string; readonly total: number } | null;
  },
) =>
  after && before.total < REVIEW_THRESHOLD && after.total >= REVIEW_THRESHOLD
    ? new DailyOutflowExceeded({ day: after.day, total: after.total })
    : undefined;

/**
 * Money out of an account per day. It emits a synthetic event when the day's
 * total crosses the threshold, so split withdrawals are caught too.
 */
export class DailyOutflow extends Domain.View("DailyOutflow", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ day: Schema.String, total: Cents }),
  initial: { day: "", total: 0 },
  evolve: {
    MoneyWithdrawn: (s, e, { at }) => add(s, e.amount, at),
    TransferDebited: (s, e, { at }) => add(s, e.amount, at),
  },
  events: [DailyOutflowExceeded],
  emit: {
    MoneyWithdrawn: crossed,
    TransferDebited: crossed,
  },
}) {}
