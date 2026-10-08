# Morning brief

The Morning brief sits at the top of **Needs you** and says what happened since
you last looked, on the machines the feed's machine filter shows (every machine
on the phone). "Since you last looked" is your previous visit: opening czcode on
any device starts a visit, and the brief keeps covering the same stretch while
you move between devices or reload.

- **Done:** what got finished, one line per project, written from the
  threads' final messages.
- **Failed or stopped:** failures grouped by cause with the reason, and runs
  that were interrupted or cancelled, which are never counted as failures. Each
  line has one action: **Retry** asks the threads to pick up where they left
  off, **Dismiss** archives them (with Undo).
- **Needs you:** how many Decisions are waiting, and threads waiting on an
  approval or an answer.
- **Machines:** a machine that is offline, overloaded, or short of disk or
  memory.

A line about one thread opens it; a line about several expands to list them.
The lines are written by the same model that writes thread titles; while it
writes, or if it can't, each line shows a plain count
instead. **Fold** shrinks the brief to one line. It doesn't appear when there's
nothing to report.
