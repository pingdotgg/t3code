# Plugins

Plugins add features to T3 Code: right panels, commands, themes, styles and tools for agents. A
plugin belongs to one environment and runs inside that environment's T3 Code server, with the same
access to your files, threads and credentials as T3 Code itself. A plugin's row lists the
permissions it says it uses, but T3 Code doesn't enforce them. Install only plugins you trust.

## Add a plugin

Open **Settings → Plugins** and drag a plugin's folder onto the page. **Add plugin** also lets you
choose the folder in a file window.

T3 Code copies a plugin folder into the environment's `plugins` folder, so later changes to your
copy do not affect the installed plugin. To update it, add the new version's folder the same way.
A new plugin is installed turned off, so none of it runs until you have read its row and turned it
on. A new version of a plugin stays on or off as the old one was. If a new version fails to install
or start, you keep the version you had, and T3 Code says why. A plugin that needs a newer version
of T3 Code, or whose settings T3 Code can't check, isn't installed, and T3 Code says why.

Plugin folders you copy into the `plugins` folder yourself show up, turned off, the next time you
open **Settings → Plugins**. That folder is `~/.t3/userdata/plugins` on the environment's machine
by default. Two folders with the same plugin id don't run until you delete one of them, and the
plugin's row names both.

To load a plugin from a folder on the environment's machine without copying it, such as one you're
building, choose **Add plugin**, open **Link a plugin folder** and enter the folder's path. **Reload**
then runs its latest files.

**Settings → Plugins** shows one environment at a time, the main one until you pick another at the
top of the page. To use a plugin on several environments, add it to each of them.

## Turn a plugin on or off

Use the switch on the plugin's row. A plugin that fails to start shows the reason on its row, for
example when it needs a newer version of T3 Code. A plugin with server code needs the environment's
T3 Code server to run on Node 24 or later, as the desktop app's does. **Reload** restarts a plugin
with its current files. Turning a plugin off doesn't stop code it started on its own, such as a
timer. If its row says some of its code is still running, restart T3 Code to stop it.

A plugin can stop T3 Code's server. When the server starts again, a plugin that stopped it while
starting, or with an error T3 Code could trace to it, is off, and its row says why. To try it again,
turn it back on. If T3 Code still won't start, run its server with `t3 --no-plugins`, which lists
your plugins but runs none, and turn the plugin off.

## Plugin settings

If a plugin has settings, open them with the settings button on its row. Each setting saves as soon
as you change it or leave its field, and an empty field shows the default the plugin uses. Secret
fields are stored in the environment's secret store and are never shown again after you save them;
the clear button next to one removes it.

## Remove a plugin

Choose **Remove** on the plugin's row and confirm in the popup. Removing a plugin also deletes its
settings, secrets and stored data, and this can't be undone. Reinstalling it later starts fresh.

A plugin loaded from its own folder shows **Unlink** instead. Unlinking stops loading it and deletes
its settings, secrets and stored data the same way, but leaves the folder where it is.

## Themes and styles

A plugin can change how T3 Code looks with files alone. CSS can still load files from other sites
and reveal what the page shows to them, so trust a styles-only plugin as you would any other. Theme
files in its `themes` folder show up as themes while the plugin is on. CSS files in its `styles`
folder apply to the app while the plugin is on, on top of T3 Code's own styles and your theme. A
plugin can be just a `styles` folder and its manifest. Themes and styles load from the same
environments as plugin UI (see [Where plugins live](#where-plugins-live)).

## Tools for agents

A plugin can give agents new tools. Agents in threads started after you turn the plugin on see them.
Turning the plugin off takes its tools away from every thread. Tools that only read work in any
thread. Tools that change things work only in a thread set to **Full access** and not in Plan mode.

## Where plugins live

Installed plugins are in the `plugins` folder of the environment's T3 Code data directory, one
folder per plugin. Their settings are in `plugin-data`, and `plugins.json` records which ones are
enabled. T3 Code reads a plugin's settings file once, so an edit you make to it by hand shows after
T3 Code restarts.

Plugin UI, styles and themes load in the web and desktop apps. They load from the app's main
environment, which is the desktop app's own server or the server the web app was opened from, and
from any other environment you turn on under **Load plugin UI from** in **Settings → Plugins**. You
can turn the main environment off there too. app.t3.codes and a desktop app with its local
environment turned off have no main environment, so no plugin UI loads until you choose one. The
choice applies to this browser only. Each chosen environment's plugins run code in this window, with
access to every environment this window is connected to, so choose only environments whose plugins
you trust.

A plugin's right panels show only in the threads of the plugin's own environment. A plugin that is on
in more than one chosen environment adds its commands and styles once, from the main environment
when it's on there. The mobile app doesn't show plugin UI, settings or
themes.
