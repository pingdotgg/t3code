#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
const requiredCwd = process.env.T3_CLAUDE_REQUIRED_CWD;
if (requiredCwd && process.cwd() !== NodeFS.realpathSync(requiredCwd)) {
  process.stderr.write(`claude: refusing to run outside ${requiredCwd}\n`);
  process.exit(1);
}
if (process.argv.includes("--version")) {
  process.stdout.write("claude 2.1.219\n");
  process.exit(0);
}
const loginMarker = process.env.T3_CLAUDE_LOGIN_MARKER;
const signedOut = loginMarker !== undefined && !NodeFS.existsSync(loginMarker);
if (process.env.T3_CLAUDE_PROBE_LOG)
  NodeFS.appendFileSync(process.env.T3_CLAUDE_PROBE_LOG, "probe\n");
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request") return;
  if (message.request?.subtype === "get_usage" && signedOut) {
    process.stdout.write(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: { session: {}, rate_limits_available: false, rate_limits: null },
        },
      }) + "\n",
    );
    return;
  }
  if (message.request?.subtype === "get_usage") {
    const marker = process.env.T3_CLAUDE_RESET_MARKER;
    const usageFailsUntil = process.env.T3_CLAUDE_USAGE_FAILS_UNTIL;
    if (
      (usageFailsUntil && !NodeFS.existsSync(usageFailsUntil)) ||
      (process.env.T3_CLAUDE_USAGE_FAILS_AFTER_CLAIM && marker && NodeFS.existsSync(marker))
    ) {
      process.stdout.write(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "error", request_id: message.request_id, error: "usage failed" },
        }) + "\n",
      );
      return;
    }
    process.stdout.write(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            session: {},
            subscription_type: "pro",
            rate_limits_available: true,
            rate_limits: {
              five_hour: {
                utilization: marker && NodeFS.existsSync(marker) ? 0 : 100,
                resets_at: null,
              },
            },
          },
        },
      }) + "\n",
    );
    return;
  }
  if (message.request?.subtype !== "initialize") return;
  process.stdout.write(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [],
          agents: [],
          models: [],
          output_style: "default",
          available_output_styles: ["default"],
          account: signedOut
            ? { tokenSource: "none", apiProvider: "firstParty" }
            : { email: "test@example.com", subscriptionType: "pro", tokenSource: "oauth" },
        },
      },
    }) + "\n",
  );
});
// Stay alive for follow-up control requests, but never outlive the
// parent: the probe aborts the SDK without awaiting the child, so an
// unconditional interval would strand this process until reboot.
const keepAlive = setInterval(() => {}, 1_000);
lines.on("close", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
