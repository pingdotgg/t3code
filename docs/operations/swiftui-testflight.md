# SwiftUI TestFlight releases

This workflow releases `apps/swift-ios`, not the React Native app in `apps/mobile`.
The release bundle identifier is `com.t3tools.t3code.swiftui`. Development builds
use a separate identity and do not replace TestFlight.

## One-time API access

Create a dedicated **App Manager** team key in App Store Connect under
**Users and Access > Integrations > App Store Connect API**. This is the minimum
role for managing external TestFlight testing. Do not use an Admin key.

Apple team keys cover all apps in the team. A key's name does not restrict its
access. Get the account owner's approval for that scope before creating it.
The release helper verifies the SwiftUI bundle identifier and the app that owns
each tester group before it changes anything.

Download the private key once. Keep its contents in a private, uncommitted
`~/.config/t3code/.env.testflight` file. This location survives worktree cleanup.
Give the directory mode `700` and the env file mode `600`. Do not put the private
key or generated tokens in Git, build output, or pull request comments.

```dotenv
T3_SWIFT_ASC_KEY_ID=KEY_ID
T3_SWIFT_ASC_ISSUER_ID=ISSUER_UUID
T3_SWIFT_ASC_PRIVATE_KEY_BASE64=BASE64_OF_THE_ENTIRE_DOWNLOADED_P8_FILE
T3_SWIFT_ASC_APP_ID=SWIFTUI_APP_ID
T3_SWIFT_ASC_PUBLIC_GROUP_ID=PUBLIC_BETA_GROUP_UUID
T3_SWIFT_ASC_INTERNAL_GROUP_ID=INTERNAL_GROUP_UUID
```

Base64 is only an encoding, not encryption. Import the downloaded key without
printing its contents or the encoded value. Verify the saved value before
removing the separate download.

Use the app and groups belonging to the SwiftUI app. Do not copy the React Native
app ID from EAS. `T3_SWIFT_TESTFLIGHT_ENV_FILE` or `--env-file` can select another
env file. If you keep it in a checkout, use an ignored `.env` file and verify
that it is not tracked. The helper reads the file without exporting its values
to other processes or loading the app's general `.env`.

REST requests use the key in memory to sign short-lived tokens. Xcode uploads
need a key file, so the helper creates a private temporary `.p8` and removes it
after the upload finishes or fails. No permanent `.p8` or JSON config is needed.
The helper does not read Safari cookies or use an Apple ID password.

## Release

1. Update the project's build number, commit, and push. Keep the existing version
   unless the release needs a new one.
2. Verify the affected native behavior. Archive the `T3Code` scheme in `Release`
   with the production Clerk and relay settings. Confirm that the host, widget,
   and share extension use the production App Group.
3. Upload the archive with API credentials:

   ```sh
   node scripts/swift-testflight.ts upload \
     --archive /absolute/path/T3Code.xcarchive \
     --export-options /absolute/path/TestFlightExportOptions.plist
   ```

   Use the existing App Store Connect export options with `destination=upload`,
   `testFlightInternalTestingOnly=false`, and
   `manageAppVersionAndBuildNumber=false`. Keep the existing signing assets.
   The helper does not enable provisioning updates or fall back to Apple ID auth.

4. Check Apple's processing state:

   ```sh
   node scripts/swift-testflight.ts status --version 0.1.0 --build 46
   ```

5. Once processing completes, publish to the configured existing groups:

   ```sh
   node scripts/swift-testflight.ts publish --version 0.1.0 --build 46 \
     --notes-file /absolute/path/release-notes.txt
   ```

   The publish command checks existing group membership and review state before
   making changes. A rerun must not resubmit an existing review or send another
   notification for a build that is already testing.

6. Check status again. An uploaded or approved build is not enough. Confirm that
   the public group has the build and that external testing has started. If Apple
   is still reviewing it, report that state without claiming the beta is live.

Do not expire older builds as part of a normal release. Do not create or revoke
signing certificates or profiles to fix an API login error. API authentication
and Apple code signing are separate.

## Apple references

- [API key types and scope](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
- [Create and download an API key](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)
- [External testing roles and review](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
