import type { ForYouItem } from "../domain/forYou";
import { mergeTicketKey } from "../domain/readiness";
import { usePrContext, useTicketPr, useTicketReadiness } from "../state/prStatus";
import { MergeConditions } from "./MergeConditions";
import { ReadinessChecklist } from "./ReadinessChecklist";

type MergeItem = Extract<ForYouItem, { readonly kind: "merge_approval" }>;

/** A merge approval's conditions, with the live result beside the orchestrator's claims and the checks in the Checks tab's rows when the board knows the ticket. */
export function MergeApprovalConditions({ item }: { item: MergeItem }) {
  const { tickets } = usePrContext();
  const key = mergeTicketKey(
    item,
    tickets.map((view) => view.ticket.key),
  );
  const view = tickets.find((entry) => entry.ticket.key === key) ?? null;
  const conditions = useTicketReadiness(view);
  const { live, now } = useTicketPr(view);
  return conditions === null ? (
    <MergeConditions conditions={item.conditions} />
  ) : (
    <ReadinessChecklist
      conditions={conditions}
      claims={item.conditions}
      checks={{ runs: live?.checks ?? [], now }}
    />
  );
}
