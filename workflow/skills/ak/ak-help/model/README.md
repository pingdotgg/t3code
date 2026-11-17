# Skill pipeline model

TLA+ model of one idea through the skills, from what each SKILL.md says: grilling, to-spec / wayfinder / plan+replan, to-tickets / plan-to-issues, maestro, maestro-worker (which ships through full-send and validate-change), merged; by hand: bcheck (also through full-send), implement-spec, triage. Results: `results.md`, before and after the skills closed the first ten gaps.

Rerun all into a new folder (mise, Node 22+, uv; each checker alone under a 2 GB cap): `sh run.sh /tmp/pipeline-out`

- Rules and shortest bug paths: `statechart Pipeline.tla --config Pipeline.cfg --view view.mjs --out NEW_DIR` (its 100,000-state bound skips a rule after the first break, so `run.sh` also runs each rule alone).
- Charts: same command with `Chart.cfg` (`chart.mmd`/`.svg`, idea to maestro) or `ExecChart.cfg` (`chart-exec.*`, tickets to merged). Small constants keep them under 500 states; svg via Pele (statechart/references/render.md).
- Graph rules: `tlc -dump dot,actionlabels states.dot -config Graph.cfg Pipeline.tla`, then `uv run --with networkx python check.py states.dot`. `Graph.cfg` uses `MaxRounds = 1`: with 3 the dot file passes 2 GB in Python.

TLC rules (every state): `NoDoubleWork` one owner per ticket across the maestro's worker, bcheck and implement-spec (which owns its tickets while its integration branch or PR is open). `NeverClaimBlocked`. `NoSpecDispatch` no worker on the spec issue (an `epic`). `PlanFiledApproved` issues come only from a plan audited and approved as filed, including after replan changed it. `ClaimsReleased` no ticket session starts with a week-old abandoned claim. `FogHasTicket` an idle map with fog has a ticket. `NoSleepingFrontier` ready tickets, a closable epic or an unannounced human task never wait on a sleeping maestro nobody owes a nudge. `BcheckLeavesHumanTasks` bcheck never owns a ready-for-human ticket.

NetworkX rules (whole graph): `EveryStateCanReachMergedOrStop`, `FiledStatesCanStillReachMerged`, `RouteReachesMerged[route]`. `NoSilentStall` automation alone ends, prompts the user or wakes someone. `NoAgentOnlyLoop` no agent-step cycle without a user prompt. `ApprovalsRequireTheUser` every step out of a user wait is a user step.

Choices in the model: the epic (a to-spec spec or a plan-to-issues epic) is closed only by the maestro or by an integration PR, and the run is "merged" only once it is closed. Replan's round limit is `MaxRounds`. A week-old claim is a wayfinder session left behind plus one idle week. bcheck's issue search finds only agent tickets; an issue the user names by ID is not checked.

Not modeled: worker crash and nudge counts, research tickets, wayfinder blocking edges, domain-modeling docs, provider labels, a deleted (not paused) heartbeat, bcheck by issue ID, implement-spec taking ready-for-human or needs-help tickets. A finished skill's report is no prompt; only questions and maestro messages are. Triage is tied to the integration PR, the one place the texts leave review findings waiting.
