import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../i18n/messages";

import type { AgentActivityText } from "./AgentActivity";

function countTable(maxCount: number, format: (count: number) => string) {
  return Object.fromEntries(
    Array.from({ length: maxCount }, (_, index) => [String(index + 1), format(index + 1)]),
  );
}

/** Translated widget copy, with count tables for counts up to `maxCount`. */
export function agentActivityText(
  maxCount: number,
  resolve: MessageResolver = m,
): AgentActivityText {
  return {
    workingFormat: resolve(msg("{count} working", { count: "{count}" })),
    working: {
      "0": resolve(msg("{count} working", { count: 0 })),
      ...countTable(maxCount, (count) => resolve(msg("{count} working", { count }))),
    },
    moreThreads: countTable(maxCount, (count) =>
      resolve(msg("{count} more threads · Open {product}", { count, product: "T3" })),
    ),
    openToRefresh: resolve(msg("Open {product} to refresh", { product: "T3" })),
    outOfDate: resolve(msg("Out of date")),
    failed: resolve(msg("Failed", { $context: "agent work status" })),
    done: resolve(msg("Done", { $context: "agent work status" })),
    workFailed: resolve(msg("Agent work failed")),
    workCompleted: resolve(msg("Agent work completed")),
    statusOutOfDate: resolve(msg("Agent status out of date")),
    approval: resolve(msg("Approval", { $context: "agent waits for an approval" })),
    input: resolve(msg("Input", { $context: "agent waits for user input" })),
    noActiveAgents: resolve(msg("No active agents")),
    activeAgents: countTable(maxCount, (count) =>
      resolve(
        msg("{count, plural, one {{count} active agent} other {{count} active agents}}", {
          count,
        }),
      ),
    ),
    active: countTable(maxCount, (count) =>
      resolve(
        msg("{count, plural, one {{count} active} other {{count} active}}", {
          count,
          $context: "number of agents working",
        }),
      ),
    ),
    needAttention: countTable(maxCount, (count) =>
      resolve(
        msg("{count, plural, one {{count} needs attention} other {{count} need attention}}", {
          count,
        }),
      ),
    ),
    needYou: countTable(maxCount, (count) =>
      resolve(msg("{count, plural, one {{count} needs you} other {{count} need you}}", { count })),
    ),
  };
}
