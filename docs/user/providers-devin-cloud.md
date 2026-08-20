# Devin Cloud

T3 Code can create and continue hosted Devin sessions through Devin's organization API. This is a
separate provider from the local [Devin CLI](./providers-devin.md): choose **Devin Cloud** when the task should
run in Devin's managed cloud environment.

## Prerequisites

If the Devin CLI is signed in on the machine running your T3 Code server, no setup is needed: Devin
Cloud reuses the CLI sign-in automatically and discovers your organization. Explicit provider
settings always take precedence over the CLI sign-in.

Otherwise, create a Devin service user and API key. The token starts with `cog_` and needs these
organization permissions:

- `ManageOrgSessions` to create sessions and send follow-up messages
- `ViewOrgSessions` to reconnect, read messages, and follow session status

You also need the target organization ID, which starts with `org-`. See Devin's
[API authentication guide](https://docs.devin.ai/api-reference/authentication) for service-user
setup and token handling.

## Provider settings

Add **Devin Cloud** in Settings → Providers and enter the service-user API key and organization ID.
Both are optional when the Devin CLI is signed in on the server machine. The API key is stored in
plain text in T3 Code's server settings, like other provider secrets.

Optional settings apply when T3 Code creates a new cloud session:

- **Create as user ID** attributes the session and follow-up messages to a Devin user.
- **Repositories** supplies repository URLs, separated by commas or new lines.
- **Tags** supplies session tags, separated by commas or new lines.

## Choosing a Devin mode

The model picker selects the Devin agent mode for the session: **Devin** (the default agent mode),
**Devin Fast** (about 2x faster at a higher cost), and the preview modes **Devin Lite**,
**Devin Ultra**, and **Devin Fusion**. Preview modes must be enabled for your organization; Devin
rejects session creation when a mode is unavailable. The mode is fixed when the cloud session is
created, so changing it requires a new thread.

## Starting and continuing tasks

The first message in a T3 thread creates a resumable Devin session. T3 Code stores its `devin-…`
session ID in the thread's provider resume cursor. Later messages are sent to that same session;
Devin automatically resumes it when it is suspended. This also works after restarting T3 Code.

T3 Code reads Devin's session messages into the thread and waits until the task finishes, pauses for
the user, pauses for approval, errors, exits, or becomes suspended. Closing the local T3 session only
detaches from Devin—it does not terminate the cloud task—so it can be continued later.

## Current limitations

- Local T3 attachments are not uploaded to Devin Cloud yet.
- Approval and structured user-input prompts must be handled in the Devin web app. Full-access mode
  creates the session with Devin's approval bypass enabled.
- Devin Cloud does not provide T3's auxiliary commit-message, PR-text, branch-name, or thread-title
  generation.
- Rollback is unavailable because Devin's session API has no turn rollback operation.

## Troubleshooting

- A `401` or `403` usually means the token is invalid or lacks one of the required organization
  permissions.
- If a task pauses for approval or user input, open its session in the Devin web app, respond there,
  then continue the T3 thread.
- If the organization or session cannot be found, confirm the API key belongs to the configured
  organization.
