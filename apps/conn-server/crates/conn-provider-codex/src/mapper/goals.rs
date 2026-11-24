//! Native goals (`/goal`), as `CodexAdapterV2` keeps them: the goal each root thread has
//! (`goalsByNativeThread`), its row on the provider thread (`emitGoalUpdate`), the run held
//! open between the turns Codex continues a goal with (`goalHolds`), and the Stops and
//! activations that end a hold. The session sends the `thread/goal/*` requests.

use std::collections::{HashMap, HashSet};

use conn_provider::TurnInput;
pub use conn_provider::goal::{GoalCommand, parse_command};
use conn_provider_support::ids::{self, Env};
use serde_json::{Value, json};

use super::{
    DRIVER, Mapper, Out, PendingTurn, Turn, agent_artifacts, provider_turn_json, push_event,
};

/// `MAX_THREAD_GOAL_OBJECTIVE_CHARS` (`effect-codex-app-server`), in code points.
const MAX_OBJECTIVE_CHARS: usize = 4_000;

/// `CodexGoalObjectiveTooLongError`'s message, when the objective is too long.
pub fn objective_too_long(objective: &str) -> Option<String> {
    let length = objective.chars().count();
    (length > MAX_OBJECTIVE_CHARS).then(|| {
        format!(
            "The goal objective is {length} characters; Codex supports at most {MAX_OBJECTIVE_CHARS}. Shorten it and send /goal again. The current goal was not changed."
        )
    })
}

/// `providerGoalFromCodex`: the provider thread's goal row, `null` for none.
pub fn provider_goal(goal: &Value) -> Value {
    let Some(objective) = goal["objective"]
        .as_str()
        .map(str::trim)
        .filter(|o| !o.is_empty())
    else {
        return Value::Null;
    };
    let status = match goal["status"].as_str() {
        Some("active") => "active",
        Some("paused") => "paused",
        Some("blocked") => "blocked",
        Some("usageLimited") => "usage_limited",
        Some("budgetLimited") => "budget_limited",
        Some("complete") => "complete",
        _ => return Value::Null,
    };
    let count = |v: &Value| v.as_f64().map_or(0, |n| n.max(0.0) as i64);
    json!({
        "objective": objective,
        "status": status,
        "tokensUsed": count(&goal["tokensUsed"]),
        "tokenBudget": goal["tokenBudget"].as_i64(),
        "timeUsedSeconds": count(&goal["timeUsedSeconds"]),
    })
}

/// `describeCodexGoal`.
pub fn describe(goal: &Value) -> String {
    format!(
        "Goal {}: {}",
        goal["status"]
            .as_str()
            .unwrap_or_default()
            .replacen('_', " ", 1),
        goal["objective"].as_str().unwrap_or_default()
    )
}

/// A completed goal turn whose run waits for Codex's next turn (`CodexGoalHold`).
struct GoalHold {
    /// Tells this hold from a later one, for the grace timer ([`Out::GoalHeld`]).
    seq: u64,
    provider_turn_id: String,
    /// The run's earlier provider turns.
    continues: Vec<String>,
    /// The held turn's `provider_turn.updated` (completed) and `turn.terminal`.
    completed: Value,
    terminal: Value,
    /// The run's next turn, when Codex starts one.
    next: PendingTurn,
}

#[derive(Default)]
pub(super) struct Goals {
    /// Native root thread → its goal row (`goalsByNativeThread`); `null` for none.
    goals: HashMap<String, Value>,
    /// Native root thread → its provider thread, with the goal last shown
    /// (`rootProviderThreads`).
    threads: HashMap<String, Value>,
    /// Setting a goal passes through cleared and paused states (`goalUpdatesHeld`).
    updates_held: HashSet<String>,
    /// Native thread → whether Stop cancelled the activation (`goalActivations`).
    activations: HashMap<String, bool>,
    holds: HashMap<String, GoalHold>,
    /// Holds whose grace ran out, waiting for the goal's pause (`pauseClaimedGoal`), with
    /// [`Self::notified`] when the pause went out.
    claimed: HashMap<String, (GoalHold, u64)>,
    /// Stops and expiry pauses in flight (`goalStops`).
    stops: HashMap<String, u32>,
    seq: u64,
    /// Counts goal notifications: the clock of [`Mapper::goal_version`].
    notified: u64,
    /// Native thread → the count at its latest goal notification. An answer to a request sent
    /// before that is older, and does not replace the goal the notification reported.
    notified_at: HashMap<String, u64>,
}

