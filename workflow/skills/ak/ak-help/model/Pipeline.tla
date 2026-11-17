---- MODULE Pipeline ----
\* The path one idea takes through the workflow skills, as the skill texts say it, not as it should be.
\* Idea-level phases (ph) are one sequential session with the user; execution (s, hd, is, tr, mst) runs beside it.
EXTENDS Naturals, FiniteSets

CONSTANTS Tickets, Human, MaxW, MaxT, MaxFog, MaxRestart, MaxRounds, ByHand, Triage, MstInit, MmInit, StartAt
\* Human: tickets plan-to-issues files as ready-for-human. ByHand = FALSE leaves out bcheck and implement-spec, Triage = FALSE leaves out triage. MstInit, MmInit and StartAt pick where the run begins:
\* the maestro's state, whether the idea runs under the maestro skill, and idea (grilling onward) or exec (tickets already filed). MaxRounds is replan's round limit (3 in the text).
\* The small settings keep the chart under 500 states.

VARIABLES ph, gc, route, aud, apr, rd, wa, wh, ws, wo, fog, mm, hl, s, hd, ht, is, ist, tr, mst, owe, rs
I == <<ph, gc, route, aud, apr, rd>>   \* where the idea is: phase, grilling context, route taken, plan audited, plan approved, replan rounds used
W == <<wa, wh, ws, wo, fog>>           \* wayfinder map: open AFK tickets, open HITL tickets, tickets a dead session left claimed (under a week, a week or more), fog patches
E == <<mm, hl, s, hd, ht, is, ist, tr, mst, owe, rs>>   \* hl: tickets labelled ready-for-human
vars == <<I, W, E>>

