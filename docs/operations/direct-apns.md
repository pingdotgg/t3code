# Direct Apple notifications

Each T3 environment can send input and approval notifications directly to Apple.
This setup is intended for personal deployments where you control the app's Apple
signing identity and the server. A separate relay account is unnecessary.

## Where the Apple key belongs

For the desktop app, the **server** is the background process PseudoCode already
runs on the Mac that hosts the work. It does not mean you must rent another machine.
With direct APNs, that Mac sends the notification to Apple, and Apple delivers it
to the iPhone.

This guide configures one trusted host. If several Macs independently host work
and send directly to Apple, each needs private APNs configuration. A Mac that only
connects to another host does not need the key.

The key must belong to the Apple developer team that owns the installed iOS app's
bundle identifier. Someone using a different developer account needs their own
iOS app identifier and a build signed by that team. An unrelated Apple key cannot
send notifications to the publisher's TestFlight or App Store app.

For an app that anyone can download and use without Apple developer setup, keep
the publisher's key on a shared notification service instead. The user's host
submits an authorized notification request to that service; the service signs it
and sends it to Apple. Apple still handles delivery. This keeps the publisher's
key off other people's computers. The direct APNs mode below does not provide
that shared service.

Never commit the `.p8` key to GitHub or include it in a downloadable app, installer,
or bundled `.env` file. GitHub Actions secrets can supply private credentials to
a deployment, but embedding those credentials in the resulting app exposes them
to everyone who downloads it.

Desktop sounds and system alerts, and the widget's foreground refresh, do not
require this APNs configuration. It enables remote iPhone alerts and background
Live Activity and widget updates.

## Apple setup

Use a paid Apple Developer Program membership, including an individual membership.
Enable Push Notifications for the iOS app identifier. Keep the app and widget
extension in the same App Group. Do not use the free Personal Team build flag;
that build excludes the widget extension.

Create an APNs signing key in Apple Developer Certificates, Identifiers & Profiles.
Keep the downloaded `.p8` file on the server machine, outside the repository. You
will also need its Key ID, the Apple Team ID, and the exact installed app bundle ID.
A key restricted to a topic or environment must allow the app and build you use.
For TestFlight and App Store installs, choose **Production** when configuring the
APNs key. A Sandbox key is for Xcode development installs, even though TestFlight
is used for testing. A Production Team Scoped key covers the team's app and Live
Activity topics; a Topic Specific key must include the topics it sends to.
The App Store Connect API key used to upload TestFlight builds is a different key;
it cannot substitute for an APNs signing key.

## Desktop configuration that survives restarts

Install a desktop build that includes direct APNs support. In Finder, choose
**Go → Go to Folder** and enter `~/.t3/userdata/secrets`. For the default installed
desktop instance, this is its private configuration directory. An environment
using a different T3 home has its own `userdata/secrets` directory. Development
instances use their own state directory and do not inherit the installed app's key.

Place these two files in that directory:

- `apns.p8`: the downloaded Apple APNs key, renamed to this filename.
- `apns.json`: a plain-text JSON file containing the following settings.

```json
{
  "keyFile": "apns.p8",
  "keyId": "YOUR_APNS_KEY_ID",
  "teamId": "YOUR_APPLE_TEAM_ID",
  "bundleId": "your.ios.bundle.identifier"
}
```

The `keyFile` can be an absolute path if the key is stored elsewhere. Relative
paths resolve beside `apns.json`, independent of the directory the app launches
from. Use the **iOS** bundle identifier, which can differ from the desktop app's.
Keep both files readable only by your account; on macOS, for the default directory:

```sh
chmod 600 "$HOME/.t3/userdata/secrets/apns.json" "$HOME/.t3/userdata/secrets/apns.p8"
```

Quit and reopen the updated desktop app after configuring it. The sender reads
the files at startup, including when the app opens from Finder or at login. No
shell exports or `.env` file are needed. The configuration is not included in
downloads, and a new installation on another computer remains unconfigured.

To disable the sender on this instance, remove `apns.json` and restart it. To rotate
the key, update the `.p8` file and its Key ID in `apns.json`, then restart.

## Optional environment overrides

