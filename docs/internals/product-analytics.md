# Product analytics

T3 Code sends anonymous product events from the server to PostHog. The server
uses the first available hashed Codex account ID, hashed Claude user ID, or
installation-scoped anonymous ID as the distinct ID. It also keeps the
telemetry opt-out, event buffer, and batch delivery. Clients do not load the
PostHog browser SDK.

## Client events

These events use the metadata from the WebSocket connection that caused them.
The metadata is not a person property or server-global current-client value.
Two clients connected to one server can report different values at the same
time.

| Event                   | Description                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.connected`      | The server accepted an authenticated WebSocket connection. Reconnects count again. Use this event for connection diagnostics, not active-use counts. |
| `client.thread.started` | The server accepted a command that created a thread.                                                                                                 |
| `client.turn.requested` | The server accepted a turn request. This is the standard active-use event.                                                                           |

`provider.turn.sent` stays a provider execution event. It does not receive
client metadata because a provider turn can continue after the requesting
client disconnects.

## Recommended properties

Client properties appear on the three client events when the connected client
reports them. Older clients can omit every client property.

| Property               | Values and meaning                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface`              | Product client: `web`, `desktop`, or `mobile`.                                                                                                                                                  |
| `webDeployment`        | Web delivery: `hosted` for the hosted app or `server` for web files served by a T3 server. Web only. This does not describe connection distance.                                                |
| `clientOs`             | `macOS`, `Windows`, `Linux`, `iOS`, `Android`, `ChromeOS`, `other`, or `unknown`.                                                                                                               |
| `clientDeviceType`     | `desktop`, `phone`, `tablet`, or `unknown`. This is separate from `surface`.                                                                                                                    |
| `clientBrowser`        | Normalized browser family. Web only. Browser detection is best effort.                                                                                                                          |
| `clientAppVersion`     | Version of the connected client.                                                                                                                                                                |
| `clientOsMajorVersion` | Client OS major version when the native client reports it. Initially mobile only.                                                                                                               |
| `clientDeviceModel`    | Hardware model when the native client reports it. Initially mobile only. This is not a user-assigned device name.                                                                               |
| `connectionMethod`     | `direct`, `ssh`, `relay`, or `unknown`. `direct` means that the client connected to the server endpoint without an SSH or relay connection. It does not mean both processes run on one machine. |

Server properties appear on all events, including server boot and background
events.

| Property           | Values and meaning                                             |
| ------------------ | -------------------------------------------------------------- |
| `serverOs`         | Server process OS, normalized to the same names as `clientOs`. |
| `serverArch`       | Server process architecture.                                   |
| `serverWslDistro`  | WSL distribution from `WSL_DISTRO_NAME`, when present.         |
| `serverAppVersion` | T3 server version.                                             |
| `serverMode`       | Server runtime mode: `desktop` or `web`.                       |

## Legacy properties

Existing property meanings do not change:

- `clientType` describes how the server runs. It is `desktop-app` for a desktop
  server and `cli-web-client` for a CLI web server. It does not describe the
  connected client. Use `surface` and `webDeployment` for new reports.
- `platform`, `arch`, `wsl`, and `t3CodeVersion` describe the server. Use the
  new `server*` names for new reports.
- `appVersion` describes the connected client. Use `clientAppVersion` for new
  reports.
- Mobile connection events keep `os`, `osMajorVersion`, and `deviceModel`.
  Use the new `client*` names for new reports.

## PostHog dashboard

Create one saved dashboard named `Client and platform usage`. Set
`client.turn.requested` as the event for active-use reports. A user can appear
in several client groups during one period, so do not add breakdown values to
calculate a total.

Save these insights:

| Insight                         | Configuration                                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active users, daily             | Trends, `client.turn.requested`, unique users, daily interval.                                                                                                                                                                                                                          |
| Active users, weekly            | Trends, `client.turn.requested`, unique users, weekly interval.                                                                                                                                                                                                                         |
| Active users, monthly           | Trends, `client.turn.requested`, unique users, monthly interval.                                                                                                                                                                                                                        |
| Client usage                    | Trends, `client.turn.requested`, unique users. Save four filtered series: `surface = desktop`, `surface = mobile`, `surface = web` and `webDeployment = hosted`, and `surface = web` and `webDeployment = server`. Name them Desktop, Native mobile, Hosted web, and Server-served web. |
| Client OS, active users         | Trends, `client.turn.requested`, unique users, breakdown by `clientOs`.                                                                                                                                                                                                                 |
| Client OS, turns                | Trends, `client.turn.requested`, total events, breakdown by `clientOs`.                                                                                                                                                                                                                 |
| Client versus server OS         | Table, `client.turn.requested`, breakdown by `clientOs` and `serverOs`.                                                                                                                                                                                                                 |
| Connection method, active users | Trends, `client.turn.requested`, unique users, breakdown by `connectionMethod`.                                                                                                                                                                                                         |
| Connection method, turns        | Trends, `client.turn.requested`, total events, breakdown by `connectionMethod`.                                                                                                                                                                                                         |
| Mobile devices                  | Table, `client.turn.requested`, filter `surface = mobile`, breakdown by `clientOs`, `clientOsMajorVersion`, and `clientDeviceType`.                                                                                                                                                     |
| Client version adoption         | Trends, `client.turn.requested`, unique users, breakdown by `clientAppVersion`.                                                                                                                                                                                                         |
| Server version adoption         | Trends, `client.turn.requested`, unique users, breakdown by `serverAppVersion`.                                                                                                                                                                                                         |
| Missing metadata                | Table or SQL insight that shows the percentage of `client.turn.requested` events where each of `surface`, `clientOs`, `clientDeviceType`, `clientAppVersion`, and `connectionMethod` is absent. Track `webDeployment` and `clientBrowser` only within `surface = web`.                  |

In PostHog Data management, use the event and property descriptions from this
document. Mark the recommended properties as verified. Keep `clientType`
visible with its legacy description so old reports remain understandable.

## Collection and release boundary

Client values are best effort. Invalid values are ignored and never reject a
connection. Browser clients use user-agent data for broad OS, browser, phone,
and tablet groups. They do not infer CPU architecture or an exact OS version
from `navigator.platform`.

This change does not collect URLs, tokens, prompts, IP addresses, or
user-assigned device names. It measures authenticated product use. It does not
measure a person who visits the hosted app without connecting to a server.

The new fields start with the first client and server release that contains
this metadata path. Historical events cannot reliably identify the client OS,
hosted web use, device type, or connection method when the old client did not
send those fields. Reports must treat missing values as pre-release or older
client data instead of backfilling them from server fields.
