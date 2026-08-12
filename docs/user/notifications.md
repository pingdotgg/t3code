# Notifications

T3 Code can notify you when an agent finishes, fails, or needs approval. Choose the events and sound under **Settings → Notifications**.

## Web Push

In a browser, sign in to T3 Connect and enable **Web Push**. Your browser will ask for notification permission. T3 Code then uses the browser's standard Web Push subscription, so notifications can arrive when the tab is in the background or closed. Firebase is not involved.

The browser must support Web Push and the page must use a secure connection. Background delivery also requires the environment to be linked to the same T3 Connect account.

When the page is running, T3 Code plays its alert chime. When the page is closed, the browser and operating system control the notification sound. Silent mode, Do Not Disturb, and browser notification settings can still suppress it.

Turning off **Web Push** unsubscribes that browser. Opening a notification returns you to the affected thread.
