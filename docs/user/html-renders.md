# Visual replies

Agents can answer with a page instead of only text: a chart, table, diagram, image collage, or mockup. Ask for one ("show this as a chart", "make a collage of these screenshots") and the agent builds a self-contained HTML page, which appears in the thread above its written reply. It works with every provider, on web, desktop, and mobile.

Pages use your current theme, including custom themes, and follow light and dark mode as you switch. Scripts run inside the page, but it is sandboxed away from T3 Code and your session. Links you click in a page open in your browser. Use the expand button to open a page full size; from there you can view its source or save it.

A page can also take your answer. When an agent offers choices or a short form, clicking a button sends that answer to the thread as your message, just as if you had typed it.

Agents can place local images in a page by file path. T3 Code embeds them when the page is published, so the page keeps working after the original files move or are deleted. Deleting the thread deletes its pages.

Before publishing, agents check their work with screenshots from a small headless browser that T3 Code keeps for itself; it never uses a browser you installed. The first preview on a machine downloads it once (about 120 MB) into T3 Code's data folder, so that preview can take a minute. Browser tabs on a remote environment use the same browser, so whichever comes first downloads it. Some Linux hosts need [setup](remote-access.md#browser-host-setup) before it can start. Pages publish without it.

## MCP apps

Some MCP servers return an interactive app with their tool results, following the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard. When an agent calls one of those tools, the app appears in the thread in place of the tool call, on web, desktop, and mobile. Codex supports this today, for any MCP server you have configured for it; other providers show these calls as ordinary tool calls.

Apps follow your theme. An app can call tools on its own server and post a message to the thread; T3 Code asks first unless the server marks the tool as read-only, and it asks before every message. On mobile, an app also asks before opening a link, and T3 Code asks before saving a file an app offers. An app stays viewable after its agent stops, but using it needs the agent of the thread that created it running, so send a message in that thread first if the app says it is unavailable. An app that navigates away from its own page is stopped.

An app can open full screen; use the button in its top corner, or press Escape outside the app, to return it to the thread. Anything else that needs your attention, such as an approval, also returns it to the thread. On mobile, full screen opens the app again in its own screen, so anything the app does not save itself starts over. An app can also keep the agent informed of what you did in it, such as a filter you picked; T3 Code sends the latest note from each app with your next message.