impl Goals {
    #[cfg(test)]
    pub(super) fn sizes(&self) -> [usize; 8] {
        [
            self.notified_at.len(),
            self.claimed.len(),
            self.goals.len(),
            self.threads.len(),
            self.updates_held.len(),
            self.activations.len(),
            self.holds.len(),
            self.stops.len(),
        ]
    }

    fn status(&self, native: &str) -> Option<&str> {
        self.goals.get(native)?["status"].as_str()
    }
}

impl<E: Env> Mapper<E> {
    /// The status of the thread's goal, if one is known.
    pub fn goal_status(&self, native: &str) -> Option<String> {
        self.goals.status(native).map(str::to_owned)
    }

    /// Stores the goal Codex answered with (`goalsByNativeThread.set`), showing nothing yet.
    pub fn store_goal(&mut self, native: &str, codex_goal: &Value) {
        self.goals
            .goals
            .insert(native.to_owned(), provider_goal(codex_goal));
    }

    /// The goal-notification count, taken before a request whose answer may race Codex's
    /// own notifications ([`Self::store_goal_answer`]).
    pub fn goal_version(&self) -> u64 {
        self.goals.notified
    }

    /// Stores the goal a request answered with, unless a notification for the same thread
    /// came after the request went out: Codex may finish a goal turn before its
    /// `thread/goal/set` answer is read. Returns whether it stored.
    pub fn store_goal_answer(&mut self, native: &str, codex_goal: &Value, version: u64) -> bool {
        let current = self
            .goals
            .notified_at
            .get(native)
            .is_none_or(|&at| at <= version);
        if current {
            self.store_goal(native, codex_goal);
        }
        current
    }

    /// Stores the goal and shows it on the provider thread.
    pub fn set_goal(&mut self, native: &str, codex_goal: &Value) -> Vec<Out> {
        self.store_goal(native, codex_goal);
        let mut out = Vec::new();
        self.emit_goal_update(native, &mut out);
        out
    }

    /// `thread/goal/updated` and `thread/goal/cleared`: a goal that no longer drives the
    /// thread ends a held run.
    pub(super) fn goal_notification(&mut self, method: &str, p: &Value, out: &mut Vec<Out>) {
        let Some(native) = p["threadId"].as_str().map(str::to_owned) else {
            return;
        };
        let goal = if method == "thread/goal/cleared" {
            &Value::Null
        } else {
            &p["goal"]
        };
        self.goals.notified += 1;
        self.goals
            .notified_at
            .insert(native.clone(), self.goals.notified);
        self.store_goal(&native, goal);
        self.emit_goal_update(&native, out);
        if self.goals.status(&native) != Some("active") {
            out.extend(self.release_goal_hold(&native, None));
        }
    }

    /// `rememberRootProviderThread`: the thread a root turn runs on, whose row carries the goal.
    pub fn remember_root_thread(
        &mut self,
        native: &str,
        provider_thread: Value,
        show: bool,
    ) -> Vec<Out> {
        let mut out = Vec::new();
        self.goals
            .threads
            .insert(native.to_owned(), provider_thread);
        if show {
            self.emit_goal_update(native, &mut out);
        }
        out
    }

    pub fn hold_goal_updates(&mut self, native: &str) {
        self.goals.updates_held.insert(native.to_owned());
    }

    /// Shows the held goal row; a goal that stopped driving the thread meanwhile then ends
    /// its held run, so the row comes first.
    pub fn release_goal_updates(&mut self, native: &str) -> Vec<Out> {
        let mut out = Vec::new();
        if self.goals.updates_held.remove(native) {
            self.emit_goal_update(native, &mut out);
            if self.goals.status(native) != Some("active") {
                out.extend(self.release_goal_hold(native, None));
            }
        }
        out
    }

