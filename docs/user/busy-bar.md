# BUSY Bar

T3 Code can show agent activity on a [BUSY Bar](https://busy.app). The bar shows **DONE** or **FAILED** with the thread's title when a run ends. It shows **APPROVE** or **INPUT** while an agent waits on you. Answering the request clears that message. Subagents and threads that were already idle when the server started stay quiet.

## Set it up

Open **Settings → Integrations → BUSY Bar** and turn on **Send events to BUSY Bar**. Over USB that's all you need. The bar shows "T3 Code" for a few seconds, and a line under the toggle says whether the server reached it.

For Wi-Fi or the cloud, open **Connection**, enter the address and secret, and save:

- **Wi-Fi:** use the bar's IP address and its HTTP access password. To set the password, connect the bar over USB, open `10.0.4.20`, and go to **Settings → HTTP Access**.
- **Anywhere:** use `api.busy.app` with an API token from [cloud.busy.app](https://cloud.busy.app/api-tokens).

The environment's server sends the alerts, so the bar must be reachable from the machine running that server. Your browser or phone doesn't need to reach it. A BUSY focus session takes priority over T3 Code's messages.
