import { RegistryContext } from "@effect/atom-react";
import { useCallback, useContext, useState } from "react";

import { checksReading } from "../board/PrChip";
import { EmptyFiles } from "../files/EmptyFiles";
import type { TicketView } from "../state/boardModel";
import { checksDotAtom } from "../state/checksView";
import { usePrContext, useTicketPr } from "../state/prStatus";
import { PrView } from "./PrView";

/** The Checks tab for one ticket: its pull request when it has one, and the CI dot for the tab's icon. */
export function TicketChecks({ view, active }: { view: TicketView; active: boolean }) {
  // A board whose Checks tab stays closed never reads the pull request for it.
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);
  const registry = useContext(RegistryContext);
  const { project } = usePrContext();
  const { ref, key, live, now } = useTicketPr(view);
  const reading = live === null ? "none" : checksReading(live, now);
  // The repo bans useEffect, so a ref callback on a hidden node hands the tab icon the reading and takes it back when the ticket changes or the board closes.
  const publish = useCallback(
    (node: HTMLElement | null) => registry.set(checksDotAtom, node === null ? "none" : reading),
    [registry, reading],
  );
  return (
    <>
      <span hidden ref={publish} />
      {ref === null || key === null ? (
        <EmptyFiles>This ticket has no pull request yet.</EmptyFiles>
      ) : (
        opened && (
          <PrView
            key={key}
            environmentId={project.environmentId}
            reference={ref}
            live={live}
            now={now}
            active={active}
          />
        )
      )}
    </>
  );
}
