# Test in other browser engines

The docked browser renders pages with Chromium. You and the agent can also test a page in Gecko
(Firefox) or WebKit (Safari) on the machine that runs the T3 Code server.

## Open a page in Firefox or Safari

In the right panel, open the "+" menu and hover Browser. Below the profiles, pick "Firefox
(Gecko)" or "Safari (WebKit)". The same choices are in the browser card of the empty panel. An
open browser tab has "Open in Firefox (Gecko)" and "Open in Safari (WebKit)" in its three-dot
menu. Those open the current page in a new tab.

The page runs headless on the machine that runs the server. The tab shows a live video of the
page and sends your clicks, scrolls, and keys to it. The address bar, back, forward, and refresh
work as in a Chromium tab. Screenshots, element picking, recording, and the device toolbar are
not available in these tabs. The page has no sound. Keyboard shortcuts with the Command or
Windows key stay with T3 Code.

Engines that are not installed do not appear in the menus.

## Let the agent test in another engine

Ask the agent to test the page in Firefox or Safari. It opens a headless tab, takes screenshots,
clicks, types, and reads the page in that engine. A headless Blink (Chromium) tab is also
available for tests that must not touch the docked browser. These tabs have no window.
Screenshots the agent saves appear in the conversation.

## Install an engine

T3 Code does not bundle these browsers. It looks for the Playwright builds of Firefox and WebKit,
and for a Chromium build, Google Chrome, or Microsoft Edge. When an engine is missing, the agent
gets an install command of this form:

```
npx playwright-core@<version> install firefox
```

Run it on the machine that runs the server. Playwright downloads the browser into its own cache.
Stock Firefox and Safari installs cannot be used.
