import type { TicketView } from "../state/boardModel";
import { useTicketReadiness } from "../state/prStatus";
import { ReadinessChecklist } from "./ReadinessChecklist";

/** A ticket's merge-ready conditions in the Ticket tab, with how many hold. */
export function TicketReadiness({ view }: { view: TicketView }) {
  const conditions = useTicketReadiness(view) ?? [];
  const met = conditions.filter((condition) => condition.met).length;
  return (
    <section className="border-b border-line px-3 py-2 text-[12px]">
      <p className="mb-1 text-[10px] text-faint uppercase">
        Merge readiness · {met} of {conditions.length} met
      </p>
      <ReadinessChecklist conditions={conditions} />
    </section>
  );
}
