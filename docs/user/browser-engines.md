# Test in other browser engines

The docked browser renders pages with Chromium. The agent can also open a headless tab in Gecko
(Firefox) or WebKit (Safari) on the machine that runs the T3 Code server.

Ask the agent to test the page in Firefox or Safari. It opens the tab, takes screenshots, clicks,
types, and reads the page in that engine. A headless Blink (Chromium) tab is also available for
tests that must not touch the docked browser. The tab has no window. Screenshots the agent saves
appear in the conversation.

T3 Code does not bundle these browsers. It looks for the Playwright builds of Firefox and WebKit,
and for a Chromium build, Google Chrome, or Microsoft Edge. When an engine is missing, the agent
gets an install command of this form:

```
npx playwright-core@<version> install firefox
```

Run it on the machine that runs the server. Playwright downloads the browser into its own cache.
Stock Firefox and Safari installs cannot be used. Recording is not available in these tabs.
