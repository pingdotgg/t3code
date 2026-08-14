# Plugins

Plugins are environment-local packages that add pages to T3 Code. A plugin can contribute several
view commands; each command appears in the sidebar and command palette on connected web and desktop
clients.

## Create a plugin

1. Open **Settings → Plugins**.
2. Select **Create**.
3. Enter a name, plugin ID, and optional description.
4. Select **Create plugin**.

T3 Code creates a working starter in the plugins directory shown at the bottom of the page. By
default, that directory is `~/.t3/plugins`. The starter includes a manifest, an immediately usable
built page, editable TSX source, and a local `@t3tools/plugin-sdk` package. Enable or disable
installed plugins from the same settings page, and use Reload after changing a manifest.

## Develop a plugin

Open the generated plugin directory in a terminal, then install and build it:

```sh
pnpm install
pnpm build
```

Edit `src/home.tsx` to change the starter page. To add another page, add an HTML build input and a
matching command to `t3-plugin.json`:

```json
{
  "schemaVersion": 1,
  "id": "deploy-tools",
  "name": "Deploy tools",
  "commands": [
    {
      "name": "dashboard",
      "title": "Dashboard",
      "entry": "dist/dashboard.html"
    }
  ]
}
```

Command and plugin IDs use lowercase letters, numbers, and hyphens. Every command points to a built
HTML file inside its plugin directory.

### Bundle your page as a classic script

Plugin pages render in a sandboxed frame with an opaque origin, so browsers fetch ES modules there
in CORS mode — which the host deliberately does not permit. Load your bundle with a plain
`<script src="app.js"></script>`, not `<script type="module">`, and configure your bundler to emit a
classic/IIFE bundle (for example `format: "iife"` in Bun or esbuild, or `output.format: "iife"` in
Rollup).

A module script fails quietly: the page renders, the network shows the file fetched successfully,
and nothing else happens, because the browser discards the response instead of executing it.

### Keep a command on one document

The host trusts the frame only while it still holds the document that was loaded for the command.
If the page navigates the frame elsewhere — `location.href = ...`, or a link that replaces the
current document — the host bridge shuts down for that frame: `showToast`, `openExternal`, and
`invoke` stop working, and a reply to an invocation that was already in flight is dropped rather
than delivered to the new document. Keep a command's UI on its own page and use `invoke` to fetch
what it needs; use **Reload** to get a fresh frame.

Plugins that need environment-local code can declare a JavaScript backend:

```json
{
  "backend": "dist/backend.mjs"
}
```

The backend is launched on demand on the environment host. It receives one JSON object on stdin
with `action` and `input` fields and must write one JSON value to stdout. The starter SDK's
`invoke(action, input)` helper sends that request from the page and returns the parsed result. A
backend runs with the same local permissions as T3 Code, so only install plugins you trust.

## Sharing plugins

A git repository can ship plugins to any environment. Put each plugin in its own folder under
`plugins/` at the repository root, and name the folder exactly like the `id` in its manifest:

```
plugins/
  deploy-tools/
    t3-plugin.json
    dist/dashboard.html
    dist/backend.mjs
  oncall/
    t3-plugin.json
    dist/home.html
```

One repository can contain as many plugins as you like; every folder directly under `plugins/` that
holds a `t3-plugin.json` is installed together. Nested folders deeper than that are not searched.

Commit the **built** output. The environment host clones the repository as-is: it does not install
dependencies and does not run a build step. The `entry` HTML of every command, the `backend` `.mjs`
if the plugin declares one, and any asset they load must all be committed. Add a build step to your
own release flow if you prefer, but the files referenced by the manifest have to exist in the repo.

Never commit secrets. Tokens, API keys, and connection strings belong in the environment, not in the
repository — have the backend read them from environment variables at run time.

To install a shared repository:

1. Open **Settings → Plugins**.
2. Under **Sources**, select **Add source**.
3. Paste the repository URL. `https://`, `ssh://`, and `git@` remotes are accepted.
4. Select **Add source**.

Each source row shows its git URL, how many plugins it provides, and any problem found while
loading it. Use **Update** to pull new commits, and **Remove** to uninstall the repository together
with every plugin it provided. Plugins that came from a source are labelled with the source name and
cannot be deleted individually; remove the source instead. Enable and disable them as usual.

> **Only add sources you trust.** A plugin backend is ordinary local code that runs on the
> environment host with the same permissions as T3 Code. It is not sandboxed, so it can read and
> write your files and reach your network. Adding a source runs code written by whoever controls
> that repository, and **Update** pulls new commits that run with those same permissions. Review the
> repository the way you would review any dependency you install locally.

## Security and remote access

Plugins live on the T3 server for their environment, so remote web and desktop clients see the same
catalog. Pages are served through short-lived signed URLs and run in a sandboxed frame with a strict
content policy. They do not receive T3 Code credentials or direct API access. Host-mediated SDK
calls provide toast and external-link actions, plus bounded invocation of a plugin's declared local
backend. Inputs travel over the authenticated environment connection rather than URL arguments.

This first version does not include a marketplace, publishing, dependency installation, background
commands, or mobile rendering.
