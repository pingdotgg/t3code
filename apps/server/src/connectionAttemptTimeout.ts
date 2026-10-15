import * as NodeNet from "node:net";

export function configureConnectionAttemptTimeout() {
  // Allow 1 s for non-final address attempts; Node's 250 ms default can drop slow-but-working connects.
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(
    Math.max(NodeNet.getDefaultAutoSelectFamilyAttemptTimeout(), 1_000),
  );
}
