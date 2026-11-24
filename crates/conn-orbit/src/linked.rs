//! Which Orbit environments a client connects to beside its primary one.
//!
//! Conn's environment provider (`planEnvironmentProvider`, `orbitGateway/environmentProvider.ts`)
//! keeps one connection per registered Orbit server: a Node is paired automatically, an Instance's
//! server only after the user connected it once, and an asleep Instance's server cannot mint a
//! pairing link. [`plan_linked_environments`] applies the same rules to a fleet listing and the
//! sessions a device already holds. Pure data in and out; the caller mints pairings
//! ([`OrbitFleetClient::mint_pairing`](crate::fleet::OrbitFleetClient::mint_pairing)) and opens
//! the connections.

use std::collections::{HashMap, HashSet};

use crate::fleet::{OrbitServerTarget, OrbitTargetStatus};
use crate::tasks::PowerState;

/// How long to wait before pairing a server again after an attempt that did not save it. Each
/// attempt mints a link on the server, so a failure must not repeat on every list
/// (`PAIRING_RETRY_MS`).
pub const LINKED_PAIRING_RETRY_MS: i64 = 5 * 60 * 1000;

/// What a client knows when it plans.
#[derive(Debug, Clone, Copy)]
pub struct LinkedPlanInput<'a> {
    /// The Gateway's registered servers.
    pub targets: &'a [OrbitServerTarget],
    /// The environment the client already uses as its primary one; never linked.
    pub primary_id: Option<&'a str>,
    /// Servers this device holds a session (a bearer token) for.
    pub saved: &'a HashSet<String>,
    /// Servers the client has connections to now.
    pub held: &'a HashSet<String>,
    /// When the client last tried to pair each unsaved server, in epoch milliseconds.
    pub pair_attempted_at_ms: &'a HashMap<String, i64>,
    /// Instance servers the user chose to link before this device has a session for them
    /// (Conn: "the user connected it"). Paired once they run.
    pub instance_opt_in: &'a HashSet<String>,
    /// Servers the user switched off (Conn's per-environment switch): never connected.
    pub disabled: &'a HashSet<String>,
    pub now_ms: i64,
}

/// The changes that bring the client's connections in line with the fleet.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkedPlan {
    /// Saved servers to connect to with their stored bearer token.
    pub connect: Vec<String>,
    /// Servers to pair with first (mint a pairing link, then connect). Record each attempt.
    pub pair: Vec<String>,
    /// Held servers the fleet no longer wants: gone, expired, cleaned up, asleep or now the primary.
    pub disconnect: Vec<String>,
}

/// How long an Instance's server must stay out of the Gateway's lists before the device forgets
/// it (`GONE_CONFIRM_MS`): a profile edit runs a second sync within seconds, so one list is no
/// proof.
pub const LINKED_GONE_CONFIRM_MS: i64 = 2 * 60 * 1000;

/// The result of [`confirm_gone_environments`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GoneVerdict {
    /// Known servers the Gateway left out for [`LINKED_GONE_CONFIRM_MS`]: forget them.
    pub gone: Vec<String>,
    /// When each known server was first missing from a list, to pass to the next call.
    pub missing_since_ms: HashMap<String, i64>,
}

/// Which known (saved or cached) servers are gone from the fleet. An empty list is never taken
/// as the truth, since a Gateway can briefly list nothing: it forgets nothing and changes no mark.
#[must_use]
pub fn confirm_gone_environments(
    known: &[String],
    targets: &[OrbitServerTarget],
    missing_since_ms: &HashMap<String, i64>,
    now_ms: i64,
) -> GoneVerdict {
    if targets.is_empty() {
        return GoneVerdict {
            gone: Vec::new(),
            missing_since_ms: missing_since_ms.clone(),
        };
    }
    let listed: HashSet<&str> = targets.iter().map(|t| t.server_id.as_str()).collect();
    let mut verdict = GoneVerdict::default();
    for id in known {
        if listed.contains(id.as_str()) {
            continue;
        }
        let since = missing_since_ms.get(id).copied().unwrap_or(now_ms);
        if now_ms - since >= LINKED_GONE_CONFIRM_MS {
            verdict.gone.push(id.clone());
        } else {
            verdict.missing_since_ms.insert(id.clone(), since);
        }
    }
    verdict
}

/// Whether a server is one Conn shows beside the primary environment, as far as the fleet says.
fn is_candidate(target: &OrbitServerTarget, primary_id: Option<&str>) -> bool {
    Some(target.server_id.as_str()) != primary_id
        && !target.cleanup_pending
        // An asleep Instance's server cannot answer, saved or not.
        && target.power_state() != Some(PowerState::Stopped)
}

