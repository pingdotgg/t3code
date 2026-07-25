# Keeping T3 Code in Sync

The T3 Code web or desktop app and the server it connects to work best when they use the same
version. If they do not match, T3 Code shows a warning with the right update option for that server.

## Where to Find the Update

You may see the warning in either of these places:

- above the message box in the current conversation
- **Settings** → **Connections**, beside the affected connection

Dismissing the conversation warning only hides that reminder for those two versions. It does not
update the server, and the version difference remains visible in Connections.

## Before You Update

Let active agent work and terminal commands finish first. Updating restarts the server, so the
connection will disappear briefly and work that is still running may be interrupted.

The update does not remove saved threads, settings, or project files.

## Choose the Action You See

| Action                     | What to do                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Select the button and leave T3 Code open. It prepares the matching version, restarts the server, and reconnects automatically. This can take several minutes.               |
| **Update the desktop app** | Open the T3 Code desktop app on the machine that runs the server and install the app update there. Reopen it if needed.                                                     |
| **Copy update command**    | Copy the command, open a terminal on the server machine, stop the current T3 Code server, and relaunch it with the copied command and any startup options you normally use. |

The available action depends on how that server was started. T3 Code does not update connected
servers silently in the background.

If the server uses the T3 Code background service, you can also update it directly on the host:

```sh
npx t3@latest service update
```

See [Running T3 Code in the Background](./background-service.md) for install, status, and removal
commands.

## After the Update

Keep the web or desktop app open while the server restarts. When it reconnects with the matching
version, the warning and update action disappear.

If the client reports a timeout, the server may still be finishing the update. Wait a minute, then
reconnect or open **Settings** → **Connections** again. If the warning remains:

1. Retry the offered action once.
2. Make sure you updated the machine named in the warning, not only the device you are using.
3. For a command-line server, relaunch it with `npx t3@<client-version>`, replacing
   `<client-version>` with the client version shown in the warning.

For remote connection setup and access troubleshooting, see [Remote Access](./remote-access.md).
