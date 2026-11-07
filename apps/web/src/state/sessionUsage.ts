import { Atom } from "effect/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";
import { SESSION_USAGE_WINDOW } from "../lib/sessionUsage";
import { workingUsageQuery } from "./workingUsageQuery";

// One timer per environment, shared by every usage badge and context meter.
export const sessionUsageAtom = Atom.family((environmentId: EnvironmentId) => {
  const working = Atom.make((get) =>
    get(environmentThreadShells.environmentThreadsAtom(environmentId)).some(
      (thread) => thread.status === "running",
    ),
  );
  const query = serverEnvironment.threadUsageSummary({
    environmentId,
    input: SESSION_USAGE_WINDOW,
  });
  return workingUsageQuery(query, working);
});
