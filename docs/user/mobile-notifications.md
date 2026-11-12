# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Live Activity Updates** on iOS, **Agent Live Updates** on Android 16 and newer, or **Ongoing Agent Activity** on older Android versions to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off the same switch to stop future cards.

For activity without ordinary alerts on Android 8 or newer, leave **Ongoing agent activity** enabled and turn off **Agent alerts** in Android's notification settings for T3 Code. Activity updates continue, and the same card shows the finished result without a separate alert. On Android 16 and newer, the finished result remains a Live Update until dismissed or expired. Keep app-wide notification permission and **Live updates** enabled so Android can display it.

On iOS you can also add the **Agent Activity** widget to your Home Screen or Lock Screen. It shows the same agents as the Live Activity, using your T3 Connect sign-in. The widget refreshes when you open T3 and shows unfinished work as out of date after 10 minutes.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. If Live Updates don't appear on Android 16 or newer, check **Live Update Settings** in T3 Code's **Settings → Notifications**. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect; a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Custom background relay

If your custom mobile build uses a separate background relay, configure its publishing servers to
use the same destination. The relay must already accept your mobile sign-in and have push credentials
for that build; see the [custom build setup](../operations/connect-setup.md#separate-background-delivery-relay).

Use the credential issued by your background relay when linking this environment to your account.
Custom relay operators can follow the [link provisioning procedure](../operations/connect-setup.md#provision-a-background-relay-link)
to obtain it.

On each publishing server, supply these runtime environment variables through its service's secret
configuration, then restart the server:

- `T3CODE_BACKGROUND_RELAY_URL`: the same background relay origin.
- `T3CODE_BACKGROUND_RELAY_ENVIRONMENT_CREDENTIAL`: that relay's environment credential.
- `T3CODE_BACKGROUND_RELAY_ISSUER`: optional relay issuer origin used as the publish proof’s `aud`
  claim; defaults to the background URL. The proof’s `iss` remains `t3-env:<environmentId>`.

The environment's existing agent activity publishing switch still controls sharing. A configured
background relay replaces the activity destination; it does not publish a second copy to T3 Connect.
To restore the single-relay server configuration, remove these runtime overrides and restart the
server. Use a mobile build without the background relay override. Existing T3 Connect credentials
are not replaced.
