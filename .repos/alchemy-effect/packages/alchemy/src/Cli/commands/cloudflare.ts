import * as cfAccounts from "@distilled.cloud/cloudflare/accounts";
import { apiKeyCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as user from "@distilled.cloud/cloudflare/user";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import * as CloudflareAccess from "../../Cloudflare/Access.ts";
import { CloudflareAuth } from "../../Cloudflare/Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "../../Cloudflare/CloudflareEnvironment.ts";
import * as CloudflareCredentials from "../../Cloudflare/Credentials.ts";
import { CloudflareLogs } from "../../Cloudflare/Logs.ts";
import { STATE_STORE_SCRIPT_NAME } from "../../Cloudflare/StateStore/Api.ts";
import { bootstrap as bootstrapCloudflare } from "../../Cloudflare/StateStore/State.ts";
import * as Clank from "../../Util/Clank.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

import {
  envFile,
  formatLocalTimestamp,
  instrumentCommand,
  parseSince,
  profile,
} from "./_shared.ts";

/**
 * Build the Cloudflare auth + environment layer stack used by every
 * `alchemy cloudflare ...` subcommand. Mirrors the wiring inside
 * `Cloudflare.state(...)` so the command can talk to the user's
 * account out-of-band.
 */
const cloudflareLayers = (
  envFileOpt: Option.Option<string>,
  profileName: string,
) =>
  Effect.gen(function* () {
    const authProviders: AuthProviders["Service"] = {};
    const authRegistry = Layer.succeed(AuthProviders, authProviders);
    const authLayer = Layer.provideMerge(CloudflareAuth, authRegistry);
    const cf = Layer.provideMerge(
      Layer.mergeAll(
        CloudflareCredentials.fromAuthProvider(),
        CloudflareEnvironment.fromProfile(),
        CloudflareAccess.AccessLive,
      ),
      authLayer,
    );

    const logger = Logger.layer([fileLogger("cloudflare.txt")], {
      mergeWithExisting: true,
    });

    return Layer.mergeAll(
      cf,
      ConfigProvider.layer(
        withProfileOverride(yield* loadConfigProvider(envFileOpt), profileName),
      ),
      logger,
    );
  });

const cloudflareForce = Flag.boolean("force").pipe(
  Flag.withDescription(
    "Force a full redeploy even if the state-store worker already exists. " +
      "Without this flag, an existing worker is adopted and only its credentials are refreshed.",
  ),
  Flag.withDefault(false),
);

const cloudflareWorkerName = Flag.string("worker-name").pipe(
  Flag.withDescription(
    "Override the default state-store worker name (advanced; only needed for multiple state stores per account).",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const bootstrapCommand = Command.make(
  "bootstrap",
  {
    envFile,
    profile,
    force: cloudflareForce,
    workerName: cloudflareWorkerName,
  },
  instrumentCommand(
    "cloudflare.bootstrap",
    (a: {
      profile: string;
      force: boolean;
      workerName: string | undefined;
    }) => ({
      "alchemy.profile": a.profile,
      "alchemy.force": a.force,
      "alchemy.worker_name": a.workerName ?? "",
    }),
  )(
    Effect.fnUntraced(function* ({ envFile, profile, force, workerName }) {
      const services = yield* cloudflareLayers(envFile, profile);
      yield* bootstrapCloudflare({
        workerName,
        force,
        profile,
      }).pipe(Effect.provide(services));
    }),
  ),
);

/**
 * A single resolved Cloudflare token policy in the shape expected by
 * `POST /user/tokens`.
 */
type CreateTokenPolicy = {
  effect: "allow";
  permissionGroups: { id: string }[];
  resources: Record<string, unknown>;
};

/**
 * Curated set of permission groups granted by `create-token` when
 * `--all-permissions` is NOT passed. Covers the services Alchemy commonly
 * deploys (Workers + storage + zone/DNS) without handing out a god token.
 * Names are matched against the account's live permission groups; any name
 * not available for the account is silently skipped.
 */
const ALCHEMY_DEFAULT_PERMISSION_GROUP_NAMES: ReadonlySet<string> = new Set([
  "Account Settings Read",
  "Workers Scripts Read",
  "Workers Scripts Write",
  "Workers KV Storage Read",
  "Workers KV Storage Write",
  "Workers R2 Storage Read",
  "Workers R2 Storage Write",
  "Workers Routes Read",
  "Workers Routes Write",
  "Workers Tail Read",
  "Workers Observability Read",
  "Workers Observability Write",
  "Workers AI Read",
  "Workers AI Write",
  "D1 Read",
  "D1 Write",
  "Queues Read",
  "Queues Write",
  "Hyperdrive Read",
  "Hyperdrive Write",
  "Pages Read",
  "Pages Write",
  "Vectorize Read",
  "Vectorize Write",
  "Pipelines Read",
  "Pipelines Write",
  "AI Gateway Read",
  "AI Gateway Run",
  "AI Gateway Write",
  "Browser Rendering Read",
  "Browser Rendering Write",
  "Images Read",
  "Images Write",
  "Stream Read",
  "Stream Write",
  "Secrets Store Read",
  "Secrets Store Write",
  "DNS Read",
  "DNS Write",
  "Zone Read",
  "Zone Settings Read",
  "Zone Settings Write",
  "SSL and Certificates Read",
  "SSL and Certificates Write",
]);

/**
 * Group permission groups by their Cloudflare scope and produce one policy
 * per scope, wiring up the right resource selector for each:
 *
 * - `com.cloudflare.api.account` → scoped to the account ID
 * - `com.cloudflare.api.account.zone` → all zones (`*`)
 * - `com.cloudflare.edge.r2.bucket` → all buckets (`*`)
 *
 * Mirrors the upstream `alchemy` "god token" policy shape. Groups with an
 * unrecognized scope are skipped, and empty policies are dropped.
 */
const buildTokenPolicies = (
  accountId: string,
  groups: readonly { id: string; scopes: readonly string[] }[],
): CreateTokenPolicy[] => {
  const buckets: Record<string, CreateTokenPolicy> = {
    "com.cloudflare.api.account": {
      effect: "allow",
      permissionGroups: [],
      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
    },
    "com.cloudflare.api.account.zone": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.api.account.zone.*": "*" },
    },
    "com.cloudflare.edge.r2.bucket": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.edge.r2.bucket.*": "*" },
    },
  };
  const seen = new Set<string>();
  for (const group of groups) {
    const bucket = buckets[group.scopes[0]!];
    if (!bucket || seen.has(group.id)) continue;
    seen.add(group.id);
    bucket.permissionGroups.push({ id: group.id });
  }
  return Object.values(buckets).filter((p) => p.permissionGroups.length > 0);
};

/**
 * Let the user pick which Cloudflare account the token is scoped to. Lists
 * the accounts visible to the configured credentials and prompts a selection
 * (defaulting the cursor to the profile's account). If there's exactly one
 * account, it's used without prompting; if the API returns none, falls back
 * to the profile's account.
 */
const selectAccountId = (defaultAccountId: string | undefined) =>
  Effect.gen(function* () {
    const list = yield* cfAccounts.listAccounts;
    const response = yield* list({});
    const accounts = response.result;

    if (accounts.length === 0) {
      if (defaultAccountId) return defaultAccountId;
      return yield* Effect.die(
        "No Cloudflare accounts found for these credentials.",
      );
    }
    if (accounts.length === 1) {
      const account = accounts[0]!;
      yield* Clank.info(`Using account: ${account.name} (${account.id})`);
      return account.id;
    }
    return yield* Clank.select({
      message: "Select a Cloudflare account",
      initialValue: defaultAccountId,
      options: accounts.map((a) => ({
        value: a.id,
        label: a.name,
        hint: a.id === defaultAccountId ? `${a.id} (current profile)` : a.id,
      })),
    });
  });

const allPermissionsFlag = Flag.boolean("all-permissions").pipe(
  Flag.withDescription(
    "Grant the token EVERY Cloudflare permission group (a 'god token'). " +
      "Use with care — it has full access to your account.",
  ),
  Flag.withDefault(false),
);

const tokenNameFlag = Flag.string("name").pipe(
  Flag.withDescription(
    "Name for the API token. Defaults to 'alchemy' (or 'alchemy-all-permissions').",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const tokenAccountIdFlag = Flag.string("account-id").pipe(
  Flag.withDescription(
    "Cloudflare account ID to scope the token to. Defaults to the profile's account.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

/**
 * `alchemy cloudflare create-token` — mint a Cloudflare API token
 * (`POST /user/tokens`).
 *
 * This command is **standalone**: it does not use an Alchemy auth profile.
 * Cloudflare only mints a token whose permissions the authenticating
 * credential is allowed to grant — and OAuth/scoped tokens silently produce a
 * token with zero permissions — so it always authenticates with the account's
 * **Global API Key** (read from `CLOUDFLARE_API_KEY` / `CLOUDFLARE_EMAIL`,
 * otherwise prompted). The key is used only to create the token and is never
 * stored.
 *
 * With `--all-permissions` it builds a "superuser" token spanning every
 * permission group (after a confirmation prompt). Otherwise it grants a
 * curated set covering the services Alchemy commonly deploys.
 */
const createTokenCommand = Command.make(
  "create-token",
  {
    envFile,
    allPermissions: allPermissionsFlag,
    name: tokenNameFlag,
    accountId: tokenAccountIdFlag,
  },
  instrumentCommand(
    "cloudflare.create-token",
    (a: { allPermissions: boolean }) => ({
      "alchemy.all_permissions": a.allPermissions,
    }),
  )(
    Effect.fnUntraced(function* ({ envFile, allPermissions, name, accountId }) {
      const configProvider = ConfigProvider.layer(
        yield* loadConfigProvider(envFile),
      );

      yield* Effect.gen(function* () {
        // The Global API Key is a dashboard-only secret — there is no API to
        // fetch it — so read it from the environment or prompt for it. It is
        // used only to create the token and is never stored.
        const envApiKey = yield* Config.string("CLOUDFLARE_API_KEY").pipe(
          Config.option,
          Config.map(Option.getOrUndefined),
        );
        const apiKey =
          envApiKey ??
          (yield* Clank.password({
            message:
              "Paste your Global API Key (see bottom of https://dash.cloudflare.com/profile/api-tokens)",
            validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
          }));

        const envEmail = yield* Config.string("CLOUDFLARE_EMAIL").pipe(
          Config.option,
          Config.map(Option.getOrUndefined),
        );
        const email =
          envEmail ??
          (yield* Clank.text({
            message: "Cloudflare account email",
            validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
          }));

        const credentials = Effect.succeed(
          apiKeyCredentials({ apiKey, email }),
        );
        const withCreds = <A, E, R>(self: Effect.Effect<A, E, R>) =>
          self.pipe(
            Effect.provideService(
              CloudflareCredentials.Credentials,
              credentials,
            ),
          );

        const resolvedAccountId =
          accountId ?? (yield* withCreds(selectAccountId(undefined)));

        const tokenName =
          name ??
          (yield* Clank.text({
            message: "Token name",
            placeholder: allPermissions ? "alchemy-superuser" : "alchemy",
            validate: (v) =>
              v.trim().length === 0 ? "Token name is required" : undefined,
          }));

        // Resolve permission groups live from Cloudflare instead of a static
        // catalog. Cloudflare silently ignores permission-group IDs it doesn't
        // recognize, so a stale local list yields a token with zero
        // permissions. `/user/tokens/permission_groups` returns exactly the
        // groups (and IDs) valid for this credential.
        //
        // We hit the endpoint with a raw GET rather than the typed distilled
        // client: the client hard-codes the set of valid `scopes` literals,
        // and Cloudflare keeps adding new ones (e.g. `com.cloudflare.edge.
        // worker.script`), which makes the strict schema reject the whole
        // response. Parsing leniently keeps us forward-compatible.
        const http = yield* HttpClient.HttpClient;
        const pgResponse = yield* http.get(
          "https://api.cloudflare.com/client/v4/user/tokens/permission_groups",
          {
            headers: {
              "X-Auth-Key": apiKey,
              "X-Auth-Email": email,
              Accept: "application/json",
            },
          },
        );
        const pgBody = (yield* pgResponse.json) as {
          result?: { id?: string; name?: string; scopes?: string[] }[];
        };
        const liveGroups = (pgBody.result ?? []).flatMap((g) =>
          g.id && g.scopes && g.scopes.length > 0
            ? [{ id: g.id, name: g.name ?? "", scopes: g.scopes }]
            : [],
        );

        const selected = allPermissions
          ? liveGroups
          : liveGroups.filter((g) =>
              ALCHEMY_DEFAULT_PERMISSION_GROUP_NAMES.has(g.name),
            );
        const policies = buildTokenPolicies(resolvedAccountId, selected);

        if (policies.length === 0) {
          return yield* Effect.die(
            "No permission groups resolved for this account; cannot create a token.",
          );
        }

        if (allPermissions) {
          yield* Clank.warn(
            "This token will have FULL access to your Cloudflare account. " +
              "Keep it secret — anyone with it can control your account.",
          );
          const ok = yield* Clank.confirm({
            message: "Create a superuser token with all permissions?",
            initialValue: false,
          });
          if (!ok) {
            yield* Console.log("Cancelled.");
            return;
          }
        }

        const result = yield* withCreds(
          user.createToken({ name: tokenName, policies }),
        );

        if (!result.value) {
          return yield* Effect.die(
            "Cloudflare did not return a token value. Try again.",
          );
        }

        // Cloudflare echoes back the policies it actually accepted. It silently
        // drops permission groups the authenticating user isn't allowed to
        // grant — so a token can come back with zero permissions even though
        // the request was well-formed. Count what was granted and warn loudly
        // if it's empty (almost always an account-role problem, not a bug).
        const granted = (result.policies ?? []).reduce(
          (n, p) => n + (p.permissionGroups?.length ?? 0),
          0,
        );

        // Verify the freshly minted token actually authenticates. The
        // Cloudflare dashboard has a long-standing rendering bug where
        // API-created tokens show a blank permission summary (and a disabled
        // "View"), which makes a perfectly good token look empty. A live
        // `/user/tokens/verify` is the source of truth.
        const status = yield* http
          .get("https://api.cloudflare.com/client/v4/user/tokens/verify", {
            headers: {
              Authorization: `Bearer ${result.value}`,
              Accept: "application/json",
            },
          })
          .pipe(
            Effect.flatMap((r) => r.json),
            Effect.map(
              (b) => (b as { result?: { status?: string } }).result?.status,
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          );

        yield* Console.log("");
        yield* Console.log(
          `Created Cloudflare API token "${result.name ?? tokenName}" (${result.id ?? "unknown id"}).`,
        );
        yield* Console.log(
          `Granted ${granted} permission group(s) across ${result.policies?.length ?? 0} policy(ies)` +
            (status ? `; token status: ${status}.` : "."),
        );
        yield* Console.log("");
        yield* Console.log(result.value);
        yield* Console.log("");
        yield* Console.log(
          "Store this value now — Cloudflare only shows it once. " +
            "Use it as CLOUDFLARE_API_TOKEN.",
        );

        if (granted === 0) {
          yield* Clank.warn(
            "Cloudflare granted 0 permissions. A token can only carry permissions " +
              "the authenticating user already holds, so this usually means the " +
              "Global API Key's user is not a Super Administrator on the selected " +
              "account. Check the user's role in the Cloudflare dashboard " +
              "(Members) and retry with an owner/Super Administrator.",
          );
        } else {
          // Token is good; preempt the "it looks empty" confusion.
          yield* Clank.info(
            "Heads up: the Cloudflare dashboard often renders API-created tokens " +
              'with a blank permission summary (and a greyed-out "View") — this is ' +
              "a known UI bug, not a broken token. The permissions above are applied. " +
              'To see them in the dashboard, open the token and click "← Edit token".',
          );
        }
      }).pipe(Effect.provide(configProvider));
    }),
  ),
);

const tailFlag = Flag.boolean("tail").pipe(
  Flag.withDescription(
    "Stream logs in real time via the Cloudflare tail websocket instead of fetching past entries.",
  ),
  Flag.withDefault(false),
);

const limitFlag = Flag.integer("limit").pipe(
  Flag.withDescription("Number of log entries to fetch (ignored with --tail)"),
  Flag.withDefault(100),
);

const sinceFlag = Flag.string("since").pipe(
  Flag.withDescription(
    "Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

/**
 * `alchemy cloudflare state logs` — get or tail logs from the
 * `alchemy-state-store` Worker on the user's account. Lets us debug
 * the state-store worker without standing up a stack file.
 */
const stateLogsCommand = Command.make(
  "logs",
  {
    envFile,
    profile,
    workerName: cloudflareWorkerName,
    tail: tailFlag,
    limit: limitFlag,
    since: sinceFlag,
  },
  instrumentCommand(
    "cloudflare.state.logs",
    (a: {
      profile: string;
      workerName: string | undefined;
      tail: boolean;
      limit: number;
    }) => ({
      "alchemy.profile": a.profile,
      "alchemy.worker_name": a.workerName ?? STATE_STORE_SCRIPT_NAME,
      "alchemy.tail": a.tail,
      "alchemy.limit": a.limit,
    }),
  )(
    Effect.fnUntraced(function* ({
      envFile,
      profile,
      workerName,
      tail,
      limit,
      since,
    }) {
      const services = yield* cloudflareLayers(envFile, profile);
      const scriptName = workerName ?? STATE_STORE_SCRIPT_NAME;

      yield* Effect.gen(function* () {
        const { accountId } =
          yield* CloudflareEnvironment.CloudflareEnvironment;
        const telemetry = yield* CloudflareLogs;

        const formatLine = (line: { timestamp: Date; message: string }) =>
          `${formatLocalTimestamp(line.timestamp)} [${scriptName}] ${line.message}`;

        if (tail) {
          yield* Console.log(`Tailing ${scriptName}...`);
          yield* telemetry
            .tailScript({ accountId, scriptName })
            .pipe(Stream.runForEach((line) => Console.log(formatLine(line))));
          return;
        }

        const sinceDate = since ? parseSince(since) : undefined;
        const lines = yield* telemetry.queryLogs({
          accountId,
          filters: [
            {
              key: "$workers.scriptName",
              operation: "eq",
              type: "string",
              value: scriptName,
            },
          ],
          options: { limit, since: sinceDate },
        });

        if (lines.length === 0) {
          yield* Console.log(`(no log entries for ${scriptName})`);
          return;
        }

        for (const line of lines.sort(
          (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
        )) {
          yield* Console.log(formatLine(line));
        }
      }).pipe(Effect.provide(services));
    }),
  ),
);

const stateCommand = Command.make("state", {}).pipe(
  Command.withSubcommands([stateLogsCommand]),
);

export const cloudflareCommand = Command.make("cloudflare", {}).pipe(
  Command.withSubcommands([bootstrapCommand, createTokenCommand, stateCommand]),
);
