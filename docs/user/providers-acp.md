# ACP Registry

T3 Code can run coding agents from the official
[ACP Registry](https://agentclientprotocol.com/get-started/registry), such as Devin, Kimi CLI,
and Gemini CLI. Registry agents bring their own models, tools, and sign-in, while T3 Code provides
projects, threads, checkpoints, and its MCP tools.

## Add an agent

1. Open **Settings → Providers**.
2. Select **Add provider** and search the ACP Registry below the driver list.
3. Select **Add** on the agent's result.
4. Confirm the name and instance ID, then complete the agent's sign-in step.

Search only shows agents that can run on the connected server. Registry agents are third-party
code; review an agent's source and license before adding it. To add an agent by its registry ID,
select **Enter manually**.

## Where agents run

Registry agents always run on the machine that hosts your T3 Code server. That stays true when you
connect through `app.t3.codes`, T3 Connect, or a relay.

Agents install under `tools/<agent-id>/<version>/` inside T3 home. T3 Code verifies SHA-256 when
the Registry entry provides one; entries without a checksum rely on the Registry's HTTPS download.
Registry `npx` and `uvx` packages install into T3-owned npm prefixes and Python tool directories at
the exact version the Registry publishes. Removing an agent's last provider instance removes the
T3-managed binary files but keeps package installs.

## Signing in

Open the agent's account section in **Settings → Providers** on web or desktop and choose
**Sign in**. If the agent offers several methods, select one first.

Browser sign-in shows the agent's URL and waits for you to open or copy it before telling the
agent to proceed. The page opens on your device, while the agent runs on the environment.
Terminal methods run in an in-app terminal on that environment. T3 Code reconnects after the
terminal login and waits for the agent to confirm sign-in before reporting success.

Sign-in leaves credentials in the agent's own store. Agents that use API keys read them from
environment variables in the instance's environment settings. If the agent supports logout,
choose **Sign out**. Signing out stops running threads of the same agent on that environment.

## Models and options

The model picker lists the models the agent reports. Other settings the agent offers, such as
reasoning effort or its own mode picker, appear in the composer's model options menu. The Plan
toggle appears only for agents with a plan or architect mode, after T3 Code has checked the agent
or started a session with it. Slash commands the agent provides
appear in the `/` menu, and commands it names with a `$` prefix appear in the `$` skill menu.

## Permissions

Registry agents read files, edit, and run commands themselves, under their own sandbox and
approval rules. When an agent asks for approval, T3 Code answers by the thread's
[permission mode](./permission-modes.md): **Supervised** shows the request in the conversation,
**Auto-accept edits** approves edits and shows the rest, and **Auto** and **Full access** approve
automatically. File reads and searches never wait for approval.

Devin runs its commands through T3 Code's terminals, and those commands follow the thread's
permission mode.

## Limits

- ACP agents cannot rewind their conversation. Reverting a thread or editing and resubmitting an
  earlier turn is unavailable. Continue with a follow-up message or start a new thread.
- Registry instances are not used for thread titles, commit messages, branch names, or pull
  request descriptions. Configure another provider for those.
- **Executable override** in the instance settings runs an existing local executable instead of
  the managed distribution. **Authentication method** picks a specific sign-in method.
