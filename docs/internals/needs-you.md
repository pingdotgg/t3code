# Needs you: the triage model

The owner reads cz on a phone or a Mac, between other things. He does not read
threads. He opens cz to clear whatever is waiting on him, judging from the media
itself (images, clips, music), and then he leaves. Every rule below follows
from that. The model is borrowed from triage tools that work this way: Linear's
inbox, Superhuman, GitHub notifications, and Things' Today.

## Two pages, not two tabs

**Needs you** (`/`) and **Threads** (`/threads`) are separate routes. They do
different jobs. Needs you is a queue to empty. Threads is a place to look
things up. Keeping both in one view made the list switch under the owner (it
used to fall back to Threads whenever Needs you was empty) and mixed thread
rows in with questions. Needs you is always home, even when it's empty. Each
page keeps its own scroll position. A Decision opens over Needs you, and a
thread over whichever page it was opened from, so Back and Esc return to that
page.

Needs you holds only what is blocked on the owner: open Decisions and threads
waiting on an approval or an answer. Things he might like to know about
(finished threads, failed jobs) go in the Morning brief at the top.
They don't take a slot in the queue.

## A card reads in three seconds

Top to bottom: **the thing itself** (image, clip, waveform, option pictures),
**one line of question**, and **the answer buttons**. Project and age come last,
in small type. Nothing else goes on the card: no type badge, no machine name
while one machine is shown, no paragraph of context. The write-up belongs in
the full view, under the media. A card the owner can answer without opening
doesn't make him open it: verdicts, single picks, and installs all work from
the card.

## Answered and stale things leave on their own

- Answering removes the card at once, with Undo in a toast for a few seconds.
  Answered Decisions only appear behind **Answered** at the bottom.
- In the full view, answering moves to the next open Decision, the way
  Superhuman does. After the last one, the view closes back to an empty Needs
  you. Prev and next arrows with "n of N" are always present, so going through
  everything never needs a separate mode.
- Every card and view has **Dismiss** (withdraws it as no longer relevant).
  Every answer is clickable at once, media played or not; the toast's Undo
  is the safety net, not a gate. The server also withdraws a
  Decision when its agent asks again on the same subject or its thread is
  archived (`apps/server/src/decisions/DecisionFollowUps.ts`). The goal is that
  nothing sits in Needs you that the owner can't act on.

## Navigation

One rule everywhere: **Esc and Back go up one level**, to the page the view was
opened from, at the same scroll position. The open item lives in the URL, so
the browser's Back, the phone's back swipe, and Esc all agree. Inside a text
field with text in it, Esc leaves the field first. j/k move through the list or
scroll the view, gg and G jump to the ends, and n/p step between Decisions.
None of these keys are ever shown on screen (the owner's rule).
