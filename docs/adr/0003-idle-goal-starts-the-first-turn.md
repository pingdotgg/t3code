# Idle Goal starts the first Turn

`/goal` could have been storage only, with auto-continue waiting until some later user Turn finished. That is not a working Goal.

We decided that becoming Active on an idle Thread starts a Turn immediately. If a Turn is already running, T3 attaches the Goal and waits; it does not steer or double-start. Stop during that Turn still pauses the Goal.

Resume on idle follows the same rule: becoming Active again starts the next Turn.
