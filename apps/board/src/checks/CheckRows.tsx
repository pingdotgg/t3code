import { useMemo } from "react";

import type { CheckRun } from "../domain/readiness";
import { CheckRow } from "./CheckRow";
import { sortChecks } from "./checkList";

/** The checks as the Checks tab, the peek drawer, and the merge approval card all list them: failing first, then running, then the rest. */
export function CheckRows({ checks, now }: { checks: ReadonlyArray<CheckRun>; now: number }) {
  const rows = useMemo(() => {
    const seen = new Map<string, number>();
    return sortChecks(checks).map((check) => {
      const base = `${check.name}\n${check.url ?? ""}`;
      // Names can repeat, so a repeat takes the next number and keeps its open state apart.
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { check, key: `${base}\n${count}` };
    });
  }, [checks]);
  return (
    <ul aria-label="Checks" className="flex flex-col">
      {rows.map(({ check, key }) => (
        <CheckRow key={key} check={check} now={now} />
      ))}
    </ul>
  );
}