    /// `emitGoalUpdate`: a `provider_thread.updated` when the goal differs from the one shown.
    fn emit_goal_update(&mut self, native: &str, out: &mut Vec<Out>) {
        if self.goals.updates_held.contains(native) {
            return;
        }
        let Some(goal) = self.goals.goals.get(native).cloned() else {
            return;
        };
        let now = self.env.now();
        let Some(thread) = self.goals.threads.get_mut(native) else {
            return;
        };
        if thread.get("goal").unwrap_or(&Value::Null) == &goal {
            return;
        }
        thread["goal"] = goal;
        thread["updatedAt"] = json!(now);
        push_event(
            out,
            json!({"type": "provider_thread.updated", "providerThread": thread.clone()}),
        );
    }

    /// `activateGoal` started: a turn that completes before the goal is active still holds.
    pub fn begin_goal_activation(&mut self, native: &str) {
        self.goals.activations.insert(native.to_owned(), false);
    }

    pub fn goal_activation_stopped(&self, native: &str) -> bool {
        self.goals.activations.get(native).copied().unwrap_or(true)
    }

    /// `activateGoal` ended: a goal that did not become active ends a held run.
    pub fn end_goal_activation(&mut self, native: &str) -> Vec<Out> {
        self.goals.activations.remove(native);
        if self.goals.status(native) == Some("active") {
            return Vec::new();
        }
        self.release_goal_hold(native, None)
    }

    /// Whether a completed root turn on this thread holds its run for Codex's next goal turn.
    pub(super) fn goal_drives(&self, native: &str) -> bool {
        self.goals.status(native) == Some("active")
            || self.goals.activations.get(native) == Some(&false)
    }

    /// Holds the run of a completed goal turn; the session starts the grace timer.
    pub(super) fn hold_goal(
        &mut self,
        turn: &Turn,
        completed: Value,
        terminal: Value,
        out: &mut Vec<Out>,
    ) {
        let (Some(run_id), Some(attempt_id)) = (turn.run_id.clone(), turn.attempt_id.clone())
        else {
            push_event(out, completed);
            push_event(out, terminal);
            return;
        };
        self.goals.seq = self.goals.seq.wrapping_add(1);
        let seq = self.goals.seq;
        let next = PendingTurn {
            thread_id: turn.thread_id.clone(),
            run_id,
            run_ordinal: turn.run_ordinal,
            turn_ordinal: turn.turn_ordinal + 1,
            attempt_id,
            app_thread: turn.app_thread.clone(),
            model_selection: turn.model_selection.clone(),
            root_node_id: turn.root_node_id.clone(),
            provider_thread_id: turn.provider_thread_id.clone(),
            provider_session_id: turn.provider_session_id.clone(),
            runtime_mode: turn.runtime_mode.clone(),
        };
        self.goals.holds.insert(
            turn.native_thread_id.clone(),
            GoalHold {
                seq,
                provider_turn_id: turn.provider_turn_id.clone(),
                continues: turn.continues.clone(),
                completed,
                terminal,
                next,
            },
        );
        out.push(Out::GoalHeld {
            thread: turn.native_thread_id.clone(),
            seq,
        });
    }

    /// A `turn/started` no start asked for: Codex continued a held goal run, or started a
    /// goal turn with no run, which is stopped. Returns whether the turn was handled.
    pub(super) fn goal_turn_started(
        &mut self,
        native_thread: &str,
        native_turn: &str,
        started_at: String,
        out: &mut Vec<Out>,
    ) -> bool {
        if let Some(hold) = self.goals.holds.remove(native_thread) {
            push_event(out, hold.completed);
            self.register(native_thread, native_turn, hold.next, started_at, out);
            if let Some(turn) = self.turns.get_mut(native_turn) {
                turn.continues = hold.continues;
                turn.continues.push(hold.provider_turn_id);
            }
            return true;
        }
        let orphan = self.goals.threads.contains_key(native_thread)
            && (self.goals.status(native_thread) == Some("active")
                || self.goals.stops.contains_key(native_thread));
        if orphan {
            out.push(Out::StopOrphanGoalTurn {
                thread: native_thread.to_owned(),
                turn: native_turn.to_owned(),
            });
        }
        orphan
    }

