#!/usr/bin/env node
// A Claude CLI that answers only the probe: signed in on Max, the account-wide weekly limit
// 42% spent and the Fable weekly bucket 100% spent. It runs no model.
import * as NodeReadline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("claude 2.1.300\n");
  process.exit(0);
}
const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
const replies = {
  initialize: {
    commands: [],
    agents: [],
    models: [],
    output_style: "default",
    available_output_styles: ["default"],
    account: { email: "scenario@example.invalid", subscriptionType: "max", tokenSource: "oauth" },
  },
  get_usage: {
    session: {},
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 10, resets_at: inDays(0.1) },
      seven_day: { utilization: 42, resets_at: inDays(3) },
      model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: inDays(3) }],
    },
  },
  get_settings: { effective: {}, sources: [] },
};
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request") return;
  const reply = replies[message.request?.subtype];
  if (reply === undefined) return;
  process.stdout.write(
    JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response: reply },
    }) + "\n",
  );
});
const keepAlive = setInterval(() => {}, 1_000);
lines.on("close", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
