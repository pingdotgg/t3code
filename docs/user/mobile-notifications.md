# Mobile notifications

Get push alerts, Live Activities, and home-screen widgets on iOS and Android when agents finish, fail, or need your approval or input.

## Paired Android environments

For self-hosted notifications without T3 Connect, pair your Android phone to your environment normally, then enable that environment under **Settings → Notifications → Paired environments**. Your server and Android app must have matching Firebase configuration; ask your server administrator if setup is unavailable.

Alerts show thread titles and project names, using the same notification behavior as T3 Connect. Their content is encrypted for your phone before it reaches Google and decrypted natively, including when the app is not running. Conversations, code and files are not included. The server must remain running to send notifications; your phone does not need to keep a connection open to receive them. Opening the thread still requires Tailscale or your normal server connection.

Enable **Ongoing Agent Activity** to follow work from your enabled environments in one activity card. Finished results remain visible for up to 15 minutes. Alerts stay quiet when their thread is on screen, while the activity card continues to update. Paired delivery is independent of T3 Connect sign-in; iOS notifications still require T3 Connect.

Both the Android app and server must support encrypted notifications. Updating the app refreshes existing enabled registrations automatically. Turn off an environment's preference to stop local alerts and remove its notification key, even while the server is offline. Revoking the phone's pairing prevents new sends. Google still processes device identifiers and delivery metadata; encryption does not hide notifications displayed on your phone.

## T3 Connect prerequisites

- Sign in to **T3 Connect** on both your phone and host machine.
- Enable **Publish agent activity** in **Settings → Sharing & access** on the host.
- Enable **Device Notifications** in **Settings → Notifications** on mobile (Android requires Android 7.0+ and Google Play services).

## Live updates and widgets

- **Live progress**: Enable **Live Activity Updates** (iOS), **Agent Live Updates** (Android 16+, check **Live Update Settings** if missing), or **Ongoing Agent Activity** (older Android). Finished results stay visible for up to 15 minutes.
- **Silent live updates (Android 8+)**: Keep **Ongoing agent activity** on and disable **Agent alerts** in Android system notification settings.
- **iOS widget**: Add the **Agent Activity** widget to your Home Screen or Lock Screen (refreshes when you open T3; marks unfinished work stale after 10 minutes).

## Notes

- Ordinary alerts are muted while their thread is on screen, though viewing a thread on another device does not silence your phone.
- Force-stopping T3 Code in Android system Settings pauses push delivery until you reopen the app.