    /// The grace after a goal turn ran out. With the goal still active, the hold is claimed
    /// (`claimGoalHold`) and the session pauses the goal ([`Out::PauseGoal`]); otherwise the
    /// run settles (`releaseGoalHold`).
    pub fn goal_grace_ended(&mut self, native: &str, seq: u64) -> Vec<Out> {
        let matches = self.goals.holds.get(native).is_some_and(|h| h.seq == seq);
        // The goal row is held: the run cannot settle before it shows, so the grace restarts.
        if matches && self.goals.updates_held.contains(native) {
            return vec![Out::GoalHeld {
                thread: native.to_owned(),
                seq,
            }];
        }
        if !matches
            || self.goals.stops.contains_key(native)
            || self.goals.status(native) != Some("active")
        {
            return self.release_goal_hold(native, Some(seq));
        }
        let Some(hold) = self.goals.holds.remove(native) else {
            return Vec::new();
        };
        self.goal_stop_begin(native);
        let version = self.goals.notified;
        self.goals
            .claimed
            .insert(native.to_owned(), (hold, version));
        vec![Out::PauseGoal {
            thread: native.to_owned(),
        }]
    }

    /// `pauseClaimedGoal`: the pause answered, or gave up; the claimed run settles either way.
    pub fn goal_paused(&mut self, native: &str, response: Option<&Value>) -> Vec<Out> {
        let mut out = Vec::new();
        let claimed = self.goals.claimed.remove(native);
        if let (Some(response), Some((_, version))) = (response, &claimed)
            && self.store_goal_answer(native, &response["goal"], *version)
        {
            self.emit_goal_update(native, &mut out);
        }
        if let Some((hold, _)) = claimed {
            out.extend(self.settle_goal_hold(hold, "completed"));
        }
        self.goal_stop_end(native);
        out
    }

    /// `releaseGoalHold`: ends a held run as completed, unless a Stop or pause is settling it.
    pub fn release_goal_hold(&mut self, native: &str, seq: Option<u64>) -> Vec<Out> {
        let matches = self
            .goals
            .holds
            .get(native)
            .is_some_and(|h| seq.is_none_or(|s| s == h.seq));
        if !matches
            || self.goals.stops.contains_key(native)
            || self.goals.updates_held.contains(native)
        {
            return Vec::new();
        }
        match self.goals.holds.remove(native) {
            Some(hold) => self.settle_goal_hold(hold, "completed"),
            None => Vec::new(),
        }
    }

    /// `settleGoalHold`: the held turn's completed row, then the run's terminal.
    fn settle_goal_hold(&mut self, hold: GoalHold, status: &str) -> Vec<Out> {
        let mut out = Vec::new();
        push_event(&mut out, hold.completed);
        let mut terminal = hold.terminal;
        terminal["status"] = json!(status);
        push_event(&mut out, terminal);
        out
    }

    /// A Stop or an expiry pause started: it settles a held run, and no release does.
    pub fn goal_stop_begin(&mut self, native: &str) {
        *self.goals.stops.entry(native.to_owned()).or_default() += 1;
        if let Some(stopped) = self.goals.activations.get_mut(native) {
            *stopped = true;
        }
    }

    pub fn goal_stop_end(&mut self, native: &str) {
        if let Some(stops) = self.goals.stops.get_mut(native) {
            *stops = stops.saturating_sub(1);
            if *stops == 0 {
                self.goals.stops.remove(native);
            }
        }
    }

    /// The lineage roots a Stop of `provider_turn_id` has now (`turnsBefore`): the running turn
    /// that answers for it with the turns it continued, and the turns of a held goal run.
    pub fn stop_roots(&self, native: &str, provider_turn_id: &str) -> Vec<String> {
        let mut roots = self
            .native_turn(provider_turn_id)
            .map(|turn| self.lineage_roots(&turn))
            .unwrap_or_default();
        if let Some(hold) = self.goals.holds.get(native).filter(|h| {
            h.provider_turn_id == provider_turn_id
                || h.continues.iter().any(|c| c == provider_turn_id)
        }) {
            roots.extend(hold.continues.iter().cloned());
            roots.push(hold.provider_turn_id.clone());
        }
        roots
    }

