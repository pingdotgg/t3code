import { movedCommand } from "alchemy/Cli/commands/compat";
import { confirmOrDecline } from "alchemy/Cli/commands/confirm";
import { envFile, yes } from "alchemy/Cli/commands/flags";
import { instrumentCommand } from "alchemy/Cli/commands/instrument";
import * as Interaction from "alchemy/Interaction";
import { loadConfigProvider } from "alchemy/Util/ConfigProvider";
import { Command, Flag } from "effect/cli";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as CloudflareToken from "./Alchemist/Token.ts";
import type { CreatedToken } from "./Alchemist/Token.ts";

const SELECTABLE_SCOPE_LABELS: Record<string, string> = {
  "com.cloudflare.api.account": "account",
  "com.cloudflare.api.account.zone": "zone",
  "com.cloudflare.api.user": "user",
  "com.cloudflare.edge.r2.bucket": "r2",
};

export const formatCreatedCloudflareToken = (result: CreatedToken, token: string) =>
  [
    "",
    `Created Cloudflare API token "${result.name}" (${result.id}).`,
    `Granted ${result.grantedPermissionGroups} permission group(s) across ${result.policies.length} policy(ies)${
      result.verificationStatus ? `; token status: ${result.verificationStatus}.` : "."
    }`,
    "",
    token,
    "",
    "Store this value now — Cloudflare only shows it once. Use it as CLOUDFLARE_API_TOKEN.",
    ...result.diagnostics.map(
      (diagnostic) => `${diagnostic.severity.toUpperCase()}: ${diagnostic.message}`,
    ),
  ].join("\n");

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
 * `alchemy provider cloudflare token` — mint a Cloudflare API token
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
  instrumentCommand("provider.cloudflare.create-token", (a: { allPermissions: boolean }) => ({
    "alchemy.all_permissions": a.allPermissions,
  }))(
    Effect.fn(function* ({ envFile, allPermissions, name, accountId, yes: approved }) {
      const prompt = yield* Interaction.Interaction;
      const provider = yield* loadConfigProvider(envFile);
      const read = <A>(config: Config.Config<Option.Option<A>>) =>
        config.pipe(
          Effect.provide(ConfigProvider.layer(provider)),
          Effect.map(Option.getOrUndefined),
        );
      const apiKey =
        (yield* read(Config.String("CLOUDFLARE_API_KEY").pipe(Config.option))) ??
        (yield* prompt.prompt.password({
          message: "Paste your Global API Key",
          // Keep the URL free of adjacent punctuation: terminals that
          // auto-link URLs otherwise fold a trailing ")" into the link.
          description:
            "Find it under Global API Key at https://dash.cloudflare.com/profile/api-tokens",
          validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
        }));
      const email =
        (yield* read(Config.String("CLOUDFLARE_EMAIL").pipe(Config.option))) ??
        (yield* prompt.prompt.text({
          message: "Cloudflare account email",
          validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
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
          defaultValue: allPermissions ? "alchemy-superuser" : "alchemy",
          validate: (value) => (value.trim().length === 0 ? "Token name is required" : undefined),
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
                description: SELECTABLE_SCOPE_LABELS[group.scopes[0]!] ?? group.scopes[0],
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
      yield* Console.log(formatCreatedCloudflareToken(result, Redacted.value(result.value)));
    }),
  ),
).pipe(Command.withDescription("Create a scoped Cloudflare API token"));

const moved = (name: string, replacement: string) =>
  movedCommand(name, `alchemy provider cloudflare ${name}`, replacement);

export const cloudflareCommand = Command.make("cloudflare", {}).pipe(
  Command.withDescription("Manage Cloudflare provider prerequisites"),
  Command.withSubcommands([
    createTokenCommand,
    moved("bootstrap", "alchemy state bootstrap --backend cloudflare"),
    moved("teardown", "alchemy state teardown --backend cloudflare"),
    Command.make("state", {}).pipe(
      Command.withSubcommands([
        movedCommand(
          "logs",
          "alchemy provider cloudflare state logs",
          "alchemy state logs --backend cloudflare",
        ),
      ]),
      Command.unlisted,
    ),
  ]),
);