/// Plans the linked environments: see the module docs for the rules.
#[must_use]
pub fn plan_linked_environments(input: &LinkedPlanInput<'_>) -> LinkedPlan {
    let mut plan = LinkedPlan::default();
    let mut wanted: HashSet<&str> = HashSet::new();
    for target in input.targets {
        if !is_candidate(target, input.primary_id) || input.disabled.contains(&target.server_id) {
            continue;
        }
        let id = target.server_id.as_str();
        if input.saved.contains(id) {
            wanted.insert(id);
            if !input.held.contains(id) {
                plan.connect.push(id.to_owned());
            }
            continue;
        }
        // An unsaved Instance's server is the user's to connect; a Node's is paired for them.
        if target.status != OrbitTargetStatus::Registered
            || (target.is_instance() && !input.instance_opt_in.contains(id))
        {
            continue;
        }
        wanted.insert(id);
        if input.held.contains(id) {
            continue;
        }
        let waiting = input
            .pair_attempted_at_ms
            .get(id)
            .is_some_and(|at| input.now_ms - at < LINKED_PAIRING_RETRY_MS);
        if !waiting {
            plan.pair.push(id.to_owned());
        }
    }
    let mut disconnect: Vec<String> = input
        .held
        .iter()
        .filter(|id| !wanted.contains(id.as_str()))
        .cloned()
        .collect();
    disconnect.sort();
    plan.disconnect = disconnect;
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::OrbitTargetKind;

    fn node(id: &str, label: &str) -> OrbitServerTarget {
        OrbitServerTarget {
            server_id: id.to_owned(),
            label: label.to_owned(),
            url: format!("http://10.44.0.1:3773/{id}"),
            server_version: None,
            registered_by: None,
            status: OrbitTargetStatus::Registered,
            cleanup_pending: false,
            kind: OrbitTargetKind::Node {
                node_name: label.to_owned(),
                roles: vec![],
            },
        }
    }

    fn instance(id: &str, power: PowerState) -> OrbitServerTarget {
        OrbitServerTarget {
            kind: OrbitTargetKind::Instance {
                instance_id: 3,
                instance_name: "task".to_owned(),
                project_id: Some(1),
                project_name: Some("orbit".to_owned()),
                project_slug: None,
                node_name: Some("beast".to_owned()),
                instance_url: None,
                power_state: Some(power),
            },
            ..node(id, "orbit / task")
        }
    }

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    fn plan(
        targets: &[OrbitServerTarget],
        primary: Option<&str>,
        saved: &[&str],
        held: &[&str],
        attempted: &[(&str, i64)],
        now_ms: i64,
    ) -> LinkedPlan {
        let attempts: HashMap<String, i64> = attempted
            .iter()
            .map(|(id, at)| ((*id).to_owned(), *at))
            .collect();
        plan_linked_environments(&LinkedPlanInput {
            targets,
            primary_id: primary,
            saved: &set(saved),
            held: &set(held),
            pair_attempted_at_ms: &attempts,
            instance_opt_in: &HashSet::new(),
            disabled: &HashSet::new(),
            now_ms,
        })
    }

    fn plan_with(
        targets: &[OrbitServerTarget],
        opt_in: &[&str],
        disabled: &[&str],
        saved: &[&str],
        held: &[&str],
    ) -> LinkedPlan {
        plan_linked_environments(&LinkedPlanInput {
            targets,
            primary_id: None,
            saved: &set(saved),
            held: &set(held),
            pair_attempted_at_ms: &HashMap::new(),
            instance_opt_in: &set(opt_in),
            disabled: &set(disabled),
            now_ms: 0,
        })
    }

    #[test]
    fn a_chosen_instance_is_paired_once_it_runs_and_not_while_it_sleeps() {
        let running = [instance("form", PowerState::Running)];
        assert_eq!(plan_with(&running, &["form"], &[], &[], &[]).pair, ["form"]);
        assert!(plan_with(&running, &[], &[], &[], &[]).pair.is_empty());
        let asleep = [instance("form", PowerState::Stopped)];
        assert!(plan_with(&asleep, &["form"], &[], &[], &[]).pair.is_empty());
    }

    #[test]
    fn a_switched_off_server_is_not_connected_and_a_held_connection_to_it_ends() {
        let targets = [node("mini", "mini"), node("vm", "nick-vm")];
        let plan = plan_with(&targets, &[], &["mini"], &["mini"], &["mini"]);
        assert_eq!(plan.disconnect, ["mini"]);
        assert!(plan.connect.is_empty());
        let paired = plan_with(&targets, &[], &["mini"], &[], &[]);
        assert_eq!(paired.pair, ["vm"], "only the one left on is paired");
    }

    #[test]
    fn a_server_the_gateway_leaves_out_is_forgotten_only_after_it_stays_out() {
        let known = vec!["form".to_owned(), "mini".to_owned()];
        let listed = [node("mini", "mini")];
        let first = confirm_gone_environments(&known, &listed, &HashMap::new(), 1_000);
        assert!(first.gone.is_empty());
        assert_eq!(first.missing_since_ms["form"], 1_000);
        let soon =
            confirm_gone_environments(&known, &listed, &first.missing_since_ms, 1_000 + 5_000);
        assert!(soon.gone.is_empty());
        let later = confirm_gone_environments(
            &known,
            &listed,
            &first.missing_since_ms,
            1_000 + LINKED_GONE_CONFIRM_MS,
        );
        assert_eq!(later.gone, ["form"]);
        // It came back: the mark clears.
        let back = confirm_gone_environments(
            &known,
            &[node("mini", "mini"), instance("form", PowerState::Stopped)],
            &first.missing_since_ms,
            1_000 + LINKED_GONE_CONFIRM_MS,
        );
        assert!(back.gone.is_empty() && back.missing_since_ms.is_empty());
        // An empty list is no proof.
        let empty = confirm_gone_environments(&known, &[], &first.missing_since_ms, 10_000_000);
        assert!(empty.gone.is_empty());
        assert_eq!(empty.missing_since_ms, first.missing_since_ms);
    }

    #[test]
    fn unsaved_nodes_are_paired_and_the_primary_is_left_alone() {
        let targets = [
            node("nick", "nick"),
            node("mini", "mini"),
            node("vm", "nick-vm"),
        ];
        let plan = plan(&targets, Some("nick"), &["nick"], &[], &[], 0);
        assert_eq!(plan.pair, ["mini", "vm"]);
        assert!(plan.connect.is_empty());
        assert!(plan.disconnect.is_empty());
    }

    #[test]
    fn a_saved_server_connects_with_its_token_instead_of_pairing_again() {
        let targets = [node("nick", "nick"), node("mini", "mini")];
        let plan = plan(&targets, Some("nick"), &["nick", "mini"], &[], &[], 0);
        assert_eq!(plan.connect, ["mini"]);
        assert!(plan.pair.is_empty());
    }

    #[test]
    fn a_connected_server_needs_nothing() {
        let targets = [node("nick", "nick"), node("mini", "mini")];
        let plan = plan(&targets, Some("nick"), &["mini"], &["mini"], &[], 0);
        assert_eq!(plan, LinkedPlan::default());
    }

    #[test]
    fn an_unsaved_instance_is_never_paired_but_a_saved_running_one_connects() {
        let targets = [
            instance("clone", PowerState::Running),
            instance("mine", PowerState::Running),
        ];
        let plan = plan(&targets, None, &["mine"], &[], &[], 0);
        assert_eq!(plan.connect, ["mine"]);
        assert!(plan.pair.is_empty());
    }

    #[test]
    fn an_asleep_instance_is_not_connected_and_a_held_connection_to_it_ends() {
        let targets = [instance("mine", PowerState::Stopped)];
        let plan = plan(&targets, None, &["mine"], &["mine"], &[], 0);
        assert!(plan.connect.is_empty());
        assert_eq!(plan.disconnect, ["mine"]);
    }

    #[test]
    fn a_failed_pairing_waits_before_it_is_tried_again() {
        let targets = [node("mini", "mini")];
        let early = plan(
            &targets,
            None,
            &[],
            &[],
            &[("mini", 1_000)],
            1_000 + LINKED_PAIRING_RETRY_MS - 1,
        );
        assert!(early.pair.is_empty());
        let later = plan(
            &targets,
            None,
            &[],
            &[],
            &[("mini", 1_000)],
            1_000 + LINKED_PAIRING_RETRY_MS,
        );
        assert_eq!(later.pair, ["mini"]);
    }

    #[test]
    fn a_server_the_fleet_dropped_or_cleaned_up_disconnects() {
        let mut cleaning = node("mini", "mini");
        cleaning.cleanup_pending = true;
        let targets = [cleaning, node("nick", "nick")];
        let plan = plan(
            &targets,
            Some("nick"),
            &["mini", "gone"],
            &["mini", "gone"],
            &[],
            0,
        );
        assert_eq!(plan.disconnect, ["gone", "mini"]);
        assert!(plan.connect.is_empty());
    }

    #[test]
    fn a_server_that_became_the_primary_disconnects_as_a_linked_one() {
        let targets = [node("mini", "mini")];
        let plan = plan(&targets, Some("mini"), &["mini"], &["mini"], &[], 0);
        assert_eq!(plan.disconnect, ["mini"]);
    }

    #[test]
    fn a_node_whose_session_expired_is_not_paired_but_a_saved_one_still_connects() {
        let mut expired = node("mini", "mini");
        expired.status = OrbitTargetStatus::SessionExpired;
        let unsaved = plan(std::slice::from_ref(&expired), None, &[], &[], &[], 0);
        assert!(unsaved.pair.is_empty());
        let saved = plan(std::slice::from_ref(&expired), None, &["mini"], &[], &[], 0);
        assert_eq!(saved.connect, ["mini"]);
    }
}
