import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";

import * as Cloudflare from "../../Alchemist/routes/cloudflare.ts";
import * as CloudflareToken from "../../Alchemist/routes/cloudflareToken.ts";
import type { CreatedToken } from "../../Alchemist/routes/cloudflareToken.ts";
import { STATE_STORE_SCRIPT_NAME } from "../../Cloudflare/StateStore/Api.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { formatLocalTimestamp } from "../Format.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { confirmOrDecline } from "./confirm.ts";
import { envFile, parseSince, profile, yes } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";

const SELECTABLE_SCOPE_LABELS: Record<string, string> = {
  "com.cloudflare.api.account": "account",
  "com.cloudflare.api.account.zone": "zone",
  "com.cloudflare.api.user": "user",
  "com.cloudflare.edge.r2.bucket": "r2",
};

export const formatCreatedCloudflareToken = (
  result: CreatedToken,
  token: string,
) =>
  [
    "",
    `Created Cloudflare API token "${result.name}" (${result.id}).`,
    `Granted ${result.grantedPermissionGroups} permission group(s) across ${result.policies.length} policy(ies)${
      result.verificationStatus
        ? `; token status: ${result.verificationStatus}.`
        : "."
    }`,
    "",
    token,
    "",
    "Store this value now — Cloudflare only shows it once. Use it as CLOUDFLARE_API_TOKEN.",
    ...result.diagnostics.map(
      (diagnostic) =>
        `${diagnostic.severity.toUpperCase()}: ${diagnostic.message}`,
    ),
  ].join("\n");

const cloudflareForce = Flag.Boolean("force").pipe(
  Flag.withDescription(
    "Force a full redeploy even if the state-store worker already exists. " +
      "Without this flag, an existing worker is adopted and only its credentials are refreshed.",
  ),
  Flag.withDefault(false),
);

const cloudflareWorkerName = Flag.String("worker-name").pipe(
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
    "provider.cloudflare.bootstrap",
    (a: {
      profile: string | undefined;
      force: boolean;
      workerName: string | undefined;
    }) => ({
      "alchemy.profile": a.profile ?? "",
      "alchemy.force": a.force,
      "alchemy.worker_name": a.workerName ?? "",
    }),
  )(
    Effect.fn(function* ({ envFile, profile, force, workerName }) {
      yield* Cloudflare.bootstrap({
        workerName,
        force,
        profile,
        envFile: Option.getOrUndefined(envFile),
      });
    }),
  ),
).pipe(
  Command.withDescription(
    "Provision Cloudflare account prerequisites for deployments",
  ),
);

const teardownCommand = Command.make(
  "teardown",
  {
    envFile,
    profile,
    workerName: cloudflareWorkerName,
    yes,
  },
  instrumentCommand(
    "provider.cloudflare.teardown",
    (a: { profile: string | undefined; workerName: string | undefined }) => ({
      "alchemy.profile": a.profile ?? "",
      "alchemy.worker_name": a.workerName ?? "",
    }),
  )(
    Effect.fn(function* ({ envFile, profile, workerName, yes: approved }) {
      yield* confirmOrDecline({
        yes: approved,
        message:
          "Tear down the Cloudflare state store and its backing resources?",
        confirmLabel: "Destroy",
        cancelLabel: "Cancel",
      });
      yield* Cloudflare.teardown({
        workerName,
        profile,
        envFile: Option.getOrUndefined(envFile),
      });
    }),
  ),
).pipe(
  Command.withDescription("Tear down the Cloudflare state store"),
  Command.unlisted,
);
const allPermissionsFlag = Flag.Boolean("all-permissions").pipe(
  Flag.withDescription(
    "Grant the token EVERY Cloudflare permission group (a 'god token'). " +
      "Use with care — it has full access to your account.",
  ),
  Flag.withDefault(false),
);

