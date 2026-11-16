---- MODULE Pipeline ----
\* The path one idea takes through the workflow skills, as the skill texts say it, not as it should be.
\* Idea-level phases (ph) are one sequential session with the user; execution (s, hd, is, tr, mst) runs beside it.
EXTENDS Naturals, FiniteSets

CONSTANTS Tickets, Human, MaxW, MaxT, MaxFog, MaxRestart, ByHand, Triage, MstInit, MmInit, StartAt
\* Human: tickets plan-to-issues files as ready-for-human. ByHand = FALSE leaves out bcheck and implement-spec, Triage = FALSE leaves out triage. MstInit, MmInit and StartAt pick where the run begins:
\* the maestro's state, whether the idea runs under the maestro skill, and idea (grilling onward) or exec (tickets already filed). The small settings keep the chart under 500 states.

VARIABLES ph, gc, route, aud, apr, wa, wh, ws, fog, mm, s, hd, ht, is, tr, mst, owe, rs
I == <<ph, gc, route, aud, apr>>   \* where the idea is: phase, grilling context, route taken, plan audited, plan approved
W == <<wa, wh, ws, fog>>           \* wayfinder map: open AFK tickets, open HITL tickets, tickets left claimed by a dead session, fog patches
E == <<mm, s, hd, ht, is, tr, mst, owe, rs>>
vars == <<I, W, E>>

