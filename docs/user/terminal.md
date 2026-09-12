# Terminal

## Copy selections automatically

On web and desktop, enable **Settings → General → Copy on select** to copy text when you
finish selecting it with the mouse in either the conversation or the terminal. The setting is
off by default. Mobile keeps its native long-press selection behavior.

**Copy on select toast** controls whether a successful automatic copy shows a confirmation.
T3 Code does not show the confirmation when clipboard access is unavailable, such as from an
insecure remote browser connection. A failed terminal copy leaves terminal input and in-progress
IME text unchanged.

Automatic copying only follows a new selection gesture. Clicking an existing selection does not
copy it again, and double- or triple-click selection produces one copy after the gesture settles.

## History

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.
