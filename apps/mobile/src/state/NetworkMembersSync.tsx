import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { networkMembers } from "./networkMembers";
import { useAtomCommand } from "./use-atom-command";

/** Follows the user's network live through every connected member and renews members it opened. */
export function NetworkMembersSync() {
  const reports = useAtomValue(networkMembers.reportsAtom);
  const renewals = useAtomValue(networkMembers.renewalsAtom);
  const follow = useAtomCommand(networkMembers.follow, "network members follow");
  const renew = useAtomCommand(networkMembers.renew, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the followed hosts' rosters into the saved catalog
  useEffect(() => {
    void follow(reports);
  }, [reports, follow]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mints a fresh credential through another member when a host refuses the saved one; the runtime bounds and spaces attempts
  useEffect(() => {
    for (const renewal of renewals) void renew(renewal);
  }, [renewals, renew]);
  return null;
}
