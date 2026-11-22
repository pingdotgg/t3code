import {
  FillCredentialInput,
  FillCredentialResult,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  RequestCredentialsInput,
  RequestCredentialsResult,
  SaveTestLoginInput,
  TestLoginStoreError,
  TestLoginSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as CredentialAutofill from "../../../credentials/CredentialAutofill.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CredentialAutofill.CredentialAutofill,
];

/** A store or browser failure, or the access gate's refusal. */
const CredentialToolFailure = Schema.Union([
  PreviewAutomationError,
  TestLoginStoreError,
  OrchestratorMcpFailure,
]);

const RequestCredentialsTool = Tool.make("request_credentials", {
  description:
    "List saved test logins for a site in the collaborative browser. Personal Vault logins are available only to the user. Returns ids, titles, usernames and saved URLs, never passwords or codes. Then call fill_credential for each field. Never ask the user to paste a password into the chat.",
  parameters: RequestCredentialsInput,
  success: RequestCredentialsResult,
  failure: CredentialToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Find saved logins")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const FillCredentialTool = Tool.make("fill_credential", {
  description:
    "Fill one field of a saved test login into the sign-in form in a collaborative browser tab: username, password, or otp (one-time code). Test logins fill without a prompt, and the tab must be on the item's saved website. The value goes straight into the page and is never returned to you; you get only a status. Fill username and password as separate calls, then submit the form with preview_click or preview_press.",
  parameters: FillCredentialInput,
  success: FillCredentialResult,
  failure: Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Fill saved login")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const SaveTestLoginTool = Tool.make("save_test_login", {
  description:
    "Save a test user you created for a site under development (sign-up, seeder or admin) in Conn's test-login store, so you and the user can sign in with it later. Test logins appear in request_credentials with source 'test' and fill without an approval prompt. Only for test users of sites being developed, never for real accounts.",
  parameters: SaveTestLoginInput,
  success: TestLoginSummary,
  failure: CredentialToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Save test login")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const CredentialsToolkit = Toolkit.make(
  RequestCredentialsTool,
  FillCredentialTool,
  SaveTestLoginTool,
);
