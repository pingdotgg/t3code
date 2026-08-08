import * as Chatbot from "@/AWS/Chatbot";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Well-formed-but-nonexistent identifiers — drive the typed error paths of
// the identity offboarding bindings without touching any real workspace.
const NONEXISTENT_SLACK_TEAM = "T0000000000";
const NONEXISTENT_SLACK_USER = "U0000000000";
const NONEXISTENT_TEAMS_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// The delete-identity operations validate the configuration ARN against the
// caller's account, so the test passes its account id as `?account=` and the
// fixture builds well-formed same-account (but nonexistent) ARNs.
const nonexistentSlackConfigurationArn = (account: string) =>
  `arn:aws:chatbot::${account}:chat-configuration/slack-channel/alchemy-probe-nonexistent`;
const nonexistentTeamsConfigurationArn = (account: string) =>
  `arn:aws:chatbot::${account}:chat-configuration/microsoft-teams-channel/alchemy-probe-nonexistent`;

export class ChatbotTestFunction extends Lambda.Function<Lambda.Function>()(
  "ChatbotTestFunction",
) {}

/**
 * Account-level Chatbot bindings fixture.
 *
 * The testing account has no Slack workspace or Microsoft Teams team
 * onboarded (onboarding requires the console OAuth flow), so the reads
 * answer real empty lists — a REAL data-plane success through each
 * binding's IAM grant — and the identity deletes answer the typed error
 * tags for nonexistent identities, proving the wiring and typed error
 * union for each capability.
 */
export default ChatbotTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const getAccountPreferences = yield* Chatbot.GetAccountPreferences();
    const updateAccountPreferences = yield* Chatbot.UpdateAccountPreferences();
    const describeSlackWorkspaces = yield* Chatbot.DescribeSlackWorkspaces();
    const describeSlackUserIdentities =
      yield* Chatbot.DescribeSlackUserIdentities();
    const deleteSlackUserIdentity = yield* Chatbot.DeleteSlackUserIdentity();
    const deleteSlackWorkspaceAuthorization =
      yield* Chatbot.DeleteSlackWorkspaceAuthorization();
    const listMicrosoftTeamsConfiguredTeams =
      yield* Chatbot.ListMicrosoftTeamsConfiguredTeams();
    const listMicrosoftTeamsUserIdentities =
      yield* Chatbot.ListMicrosoftTeamsUserIdentities();
    const deleteMicrosoftTeamsUserIdentity =
      yield* Chatbot.DeleteMicrosoftTeamsUserIdentity();
    const deleteMicrosoftTeamsConfiguredTeam =
      yield* Chatbot.DeleteMicrosoftTeamsConfiguredTeam();

    const bound = {
      getAccountPreferences,
      updateAccountPreferences,
      describeSlackWorkspaces,
      describeSlackUserIdentities,
      deleteSlackUserIdentity,
      deleteSlackWorkspaceAuthorization,
      listMicrosoftTeamsConfiguredTeams,
      listMicrosoftTeamsUserIdentities,
      deleteMicrosoftTeamsUserIdentity,
      deleteMicrosoftTeamsConfiguredTeam,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/account-preferences") {
          // Succeeds on every account — a REAL success through the
          // binding's IAM grant.
          const result = yield* getAccountPreferences();
          return yield* HttpServerResponse.json({
            ok: true,
            hasPreferences: result.AccountPreferences !== undefined,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/account-preferences-roundtrip"
        ) {
          // Read the current preferences, then write the identical values
          // back — a safe no-op write proving the update binding.
          const current = yield* getAccountPreferences();
          const result = yield* updateAccountPreferences({
            UserAuthorizationRequired:
              current.AccountPreferences?.UserAuthorizationRequired ?? false,
            TrainingDataCollectionEnabled:
              current.AccountPreferences?.TrainingDataCollectionEnabled ??
              false,
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              hasPreferences: r.AccountPreferences !== undefined,
            })),
            Effect.catchTag(
              ["InvalidParameterException", "InvalidRequestException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/slack-workspaces") {
          const result = yield* describeSlackWorkspaces();
          return yield* HttpServerResponse.json({
            ok: true,
            count: (result.SlackWorkspaces ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/slack-user-identities") {
          const result = yield* describeSlackUserIdentities();
          return yield* HttpServerResponse.json({
            ok: true,
            count: (result.SlackUserIdentities ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/teams-configured-teams"
        ) {
          const result = yield* listMicrosoftTeamsConfiguredTeams();
          return yield* HttpServerResponse.json({
            ok: true,
            count: (result.ConfiguredTeams ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/teams-user-identities") {
          const result = yield* listMicrosoftTeamsUserIdentities();
          return yield* HttpServerResponse.json({
            ok: true,
            count: (result.TeamsUserIdentities ?? []).length,
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/delete-slack-user-identity"
        ) {
          const result = yield* deleteSlackUserIdentity({
            ChatConfigurationArn: nonexistentSlackConfigurationArn(
              url.searchParams.get("account") ?? "",
            ),
            SlackTeamId: NONEXISTENT_SLACK_TEAM,
            SlackUserId: NONEXISTENT_SLACK_USER,
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag(
              [
                "DeleteSlackUserIdentityException",
                "InvalidParameterException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "POST" &&
          pathname === "/delete-slack-workspace-authorization"
        ) {
          const result = yield* deleteSlackWorkspaceAuthorization({
            SlackTeamId: NONEXISTENT_SLACK_TEAM,
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag(
              [
                "DeleteSlackWorkspaceAuthorizationFault",
                "InvalidParameterException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "POST" &&
          pathname === "/delete-teams-user-identity"
        ) {
          const result = yield* deleteMicrosoftTeamsUserIdentity({
            ChatConfigurationArn: nonexistentTeamsConfigurationArn(
              url.searchParams.get("account") ?? "",
            ),
            UserId: NONEXISTENT_TEAMS_ID,
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag(
              [
                "DeleteMicrosoftTeamsUserIdentityException",
                "InvalidParameterException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "POST" &&
          pathname === "/delete-teams-configured-team"
        ) {
          const result = yield* deleteMicrosoftTeamsConfiguredTeam({
            TeamId: NONEXISTENT_TEAMS_ID,
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            // ResourceNotFoundException ("No Team found for the team id")
            // is outside the Smithy model's union for this operation and is
            // added via patches/chatbot.json.
            Effect.catchTag(
              [
                "DeleteTeamsConfiguredTeamException",
                "InvalidParameterException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Chatbot.GetAccountPreferencesHttp,
        Chatbot.UpdateAccountPreferencesHttp,
        Chatbot.DescribeSlackWorkspacesHttp,
        Chatbot.DescribeSlackUserIdentitiesHttp,
        Chatbot.DeleteSlackUserIdentityHttp,
        Chatbot.DeleteSlackWorkspaceAuthorizationHttp,
        Chatbot.ListMicrosoftTeamsConfiguredTeamsHttp,
        Chatbot.ListMicrosoftTeamsUserIdentitiesHttp,
        Chatbot.DeleteMicrosoftTeamsUserIdentityHttp,
        Chatbot.DeleteMicrosoftTeamsConfiguredTeamHttp,
      ),
    ),
  ),
);
