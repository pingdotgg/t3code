# Skill pipeline model

TLA+ model of one idea through the skills, from what each SKILL.md says: grilling, to-spec / wayfinder / plan+replan, to-tickets / plan-to-issues, maestro, maestro-worker, merged; by hand: bcheck, implement-spec, triage. Results: `results.md`.

Rerun all into a new folder (mise, Node 22+, uv; each checker alone under a 2 GB cap): `sh run.sh /tmp/pipeline-out`

- Rules and shortest bug paths: `statechart Pipeline.tla --config Pipeline.cfg --view view.mjs --out NEW_DIR` (its 100,000-state bound skips a rule after the first break, so `run.sh` also runs each rule alone).
- Charts: same command with `Chart.cfg` (`chart.mmd`/`.svg`, idea to maestro) or `ExecChart.cfg` (`chart-exec.*`, tickets to merged). Small constants keep them under 500 states; svg via Pele (statechart/references/render.md).
- Graph rules: `tlc -dump dot,actionlabels states.dot -config Graph.cfg Pipeline.tla`, then `uv run --with networkx python check.py states.dot`.

TLC rules (every state): `NoDoubleWork` one worker per ticket across maestro, bcheck, implement-spec. `NeverClaimBlocked`. `NoSpecDispatch` no worker on the spec issue. `PlanFiledApproved` issues come only from a plan audited and approved as filed. `ClaimsReleased` a wayfinder claim ends with its session. `FogHasTicket` an idle map with fog has a ticket. `NoSleepingFrontier` ready tickets never wait on a sleeping maestro nobody owes a nudge. `BcheckLeavesHumanTasks`.

NetworkX rules (whole graph): `EveryStateCanReachMergedOrStop`, `FiledStatesCanStillReachMerged`, `RouteReachesMerged[route]`. `NoSilentStall` automation alone ends, prompts the user or wakes someone. `NoAgentOnlyLoop` no agent-step cycle without a user prompt. `ApprovalsRequireTheUser` every step out of a user wait is a user step.

Not modeled: worker crash and nudge counts, research tickets, wayfinder blocking edges, domain-modeling docs, provider labels. A finished skill's report is no prompt; only questions and maestro messages are.
