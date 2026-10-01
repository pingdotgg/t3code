# ChatGPT Web

ChatGPT Web is an experimental provider that sends model requests through your
ChatGPT website session in T3 Code's shared browser. OpenCode 1.14.19 or newer
supplies the local coding tools and follows T3 Code's permission mode.
This provider uses a separate OpenCode configuration; existing OpenCode plugins,
provider settings, and project-specific OpenCode configuration are not imported.

In **Settings > Providers**, select **ChatGPT Web**, then start a thread with that provider. T3 opens ChatGPT in the thread's visible shared browser. If the first request asks you to sign in, complete sign-in there and retry. The browser session stays in T3's persistent preview profile; T3 does not copy cookies or start a separate browser. Agent browser access must be enabled for the project, and a connected T3 Code desktop must host the preview.

To keep automatic titles and generated text on this provider too, explicitly
select its model in **Settings > General > Text generation**. Source control
writing can have a separate model override. Choosing ChatGPT for a thread does
not change those settings. ChatGPT Web generates thread titles locally from the
first message, without another website request.

T3 uses temporary chats and the website's current model. Requests run in the
visible shared browser. If ChatGPT asks for verification, complete it in that tab.
The failed request starts the configured cooldown before another request. T3
does not bypass browser checks. Clear the preview browser's site data from its
browser controls to sign out.

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
