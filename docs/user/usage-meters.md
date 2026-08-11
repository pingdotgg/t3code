# Usage meters

The small circles next to the send button show how much of your provider
subscription you have used up. They are there so you find out you are running
low before a turn stops halfway through, not after.

## What the circles mean

Each circle is one limit your account is measured against. The ring fills up as
you use it, and the number in the middle is the percentage used.

**Claude** shows three:

- **Session** — your 5-hour window
- **Weekly** — your weekly window
- **Fable** — your weekly window for Fable models specifically

**Codex** shows two, usually a shorter window and a weekly one.

**Cursor, Grok, and OpenCode** show nothing. They do not report usage, so
rather than show you an empty or guessed circle, T3 Code shows none at all.

A circle turns red past 90%. That is a nudge, not a block — nothing in T3 Code
stops you at any number.

## Seeing more detail

Hover a circle for the displayed percentage and when that limit resets. Resets
less than a day away count down ("resets in 2h 15m"); further out they show
the day and time ("resets Mon 9:00 AM"), and beyond a couple of days the date
comes along too.

If a limit does not report a reset time, the line is simply left out.

On mobile there is one button in the composer toolbar instead of a row of
circles — it shows whichever limit is closest to running out, and tapping it
lists them all.

## When the composer is narrow

In a narrow window the circles collapse into one, showing whichever limit is
closest to running out. Hover it and you still get the full breakdown.

## How fresh the numbers are

They refresh when you come back to the app, when you switch providers, and
when you hover or tap a meter. Codex also volunteers new numbers at the end of
every turn. If a reading is more than a minute old, the popover tells you how
old ("as of 12m ago").

Checking your usage never costs you any of it.

## If no circles appear

That is normal in several cases and never an error you need to fix:

- your provider does not report usage
- no usage has been read yet — switching away from the app and back asks for
  a fresh reading
- T3 Code could not read your provider credentials, or they have expired.
  Signing in again with the provider's own CLI fixes it

Usage meters are informational. When they cannot be shown, everything else
keeps working exactly as before.
