# Antigravity

T3 Code runs Google's official Antigravity ACP agent. By default it signs in with your personal
Google account and uses that account's Antigravity access, including access provided by a
Google AI subscription. It never falls back to a different sign-in method than the one you
select.

The agent, files, conversation state, and Google credentials stay on the selected environment.
Your browser or phone controls that environment. Signing in to the Antigravity IDE or CLI does
not sign in this T3 Code provider.

## Set up Antigravity

On web or desktop, open **Settings** > **Providers**, select the device that runs your project,
then select **Antigravity**. On mobile, open **Settings** > **Environments**, expand the
environment, then choose **Set up Antigravity**. An existing setup shows **Manage Antigravity**.
The model picker can open setup for the selected environment too.

1. Choose **Enable Antigravity**. Antigravity is off by default.
2. Choose **Install Antigravity**. T3 Code downloads the official runtime from Google to that
   environment. Installation continues if you leave the page or reconnect.
3. Choose **Sign in with Google**.
4. Choose **Open sign-in page** on web or desktop, or **Open Google sign-in** on mobile. You can
   use **Copy sign-in link** to open it in another browser.
5. Complete Google sign-in. Use the account you use for Antigravity.
6. Wait for T3 Code to confirm sign-in and load the model choices. Select an Antigravity model
   in the thread's model picker.

Setup requires a connection with permission to operate the environment. If setup is unavailable
on an older server, update that environment first.

### Sign in from a remote device

Google returns to a `127.0.0.1` address on the device running your browser. If that is the same
machine as the T3 Code environment, sign-in can finish directly.

On a phone or another computer, the final page will usually fail to load. This is expected.
Copy the full address from the browser, including everything after `?`, and paste it into the
return URL field in T3 Code. Choose **Continue** on web or desktop, or **Complete sign-in** on
mobile. Do not change the address to your server's hostname.

Return to the same T3 Code client and environment where you started sign-in. Another client
can see that sign-in is in progress, but cannot complete that attempt. The setup screen shows
the expiry time. If it expires, choose **Retry Google sign-in** and use the new link.

The return URL contains a temporary sign-in code. Paste it only into the setup field, not into
a thread or bug report. T3 Code waits for Google's agent to confirm sign-in. A successful
callback page alone does not prove account access.

### Other sign-in methods

**Sign-in method** in the Antigravity provider settings on web or desktop selects how the
agent authenticates. Mobile shows the selected method and its connect controls.

| Method                     | What you enter                           | How it signs in                 |
| -------------------------- | ---------------------------------------- | ------------------------------- |
| Google account             | Nothing                                  | Google sign-in page             |
| Gemini Enterprise          | GCP project and GCP location             | Google sign-in page             |
| Gemini API key             | API key                                  | Choose **Connect**. No browser. |
| Agent Platform (Vertex AI) | API key, or GCP project and GCP location | Choose **Connect**. No browser. |

Gemini Enterprise resolves your license for the project and location you enter. Agent Platform
with a project and location uses Application Default Credentials on the environment. API keys
are stored in plain text in T3 Code settings on that environment and are passed only to the
Antigravity agent process. Ambient `GEMINI_API_KEY` or `GOOGLE_*` variables on the environment
are ignored.

Changing the method stops the instance's sessions. Sign out or disconnect before you switch
accounts.

## Runtime installation

Managed downloads are available for these environment hosts:

| Host    | Architecture  |
| ------- | ------------- |
| macOS   | Apple Silicon |
| Linux   | x64 or ARM64  |
| Windows | x64 or ARM64  |

Google does not publish a local Intel Mac runtime. Use an Intel Mac as a client connected to
a supported remote environment.

The current Linux x64 runtime downloads about 543 MB and uses about 1.65 GB after extraction.
Allow at least 2.5 GB free for installation. An update keeps the previous runtime too.
T3 Code does not download it until you choose to install it.

On web or desktop, **Update Antigravity** appears when T3 Code has a newer managed release.
Running sessions keep their current runtime. New sessions use the installed update.

### Use a manual installation