None == "-"
Iss == Tickets \cup {"S"}                       \* S is the spec issue to-spec publishes; A, B are tickets, B is blocked by A
Unblocked(i) == i = "B" => s["A"] = "Merged"
Claimable(i) == s[i] = "Ready" /\ Unblocked(i)
Running == {i \in Iss : s[i] = "Run"}
Filed == {i \in Iss : s[i] # "-"}
Requeue == [i \in Iss |-> IF s[i] = "Claimed" THEN "Ready" ELSE s[i]]   \* maestro first tick: in-progress with no child = orphan
Live == ph \in {"Exec", "MAsk"}
FileTickets == [i \in Iss |-> IF i \in Tickets /\ s[i] = "-" THEN "Ready" ELSE s[i]]
FilePlanTickets == [i \in Iss |-> IF i \in Tickets /\ s[i] = "-" THEN (IF i \in Human THEN "HReady" ELSE "Ready") ELSE s[i]]

Waits == {"GAsked", "GConfirm", "SAsked", "TQuiz", "PPresent", "PBlocked", "PAmbig", "WNoFog", "MAsk"}
Prompted == ph \in Waits \/ hd \in {"bcq", "bcp"} \/ is = "pr" \/ tr \in {"batch", "sum"}

Init == /\ gc = None /\ wa = 0 /\ wh = 0 /\ ws = 0 /\ fog = 0
        /\ mm \in MmInit                        \* was this idea started under the maestro skill (its Intake nudges the maestro)?
        /\ hd = None /\ ht = None /\ is = None /\ tr = None /\ mst \in MstInit /\ rs = 0
        /\ IF StartAt = "idea"
           THEN ph = "Idea" /\ route = None /\ aud = FALSE /\ apr = FALSE /\ s = [i \in Iss |-> "-"] /\ owe = FALSE
           ELSE ph = "Exec" /\ route = "plan" /\ aud = TRUE /\ apr = TRUE /\ s = [i \in Iss |-> IF i \in Tickets THEN (IF i \in Human THEN "HReady" ELSE "Ready") ELSE "-"] /\ owe = mm   \* a plan-to-issues batch was just filed

\* ---- grilling (grilling, grill-me, grill-with-docs); wayfinder reuses it through gc ----
StartGrilling     == /\ ph = "Idea" /\ ph' = "GThink" /\ gc' = "intake" /\ UNCHANGED <<route, aud, apr, W, E>>
UserSkipsGrilling == /\ ph = "Idea" /\ ph' = "Route" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
AskRound          == /\ ph = "GThink" /\ ph' = "GAsked" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
FrontierEmpty     == /\ ph = "GThink" /\ ph' = "GConfirm" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserAnswers       == /\ ph = "GAsked" /\ ph' = "GThink" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserKeepsGrilling == /\ ph = "GConfirm" /\ ph' = "GThink" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserConfirmsIntake  == /\ ph = "GConfirm" /\ gc = "intake" /\ ph' = "Route" /\ gc' = None /\ UNCHANGED <<route, aud, apr, W, E>>
UserConfirmsDest    == /\ ph = "GConfirm" /\ gc = "dest" /\ ph' = "GThink" /\ gc' = "breadth" /\ UNCHANGED <<route, aud, apr, W, E>>
UserConfirmsBreadth == /\ ph = "GConfirm" /\ gc = "breadth" /\ ph' = "WChart" /\ gc' = None /\ UNCHANGED <<route, aud, apr, W, E>>
UserConfirmsTicket  == /\ ph = "GConfirm" /\ gc = "ticket" /\ ph' = "WRecord" /\ gc' = None /\ UNCHANGED <<route, aud, apr, W, E>>
UserStopsGrilling   == /\ ph \in {"GAsked", "GConfirm"} /\ gc # "ticket" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserLeavesTicketSession == /\ ph \in {"GAsked", "GConfirm"} /\ gc = "ticket" /\ ph' = "WIdle" /\ gc' = None
                           /\ ws' = (IF ws < MaxT THEN ws + 1 ELSE ws) /\ UNCHANGED <<route, aud, apr, wa, wh, fog, E>>

\* ---- the master picks the route (maestro Intake; no criteria beyond "very large work -> wayfinder") ----
RouteSpec      == /\ ph = "Route" /\ ph' = "SSeams" /\ route' = "spec" /\ UNCHANGED <<gc, aud, apr, W, E>>
RoutePlan      == /\ ph = "Route" /\ ph' = "PDraft" /\ route' = "plan" /\ aud' = FALSE /\ apr' = FALSE /\ UNCHANGED <<gc, W, E>>
RoutePlanFile  == /\ ph = "Route" /\ ph' = "PIssues" /\ route' = "plan" /\ aud' = FALSE /\ apr' = TRUE /\ UNCHANGED <<gc, W, E>>   \* the user hands plan-to-issues their own plan file
RouteWayfinder == /\ ph = "Route" /\ ph' = "GThink" /\ gc' = "dest" /\ route' = "wayfinder" /\ UNCHANGED <<aud, apr, W, E>>

\* ---- to-spec ----
SketchSeams       == /\ ph = "SSeams" /\ ph' = "SAsked" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserApprovesSeams == /\ ph = "SAsked" /\ ph' = "SPublish" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserRejectsSeams  == /\ ph = "SAsked" /\ ph' = "SSeams" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserStopsSpec     == /\ ph = "SAsked" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
PublishSpec       == /\ ph = "SPublish" /\ ph' = "TDraft"                            \* published with ready-for-agent, "no need for additional triage"
                     /\ s' = [s EXCEPT !["S"] = IF s["S"] = "-" THEN "Ready" ELSE s["S"]]
                     /\ UNCHANGED <<gc, route, aud, apr, W, mm, hd, ht, is, tr, mst, owe, rs>>

\* ---- to-tickets (after to-spec, and as the last step of wayfinder) ----
DraftSlices       == /\ ph = "TDraft" /\ ph' = "TQuiz" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserApprovesBreakdown == /\ ph = "TQuiz" /\ ph' = "TPublish" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserWantsRevision == /\ ph = "TQuiz" /\ ph' = "TDraft" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserStopsTickets  == /\ ph = "TQuiz" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
PublishTickets    == /\ ph = "TPublish" /\ ph' = "Exec" /\ s' = FileTickets
                     /\ owe' = (owe \/ mm \/ route = "wayfinder")                   \* only the maestro Intake and wayfinder's last step say to hand the tickets to the maestro
                     /\ UNCHANGED <<gc, route, aud, apr, W, mm, hd, ht, is, tr, mst, rs>>

\* ---- plan, replan, plan-to-issues ----
DraftPlan         == /\ ph = "PDraft" /\ ph' = "PAudit" /\ aud' = FALSE /\ apr' = FALSE /\ UNCHANGED <<gc, route, W, E>>
AuditCovers       == /\ ph = "PAudit" /\ ph' = "PPresent" /\ aud' = TRUE /\ UNCHANGED <<gc, route, apr, W, E>>
AuditFindsGaps    == /\ ph = "PAudit" /\ ph' = "PRewrite" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
RewritePlan       == /\ ph = "PRewrite" /\ ph' = "PAudit" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
AuditAsksBlocking == /\ ph = "PAudit" /\ ph' = "PBlocked" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserAnswersBlocking == /\ ph = "PBlocked" /\ ph' = "PAudit" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserStopsBlocked  == /\ ph = "PBlocked" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserApprovesPlan  == /\ ph = "PPresent" /\ ph' = "PIssues" /\ apr' = TRUE /\ UNCHANGED <<gc, route, aud, W, E>>
UserRejectsPlan   == /\ ph = "PPresent" /\ ph' = "PDraft" /\ aud' = FALSE /\ apr' = FALSE /\ UNCHANGED <<gc, route, W, E>>
UserStopsPlan     == /\ ph = "PPresent" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
ReplanInline      == /\ ph = "PIssues" /\ ~aud /\ aud' = TRUE /\ apr' \in {apr, FALSE}   \* plan-to-issues Step 1: not audited yet, so run replan first; a rewrite voids the approval
                     /\ UNCHANGED <<ph, gc, route, W, E>>
AsksDeps          == /\ ph = "PIssues" /\ aud /\ ph' = "PAmbig" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
DepsClear         == /\ ph = "PIssues" /\ aud /\ ph' = "PCreate" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserAnswersDeps   == /\ ph = "PAmbig" /\ ph' = "PCreate" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
CreateIssues      == /\ ph = "PCreate" /\ ph' = "Exec" /\ s' = FilePlanTickets /\ owe' = (owe \/ mm)
                     /\ UNCHANGED <<gc, route, aud, apr, W, mm, hd, ht, is, tr, mst, rs>>

\* ---- wayfinder ----
ChartFog          == /\ ph = "WChart" /\ ph' = "WIdle"
                     /\ \E a \in 0..1, h \in 0..1, f \in 1..MaxFog : a + h >= 1 /\ wa' = a /\ wh' = h /\ fog' = f
                     /\ ws' = 0 /\ UNCHANGED <<gc, route, aud, apr, E>>
ChartNoFog        == /\ ph = "WChart" /\ ph' = "WNoFog" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserPicksSpec     == /\ ph = "WNoFog" /\ ph' = "SSeams" /\ route' = "spec" /\ UNCHANGED <<gc, aud, apr, W, E>>
UserStopsNoFog    == /\ ph = "WNoFog" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserInvokesMap    == /\ ph = "WIdle" /\ wa + wh > 0 /\ ph' = "WPick" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserNamesStaleTicket == /\ ph = "WIdle" /\ ws > 0 /\ ph' = "GThink" /\ gc' = "ticket" /\ ws' = ws - 1 /\ UNCHANGED <<route, aud, apr, wa, wh, fog, E>>
UserStopsMap      == /\ ph = "WIdle" /\ ph' = "Stopped" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
PickAfkTicket     == /\ ph = "WPick" /\ wa > 0 /\ ph' = "WRecord" /\ wa' = wa - 1 /\ UNCHANGED <<gc, route, aud, apr, wh, ws, fog, E>>
PickHitlTicket    == /\ ph = "WPick" /\ wh > 0 /\ ph' = "GThink" /\ gc' = "ticket" /\ wh' = wh - 1 /\ UNCHANGED <<route, aud, apr, wa, ws, fog, E>>
RecordResolution  == /\ ph = "WRecord" /\ ph' = "WGrad" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
Graduate          == /\ ph = "WGrad"
                     /\ \E na \in 0..1, nh \in 0..1, df \in 0..1 :
                          /\ df <= fog /\ wa + na <= MaxT /\ wh + nh <= MaxT
                          /\ wa' = wa + na /\ wh' = wh + nh /\ fog' = fog - df
                          /\ ph' = IF wa + na + wh + nh + ws + fog - df = 0 THEN "WDone" ELSE "WIdle"
                     /\ UNCHANGED <<gc, route, aud, apr, ws, E>>
FileMapTickets    == /\ ph = "WDone" /\ ph' = "TDraft" /\ UNCHANGED <<gc, route, aud, apr, W, E>>

\* ---- maestro, workers, master (maestro and maestro-worker skills) ----
MaestroDispatches(i) == /\ mst = "on" /\ Claimable(i) /\ Cardinality(Running) < MaxW
                        /\ s' = [s EXCEPT ![i] = "Run"] /\ UNCHANGED <<I, W, mm, hd, ht, is, tr, mst, owe, rs>>
MaestroReaps(i)      == /\ mst = "on" /\ s[i] = "WHelp" /\ s' = [s EXCEPT ![i] = "Help"] /\ UNCHANGED <<I, W, mm, hd, ht, is, tr, mst, owe, rs>>
MaestroPauses        == /\ mst = "on" /\ \A i \in Iss : ~Claimable(i) /\ s[i] \notin {"Run", "WHelp"}
                        /\ mst' = "off" /\ UNCHANGED <<I, W, mm, s, hd, ht, is, tr, owe, rs>>
MaestroRestarts      == /\ rs < MaxRestart /\ mst # "none" /\ rs' = rs + 1 /\ mst' = "on" /\ s' = Requeue
                        /\ UNCHANGED <<I, W, mm, hd, ht, is, tr, owe>>
WorkerMerges(i)      == /\ s[i] = "Run" /\ s' = [s EXCEPT ![i] = "Merged"] /\ mst' = "on" /\ UNCHANGED <<I, W, mm, hd, ht, is, tr, owe, rs>>
WorkerAsksHelp(i)    == /\ s[i] = "Run" /\ s' = [s EXCEPT ![i] = "WHelp"] /\ mst' = "on" /\ UNCHANGED <<I, W, mm, hd, ht, is, tr, owe, rs>>
UserDoesHumanTask(i) == /\ s[i] = "HReady" /\ Unblocked(i) /\ s' = [s EXCEPT ![i] = "Merged"] /\ UNCHANGED <<I, W, mm, hd, ht, is, tr, mst, owe, rs>>
MasterFinishes(i)    == /\ s[i] = "Help" /\ s' = [s EXCEPT ![i] = "Merged"] /\ owe' = TRUE /\ UNCHANGED <<I, W, mm, hd, ht, is, tr, mst, rs>>
MasterReleases(i)    == /\ s[i] = "Help" /\ s' = [s EXCEPT ![i] = "Ready"] /\ owe' = TRUE /\ UNCHANGED <<I, W, mm, hd, ht, is, tr, mst, rs>>
HandOffNudges        == /\ owe /\ mst # "none" /\ mst' = "on" /\ owe' = FALSE /\ UNCHANGED <<I, W, mm, s, hd, ht, is, tr, rs>>
HandOffAsksToStart   == /\ owe /\ mst = "none" /\ ph = "Exec" /\ ph' = "MAsk" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
UserStartsMaestro    == /\ ph = "MAsk" /\ ph' = "Exec" /\ mst' = "on" /\ owe' = FALSE /\ s' = Requeue /\ UNCHANGED <<gc, route, aud, apr, W, mm, hd, ht, is, tr, rs>>
UserDeclinesMaestro  == /\ ph = "MAsk" /\ ph' = "Exec" /\ owe' = FALSE /\ UNCHANGED <<gc, route, aud, apr, W, mm, s, hd, ht, is, tr, mst, rs>>

\* ---- by hand: bcheck, implement-spec, triage ----
BcheckPicks(i)       == /\ ByHand /\ Live /\ i \in Tickets /\ hd = None /\ (Claimable(i) \/ (s[i] = "HReady" /\ Unblocked(i)))   \* its issue search has no -label:ready-for-human
                        /\ s' = [s EXCEPT ![i] = "Claimed"] /\ hd' = "bc" /\ ht' = i /\ UNCHANGED <<I, W, mm, is, tr, mst, owe, rs>>
BcheckReady          == /\ ByHand /\ hd = "bc" /\ hd' = "bci" /\ UNCHANGED <<I, W, mm, s, ht, is, tr, mst, owe, rs>>
BcheckNeedsPlanning  == /\ ByHand /\ hd = "bc" /\ hd' = "bcq" /\ UNCHANGED <<I, W, mm, s, ht, is, tr, mst, owe, rs>>
UserAnswersBcheck    == /\ ByHand /\ hd = "bcq" /\ hd' = "bcp" /\ UNCHANGED <<I, W, mm, s, ht, is, tr, mst, owe, rs>>
UserApprovesBcheckPlan == /\ ByHand /\ hd = "bcp" /\ hd' = "bci" /\ UNCHANGED <<I, W, mm, s, ht, is, tr, mst, owe, rs>>
UserRejectsBcheckPlan  == /\ ByHand /\ hd = "bcp" /\ hd' = "bcq" /\ UNCHANGED <<I, W, mm, s, ht, is, tr, mst, owe, rs>>
BcheckImplements     == /\ ByHand /\ hd = "bci" /\ hd' = "bcc" /\ UNCHANGED <<I, W, mm, s, ht, is, tr, mst, owe, rs>>   \* the text ends here: no PR, no merge, in-progress stays
UserRunsImplementSpec == /\ ByHand /\ Live /\ is = None /\ \E i \in Iss : s[i] \notin {"-", "Merged"}
                         /\ is' = "run" /\ UNCHANGED <<I, W, mm, s, hd, ht, tr, mst, owe, rs>>               \* never touches a label
ImplementSpecFinishes == /\ ByHand /\ is = "run" /\ is' = "pr" /\ UNCHANGED <<I, W, mm, s, hd, ht, tr, mst, owe, rs>>
UserMergesIntegrationPR == /\ ByHand /\ is = "pr" /\ is' = "done" /\ s' = [i \in Iss |-> IF s[i] = "-" THEN "-" ELSE "Merged"]
                           /\ UNCHANGED <<I, W, mm, hd, ht, tr, mst, owe, rs>>
UserRunsTriage       == /\ Triage /\ tr = None /\ (hd = "bcc" \/ is = "pr") /\ tr' = "batch" /\ UNCHANGED <<I, W, mm, s, hd, ht, is, mst, owe, rs>>
UserAnswersBatch     == /\ Triage /\ tr = "batch" /\ tr' = "bdone" /\ UNCHANGED <<I, W, mm, s, hd, ht, is, mst, owe, rs>>
NextBatch            == /\ Triage /\ tr = "bdone" /\ tr' = "batch" /\ UNCHANGED <<I, W, mm, s, hd, ht, is, mst, owe, rs>>
SummarizeFindings    == /\ Triage /\ tr = "bdone" /\ tr' = "sum" /\ UNCHANGED <<I, W, mm, s, hd, ht, is, mst, owe, rs>>
UserApprovesFixes    == /\ Triage /\ tr = "sum" /\ tr' = "fix" /\ UNCHANGED <<I, W, mm, s, hd, ht, is, mst, owe, rs>>
FixesDone            == /\ Triage /\ tr = "fix" /\ tr' = None /\ UNCHANGED <<I, W, mm, s, hd, ht, is, mst, owe, rs>>
FixTooBig            == /\ Triage /\ tr = "fix" /\ ph = "Exec" /\ tr' = None /\ ph' = "PDraft" /\ route' = "plan" /\ aud' = FALSE /\ apr' = FALSE
                        /\ UNCHANGED <<gc, W, mm, s, hd, ht, is, mst, owe, rs>>                        \* "a new planning cycle"

Finish   == /\ ph = "Exec" /\ Filed # {} /\ \A i \in Filed : s[i] = "Merged" /\ ph' = "Done" /\ UNCHANGED <<gc, route, aud, apr, W, E>>
Terminal == ph \in {"Done", "Stopped"} /\ UNCHANGED vars

Idea == \/ StartGrilling \/ UserSkipsGrilling \/ AskRound \/ FrontierEmpty \/ UserAnswers \/ UserKeepsGrilling
        \/ UserConfirmsIntake \/ UserConfirmsDest \/ UserConfirmsBreadth \/ UserConfirmsTicket \/ UserStopsGrilling \/ UserLeavesTicketSession
        \/ RouteSpec \/ RoutePlan \/ RoutePlanFile \/ RouteWayfinder
        \/ SketchSeams \/ UserApprovesSeams \/ UserRejectsSeams \/ UserStopsSpec \/ PublishSpec
        \/ DraftSlices \/ UserApprovesBreakdown \/ UserWantsRevision \/ UserStopsTickets \/ PublishTickets
        \/ DraftPlan \/ AuditCovers \/ AuditFindsGaps \/ RewritePlan \/ AuditAsksBlocking \/ UserAnswersBlocking \/ UserStopsBlocked
        \/ UserApprovesPlan \/ UserRejectsPlan \/ UserStopsPlan \/ ReplanInline \/ AsksDeps \/ DepsClear \/ UserAnswersDeps \/ CreateIssues
        \/ ChartFog \/ ChartNoFog \/ UserPicksSpec \/ UserStopsNoFog \/ UserInvokesMap \/ UserNamesStaleTicket \/ UserStopsMap
        \/ PickAfkTicket \/ PickHitlTicket \/ RecordResolution \/ Graduate \/ FileMapTickets
Exec == \/ \E i \in Iss : MaestroDispatches(i) \/ MaestroReaps(i) \/ WorkerMerges(i) \/ WorkerAsksHelp(i) \/ MasterFinishes(i) \/ MasterReleases(i) \/ UserDoesHumanTask(i)
        \/ MaestroPauses \/ MaestroRestarts \/ HandOffNudges \/ HandOffAsksToStart \/ UserStartsMaestro \/ UserDeclinesMaestro
        \/ Finish
        \/ \E i \in Tickets : BcheckPicks(i)
        \/ BcheckReady \/ BcheckNeedsPlanning \/ UserAnswersBcheck \/ UserApprovesBcheckPlan \/ UserRejectsBcheckPlan \/ BcheckImplements
        \/ UserRunsImplementSpec \/ ImplementSpecFinishes \/ UserMergesIntegrationPR
        \/ UserRunsTriage \/ UserAnswersBatch \/ NextBatch \/ SummarizeFindings \/ UserApprovesFixes \/ FixesDone \/ FixTooBig

Next == Idea \/ Exec \/ Terminal
Spec == Init /\ [][Next]_vars

\* ---- rules ----
NoDoubleWork      == \A i \in Iss : ~(s[i] = "Run" /\ (is = "run" \/ (i = ht /\ hd # None)))
NeverClaimBlocked == \A i \in Iss : s[i] \in {"Run", "Claimed"} => Unblocked(i)
NoSpecDispatch    == s["S"] # "Run"
PlanFiledApproved == (route = "plan" /\ ph \in {"Exec", "MAsk", "Done"}) => (aud /\ apr)
ClaimsReleased    == ws = 0
FogHasTicket      == (ph = "WIdle" /\ fog > 0) => wa + wh > 0
BcheckLeavesHumanTasks == ~(hd # None /\ ht \in Human)
NoSleepingFrontier == ~(ph = "Exec" /\ mst = "off" /\ (\E i \in Iss : Claimable(i)) /\ ~owe /\ ~Prompted /\ hd = None /\ is # "run")
====
