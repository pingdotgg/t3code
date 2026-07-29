# Follow agent output and Reduce motion

Two per-device settings in **Settings → Appearance**, both aimed at how much the
UI moves while an agent works.

## Follow agent output

Off by default. When on, the transcript scrolls itself to stay at the live edge
while an agent streams. That fires once per streamed chunk, which is the
continuous scrolling that makes long sessions tiring to read.

With it off:

- the transcript holds still while output streams in
- sending a message still positions the new turn once, so you are not left
  looking at old messages
- the scroll-to-end button appears whenever you are away from the live edge, so
  jumping to the end stays one click away

## Reduce motion

Forces the reduced-motion path on even when the OS does not ask for it:

- scrolls become instant instead of animated — the new-turn jump, the
  scroll-to-end button, and the minimap
- looping indicator animations stop (status pulse, skeleton shimmer, the working
  indicator, the ultrathink gradients)
- the composer morph and the mobile route view-transition are skipped

Spinners keep spinning. A frozen spinner reads as a hung app, which is worse
than the motion it would remove.

`prefers-reduced-motion: reduce` from the OS still applies on its own, whatever
this setting says.