    /// Stop named a held run's turn: it ends interrupted, with no `turn/interrupt`. Returns
    /// its events and the run's provider turns, whose work the Stop also ends.
    pub fn stop_held_goal(
        &mut self,
        native: &str,
        provider_turn_id: &str,
    ) -> Option<(Vec<Out>, Vec<String>)> {
        let held = self.goals.holds.get(native).is_some_and(|h| {
            h.provider_turn_id == provider_turn_id
                || h.continues.iter().any(|c| c == provider_turn_id)
        });
        if !held {
            return None;
        }
        let hold = self.goals.holds.remove(native)?;
        let mut roots = hold.continues.clone();
        roots.push(hold.provider_turn_id.clone());
        Some((self.settle_goal_hold(hold, "interrupted"), roots))
    }

    /// The app-server is gone: a held run's turn did complete.
    pub(super) fn settle_goal_holds(&mut self, out: &mut Vec<Out>) {
        let holds: Vec<GoalHold> = self
            .goals
            .holds
            .drain()
            .chain(self.goals.claimed.drain().map(|(n, (h, _))| (n, h)))
            .map(|(_, h)| h)
            .collect();
        for hold in holds {
            out.extend(self.settle_goal_hold(hold, "completed"));
        }
        self.goals.activations.clear();
        self.goals.stops.clear();
    }

    /// `completeGoalCommandTurn`: a `/goal` that reaches no model turn settles its run, with
    /// its reply as the agent's message. A state change replies through the goal row.
    pub fn goal_command_turn(
        &mut self,
        native: &str,
        input: &TurnInput,
        reply: Option<&str>,
    ) -> Vec<Out> {
        let mut out = Vec::new();
        let now = self.env.now();
        let native_turn = format!("goal-command:{}", input.attempt_id.as_str());
        self.begin_turn(native, input);
        let Some(pending) = self.pending_turns.remove(native) else {
            return out;
        };
        let mut turn = self.turn_from(native, &native_turn, pending, now.clone());
        let mut row = provider_turn_json(&turn, "running", None);
        row["nativeTurnRef"] = Value::Null;
        push_event(
            &mut out,
            json!({"type": "provider_turn.updated", "threadId": turn.thread_id, "providerTurn": row.clone()}),
        );
        out.extend(self.remember_root_thread(
            native,
            conn_contract::to_json(&input.provider_thread),
            true,
        ));
        if let Some(reply) = reply {
            let (node, message, item) =
                agent_artifacts(&mut self.env, &mut turn, &native_turn, reply, true);
            push_event(&mut out, json!({"type": "node.updated", "node": node}));
            push_event(
                &mut out,
                json!({"type": "message.updated", "message": message}),
            );
            push_event(
                &mut out,
                json!({"type": "turn_item.updated", "turnItem": item}),
            );
        }
        row["status"] = json!("completed");
        row["completedAt"] = json!(now);
        push_event(
            &mut out,
            json!({"type": "provider_turn.updated", "threadId": turn.thread_id, "providerTurn": row}),
        );
        push_event(
            &mut out,
            json!({
                "type": "turn.terminal",
                "providerThreadId": turn.provider_thread_id,
                "providerTurnId": ids::provider_turn_id(DRIVER, &native_turn),
                "runOrdinal": turn.run_ordinal,
                "status": "completed",
                "failure": null,
                "threadDisposition": "reusable",
            }),
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_goals_become_provider_goal_rows() {
        let goal = json!({"objective": " Ship ", "status": "usageLimited", "tokensUsed": -3,
            "tokenBudget": null, "timeUsedSeconds": 4});
        assert_eq!(
            provider_goal(&goal),
            json!({"objective": "Ship", "status": "usage_limited", "tokensUsed": 0,
                "tokenBudget": null, "timeUsedSeconds": 4})
        );
        assert_eq!(
            provider_goal(&json!({"objective": " ", "status": "active"})),
            Value::Null
        );
        assert_eq!(provider_goal(&Value::Null), Value::Null);
        assert_eq!(describe(&provider_goal(&goal)), "Goal usage limited: Ship");
    }
}
