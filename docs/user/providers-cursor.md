# Cursor

T3 Code runs Cursor agents through the official Cursor SDK on your selected environment. The SDK
ships with T3 Code, so you do not need the Cursor CLI.

## Sign in

On web or desktop, open **Settings > Providers**, choose the environment that runs your project,
and enable Cursor. Choose **Sign in**, then open the sign-in page and finish in your browser.
T3 Code updates when sign-in finishes. This also works when you connect to a remote environment.
Provider sign-in is not available in the mobile app.

Each provider instance keeps its own sign-in on the environment that runs it. Your Cursor editor
and CLI logins are separate. To use an API key instead, add `CURSOR_API_KEY` to the instance's
environment variables. The key overrides browser sign-in; remove it to use the browser flow.

**Switch account** and **Sign out** stop that instance's running threads and keep their history.
Sign-out forgets the saved credential. To revoke the generated key before it expires, remove it
from the API keys in your Cursor dashboard.

## How Cursor threads behave

- Cursor loads your project and user rules, skills, and MCP servers, as the CLI does.
- Cursor does not send approval requests. See
  [permission modes](./permission-modes.md#provider-differences).
- Threads from older versions of T3 Code used the Cursor CLI. They continue in a new Cursor agent
  that does not see the earlier conversation.
- The **Binary path** and **API endpoint** settings from the CLI integration no longer apply.
