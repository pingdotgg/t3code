const grill = {
  intake: "Grilling",
  dest: "Wayfinder: grilling for the destination",
  breadth: "Wayfinder: grilling the whole space",
  ticket: "Wayfinder: grilling one ticket",
};
const exec = (v) => {
  const st = Object.values(v.s);
  if (st.every((x) => x === "Merged" || x === "-")) return "Last ticket merged, closing out";
  if (v.tr !== "-") return "Triage of review findings";
  if (v.is === "run") return "implement-spec running on an integration branch";
  if (v.is === "pr") return "Integration PR waiting for you";
  if (["bcq", "bcp"].includes(v.hd)) return "bcheck planning with you";
  if (v.hd === "bca") return "bcheck's full-send is asking you";
  if (["bc", "bci", "bcs"].includes(v.hd)) return "bcheck working a ticket";
  if (st.includes("Help") || st.includes("WHelp")) return "needs-help: waiting on the master";
  if (st.includes("HAnn")) return "Human task unblocked, master told";
  if (st.includes("Run")) return "A worker is running";
  if (st.includes("Claimed")) return "Ticket in-progress by hand";
  if (st.includes("Ready"))
    return v.mst === "on"
      ? "Maestro dispatching"
      : v.mst === "off"
        ? "Tickets ready, maestro asleep"
        : "Tickets ready, no maestro";
  return "Tickets filed";
};
const names = {
  Idea: "Idea",
  GThink: null,
  GAsked: "Grilling: waiting for your answers",
  GConfirm: "Grilling: waiting for you to confirm",
  Route: "Choosing a route",
  SSeams: "to-spec: sketching seams",
  SAsked: "to-spec: waiting for you on seams",
  SPublish: "to-spec: publishing the spec",
  TDraft: "to-tickets: slicing",
  TQuiz: "to-tickets: waiting for you on the breakdown",
  TPublish: "to-tickets: publishing",
  PDraft: "Plan: drafting",
  PAudit: "replan: auditing",
  PRewrite: "replan: rewriting",
  PBlocked: "replan: waiting for you on a blocking question",
  PPresent: "Plan: waiting for your approval",
  PIssues: "plan-to-issues: reading the plan",
  PAmbig: "plan-to-issues: waiting for you on dependencies",
  PReapprove: "plan-to-issues: waiting for you to approve the replanned plan",
  PGaps: "replan: out of rounds, waiting for you",
  PCreate: "plan-to-issues: creating issues",
  WChart: "Wayfinder: charting the map",
  WNoFog: "Wayfinder: no fog, waiting for you",
  WFogAsk: "Wayfinder: no tickets left but fog, waiting for you",
  WIdle: "Wayfinder: map between sessions",
  WPick: "Wayfinder: picking a ticket",
  WRecord: "Wayfinder: recording the answer",
  WGrad: "Wayfinder: graduating fog",
  WDone: "Wayfinder: the way is clear",
  MAsk: "Waiting for you to start the maestro",
  Stopped: "You stopped",
  Done: "Merged",
};
export const title = "Idea to merged: the skill pipeline";
export const state = (v) =>
  v.ph === "GThink" ? `${grill[v.gc]}: thinking` : v.ph === "Exec" ? exec(v) : names[v.ph];
