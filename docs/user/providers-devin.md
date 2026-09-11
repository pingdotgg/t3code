# Devin

T3 Code can run Devin through the Agent Client Protocol (ACP) exposed by the Devin CLI.

## Setup

1. Install the [Devin CLI](https://docs.devin.ai/work-with-devin/devin-cli).
2. Authenticate in a terminal:

   ```bash
   devin auth login
   ```

3. Restart T3 Code so it inherits the updated `PATH`, then enable **Devin** in Settings.

T3 Code starts `devin acp` for each session. The model picker is populated from
`devin models list --format json`, including the `adaptive` model.

Model families are refreshed when T3 Code starts and when Devin settings change. Reasoning level,
speed, and context-window variants appear as options on a single family row; restarting T3 Code
after upgrading this integration also refreshes any older cached model list.

If T3 Code cannot find the executable, set **Binary path** in the Devin provider settings to the
absolute path of the `devin` executable. On Windows, an existing T3 Code process may need to be
restarted after the CLI installer updates your user `PATH`.

## Usage and context window

The **Usage** page includes token and cost records returned by Devin ACP prompt responses. These
records are read from the T3 server's canonical provider event logs, so they are available for
Devin sessions run through that server and remain local to the environment. The page labels this
source as **Devin ACP** and supports model/provider filtering and CSV export.

Devin's ACP `usage_update` notification also powers the context-window meter beside the composer.
Open the meter to see the current context percentage, used/max tokens, total processed tokens, and
provider-reported turn/session estimates when the CLI supplies them. A model switch keeps the T3
thread identity and asks Devin to restore the prior session through ACP `session/load`.

The Usage page's local token/cost estimate is not Devin plan billing. If you have an Enterprise
organization, you can optionally add a separate `cog_...` Devin service-user key with
`ViewOrgConsumption` permission and the organization ID as sensitive provider environment
variables named `DEVIN_API_KEY` and `DEVIN_ORG_ID`. T3 calls Devin's organization consumption API
on the server and shows returned ACUs in a separate card; ACUs are never mixed into token costs.
The ordinary Devin CLI login token is not reused for this request. Without those optional
variables, the page continues to show the local estimate and explains that account ACUs are not
configured. Sessions outside T3 remain visible in Devin's Billing/Session Insights views.

Provider event logs are retained for a limited period by the server's observability policy. Export
or review a Usage window before rotating logs if you need a longer local record.

## Capability limits

Conversation rewind is not supported by the Devin integration. Start a new thread when you need a fresh conversation.

Devin sessions use T3's shared ACP integration paths. The current Devin CLI does not provide
a supported child-agent event stream or elicitation flow, and T3 preserves supported resource
metadata through the generic activity path; live Devin resource emission/rendering has not been
verified because the installed CLI emitted no resource blocks. These capabilities are therefore not
available as Devin-specific controls in T3 Code.

## Remote servers

When you pair a phone or hosted web app with a remote T3 server, Devin runs on the remote machine.
Install and authenticate the Devin CLI there, and configure its binary path in that server's
provider settings; installing Devin only on the client device is not sufficient. A production build
can serve the modified web UI, but it still needs a running compatible T3 server (`t3 serve`) for
ACP sessions, Usage scanning, and event-log telemetry.

## Permissions

T3 Code maps its permission modes to Devin ACP modes:

- **Ask** uses Devin's `ask` mode.
- **Auto-accept edits** uses `accept-edits`.
- **Auto** uses `smart`.
- **Full access** uses `bypass`.
- Plan interactions use Devin's `plan` mode.

Devin support is currently marked Early Access.
