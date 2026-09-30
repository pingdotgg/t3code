# ChatGPT Web

ChatGPT Web is an experimental provider that sends model requests through your
ChatGPT website session. Firefox must be installed and signed in to ChatGPT on
the machine running the environment. OpenCode 1.14.19 or newer supplies the local
coding tools and follows T3 Code's permission mode.
This provider uses a separate OpenCode configuration; existing OpenCode plugins,
provider settings, and project-specific OpenCode configuration are not imported.

In **Settings > Providers**, add **ChatGPT Web**. Leave the Firefox profile folder
blank to use the default profile, or enter the folder shown in Firefox's
`about:profiles`. Select the new provider when starting a thread. Remote and
mobile clients use Firefox on the environment's machine.

To keep automatic titles and generated text on this provider too, explicitly
select its model in **Settings > General > Text generation**. Source control
writing can have a separate model override. Choosing ChatGPT for a thread does
not change those settings. ChatGPT Web generates thread titles locally from the
first message, without another website request.

T3 copies only ChatGPT cookies into an isolated Firefox profile and leaves your
existing browser open. It uses temporary chats and the web session's current
model. Background mode uses standard headless Firefox. Disable that setting to
see Firefox on the environment's desktop. If ChatGPT asks for a browser check or
sign-in, the request stops. Sign in through your normal Firefox profile, then
disable and enable the provider to reconnect. Disabling or removing the provider
closes its Firefox process and deletes its temporary profile.

## Request limits and usage

Defaults allow one request per 60 seconds, 20 per rolling hour, and 100 per
rolling 24 hours. Each tool step is another model request. Edit these limits in
the provider's settings. Attempts count even when cancelled or unsuccessful,
and counters survive restarts. Reaching an hourly or daily cap stops the turn.
Service errors start a configurable cooldown, initially 30 minutes. These are
local limits for one environment; requests from your other browsers or
environments are not included. No rate setting guarantees against account
restrictions or changes to ChatGPT's web service.

Completed model requests appear under **ChatGPT Web (estimated)**. Input and output
tokens are estimates from visible UTF-8 text (one token per four bytes), including
the coding instructions and tool results sent to ChatGPT. Exact model tokens,
hidden reasoning, cache counts, and ChatGPT's remaining allowance are unavailable.
No API price is assigned unless you supply a price override. Attachments are not
supported by this provider.
The local web transport accepts prompts up to 80 KB, including instructions,
tools, and conversation history. Start a new thread if that budget is reached.
Automatic context compaction is disabled to avoid spending website requests on
repeated summaries of the fixed tool catalogue.