export const group = (v) => {
  if (v.ph === "Done") return "done";
  if (v.ph === "Stopped") return "stop";
  if (v.ph === "Exec" || v.ph === "MAsk") return "exec";
  if (v.ph.startsWith("W") || v.gc === "dest" || v.gc === "breadth" || v.gc === "ticket")
    return "wayfinder";
  if (v.ph.startsWith("P")) return "plan";
  if (v.ph.startsWith("S") || v.ph.startsWith("T")) return "spec";
  return "intake";
};
export const colors = {
  intake: "blue",
  spec: "purple",
  plan: "orange",
  wayfinder: "yellow",
  exec: "teal",
  done: "pink",
  stop: "tan",
};
const words = {
  StartGrilling: "you start grilling",
  UserSkipsGrilling: "you skip straight to filing",
  AskRound: "the agent asks a round",
  FrontierEmpty: "no questions left",
  UserAnswers: "you answer the round",
  UserKeepsGrilling: "you want more grilling",
  UserConfirmsIntake: "you confirm shared understanding",
  UserConfirmsDest: "you confirm the destination",
  UserConfirmsBreadth: "you confirm the open decisions",
  UserConfirmsTicket: "you confirm the answer",
  UserStopsGrilling: "you stop",
  UserLeavesTicketSession: "you leave the ticket session, its claim stays",
  RouteSpec: "master picks to-spec",
  RoutePlan: "master picks plan then plan-to-issues",
  RoutePlanFile: "you hand over your own plan file",
  RouteWayfinder: "master picks wayfinder",
  SketchSeams: "the agent proposes test seams",
  UserApprovesSeams: "you approve the seams",
  UserRejectsSeams: "you reject the seams",
  UserStopsSpec: "you stop",
  PublishSpec: "spec issue published as an epic",
  DraftSlices: "the agent drafts slices",
  UserApprovesBreakdown: "you approve the breakdown",
  UserWantsRevision: "you ask to split or merge tickets",
  UserStopsTickets: "you stop",
  PublishTickets: "tickets published as ready-for-agent, any maestro thread is nudged",
  DraftPlan: "the agent drafts a plan",
  AuditCovers: "the audit reaches 100%",
  AuditFindsGaps: "the audit finds gaps",
  RewritePlan: "the agent rewrites and re-audits",
  AuditStillShort: "gaps remain after the third round",
  AuditAsksBlocking: "the audit needs your input",
  UserAnswersBlocking: "you answer",
  UserStopsBlocked: "you stop",
  UserAnswersGaps: "you answer what is uncovered",
  UserStopsGaps: "you stop",
  UserApprovesPlan: "you approve the plan",
  UserRejectsPlan: "you reject the plan",
  UserStopsPlan: "you stop",
  ReplanInline: "plan-to-issues finds the plan unaudited and runs replan",
  ReplanInlineStuck: "plan-to-issues' replan runs out of rounds",
  AsksReapproval: "replan changed the plan, plan-to-issues asks again",
  UserApprovesChanges: "you approve the changed plan",
  UserRejectsChanges: "you reject the changed plan",
  UserStopsChanges: "you stop",
  AsksDeps: "dependencies look ambiguous",
  DepsClear: "dependencies are clear",
  UserAnswersDeps: "you answer",
  CreateIssues: "epic and tasks created, any maestro thread is nudged",
  ChartFog: "the map is charted with fog",
  ChartNoFog: "no fog found",
  UserPicksSpec: "you choose to-spec",
  UserStopsNoFog: "you stop",
  UserInvokesMap: "you start a ticket session, week-old claims are unassigned",
  UserNamesStaleTicket: "you name a ticket a dead session claimed",
  UserStopsMap: "you stop",
  WeekPasses: "the map sits idle for a week",
  PickAfkTicket: "the session takes an AFK ticket",
  PickHitlTicket: "the session takes a HITL ticket",
  RecordResolution: "answer posted, ticket closed",
  Graduate: "fog graduates into tickets or the map clears",
  UserGraduatesFog: "you graduate the leftover fog into tickets",
  UserRulesOutFog: "you rule the leftover fog out of scope",
  FileMapTickets: "no tickets and no fog left",
  MaestroDispatches: "maestro claims a ticket and starts a worker",
  MaestroReaps: "maestro labels needs-help and tells the master",
  MaestroClosesEpic: "maestro closes the epic, every sub-issue is closed",
  MaestroAnnouncesHuman: "maestro tells the master a human task is unblocked",
  MaestroPauses: "maestro finds nothing to do and pauses its heartbeat",
  MaestroRestarts: "maestro restarts and reaps what asked for help",
  WorkerMerges: "worker merges the PR",
  WorkerAsksHelp: "worker labels needs-help",
  UserDoesHumanTask: "someone does the human task by hand",
  MasterFinishes: "master finishes the ticket by hand",
  MasterReleases: "master removes needs-help",
  HandOffNudges: "someone nudges the maestro",
  HandOffAsksToStart: "master asks you to start the maestro",
  UserStartsMaestro: "you start the maestro",
  UserDeclinesMaestro: "you decline the maestro",
  BcheckPicks: "you run bcheck and it claims a ticket",
  BcheckReady: "bcheck judges it ready",
  BcheckNeedsPlanning: "bcheck judges it needs planning",
  UserAnswersBcheck: "you answer, plan is audited",
  UserApprovesBcheckPlan: "you approve the plan",
  UserRejectsBcheckPlan: "you reject the plan",
  BcheckImplements: "bcheck implements and hands over to full-send",
  BcheckShipAsks: "full-send asks the user",
  UserAnswersShipAsk: "you answer full-send",
  BcheckMerges: "full-send merges the PR and closes the issue",
  UserRunsImplementSpec: "you run implement-spec",
  ImplementSpecFinishes: "implement-spec marks the PR ready",
  UserMergesIntegrationPR: "you merge the integration PR",
  UserRunsTriage: "you run triage",
  UserAnswersBatch: "you answer a batch",
  NextBatch: "more findings",
  SummarizeFindings: "all findings discussed",
  UserApprovesFixes: "you approve the fixes",
  FixesDone: "fixes applied",
  FixTooBig: "a fix needs a new planning cycle",
  Finish: "every ticket is merged",
};
export const step = (action) => words[action] ?? null;