For a manually launched host, set these variables in the same terminal before
starting its executable. All four together override `apns.json`; a partial
override disables the sender with a configuration warning rather than combining
credentials from different sources.

```sh
export T3CODE_APNS_KEY_FILE='/absolute/private/path/AuthKey_YOURKEYID.p8'
export T3CODE_APNS_KEY_ID='YOURKEYID'
export T3CODE_APNS_TEAM_ID='YOURTEAMID'
export T3CODE_APNS_BUNDLE_ID='your.ios.bundle.identifier'
```

The key contents stay in the file. T3 reads it locally and uses it to sign APNs
requests. Do not paste the private key into chat, a client setting, or a build-time
public environment variable. A desktop app started from Finder does not inherit
terminal exports; use the private configuration file above for ordinary desktop
launches. Creating an `.env` file beside an installed app does not load it.

## Delivery requirements

No inbound Apple callback endpoint is needed. The environment needs outbound
HTTP/2 over TLS on port 443 to `api.push.apple.com` and
`api.sandbox.push.apple.com`. The phone registers its tokens using its existing
authenticated server connection, including connections through tunnels.

The app reads its provisioning profile to select sandbox versus production. If
the profile lookup returns no environment, a native App Store release type
selects production. Branding and app variant names do not select token routing.
TestFlight uses production APNs. An Xcode development install uses sandbox APNs.

## Install and verify

Build and install the updated iOS app. This requires a native build because the
app includes background notification support and native application metadata.
An over-the-air JavaScript update to an older client is insufficient.

1. Pair the app with the updated environment and open Settings.
2. Open **Notifications**, enable **Use my servers**, and
   allow notifications and sound. Check that the environment reports registration.
3. Enable **Live Activities**, start work, and keep the app open until a card is
   created. Lock the phone and confirm the card remains visible and updates.
4. Trigger an input or approval request from another client while the phone is
   locked. Confirm the alert, sound, and tap-to-thread navigation.
5. Add the Agent Activity widget, open the app to populate it, then check its
   saved activity and subsequent background updates.

The desktop **Test notification** button sends a local desktop notification only;
it does not test iPhone APNs delivery. Being active on the desktop does not suppress
direct iPhone alerts. A registration status confirms that the server saved the
device registration, not that Apple accepted a push.

Routine widget background pushes are limited to one every 20 minutes per device
per server, on activity changes. Attention alerts also include a widget snapshot.
iOS may defer or suppress background execution, particularly after force-quitting
the app; opening the app refreshes the widget. This implementation uses background
app notifications and WidgetKit timeline reloads, rather than iOS 26 WidgetKit push
tokens. It does not promise immediate widget redraws.

Live Activities use activity-specific APNs tokens. They are created while the app
is in the foreground, one per environment, and end when work finishes. To show a
new card after one has ended, open the app while work is active. Remote push-to-start
is not enabled.

## Disable and diagnose

Turn off **Use my servers** while connected to remove this device's direct
registrations and end its cards. If a server is offline, reconnect to complete
unregistration, or revoke the phone's session on that server. Every delivery
checks session validity; revoked or expired sessions stop receiving pushes.

The server logs APNs rejection status and reason without logging device tokens or
private keys. `403 BadEnvironmentKeyInToken` indicates the signing key is not
accepted for the requested APNs environment. Check the key's environment in Apple
Developer; for TestFlight, install a Production APNs key, update its Key ID in
`apns.json`, and restart the host. Changing the phone to Sandbox routing is not a
fix for a Production device token. No app rebuild is needed to replace the host key.

`BadDeviceToken` and `DeviceTokenNotForTopic` usually indicate a
signing-environment or bundle-ID mismatch. Invalid/unregistered tokens are removed.
Transport failures, rate limits, and server errors receive two bounded retries;
later state changes and phone registration reconcile the current card. The queue
is in memory, so a server restart does not replay old attention alerts.

References: [Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
[Apple APNs key configuration](https://developer.apple.com/help/account/keys/create-a-private-key),
[Apple token-based connections](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns),
[Expo signed APNs environment](https://docs.expo.dev/versions/latest/sdk/application/),
[Apple background updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).
