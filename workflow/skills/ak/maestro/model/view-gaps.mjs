const unblocked = (v, i) => !(i === "B" && v.s.A !== "Merged");
const phase = (v, i) => {
  const s = v.s[i];
  const holder = Object.values(v.wk).find((w) => w.k !== "Idle" && w.i === i);
  if (s === "Ready") return unblocked(v, i) ? "ready-for-agent" : "blocked by A";
  if (s === "Claimed") {
    if (v.pend === i) return "claimed, worker not started";
    if (!holder) return "in-progress, nobody owns it";
    return holder.k === "Run" ? "worker running" : "worker ended, maestro not looked yet";
  }
  return {
    ClaimedHelp: "needs-help raised, maestro not looked yet",
    Help: "needs-help, master decides",
    Merged: "merged",
  }[s];
};
export const title = "Maestro: issue lifecycle";
const hb = {
  on: "checks the queue every 5 min",
  paused: "paused (queue looks empty)",
  deleted: "deleted (all done)",
};
export const state = (v) => ({
  ...Object.fromEntries(Object.keys(v.s).map((i) => [`Issue ${i}`, phase(v, i)])),
  "Maestro heartbeat": hb[v.hb],
});
export const group = (v) => (Object.values(v.s).every((x) => x === "Merged") ? "done" : "going");
export const colors = { done: "teal", going: "blue" };
const words = {
  MaestroClaims: "maestro adds in-progress",
  MaestroSpawns: "maestro starts a worker",
  MaestroReapsMerged: "maestro sees it merged",
  MaestroReapsHelp: "maestro sees needs-help and tells master",
  MaestroNudgesWorker: "maestro nudges the worker",
  MaestroGivesUpNudging: "maestro gives up nudging: needs-help",
  MaestroRequeuesDied: "worker vanished: maestro requeues (or needs-help the second time)",
  MaestroRequeuesOrphan: "maestro requeues an orphan",
  WorkerMerges: "worker merges the PR",
  WorkerAsksHelp: "worker labels needs-help",
  WorkerQuits: "worker quits early",
  WorkerDies: "worker dies",
  MasterFinishes: "master finishes it by hand",
  MasterReleases: "master removes needs-help",
  MaestroRestarts: "maestro restarts and forgets",
  MaestroEndsTick: "maestro ends its tick (pauses the heartbeat if the queue looks empty)",
  MasterNudges: "master nudges maestro",
  HeartbeatFires: "heartbeat wakes maestro",
  SomeoneNudges: "someone nudges maestro",
};
export const step = (action, from, to) => {
  if (action === "WorkerEnds")
    return Object.keys(to.s).some((i) => to.s[i] === "Merged" && from.s[i] !== "Merged")
      ? words.WorkerMerges
      : words.WorkerAsksHelp;
  return words[action] ?? null;
};
