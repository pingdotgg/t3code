# Mobile notifications

Get push alerts, Live Activities, and home-screen widgets on iOS and Android when agents finish, fail, or need your approval or input.

## Prerequisites

- Sign in to **T3 Connect** on both your phone and host machine (direct/Tailscale connections alone do not deliver background push notifications).
- Enable **Publish agent activity** in **Settings → Sharing & access** on the host.
- Enable **Device Notifications** in **Settings → Notifications** on mobile (Android requires Android 7.0+ and Google Play services).

## Live updates and widgets

- **Live progress**: Enable **Live Activity Updates** (iOS), **Agent Live Updates** (Android 16+, check **Live Update Settings** if missing), or **Ongoing Agent Activity** (older Android). Finished results stay visible for up to 15 minutes.
- **Silent live updates (Android 8+)**: Keep **Ongoing agent activity** on and disable **Agent alerts** in Android system notification settings.
- **iOS widget**: Add the **Agent Activity** widget to your Home Screen or Lock Screen (refreshes when you open T3; marks unfinished work stale after 10 minutes).

## Notes

- Ordinary alerts are muted while the mobile app is in the foreground, though viewing a thread on another device does not silence your phone.
- Force-stopping T3 Code in Android system Settings pauses push delivery until you reopen the app.

## Focus filters

On iOS, a Focus can choose which environments T3 Code uses. Open **Settings → Focus**, pick a Focus, tap **Add Filter**, choose **T3 Code**, and select the environments to keep. While that Focus is on, T3 Code connects only to those environments and iOS silences notifications from the others. Environments left out show **Paused by Focus** in **Settings → Environments**. Their switches keep your setting, so turning the Focus off reconnects exactly the environments you had on. An environment you switched off stays off, even when the Focus allows it.

A filter with no environments selected changes nothing. If a Focus turns on or off while T3 Code is closed or in the background, the app applies the change the next time you open it. You can also set the filter from the Shortcuts app with the **Set T3 Code Focus Filter** action.
