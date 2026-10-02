import { ProviderInstanceId } from "@t3tools/contracts";

import type { OrchestratorFixtureInput } from "../shared.ts";

/**
 * Hand-ported (no account on hand can reach Luna Reserve on demand). The
 * ordinary turn frames come from the recorded multi_turn capture; the rest are
 * shaped from openai/codex rust-v0.156.1:
 * - usage-limit stop: core/src/session/turn.rs:1664-1668 and 796-810,
 *   app-server/src/bespoke_event_handling.rs:1030-1052, 1501-1520, 1572-1624,
 *   message text protocol/src/error.rs:725-728, code error.rs:449-451.
 * - account/rateLimits/read: request per tui/src/app/background_requests.rs:788-795
 *   and app-server-protocol/src/protocol/v2/account.rs:311-324; response per
 *   app-server/src/request_processors/account_processor.rs:1197-1211 with the
 *   Reserve bucket from backend-client/src/client/rate_limit_resets.rs:45-57 and
 *   the banner from tui/src/app/tests/luna_reserve_recovery_tests.rs:10-25.
 */
export const LUNA_RESERVE_PROMPTS = [
  "Respond with exactly: ordinary quota turn complete",
  "Respond with exactly: exhausted quota turn complete",
  "Respond with exactly: luna reserve turn complete",
  "Respond with exactly: recovered quota turn complete",
] as const;

export const LUNA_RESERVE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
  options: [{ id: "reasoningEffort", value: "medium" }],
};

export function codexLunaReserveInput(): OrchestratorFixtureInput {
  return { steps: LUNA_RESERVE_PROMPTS.map((text) => ({ type: "message", text })) };
}
