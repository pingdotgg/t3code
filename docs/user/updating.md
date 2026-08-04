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
| **Update server**          | Available for the T3 Code Linux background service. Select the button and leave T3 Code open while it prepares, tests, restarts, and reconnects.                            |
| **Update the desktop app** | Open the T3 Code desktop app on the machine that runs the server and install the app update there. Reopen it if needed.                                                     |
| **Copy update command**    | Copy the command, open a terminal on the server machine, stop the current T3 Code server, and relaunch it with the copied command and any startup options you normally use. |

The available action depends on how that server was started. T3 Code does not update connected
servers silently in the background.

If the requested version includes a database update, remote installation stops before restart and
asks you to run the exact `npx t3@<version> service update` command on the server machine. This is
an intentional rollback-safety boundary.

After selecting **Update server**, the warning becomes a three-step progress rail:
**Download**, **Install**, and **Resume**. The same progress appears in the conversation and in
Connections, so navigating between them does not lose the update. A failed step remains visible
with its error and an option to retry.

**Copy update command** gives you `npx t3@<client-version>`, which relaunches the server directly
at the matching version. Add whatever startup options you normally use.

If the server instead runs as the T3 Code background service, update the service on the host and
pin the same version:

```sh
npx t3@<client-version> service update
```

`service update` installs the version of the CLI that invoked it, so `npx t3@latest service update`
only resolves the skew when your client happens to be on the latest release. The exact version from
the warning always works.

See [Running T3 Code in the Background](./background-service.md) for install, status, and removal
commands.

## After the Update

Keep the web or desktop app open while the server restarts. The update completes only after the
service launcher reports that exact update committed and the replacement server is ready to accept
commands. A rollback is reported immediately instead of waiting for a generic reconnect timeout.

If a step fails:

1. Retry the offered action once.
2. Make sure you updated the machine named in the warning, not only the device you are using.
3. For a command-line server, relaunch it with `npx t3@<client-version>`, replacing
   `<client-version>` with the client version shown in the warning.

For remote connection setup and access troubleshooting, see [Remote Access](./remote-access.md).
