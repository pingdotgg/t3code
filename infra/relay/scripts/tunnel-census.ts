// Read-only count of Cloudflare tunnels in the managed-endpoint account,
// grouped by relay stage, status, and how long they have been idle. The reaper
// only sees its own stage's prefix, so this shows how much of the backlog
// belongs to other stages.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/tunnel-census.ts
//
// The token needs Cloudflare Tunnel read access. Nothing is modified.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const PREFIX = "t3coderelay-managedendpoint-";
const PAGE_SIZE = 1_000;
const DAY_MS = 86_400_000;

// Cloudflare documents every field here as optional, so a tunnel missing one
// must not fail the whole page.
const Tunnel = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  conns_inactive_at: Schema.optional(Schema.NullOr(Schema.String)),
});
type Tunnel = typeof Tunnel.Type;
const TunnelPage = Schema.Struct({ result: Schema.Array(Tunnel) });

// "t3coderelay-managedendpoint-<stage>-<16 hex>"; stages may contain hyphens.
const stageOf = (name: string | null | undefined) =>
  name ? name.slice(PREFIX.length).replace(/-[a-f0-9]{16}$/u, "") : "unknown";

const ageBucket = (tunnel: Tunnel, now: number) => {
  const since = Date.parse(tunnel.conns_inactive_at ?? tunnel.created_at ?? "");
  if (Number.isNaN(since)) return "unknown";
  const days = (now - since) / DAY_MS;
  if (days > 90) return ">90d";
  if (days > 30) return ">30d";
  if (days > 7) return ">7d";
  return "<=7d";
};

const main = Effect.gen(function* () {
  const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const client = yield* HttpClient.HttpClient;
  const now = yield* Clock.currentTimeMillis;

  const listPage = (page: number) =>
    HttpClientRequest.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`, {
      urlParams: {
        is_deleted: "false",
        include_prefix: PREFIX,
        per_page: String(PAGE_SIZE),
        page: String(page),
      },
    }).pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      client.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TunnelPage)),
      Effect.map((body) => body.result),
    );

  const counts = new Map<string, number>();
  let total = 0;
  for (let page = 1; ; page += 1) {
    const tunnels = yield* listPage(page);
    for (const tunnel of tunnels) {
      total += 1;
      const idle =
        tunnel.status === "down" || tunnel.status === "inactive" ? ageBucket(tunnel, now) : "-";
      const key = `${stageOf(tunnel.name)}\t${tunnel.status ?? "unknown"}\t${idle}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (tunnels.length < PAGE_SIZE) break;
  }

  yield* Console.log("stage\tstatus\tidle\tcount");
  for (const [key, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    yield* Console.log(`${key}\t${count}`);
  }
  yield* Console.log(`total\t\t\t${total}`);
}).pipe(Effect.provide(FetchHttpClient.layer));

NodeRuntime.runMain(main);
