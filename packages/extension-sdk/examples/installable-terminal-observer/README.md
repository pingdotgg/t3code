# Installable terminal status consumer

This independently packaged example observes one existing terminal through
t3.terminal/sessions and exposes its own example.terminal-observer/status API.
Its view calls that API; the separate worker calls the selected native provider.
Neither imports an app component, private store, terminal RPC singleton or PTY service.

Install this directory with the t3.terminal/read grant for the target project. Open
**Extensions → Open Terminal status · Side panel** in a thread, enter the ID of a terminal already opened in that
thread (commonly term-1), and select **Read status**. The authenticated login must
also have terminal:operate and the current HTTP transport's access:write scope.
Plugin installation/grants do not grant the login authority. Missing native provider
or incompatible API version makes the dependency unavailable.

The response is bounded metadata, with null when no live manager session exists.
Inspection does not open, attach, restart, resize, close or restore a terminal.
Moved/unsupported launch mappings are unavailable. Output does not contain history,
PID, cwd or environment variables. Terminal IDs here are observation selectors,
not durable resource handles.

This is an API consumer example, not an interactive Terminal replacement. Output
streaming, controls, ownership/epochs, restore after server restart and renderer
parity require later contracts. Web/desktop are declared; neither mobile renderer
is implemented by this package.
