# Agent browser controls

When agent browser access is enabled, a coding agent can use the collaborative preview browser for
the current thread. Browser tools never grant access by themselves. Turn access on or off in
Settings under Integrations.

Agents can list the current thread's preview tabs before choosing a target. Lists are paginated and
do not open a window, attach a host, or navigate a page. An agent can close one tab by its exact tab
ID. It cannot omit the ID to close every tab, and it cannot list or close another thread's tabs.

Closing a tab updates the server-owned preview session. Connected desktop clients remove the
matching webview through the normal preview event stream. Repeating the close reports that the tab
no longer exists instead of claiming that another tab was closed.
