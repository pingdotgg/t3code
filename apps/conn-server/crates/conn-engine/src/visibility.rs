//! Which turn items a thread shows: `createOrchestrationV2TurnItemVisibility` in T3's
//! `packages/shared/src/orchestrationV2Timeline.ts`. `visibleTurnItems` holds these.
//!
//! - Items of a `rolled_back` run are hidden.
//! - A queued user message (`inputIntent: queued_turn`) is hidden while its run is `queued`
//!   or after it was `cancelled`; the queue panel shows it.
//! - A `run_interrupt_result` from a superseded attempt is hidden unless its run also has a
//!   `run_interrupt_request` (the user's Stop).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

/// The positions in `items` that are visible, in order.
pub(crate) fn visible_items(runs: &[Value], attempts: &[Value], items: &[Value]) -> Vec<usize> {
    let mut rule = Visibility::new(runs, attempts);
    if rule.needs_interrupts() {
        rule.set_interrupted(
            items
                .iter()
                .filter(|item| item["type"] == "run_interrupt_request")
                .filter_map(|item| item["runId"].as_str())
                .map(str::to_owned)
                .collect(),
        );
    }
    items
        .iter()
        .enumerate()
        .filter(|(_, item)| rule.shows(item))
        .map(|(at, _)| at)
        .collect()
}

/// The visibility rule of one thread, so a reader can test turn items one at a time.
pub(crate) struct Visibility {
    /// Runs whose status hides items: `rolled_back`, `cancelled`, `queued`.
    statuses: HashMap<String, String>,
    /// `(runId, rootNodeId)` of superseded attempts.
    superseded: HashSet<(String, String)>,
    /// Runs with a `run_interrupt_request` item (the user's Stop).
    interrupted: HashSet<String>,
}

impl Visibility {
    pub(crate) fn new(runs: &[Value], attempts: &[Value]) -> Self {
        // The last row for a run id wins, as T3 builds its map.
        let mut statuses = HashMap::new();
        for run in runs {
            let (Some(id), Some(status)) = (run["id"].as_str(), run["status"].as_str()) else {
                continue;
            };
            if matches!(status, "rolled_back" | "cancelled" | "queued") {
                statuses.insert(id.to_owned(), status.to_owned());
            } else {
                statuses.remove(id);
            }
        }
        let mut superseded = HashSet::new();
        for attempt in attempts {
            if attempt["status"] != "superseded" {
                continue;
            }
            if let (Some(run), Some(root)) =
                (attempt["runId"].as_str(), attempt["rootNodeId"].as_str())
            {
                superseded.insert((run.to_owned(), root.to_owned()));
            }
        }
        Self {
            statuses,
            superseded,
            interrupted: HashSet::new(),
        }
    }

    /// Whether [`Visibility::shows`] needs the runs with a Stop request.
    pub(crate) fn needs_interrupts(&self) -> bool {
        !self.superseded.is_empty()
    }

    pub(crate) fn set_interrupted(&mut self, runs: HashSet<String>) {
        self.interrupted = runs;
    }

    pub(crate) fn shows(&self, item: &Value) -> bool {
        let run = item["runId"].as_str();
        let status = run
            .and_then(|run| self.statuses.get(run))
            .map(String::as_str);
        if status == Some("rolled_back") {
            return false;
        }
        if matches!(status, Some("queued" | "cancelled"))
            && item["type"] == "user_message"
            && item["inputIntent"] == "queued_turn"
        {
            return false;
        }
        let (Some(run), Some(node)) = (run, item["nodeId"].as_str()) else {
            return true;
        };
        !(item["type"] == "run_interrupt_result"
            && self.superseded.contains(&(run.to_owned(), node.to_owned()))
            && !self.interrupted.contains(run))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::visible_items;

    const RUN: &str = "run:timeline-visibility";
    const NODE: &str = "node:timeline-visibility";

    fn shown(runs: Value, attempts: Value, items: &Value) -> Vec<usize> {
        visible_items(
            runs.as_array().unwrap(),
            attempts.as_array().unwrap(),
            items.as_array().unwrap(),
        )
    }

    use serde_json::Value;

    // The cases of T3's `orchestrationV2Timeline.test.ts`.
    #[test]
    fn hides_unpaired_interruption_results_from_superseded_attempts() {
        let items = json!([{"type": "run_interrupt_result", "runId": RUN, "nodeId": NODE}]);
        let attempts = json!([{"runId": RUN, "rootNodeId": NODE, "status": "superseded"}]);
        let runs = json!([{"id": RUN, "status": "running"}]);
        assert!(shown(runs, attempts, &items).is_empty());
    }

    #[test]
    fn keeps_paired_superseded_results_unless_the_run_is_rolled_back() {
        for (status, visible) in [
            ("running", true),
            ("cancelled", true),
            ("rolled_back", false),
        ] {
            let items = json!([
                {"type": "run_interrupt_request", "runId": RUN, "nodeId": NODE},
                {"type": "run_interrupt_result", "runId": RUN, "nodeId": NODE},
            ]);
            let attempts = json!([{"runId": RUN, "rootNodeId": NODE, "status": "superseded"}]);
            let runs = json!([{"id": RUN, "status": status}]);
            assert_eq!(
                shown(runs, attempts, &items).contains(&1),
                visible,
                "{status}"
            );
        }
    }

    #[test]
    fn hides_queued_user_messages_of_queued_or_cancelled_runs_only() {
        let items = json!([
            {"type": "user_message", "inputIntent": "queued_turn", "runId": RUN, "nodeId": NODE},
            {"type": "assistant_message", "runId": RUN, "nodeId": NODE},
        ]);
        for (status, queued, ordinary) in [
            ("queued", false, true),
            ("cancelled", false, true),
            ("rolled_back", false, false),
            ("completed", true, true),
            ("running", true, true),
        ] {
            let got = shown(json!([{"id": RUN, "status": status}]), json!([]), &items);
            assert_eq!(got.contains(&0), queued, "{status}");
            assert_eq!(got.contains(&1), ordinary, "{status}");
        }
    }

    #[test]
    fn the_last_status_of_a_run_wins() {
        let items = json!([{"type": "assistant_message", "runId": RUN, "nodeId": NODE}]);
        let runs =
            json!([{"id": RUN, "status": "rolled_back"}, {"id": RUN, "status": "completed"}]);
        assert_eq!(shown(runs, json!([]), &items), vec![0]);
        let runs =
            json!([{"id": RUN, "status": "completed"}, {"id": RUN, "status": "rolled_back"}]);
        assert!(shown(runs, json!([]), &items).is_empty());
    }

    #[test]
    fn items_without_a_run_stay() {
        let items = json!([{"type": "notification", "runId": null, "nodeId": null}]);
        let runs = json!([{"id": RUN, "status": "rolled_back"}]);
        assert_eq!(shown(runs, json!([]), &items), vec![0]);
    }
}
