---------------------------- MODULE SideChatLifecycle ----------------------------
(* A lesson L holds side chat A, and A holds nested side chat B. Each action is one
   orchestrator command, which commits atomically under the lesson's lock
   (Orchestrator.ts sideChatLessonLockThreadId), or one provider or effect-worker step.
   Every side chat already has a message: empty ones are deleted, not finished, and are
   out of scope. Code refs are to apps/server/src/orchestration-v2/Orchestrator.ts. *)
EXTENDS Naturals, Sequences

CONSTANTS MaxQueued, MaxRequests, ExternalSends

Chats == {"A", "B"}
Parent == [A |-> "L", B |-> "A"]
Below(t) == IF t = "L" THEN <<"B", "A">> ELSE IF t = "A" THEN <<"B">> ELSE <<>>  \* deepest first

VARIABLES
  done,      \* "open" | "generating" | "ready": sideChat.done (null, or its outcome.status)
  req,       \* done.outcome.requestId; a new one per finish (sideChatOutcomeRequestId)
  turn,      \* "idle" | "running" | "stopping": the chat's active run, if any (isActiveRun)
  queued,    \* how many runs have status "queued"
  held,      \* whether they are queueHeld (Stop holds them; only a user's client message resumes)
  pending,   \* side-chat.outcome effects in the outbox, as <<chat, requestId>>
  nextReq,
  finishes,  \* finishSideChat calls since the chat last opened
  landed     \* requestId of the outcome that landed since it last opened, or 0

vars == <<done, req, turn, queued, held, pending, nextReq, finishes, landed>>

Init ==
  /\ done = [c \in Chats |-> "open"]
  /\ req = [c \in Chats |-> 0]
  /\ turn = [c \in Chats |-> "idle"]
  /\ queued = [c \in Chats |-> 0]
  /\ held = [c \in Chats |-> FALSE]
  /\ pending = {}
  /\ nextReq = 1
  /\ finishes = [c \in Chats |-> 0]
  /\ landed = [c \in Chats |-> 0]

\* One step inside a command: a record of the variables a command threads through.
St == [done |-> done, req |-> req, turn |-> turn, queued |-> queued, held |-> held,
       pending |-> pending, nextReq |-> nextReq, finishes |-> finishes, landed |-> landed]
Commit(s) ==
  /\ done' = s.done /\ req' = s.req /\ turn' = s.turn /\ queued' = s.queued /\ held' = s.held
  /\ pending' = s.pending /\ nextReq' = s.nextReq /\ finishes' = s.finishes /\ landed' = s.landed

\* finishSideChat: done = generating with a fresh requestId, and a side-chat.outcome effect.
Finish(s, c) ==
  [s EXCEPT !.done[c] = "generating", !.req[c] = s.nextReq,
            !.pending = @ \cup {<<c, s.nextReq>>}, !.nextReq = @ + 1,
            !.finishes[c] = @ + 1]

\* stopSideChatRun: Stop only records an interrupt request; the run ends later (RunEnds).
\* Then every queued run is cancelled.
StopRun(s, c) ==
  [s EXCEPT !.turn[c] = IF @ = "running" THEN "stopping" ELSE @, !.queued[c] = 0, !.held[c] = FALSE]

\* dispatchSideChatDone, without discard.
Done(c) ==
  /\ nextReq + Len(Below(c)) + 1 <= MaxRequests
  /\ LET s0 == St
         \* Open nested side chats end first, deepest first.
         s1 == IF c = "A" /\ s0.done["B"] = "open" THEN Finish(StopRun(s0, "B"), "B") ELSE s0
     IN IF s1.done[c] /= "open"
          THEN Commit(s1)  \* already done: an accepted no-op keeps the first outcome
          ELSE Commit(Finish(StopRun(s1, c), c))

\* applySideChatUserMessage's loop: idle open side chats below t finish; one with a queued
\* or active run stays open, and so does every one above it (keptOpen).
AutoFinishBelow(s0, t) ==
  LET step(s, c, kept) ==
        IF s.done[c] /= "open" THEN <<s, kept>>
        ELSE IF c \in kept \/ s.queued[c] > 0 \/ s.turn[c] /= "idle"
          THEN <<s, kept \cup {Parent[c]}>>
          ELSE <<Finish(s, c), kept>>
      b == Below(t)
      r1 == IF Len(b) >= 1 THEN step(s0, b[1], {}) ELSE <<s0, {}>>
      r2 == IF Len(b) >= 2 THEN step(r1[1], b[2], r1[2]) ELSE r1
  IN r2[1]

\* reopenDoneSideChats: the chat and every done side chat above it reopen.
Reopen(s, c) ==
  LET up == IF c = "B" THEN {"A", "B"} ELSE {"A"}
  IN [s EXCEPT !.done = [x \in Chats |-> IF x \in up THEN "open" ELSE @[x]],
               !.finishes = [x \in Chats |-> IF x \in up /\ s.done[x] /= "open" THEN 0 ELSE @[x]],
               !.landed = [x \in Chats |-> IF x \in up /\ s.done[x] /= "open" THEN 0 ELSE @[x]]]

\* dispatchMessage: starts a run, or queues it behind the active one (queueBehindRun). A
\* user's client message releases a held queue (heldRunsToRelease); any other joins the hold.
StartOrQueue(s, c, release) ==
  IF s.turn[c] = "idle"
    THEN [s EXCEPT !.turn[c] = "running", !.held[c] = @ /\ ~release]
    ELSE [s EXCEPT !.queued[c] = @ + 1, !.held[c] = @ /\ ~release]

\* message.dispatch from the user into side chat c.
UserSend(c) ==
  /\ queued[c] < MaxQueued
  /\ nextReq + 1 <= MaxRequests
  /\ Commit(StartOrQueue(AutoFinishBelow(Reopen(St, c), c), c, TRUE))

\* message.dispatch from the user into the lesson.
LessonSend ==
  /\ nextReq + 2 <= MaxRequests
  /\ Commit(AutoFinishBelow(St, "L"))

\* message.dispatch that isTrigger rejects (a scheduled task, a notification, a delegated
\* task's completion, an agent's send): applySideChatUserMessage returns before reopening.
ExternalSend(c) ==
  /\ ExternalSends
  /\ queued[c] < MaxQueued
  /\ Commit(StartOrQueue(St, c, FALSE))

\* Stop on an open side chat: interrupt requested, queued runs held (holdStoppedThread).
Stop(c) ==
  /\ done[c] = "open" /\ turn[c] = "running"
  /\ turn' = [turn EXCEPT ![c] = "stopping"]
  /\ held' = [held EXCEPT ![c] = queued[c] > 0]
  /\ UNCHANGED <<done, req, queued, pending, nextReq, finishes, landed>>

\* The provider ends the active run (completed, or interrupted after a stop).
RunEnds(c) ==
  /\ turn[c] /= "idle"
  /\ turn' = [turn EXCEPT ![c] = "idle"]
  /\ UNCHANGED <<done, req, queued, held, pending, nextReq, finishes, landed>>

\* The next queued run starts once nothing is active and the queue is not held.
QueuedStarts(c) ==
  /\ turn[c] = "idle" /\ queued[c] > 0 /\ ~held[c]
  /\ turn' = [turn EXCEPT ![c] = "running"]
  /\ queued' = [queued EXCEPT ![c] = @ - 1]
  /\ UNCHANGED <<done, req, held, pending, nextReq, finishes, landed>>

\* SideChatLifecycleService.writeOutcome, then dispatchSideChatOutcomeComplete: only the
\* generating request of the chat lands; a stale one emits the row unchanged.
OutcomeComplete(e) ==
  /\ e \in pending
  /\ LET c == e[1] IN
       IF done[c] = "generating" /\ req[c] = e[2]
         THEN /\ done' = [done EXCEPT ![c] = "ready"]
              /\ landed' = [landed EXCEPT ![c] = e[2]]
         ELSE UNCHANGED <<done, landed>>
  /\ pending' = pending \ {e}
  /\ UNCHANGED <<req, turn, queued, held, nextReq, finishes>>

Next ==
  \/ \E c \in Chats : Done(c) \/ UserSend(c) \/ ExternalSend(c) \/ Stop(c) \/ RunEnds(c) \/ QueuedStarts(c)
  \/ LessonSend
  \/ \E e \in pending : OutcomeComplete(e)

Spec == Init /\ [][Next]_vars /\ \A x \in Chats : WF_vars(RunEnds(x)) /\ WF_vars(QueuedStarts(x))
        /\ \A r \in 1..MaxRequests, c \in Chats : WF_vars(OutcomeComplete(<<c, r>>))

---------------------------------------------------------------------------------
\* THE PROPERTY: a side chat is finished at most once each time it is open, gets the outcome
\* of that finish, and once finished has nothing queued or running except a turn being stopped.

FinishedOnce == \A c \in Chats : finishes[c] <= 1

OwnOutcome == \A c \in Chats : done[c] = "ready" => landed[c] = req[c]

NothingLeftWhenDone ==
  \A c \in Chats : done[c] /= "open" => queued[c] = 0 /\ turn[c] /= "running"

\* "At least once": a note being written always settles.
NoteSettles == \A c \in Chats : done[c] = "generating" ~> done[c] /= "generating"
================================================================================
