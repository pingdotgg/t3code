# Plugin views

A trusted local plugin can add views: small panels of its own UI that open as
tabs in the right panel of the web and desktop apps. A view runs in an isolated
frame. It cannot read T3 Code's pages, storage or connection, and it can only
reach its own plugin.

## Offering a view

In the plugin's `t3-plugin.json`, add `"views"` to `capabilities`, set
`"proposedApi": true`, and declare up to 8 views. Each has an `id`, a `title`,
the placement `side-panel`, one `script` and an optional `style`:

```json
{
  "capabilities": ["views"],
  "proposedApi": true,
  "views": [
    {
      "id": "board",
      "title": "Board",
      "placement": "side-panel",
      "script": "views/board.js",
      "style": "views/board.css"
    }
  ]
}
```

A view is one script and one stylesheet, together at most 1 MiB. It cannot load
other files or reach the network; inline images and fonts as `data:` URLs.

The script finds `t3View` on `window`. `t3View.ready` resolves once the view is
connected, and `t3View.call(handler, input)` asks the plugin, which answers by
registering `context.proposed.handle("view:<view id>:<handler>", handler)`:

```js
// views/board.js
t3View.ready.then(async () => {
  const answer = await t3View.call("echo", { from: "board" });
  document.body.textContent = JSON.stringify(answer);
});

// main.mjs, inside the plugin's activate(context)
context.proposed.handle("view:board:echo", (input) => ({ echo: input }));
```

Inputs and answers must be JSON of at most 64 KiB, and a call that does not
finish within 30 seconds fails. A view that sends too many messages, or stops
answering T3 Code's checks, is stopped; **Reload** in its tab starts it again.

## Opening a view

Plugins are added, consented to and enabled from an administrative connection,
as described in [Plugin tools](./plugin-tools.md). An enabled plugin's views
appear after the built-in panels in the right panel's empty launcher and its
**+** menu. Showing a view does not start the plugin; its first call does.

Disabling or removing the plugin closes its views at once on every connected
client. Changed files close them too, once T3 Code detects the change at one of
the checks described in [Plugin tools](./plugin-tools.md); a view already open
keeps running until then. The tab stays and says the view is not available, and
the view comes back when the plugin is enabled again. Close the tab to remove
it.

Views are not available in the mobile apps yet.
