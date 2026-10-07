# Visual replies

Agents can answer with a page instead of only text: a chart, table, diagram, image collage, or mockup. Ask for one ("show this as a chart", "make a collage of these screenshots") and the agent builds a self-contained HTML page, which appears in the thread above its written reply. It works with every provider, on web, desktop, and mobile.

Pages use your current theme, including custom themes, and follow light and dark mode as you switch. Scripts run inside the page, but it is sandboxed away from T3 Code and your session. Links you click in a page open in your browser. Minimize a page to fold it down to its title, then select the title to show it again. This is temporary and only affects your client. Use the expand button to open a page full size; from there you can view its source or save it.

Agents can place local images in a page by file path. T3 Code embeds them when the page is published, so the page keeps working after the original files move or are deleted. Deleting the thread deletes its pages.

Before publishing, agents check their work with screenshots from a small headless browser that T3 Code keeps for itself; it never uses a browser you installed. The first preview on a machine downloads it once (about 120 MB) into T3 Code's data folder, so that preview can take a minute. Browser tabs on a remote environment use the same browser, so whichever comes first downloads it. Some Linux hosts need [setup](remote-access.md#browser-host-setup) before it can start. Pages publish without it.
