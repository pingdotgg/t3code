import { useAtomValue } from "@effect/atom-react";
import type { NetworkRoster } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { networkMembers } from "./networkMembers";
import { useAtomCommand } from "./use-atom-command";

/** Follows the user's network through every connected member and renews members it opened. */
export function NetworkMembersSync() {
  const reports = useAtomValue(networkMembers.reportsAtom);
  const renewals = useAtomValue(networkMembers.renewalsAtom);
  const follow = useAtomCommand(networkMembers.follow, "network members follow");
  const open = useAtomCommand(networkMembers.open, { reportFailure: false });
  const followed = useRef(new Map<EnvironmentId, NetworkRoster | null>());
  const renewing = useRef(new Map<EnvironmentId, string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes each connected member's roster into the saved catalog
  useEffect(() => {
    for (const report of reports) {
      if (followed.current.has(report.host) && followed.current.get(report.host) === report.roster)
        continue;
      followed.current.set(report.host, report.roster);
      void follow(report);
    }
  }, [reports, follow]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mints a fresh credential through another member when a host refuses the saved one
  useEffect(() => {
    const due = new Set(renewals.map((renewal) => renewal.environmentId));
    for (const environmentId of renewing.current.keys()) {
      if (!due.has(environmentId)) renewing.current.delete(environmentId);
    }
    for (const renewal of renewals) {
      if (renewing.current.get(renewal.environmentId) === renewal.attemptKey) continue;
      renewing.current.set(renewal.environmentId, renewal.attemptKey);
      void open(renewal.environmentId);
    }
  }, [renewals, open]);
  return null;
}
