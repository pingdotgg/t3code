// Fake CLIProxyAPI management API serving the Limits scenarios in scenarios.json.
// Usage: node hub.mjs <state.json> [port]. state.json is {"scenario": "A", "n0": <epoch ms>};
// it is re-read on every request, so edit it and press Refresh limits to switch scenarios.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

const [statePath, port = "18517"] = process.argv.slice(2);
if (!statePath) throw new Error("usage: node hub.mjs <state.json> [port]");
const scenarios = JSON.parse(
  NodeFS.readFileSync(new URL("./scenarios.json", import.meta.url), "utf8"),
);
const MINUTE = 60_000;

// A window is [usedPercent, minutesFromN0 | null]; null is unknown reset timing.
const at = (n0, minutes) => (minutes === null ? null : n0 + minutes * MINUTE);
const usage = (account, n0) => {
  const [session, weekly, fable] = account.windows;
  if (account.provider === "codex") {
    const window = ([used, minutes], seconds) => ({
      used_percent: used,
      reset_at: at(n0, minutes) === null ? null : Math.floor(at(n0, minutes) / 1000),
      limit_window_seconds: seconds,
    });
    return {
      plan_type: "pro",
      rate_limit: {
        primary_window: window(session, 18_000),
        secondary_window: window(weekly, 604_800),
      },
    };
  }
  const window = ([used, minutes]) => ({
    utilization: used,
    resets_at: at(n0, minutes) === null ? null : new Date(at(n0, minutes)).toISOString(),
  });
  return {
    five_hour: window(session),
    seven_day: window(weekly),
    limits: fable
      ? [
          {
            kind: "weekly_scoped",
            percent: fable[0],
            resets_at: window(fable).resets_at,
            scope: { model: { display_name: "Fable" } },
          },
        ]
      : [],
  };
};

const json = (response, body) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

NodeHttp.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    const { scenario, n0 } = JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
    const accounts = scenarios[scenario];
    if (!accounts) return json(response, { files: [] });
    if (request.url.endsWith("/v0/management/auth-files")) {
      return json(response, {
        files: Object.entries(accounts).map(([id, account]) => ({
          id,
          auth_index: id,
          provider: account.provider,
          ...(account.email ? { email: account.email } : {}),
        })),
      });
    }
    if (request.url.endsWith("/v0/management/api-call")) {
      const call = JSON.parse(raw);
      const account = accounts[call.auth_index];
      if (!account) return json(response, { status_code: 404, body: "{}" });
      if (call.url.endsWith("/rate-limit-reset-credits")) {
        const credits = Array.from({ length: account.credits ?? 0 }, (_, index) => ({
          id: `${call.auth_index}-credit-${index}`,
          status: "available",
          reset_type: "codex_rate_limits",
          expires_at: new Date(n0 + 3 * 24 * 60 * MINUTE).toISOString(),
        }));
        return json(response, { status_code: 200, body: JSON.stringify({ credits }) });
      }
      return json(response, { status_code: 200, body: JSON.stringify(usage(account, n0)) });
    }
    response.writeHead(404).end();
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`usage limits hub on ${port}`));