const tokenNameFlag = Flag.String("name").pipe(
  Flag.withDescription(
    "Name for the API token. Defaults to 'alchemy' (or 'alchemy-all-permissions').",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

const tokenAccountIdFlag = Flag.String("account-id").pipe(
  Flag.withDescription(
    "Cloudflare account ID(s) to scope the token to (comma-separated for " +
      "multiple). If omitted, you'll be prompted to select from your accounts.",
  ),
  Flag.optional,
  Flag.map(
    Option.match({
      onNone: () => undefined,
      onSome: (v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
    }),
  ),
);

/**
 * `alchemy provider cloudflare create-token` — mint a Cloudflare API token
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
 * permission group (after a confirmation prompt). Otherwise it prompts the
 * user to pick which permission groups to grant from the account's live set.
 *
 * The token can be scoped to more than one account: pass a comma-separated
 * list to `--account-id`, or (when neither is supplied) pick multiple accounts
 * from the interactive selection prompt.
 */
const createTokenCommand = Command.make(
  "token",
  {
    envFile,
    allPermissions: allPermissionsFlag,
    name: tokenNameFlag,
    accountId: tokenAccountIdFlag,
    yes,
  },
  instrumentCommand(
    "cloudflare.create-token",
    (a: { allPermissions: boolean }) => ({
      "alchemy.all_permissions": a.allPermissions,
    }),
  )(
    Effect.fn(function* ({
      envFile,
      allPermissions,
      name,
      accountId,
      yes: approved,
    }) {
      const prompt = yield* CliKit.CliKit;
      const provider = yield* loadConfigProvider(envFile);
      const read = <A>(config: Config.Config<Option.Option<A>>) =>
        config.pipe(
          Effect.provide(ConfigProvider.layer(provider)),
          Effect.map(Option.getOrUndefined),
        );
      const apiKey =
        (yield* read(
          Config.String("CLOUDFLARE_API_KEY").pipe(Config.option),
        )) ??
        (yield* prompt.prompt.password({
          message:
            "Paste your Global API Key (see bottom of https://dash.cloudflare.com/profile/api-tokens)",
          validate: (value) =>
            value.trim().length === 0 ? "Required" : undefined,
        }));
      const email =
        (yield* read(Config.String("CLOUDFLARE_EMAIL").pipe(Config.option))) ??
        (yield* prompt.prompt.text({
          message: "Cloudflare account email",
          validate: (value) =>
            value.trim().length === 0 ? "Required" : undefined,
        }));
      const credentials = { email, apiKey: Redacted.make(apiKey) };
      const catalog = yield* CloudflareToken.catalog(credentials);
      const resolvedAccountIds =
        accountId ??
        (catalog.accounts.length === 1
          ? [catalog.accounts[0]!.id]
          : yield* prompt.prompt.multiSelect<string>({
              message: "Select the Cloudflare accounts to scope the token to",
              searchable: true,
              options: catalog.accounts.map((account) => ({
                value: account.id,
                label: account.name,
                description: account.id,
              })),
              required: true,
            }));
      const tokenName =
        name ??
        (yield* prompt.prompt.text({
          message: "Token name",
          placeholder: allPermissions ? "alchemy-superuser" : "alchemy",
          validate: (value) =>
            value.trim().length === 0 ? "Token name is required" : undefined,
        }));
      const permissionGroupIds = allPermissions
        ? ("all" as const)
        : yield* prompt.prompt.multiSelect<string>({
            message: "Select the permission groups to grant",
            descriptionPlacement: "inline",
            options: catalog.permissionGroups
              .filter(({ selectable }) => selectable)
              .sort(
                (a, b) =>
                  (a.category ?? "").localeCompare(b.category ?? "") ||
                  a.name.localeCompare(b.name),
              )
              .map((group) => ({
                value: group.id,
                label: group.name,
                description:
                  SELECTABLE_SCOPE_LABELS[group.scopes[0]!] ?? group.scopes[0],
              })),
            required: true,
          });
      const plan = yield* CloudflareToken.plan({
        credentials,
        name: tokenName,
        accountIds: resolvedAccountIds,
        permissionGroupIds,
      });
      if (plan.grantsFullAccess) {
        yield* prompt.output.warning(
          "This token will have FULL access to your Cloudflare account. Keep it secret.",
        );
        // `--yes` is the non-interactive path: without it, a CI invocation
        // of `--all-permissions` dies on the confirm prompt.
        yield* confirmOrDecline({
          yes: approved,
          message: "Create a superuser token with all permissions?",
          confirmLabel: "Create",
          cancelLabel: "Cancel",
          abortMessage: "Cancelled.",
        });
      }
      const result = yield* CloudflareToken.create({
        credentials,
        plan,
      });
      yield* Console.log(
        formatCreatedCloudflareToken(result, Redacted.value(result.value)),
      );
    }),
  ),
).pipe(Command.withDescription("Create a scoped Cloudflare API token"));

const tailFlag = Flag.Boolean("tail").pipe(
  Flag.withAlias("t"),
  Flag.withDescription(
    "Stream logs in real time via the Cloudflare tail websocket instead of fetching past entries.",
  ),
  Flag.withDefault(false),
);

const limitFlag = Flag.Int("limit").pipe(
  Flag.withDescription("Number of log entries to fetch (ignored with --tail)"),
  Flag.withDefault(100),
);

const sinceFlag = Flag.String("since").pipe(
  Flag.withDescription(
    "Fetch logs since this time (e.g. '1h', '30m', '2024-01-01T00:00:00Z')",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

/**
 * `alchemy provider cloudflare state logs` — get or tail logs from the
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
      profile: string | undefined;
      workerName: string | undefined;
      tail: boolean;
      limit: number;
    }) => ({
      "alchemy.profile": a.profile ?? "",
      "alchemy.worker_name": a.workerName ?? STATE_STORE_SCRIPT_NAME,
      "alchemy.tail": a.tail,
      "alchemy.limit": a.limit,
    }),
  )(
    Effect.fn(function* ({ envFile, profile, workerName, tail, limit, since }) {
      const scriptName = workerName ?? STATE_STORE_SCRIPT_NAME;
      const target = {
        profile,
        workerName,
        envFile: Option.getOrUndefined(envFile),
      };
      const formatLine = (line: { timestamp: Date; message: string }) =>
        `${formatLocalTimestamp(line.timestamp)} [${scriptName}] ${line.message}`;
      if (tail) {
        yield* CliKit.accessors.output.info(`Tailing ${scriptName}...`);
        yield* Cloudflare.tailStateLogs(target).pipe(
          Stream.runForEach((line) => Console.log(formatLine(line))),
        );
        return;
      }
      const lines = yield* Cloudflare.stateLogs({
        ...target,
        limit,
        since: since ? yield* parseSince(since) : undefined,
      });
      if (lines.length === 0) {
        yield* Console.log(`(no log entries for ${scriptName})`);
        return;
      }
      for (const line of lines) yield* Console.log(formatLine(line));
    }),
  ),
).pipe(
  Command.withDescription("Stream or fetch logs from the state-store worker"),
);

const stateCommand = Command.make("state", {}).pipe(
  Command.withDescription("Manage the Cloudflare-hosted state store"),
  Command.withSubcommands([stateLogsCommand]),
);

export const cloudflareCommand = Command.make("cloudflare", {}).pipe(
  Command.withDescription("Manage Cloudflare provider prerequisites"),
  Command.withSubcommands([
    bootstrapCommand,
    teardownCommand,
    createTokenCommand,
    stateCommand,
  ]),
);
