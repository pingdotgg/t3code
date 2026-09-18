// Relative import (not `@/` alias) so this fixture runs as a bare bun/node
// child without a paths-aware loader. Excluded from the test project's
// typecheck (see tsconfig.test.json) because the relative path crosses
// composite-project boundaries.
import * as Effect from "effect/Effect";
import {
  installShutdownFeedback,
  suppressInterruptMessages,
} from "../../../src/Cli/commands/errors.ts";

if (process.env.SHUTDOWN_FIXTURE_SUPPRESS === "1") {
  Effect.runSync(suppressInterruptMessages);
}
Effect.runSync(installShutdownFeedback);

// Simulates a teardown that takes this long after the first SIGINT. Without
// it the fixture never exits on its own (a hanging cleanup).
const exitAfter = Number.parseInt(
  process.env.SHUTDOWN_FIXTURE_EXIT_AFTER_MS ?? "",
  10,
);
if (Number.isFinite(exitAfter)) {
  process.once("SIGINT", () => {
    setTimeout(() => process.exit(0), exitAfter);
  });
}

console.log("ready");
setInterval(() => {}, 1000);
