# Linked dev servers

When a terminal in a thread starts a web dev server, T3 Code detects the listening port and links
the server to that thread. Linked servers follow the thread wherever you work:

- On web and desktop, a globe icon appears on the thread's row in the sidebar; click it to open
  the server. The desktop in-app browser also lists every live local server, so you can open one
  in a browser tab next to the conversation.
- On mobile, a globe button appears in the thread header while the thread has a linked dev
  server. On iOS it opens a menu listing each server by port and process; pick one to open it in
  your browser. On Android it opens the first available server directly.

Your phone is not the machine running the server, so T3 Code rewrites `localhost` addresses to
the address you are connected to the environment through before opening them. This works when you
reach the environment over your local network or a tailnet. A public tunnel does not forward dev
server ports, so those servers are still listed but marked as not reachable from your device.
