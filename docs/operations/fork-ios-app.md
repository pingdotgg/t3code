# The fork's iOS app and its push notifications

The fork builds its own iOS app, signed with your own Apple team, so the phone gets the fork's
features. The fork's builds have T3 Connect turned off, so notifications cannot come through
upstream's relay. Instead each T3 server sends them to Apple itself, with your own APNs key.

## Building and installing

You need a paid Apple Developer Program membership: push, App Groups and the widget and share
extensions cannot be signed by a Personal Team, and Personal Team builds expire after seven days.
A free account still works with `T3CODE_IOS_PERSONAL_TEAM=1` (see `apps/mobile/README.md`), without
notifications; add `T3CODE_IOS_TEAM_ID` with the Personal Team's ID, the `OU` of its Apple
Development certificate, to sign with it rather than leave the choice to Expo.

1. In Xcode → Settings → Accounts, sign in with the Apple ID of your team.
2. Connect the iPhone, trust the Mac, and turn on Settings → Privacy & Security → Developer Mode.
3. From `apps/mobile`, with your team ID (Membership details in the developer portal) and a bundle
   identifier you own:

   ```sh
   T3CODE_IOS_TEAM_ID=ABCDE12345 \
   T3CODE_IOS_BUNDLE_ID=com.example.t3code \
   vp run ios:release
   ```

   Run it again to install a newer commit. Over-the-air updates are off for these builds, since
   upstream's update channel would replace the fork's JavaScript.

The first device build for a new bundle identifier can stop at "No profiles for '<bundle id>' were
found": Expo lets Xcode create provisioning profiles only when the project names no team, and these
builds name yours. Build once with provisioning allowed; it registers the app ID, its capabilities,
the App Group and the extension IDs, and later `vp run ios:release` runs reuse the profile:

```sh
cd apps/mobile
xcodebuild -workspace ios/T3Code.xcworkspace -scheme T3Code -configuration Release \
  -destination id=<device udid> DEVELOPMENT_TEAM=<team id> \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration
xcrun devicectl device install app --device <device udid> \
  ~/Library/Developer/Xcode/DerivedData/T3Code-*/Build/Products/Release-iphoneos/T3Code.app
```

`xcrun devicectl list devices` shows the udid. Signing asks for the Mac login password to use the
certificate's key; answer Always Allow, since a denied prompt leaves a framework unsigned and the
phone refuses the app. If `security find-identity -v -p codesigning` lists no valid identity after
Xcode created the certificate, the keychain lacks Apple's current intermediate: add
[AppleWWDRCAG3.cer](https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer) to the login
keychain. On the phone, trust the developer once under Settings → General → VPN & Device
Management.

## Push notifications

1. In the developer portal, under Certificates, Identifiers & Profiles → Keys, create a key with
   Apple Push Notifications service (APNs) enabled, and download its `.p8` file. Apple lets you
   download it only once. One key serves every app of the team, sandbox and production.
2. On each T3 server the phone should hear from, open Settings → General → Notifications →
   Phone notifications, and add the team ID, the key ID and the `.p8` file.
3. In the app, open Settings → Notifications and turn on Device Notifications. The phone registers
   with every connected server that sends notifications itself, and again after a reconnect or a
   token change.
4. Send test, on the server's Phone notifications row, notifies every registered phone and shows
   APNs' answer for any that failed.

The server notifies when a thread needs approval or input, fails, or completes, using the same rules
as the relay. Completions wait five seconds, so a run followed at once by its continuation does not
notify. Subagent approval waits do not notify yet.

A locally built app reports production APNs but carries a sandbox token when Xcode signs it for
development. The server retries the other APNs host when Apple answers `BadDeviceToken`, remembers
the one that worked, and drops a phone that Apple rejects in both, or answers `Unregistered` for.
The key and the registered phones live in the server's secret store, never in its settings.