None == "-"
Iss == Tickets \cup {"S"}                       \* S is the spec issue (or plan epic), labelled epic; A, B are tickets, B is blocked by A
Unblocked(i) == i = "B" => s["A"] = "Merged"
Claimable(i) == s[i] = "Ready" /\ Unblocked(i)
Blocked(i) == s[i] \notin {"-", "Merged"} /\ ~Unblocked(i)
Running == {i \in Iss : s[i] = "Run"}
Filed == {i \in Iss : s[i] # "-"}
EpicClosable == s["S"] = "Epic" /\ \A t \in Tickets : s[t] = "Merged"      \* maestro step 4: an open epic whose sub-issues are all closed
HumanDue(i) == s[i] = "HReady" /\ Unblocked(i)                              \* maestro step 5: an unblocked ready-for-human issue the master has not been told about
MaestroWork == (\E i \in Iss : Claimable(i) \/ HumanDue(i)) \/ EpicClosable
FirstTickReap == [i \in Iss |-> IF s[i] = "WHelp" THEN "Help" ELSE s[i]]    \* first tick: in-progress + needs-help is reaped and told to the master; a claim without "maestro: claimed" is another session's
Live == ph \in {"Exec", "MAsk"}
FileTickets == [i \in Iss |-> IF i \in Tickets /\ s[i] = "-" THEN "Ready" ELSE s[i]]
FilePlanTickets == [i \in Iss |-> IF i = "S" /\ s[i] = "-" THEN "Epic"
                                  ELSE IF i \in Tickets /\ s[i] = "-" THEN (IF i \in Human THEN "HReady" ELSE "Ready") ELSE s[i]]

Waits == {"GAsked", "GConfirm", "SAsked", "TQuiz", "PPresent", "PBlocked", "PAmbig", "PReapprove", "PGaps", "WNoFog", "WFogAsk", "MAsk"}
Prompted == ph \in Waits \/ hd \in {"bcq", "bcp", "bca"} \/ is = "pr" \/ tr \in {"batch", "sum"}

Init == /\ gc = None /\ rd = 0 /\ wa = 0 /\ wh = 0 /\ ws = 0 /\ wo = 0 /\ fog = 0
        /\ mm \in MmInit                        \* was this idea started under the maestro skill (its Intake nudges the maestro)?
        /\ hd = None /\ ht = None /\ is = None /\ ist = {} /\ tr = None /\ mst \in MstInit /\ rs = 0
        /\ IF StartAt = "idea"
           THEN ph = "Idea" /\ route = None /\ aud = FALSE /\ apr = FALSE /\ s = [i \in Iss |-> "-"] /\ owe = FALSE /\ hl = {}
           ELSE ph = "Exec" /\ route = "plan" /\ aud = TRUE /\ apr = TRUE   \* a plan-to-issues batch was just filed, epic included, and it nudged any maestro thread
                /\ s = [i \in Iss |-> IF i = "S" THEN "Epic" ELSE IF i \in Human THEN "HReady" ELSE "Ready"] /\ hl = Human /\ owe = (mm \/ mst # "none")

\* ---- grilling (grilling, grill-me, grill-with-docs); wayfinder reuses it through gc ----
StartGrilling     == /\ ph = "Idea" /\ ph' = "GThink" /\ gc' = "intake" /\ UNCHANGED <<route, aud, apr, rd, W, E>>
UserSkipsGrilling == /\ ph = "Idea" /\ ph' = "Route" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
AskRound          == /\ ph = "GThink" /\ ph' = "GAsked" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
FrontierEmpty     == /\ ph = "GThink" /\ ph' = "GConfirm" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserAnswers       == /\ ph = "GAsked" /\ ph' = "GThink" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserKeepsGrilling == /\ ph = "GConfirm" /\ ph' = "GThink" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserConfirmsIntake  == /\ ph = "GConfirm" /\ gc = "intake" /\ ph' = "Route" /\ gc' = None /\ UNCHANGED <<route, aud, apr, rd, W, E>>
UserConfirmsDest    == /\ ph = "GConfirm" /\ gc = "dest" /\ ph' = "GThink" /\ gc' = "breadth" /\ UNCHANGED <<route, aud, apr, rd, W, E>>
UserConfirmsBreadth == /\ ph = "GConfirm" /\ gc = "breadth" /\ ph' = "WChart" /\ gc' = None /\ UNCHANGED <<route, aud, apr, rd, W, E>>
UserConfirmsTicket  == /\ ph = "GConfirm" /\ gc = "ticket" /\ ph' = "WRecord" /\ gc' = None /\ UNCHANGED <<route, aud, apr, rd, W, E>>
UserStopsGrilling   == /\ ph \in {"GAsked", "GConfirm"} /\ gc # "ticket" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserLeavesTicketSession == /\ ph \in {"GAsked", "GConfirm"} /\ gc = "ticket" /\ ph' = "WIdle" /\ gc' = None
                           /\ ws' = (IF ws + wo < MaxT THEN ws + 1 ELSE ws) /\ UNCHANGED <<route, aud, apr, rd, wa, wh, wo, fog, E>>

\* ---- the master picks the route (maestro Intake; no criteria beyond "very large work -> wayfinder") ----
RouteSpec      == /\ ph = "Route" /\ ph' = "SSeams" /\ route' = "spec" /\ UNCHANGED <<gc, aud, apr, rd, W, E>>
RoutePlan      == /\ ph = "Route" /\ ph' = "PDraft" /\ route' = "plan" /\ aud' = FALSE /\ apr' = FALSE /\ rd' = 0 /\ UNCHANGED <<gc, W, E>>
RoutePlanFile  == /\ ph = "Route" /\ ph' = "PIssues" /\ route' = "plan" /\ aud' = FALSE /\ apr' = TRUE /\ rd' = 0 /\ UNCHANGED <<gc, W, E>>   \* the user hands plan-to-issues their own plan file
RouteWayfinder == /\ ph = "Route" /\ ph' = "GThink" /\ gc' = "dest" /\ route' = "wayfinder" /\ UNCHANGED <<aud, apr, rd, W, E>>

\* ---- to-spec ----
SketchSeams       == /\ ph = "SSeams" /\ ph' = "SAsked" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserApprovesSeams == /\ ph = "SAsked" /\ ph' = "SPublish" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserRejectsSeams  == /\ ph = "SAsked" /\ ph' = "SSeams" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserStopsSpec     == /\ ph = "SAsked" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
PublishSpec       == /\ ph = "SPublish" /\ ph' = "TDraft"                            \* published with the epic label, "the spec is a parent for tickets, never one agent's task"
                     /\ s' = [s EXCEPT !["S"] = IF s["S"] = "-" THEN "Epic" ELSE s["S"]]
                     /\ UNCHANGED <<gc, route, aud, apr, rd, W, mm, hl, hd, ht, is, ist, tr, mst, owe, rs>>

\* ---- to-tickets (after to-spec, and as the last step of wayfinder) ----
DraftSlices       == /\ ph = "TDraft" /\ ph' = "TQuiz" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserApprovesBreakdown == /\ ph = "TQuiz" /\ ph' = "TPublish" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserWantsRevision == /\ ph = "TQuiz" /\ ph' = "TDraft" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserStopsTickets  == /\ ph = "TQuiz" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
PublishTickets    == /\ ph = "TPublish" /\ ph' = "Exec" /\ s' = FileTickets
                     /\ owe' = (owe \/ mm \/ route = "wayfinder" \/ mst # "none")   \* to-tickets nudges an existing maestro thread; the maestro Intake and wayfinder's last step also hand the tickets to a maestro that does not exist yet
                     /\ UNCHANGED <<gc, route, aud, apr, rd, W, mm, hl, hd, ht, is, ist, tr, mst, rs>>

\* ---- plan, replan, plan-to-issues ----
DraftPlan         == /\ ph = "PDraft" /\ ph' = "PAudit" /\ aud' = FALSE /\ apr' = FALSE /\ rd' = 0 /\ UNCHANGED <<gc, route, W, E>>
AuditCovers       == /\ ph = "PAudit" /\ ph' = "PPresent" /\ aud' = TRUE /\ UNCHANGED <<gc, route, apr, rd, W, E>>
AuditFindsGaps    == /\ ph = "PAudit" /\ rd < MaxRounds /\ ph' = "PRewrite" /\ rd' = rd + 1 /\ UNCHANGED <<gc, route, aud, apr, W, E>>
RewritePlan       == /\ ph = "PRewrite" /\ ph' = "PAudit" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
AuditStillShort   == /\ ph = "PAudit" /\ rd = MaxRounds /\ ph' = "PGaps" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>   \* replan: after the last round, stop and show the user what is still uncovered
AuditAsksBlocking == /\ ph = "PAudit" /\ ph' = "PBlocked" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserAnswersBlocking == /\ ph = "PBlocked" /\ ph' = "PAudit" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserStopsBlocked  == /\ ph = "PBlocked" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserAnswersGaps   == /\ ph = "PGaps" /\ ph' = "PAudit" /\ rd' = 0 /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserStopsGaps     == /\ ph = "PGaps" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserApprovesPlan  == /\ ph = "PPresent" /\ ph' = "PIssues" /\ apr' = TRUE /\ UNCHANGED <<gc, route, aud, rd, W, E>>
UserRejectsPlan   == /\ ph = "PPresent" /\ ph' = "PDraft" /\ aud' = FALSE /\ apr' = FALSE /\ UNCHANGED <<gc, route, rd, W, E>>
UserStopsPlan     == /\ ph = "PPresent" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
ReplanInline      == /\ ph = "PIssues" /\ ~aud /\ aud' = TRUE /\ apr' \in {apr, FALSE}   \* plan-to-issues Step 1: not audited yet, so run replan first; a rewrite voids the approval
                     /\ UNCHANGED <<ph, gc, route, rd, W, E>>
ReplanInlineStuck == /\ ph = "PIssues" /\ ~aud /\ ph' = "PGaps" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>   \* the inline replan hit its round limit
AsksReapproval    == /\ ph = "PIssues" /\ aud /\ ~apr /\ ph' = "PReapprove" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>   \* Step 1: the audit changed the plan, show the user and get approval before creating anything
UserApprovesChanges == /\ ph = "PReapprove" /\ ph' = "PIssues" /\ apr' = TRUE /\ UNCHANGED <<gc, route, aud, rd, W, E>>
UserRejectsChanges  == /\ ph = "PReapprove" /\ ph' = "PDraft" /\ aud' = FALSE /\ apr' = FALSE /\ UNCHANGED <<gc, route, rd, W, E>>
UserStopsChanges    == /\ ph = "PReapprove" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
AsksDeps          == /\ ph = "PIssues" /\ aud /\ apr /\ ph' = "PAmbig" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
DepsClear         == /\ ph = "PIssues" /\ aud /\ apr /\ ph' = "PCreate" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserAnswersDeps   == /\ ph = "PAmbig" /\ ph' = "PCreate" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
CreateIssues      == /\ ph = "PCreate" /\ ph' = "Exec" /\ s' = FilePlanTickets
                     /\ owe' = (owe \/ mm \/ mst # "none")                         \* Step 5: nudge an existing maestro thread; the maestro Intake asks for one to be started
                     /\ hl' = hl \cup {t \in Human : s[t] = "-"}
                     /\ UNCHANGED <<gc, route, aud, apr, rd, W, mm, hd, ht, is, ist, tr, mst, rs>>

\* ---- wayfinder ----
ChartFog          == /\ ph = "WChart" /\ ph' = "WIdle"
                     /\ \E a \in 0..1, h \in 0..1, f \in 1..MaxFog : a + h >= 1 /\ wa' = a /\ wh' = h /\ fog' = f
                     /\ ws' = 0 /\ wo' = 0 /\ UNCHANGED <<gc, route, aud, apr, rd, E>>
ChartNoFog        == /\ ph = "WChart" /\ ph' = "WNoFog" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserPicksSpec     == /\ ph = "WNoFog" /\ ph' = "SSeams" /\ route' = "spec" /\ UNCHANGED <<gc, aud, apr, rd, W, E>>
UserStopsNoFog    == /\ ph = "WNoFog" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserInvokesMap    == /\ ph = "WIdle" /\ wa + wh + wo > 0 /\ ph' = "WPick"
                     /\ wh' = wh + wo /\ wo' = 0                                   \* step 2: a claim with no activity for a week is unassigned first; it was a HITL ticket
                     /\ UNCHANGED <<gc, route, aud, apr, rd, wa, ws, fog, E>>
UserNamesStaleTicket == /\ ph = "WIdle" /\ ws + wo > 0 /\ ph' = "GThink" /\ gc' = "ticket"
                        /\ \/ ws > 0 /\ ws' = ws - 1 /\ wh' = wh + wo /\ wo' = 0
                           \/ wo > 0 /\ ws' = ws /\ wh' = wh + wo - 1 /\ wo' = 0
                        /\ UNCHANGED <<route, aud, apr, rd, wa, fog, E>>
UserStopsMap      == /\ ph = "WIdle" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
WeekPasses        == /\ ph = "WIdle" /\ ws > 0 /\ ws' = 0 /\ wo' = wo + ws /\ UNCHANGED <<I, wa, wh, fog, E>>   \* the map sits idle for a week
PickAfkTicket     == /\ ph = "WPick" /\ wa > 0 /\ ph' = "WRecord" /\ wa' = wa - 1 /\ UNCHANGED <<gc, route, aud, apr, rd, wh, ws, wo, fog, E>>
PickHitlTicket    == /\ ph = "WPick" /\ wh > 0 /\ ph' = "GThink" /\ gc' = "ticket" /\ wh' = wh - 1 /\ UNCHANGED <<route, aud, apr, rd, wa, ws, wo, fog, E>>
RecordResolution  == /\ ph = "WRecord" /\ ph' = "WGrad" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
Graduate          == /\ ph = "WGrad"
                     /\ \E na \in 0..1, nh \in 0..1, df \in 0..1 :
                          /\ df <= fog /\ (na = 0 \/ wa < MaxT) /\ (nh = 0 \/ wh < MaxT)
                          /\ wa' = wa + na /\ wh' = wh + nh /\ fog' = fog - df
                          /\ ph' = IF wa + na + wh + nh + ws + wo > 0 THEN "WIdle" ELSE IF fog - df > 0 THEN "WFogAsk" ELSE "WDone"
                     /\ UNCHANGED <<gc, route, aud, apr, rd, ws, wo, E>>
UserGraduatesFog  == /\ ph = "WFogAsk" /\ ph' = "WIdle"                             \* step 6: no tickets left but fog remains, the user decides
                     /\ \E a \in 0..1, h \in 0..1 : a + h >= 1 /\ wa' = a /\ wh' = h
                     /\ fog' = 0 /\ UNCHANGED <<gc, route, aud, apr, rd, ws, wo, E>>
UserRulesOutFog   == /\ ph = "WFogAsk" /\ ph' = "WDone" /\ fog' = 0 /\ UNCHANGED <<gc, route, aud, apr, rd, wa, wh, ws, wo, E>>
FileMapTickets    == /\ ph = "WDone" /\ ph' = "TDraft" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>

\* ---- maestro, workers, master (maestro and maestro-worker skills; a worker ships through full-send, which ends merged or asking for help) ----
MaestroDispatches(i) == /\ mst = "on" /\ Claimable(i) /\ Cardinality(Running) < MaxW       \* labels in-progress and comments "maestro: claimed"
                        /\ s' = [s EXCEPT ![i] = "Run"] /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, mst, owe, rs>>
MaestroReaps(i)      == /\ mst = "on" /\ s[i] = "WHelp" /\ s' = [s EXCEPT ![i] = "Help"] /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, mst, owe, rs>>
MaestroClosesEpic    == /\ mst = "on" /\ EpicClosable /\ s' = [s EXCEPT !["S"] = "Merged"] /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, mst, owe, rs>>
MaestroAnnouncesHuman(i) == /\ mst = "on" /\ HumanDue(i) /\ s' = [s EXCEPT ![i] = "HAnn"] /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, mst, owe, rs>>
MaestroPauses        == /\ mst = "on" /\ \A i \in Iss : ~Claimable(i) /\ s[i] \notin {"Run", "WHelp", "Help"} /\ ~Blocked(i) /\ ~HumanDue(i)
                        /\ ~EpicClosable /\ mst' = "off" /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, is, ist, tr, owe, rs>>
MaestroRestarts      == /\ rs < MaxRestart /\ mst # "none" /\ rs' = rs + 1 /\ mst' = "on" /\ s' = FirstTickReap
                        /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, owe>>
WorkerMerges(i)      == /\ s[i] = "Run" /\ s' = [s EXCEPT ![i] = "Merged"] /\ mst' = "on" /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, owe, rs>>
WorkerAsksHelp(i)    == /\ s[i] = "Run" /\ s' = [s EXCEPT ![i] = "WHelp"] /\ mst' = "on" /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, owe, rs>>
UserDoesHumanTask(i) == /\ s[i] \in {"HReady", "HAnn"} /\ Unblocked(i) /\ s' = [s EXCEPT ![i] = "Merged"] /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, mst, owe, rs>>
MasterFinishes(i)    == /\ s[i] = "Help" /\ s' = [s EXCEPT ![i] = "Merged"] /\ owe' = TRUE /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, mst, rs>>
MasterReleases(i)    == /\ s[i] = "Help" /\ s' = [s EXCEPT ![i] = "Ready"] /\ owe' = TRUE /\ UNCHANGED <<I, W, mm, hl, hd, ht, is, ist, tr, mst, rs>>
HandOffNudges        == /\ owe /\ mst # "none" /\ mst' = "on" /\ owe' = FALSE /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, is, ist, tr, rs>>
HandOffAsksToStart   == /\ owe /\ mst = "none" /\ ph = "Exec" /\ ph' = "MAsk" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
UserStartsMaestro    == /\ ph = "MAsk" /\ ph' = "Exec" /\ mst' = "on" /\ owe' = FALSE /\ s' = FirstTickReap /\ UNCHANGED <<gc, route, aud, apr, rd, W, mm, hl, hd, ht, is, ist, tr, rs>>
UserDeclinesMaestro  == /\ ph = "MAsk" /\ ph' = "Exec" /\ owe' = FALSE /\ UNCHANGED <<gc, route, aud, apr, rd, W, mm, hl, s, hd, ht, is, ist, tr, mst, rs>>

\* ---- by hand: bcheck, implement-spec, triage ----
BcheckPicks(i)       == /\ ByHand /\ Live /\ i \in Tickets /\ hd = None /\ Claimable(i)   \* its issue search now has -label:ready-for-human
                        /\ s' = [s EXCEPT ![i] = "Claimed"] /\ hd' = "bc" /\ ht' = i /\ UNCHANGED <<I, W, mm, hl, is, ist, tr, mst, owe, rs>>
BcheckReady          == /\ ByHand /\ hd = "bc" /\ hd' = "bci" /\ UNCHANGED <<I, W, mm, hl, s, ht, is, ist, tr, mst, owe, rs>>
BcheckNeedsPlanning  == /\ ByHand /\ hd = "bc" /\ hd' = "bcq" /\ UNCHANGED <<I, W, mm, hl, s, ht, is, ist, tr, mst, owe, rs>>
UserAnswersBcheck    == /\ ByHand /\ hd = "bcq" /\ hd' = "bcp" /\ UNCHANGED <<I, W, mm, hl, s, ht, is, ist, tr, mst, owe, rs>>
UserApprovesBcheckPlan == /\ ByHand /\ hd = "bcp" /\ hd' = "bci" /\ UNCHANGED <<I, W, mm, hl, s, ht, is, ist, tr, mst, owe, rs>>
UserRejectsBcheckPlan  == /\ ByHand /\ hd = "bcp" /\ hd' = "bcq" /\ UNCHANGED <<I, W, mm, hl, s, ht, is, ist, tr, mst, owe, rs>>
BcheckImplements     == /\ ByHand /\ hd = "bci" /\ hd' = "bcs" /\ UNCHANGED <<I, W, mm, hl, s, ht, is, ist, tr, mst, owe, rs>>   \* then ships through full-send
BcheckShipAsks       == /\ ByHand /\ hd = "bcs" /\ hd' = "bca" /\ UNCHANGED <<I, W, mm, hl, s, ht, is, ist, tr, mst, owe, rs>>   \* full-send's question tool
UserAnswersShipAsk   == /\ ByHand /\ hd = "bca" /\ hd' = "bcs" /\ UNCHANGED <<I, W, mm, hl, s, ht, is, ist, tr, mst, owe, rs>>
BcheckMerges         == /\ ByHand /\ hd = "bcs" /\ hd' = None /\ ht' = None /\ s' = [s EXCEPT ![ht] = "Merged"]   \* the merge closes the issue; nobody nudges the maestro
                        /\ UNCHANGED <<I, W, mm, hl, is, ist, tr, mst, owe, rs>>
UserRunsImplementSpec == /\ ByHand /\ Live /\ is = None
                         /\ \E t \in Tickets : s[t] \in {"Ready", "HReady", "Help"}
                         /\ is' = "run" /\ ist' = {t \in Tickets : s[t] \in {"Ready", "HReady", "Help"}}   \* step 1 leaves out in-progress tickets; it never labels the ones it takes
                         /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, tr, mst, owe, rs>>
ImplementSpecFinishes == /\ ByHand /\ is = "run" /\ is' = "pr" /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, ist, tr, mst, owe, rs>>
UserMergesIntegrationPR == /\ ByHand /\ is = "pr" /\ is' = "done" /\ ist' = {}
                           /\ s' = [i \in Iss |-> IF (i = "S" \/ i \in ist) /\ s[i] # "-" THEN "Merged" ELSE s[i]]   \* the PR closes the spec and the tickets it took
                           /\ UNCHANGED <<I, W, mm, hl, hd, ht, tr, mst, owe, rs>>
UserRunsTriage       == /\ Triage /\ tr = None /\ is = "pr" /\ tr' = "batch" /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, is, ist, mst, owe, rs>>
UserAnswersBatch     == /\ Triage /\ tr = "batch" /\ tr' = "bdone" /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, is, ist, mst, owe, rs>>
NextBatch            == /\ Triage /\ tr = "bdone" /\ tr' = "batch" /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, is, ist, mst, owe, rs>>
SummarizeFindings    == /\ Triage /\ tr = "bdone" /\ tr' = "sum" /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, is, ist, mst, owe, rs>>
UserApprovesFixes    == /\ Triage /\ tr = "sum" /\ tr' = "fix" /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, is, ist, mst, owe, rs>>
FixesDone            == /\ Triage /\ tr = "fix" /\ tr' = None /\ UNCHANGED <<I, W, mm, hl, s, hd, ht, is, ist, mst, owe, rs>>
FixTooBig            == /\ Triage /\ tr = "fix" /\ ph = "Exec" /\ tr' = None /\ ph' = "PDraft" /\ route' = "plan" /\ aud' = FALSE /\ apr' = FALSE
                        /\ UNCHANGED <<gc, rd, W, mm, hl, s, hd, ht, is, ist, mst, owe, rs>>                        \* "a new planning cycle"

Finish   == /\ ph = "Exec" /\ Filed # {} /\ \A i \in Filed : s[i] = "Merged" /\ ph' = "Done" /\ UNCHANGED <<gc, route, aud, apr, rd, W, E>>
Terminal == ph \in {"Done", "Stopped"} /\ UNCHANGED vars

Idea == \/ StartGrilling \/ UserSkipsGrilling \/ AskRound \/ FrontierEmpty \/ UserAnswers \/ UserKeepsGrilling
        \/ UserConfirmsIntake \/ UserConfirmsDest \/ UserConfirmsBreadth \/ UserConfirmsTicket \/ UserStopsGrilling \/ UserLeavesTicketSession
        \/ RouteSpec \/ RoutePlan \/ RoutePlanFile \/ RouteWayfinder
        \/ SketchSeams \/ UserApprovesSeams \/ UserRejectsSeams \/ UserStopsSpec \/ PublishSpec
        \/ DraftSlices \/ UserApprovesBreakdown \/ UserWantsRevision \/ UserStopsTickets \/ PublishTickets
        \/ DraftPlan \/ AuditCovers \/ AuditFindsGaps \/ RewritePlan \/ AuditStillShort \/ AuditAsksBlocking \/ UserAnswersBlocking \/ UserStopsBlocked \/ UserAnswersGaps \/ UserStopsGaps
        \/ UserApprovesPlan \/ UserRejectsPlan \/ UserStopsPlan \/ ReplanInline \/ ReplanInlineStuck \/ AsksReapproval \/ UserApprovesChanges \/ UserRejectsChanges \/ UserStopsChanges
        \/ AsksDeps \/ DepsClear \/ UserAnswersDeps \/ CreateIssues
        \/ ChartFog \/ ChartNoFog \/ UserPicksSpec \/ UserStopsNoFog \/ UserInvokesMap \/ UserNamesStaleTicket \/ UserStopsMap \/ WeekPasses
        \/ PickAfkTicket \/ PickHitlTicket \/ RecordResolution \/ Graduate \/ UserGraduatesFog \/ UserRulesOutFog \/ FileMapTickets
Exec == \/ \E i \in Iss : MaestroDispatches(i) \/ MaestroReaps(i) \/ MaestroAnnouncesHuman(i) \/ WorkerMerges(i) \/ WorkerAsksHelp(i) \/ MasterFinishes(i) \/ MasterReleases(i) \/ UserDoesHumanTask(i)
        \/ MaestroClosesEpic \/ MaestroPauses \/ MaestroRestarts \/ HandOffNudges \/ HandOffAsksToStart \/ UserStartsMaestro \/ UserDeclinesMaestro
        \/ Finish
        \/ \E i \in Tickets : BcheckPicks(i)
        \/ BcheckReady \/ BcheckNeedsPlanning \/ UserAnswersBcheck \/ UserApprovesBcheckPlan \/ UserRejectsBcheckPlan \/ BcheckImplements \/ BcheckShipAsks \/ UserAnswersShipAsk \/ BcheckMerges
        \/ UserRunsImplementSpec \/ ImplementSpecFinishes \/ UserMergesIntegrationPR
        \/ UserRunsTriage \/ UserAnswersBatch \/ NextBatch \/ SummarizeFindings \/ UserApprovesFixes \/ FixesDone \/ FixTooBig

Next == Idea \/ Exec \/ Terminal
Spec == Init /\ [][Next]_vars

\* ---- rules ----
Owners(i) == {o \in {"maestro", "bcheck", "spec"} :
                \/ (o = "maestro" /\ s[i] = "Run")
                \/ (o = "bcheck" /\ hd # None /\ ht = i)
                \/ (o = "spec" /\ is \in {"run", "pr"} /\ i \in ist)}   \* implement-spec builds a ticket on its integration branch until the PR merges
NoDoubleWork      == \A i \in Tickets : Cardinality(Owners(i)) <= 1
NeverClaimBlocked == \A i \in Iss : s[i] \in {"Run", "Claimed"} => Unblocked(i)
NoSpecDispatch    == s["S"] # "Run"
PlanFiledApproved == (route = "plan" /\ ph \in {"Exec", "MAsk", "Done"}) => (aud /\ apr)
ClaimsReleased    == (ph \in {"WPick", "WRecord", "WGrad"} \/ gc = "ticket") => wo = 0    \* a session never starts with a claim a week old
FogHasTicket      == (ph = "WIdle" /\ fog > 0) => wa + wh + ws + wo > 0
BcheckLeavesHumanTasks == ~(hd # None /\ ht \in hl)
NoSleepingFrontier == ~(ph = "Exec" /\ mst = "off" /\ MaestroWork /\ ~owe /\ ~Prompted /\ hd = None /\ is # "run")
====