Download the correct archive from the [official ACP Registry][registry] and extract both the
ACP executable and its `localharness_external` helper into the same directory. Keep both files
at the same version and make them executable on macOS or Linux. Windows uses `.exe` files.

On web or desktop, set **Binary path** in the Antigravity provider settings to the ACP
executable on the selected environment. Do not point it at the helper or the Antigravity IDE.

A nonempty **Binary path** takes priority. With the field empty, T3 Code uses its managed
runtime, then an installation on the environment's `PATH`. An invalid explicit path reports
an error instead of selecting another installation. T3 Code does not update or remove manual
installations. Clear **Binary path** to use managed installation controls.

## Models and threads

The current official ACP exposes Gemini models only. T3 Code uses the model IDs and names
returned for your account, including any model choices with different thinking levels. Models
available in other Antigravity apps might not be available through this agent.

New threads use Gemini 3.8 Flash (High) when your account offers it. Older Gemini generations
stay available under **Legacy models** in the picker.

Threads keep their selected model when you resume them. If that model is no longer available,
T3 Code asks you to select an available model instead of silently changing it.

Use Antigravity's native `/plan` command to request a plan. T3 Code's separate Plan mode control
is not available for this provider.

Antigravity reads and edits workspace files through T3 Code. Each write shows up as a file
change approval with the content, so **Supervised** and **Auto-accept edits** behave the same way
they do for other providers. Attach images, PDFs, text files, or audio clips to a message and
the agent receives them directly.

When the agent offers **Allow for this thread** on a shell or web tool, T3 Code shows Google's
prompt injection warning next to that choice. Untrusted content could re-run the same action
without asking again.

Antigravity can ask you to choose from a fixed set of answers. Select one of the offered
choices. These questions do not accept custom text and still appear in **Full access** mode.
See [Permission modes](./permission-modes.md) for tool approvals.

T3 Code keeps thread history and file diffs. Antigravity does not support conversation rewind,
so reverting a thread or editing and resubmitting an earlier turn is unavailable. Send a
follow-up message or start a new thread instead.

## Accounts and removal

Each Antigravity provider instance has its own Google sign-in on its environment. Use
**Add provider** in web or desktop provider settings to create a separate instance for another
account. To replace an instance's account, sign out first, then sign in again.

| Action                                                                           | Result                                                                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Disable Antigravity                                                              | Stops the instance's sessions. Keeps Google sign-in, thread history, and files.                                               |
| Sign out of Google                                                               | Stops the instance's sessions and removes its saved Google credentials. Keeps thread history and files.                       |
| Remove downloaded runtime on web or desktop, or Remove managed install on mobile | Removes the runtime shared by Antigravity instances on that environment. Keeps Google credentials, thread history, and files. |

Send `/logout` by itself in an Antigravity thread to sign out that provider instance. This has
the same effect as **Sign out of Google**, including stopping its other sessions.

Before removing a managed runtime, disable the instances that use it and cancel any active
installation. T3 Code refuses removal while the runtime is in use. An explicit **Binary path**
that points into the managed runtime must be cleared first.

## Account access and errors

Google controls account eligibility, models, and usage limits. T3 Code does not report your
paid-plan tier or remaining subscription quota. See Google's [Antigravity plans][plans] and
[personal Google sign-in guide][google-setup].

After an environment restarts, Google sign-in can show as not checked until an authenticated
session succeeds. To check account access and reload models, use **Refresh provider status**
in web or desktop provider settings, or **Refresh models** in the mobile model picker. Refresh
uses saved Google sign-in and does not open a login page. If sign-in is required, use the
provider's setup controls. Automatic status checks verify the installation only.

If Google reports `SUBSCRIPTION_REQUIRED`, an account restriction, or a usage limit, read the
provider's message. A finished turn can contain an upstream error instead of completed work.
Use any retry time Google supplies. T3 Code does not switch to an API key to get past the limit.

[registry]: https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
[plans]: https://antigravity.google/docs/plans
[google-setup]: https://antigravity.google/docs/ide/extensions/zed
