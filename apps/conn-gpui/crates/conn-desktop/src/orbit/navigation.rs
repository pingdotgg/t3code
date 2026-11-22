//! Opening an agent's Conn conversation from Tasks.
//!
//! Port of `apps/web/src/orbit/tasks/taskNavigation.logic.ts`. The async orchestration
//! (`openOrbitAgentConversation`) belongs to the app; here are its pure parts: where a click
//! starts, the guard that drops stale clicks, and the environment preparation decision.

use conn_orbit::tasks::{ConversationRef, OrbitEnvironment, PowerState};

/// Where a Tasks click starts: the board, a task, or one of its subtasks, of one thread.
pub fn tasks_navigation_place(
    thread_key: &str,
    shown: Option<(Option<i64>, Option<i64>)>,
) -> String {
    match shown {
        Some((Some(task_id), subtask_id)) => match subtask_id {
            Some(subtask_id) => format!("{thread_key}|{task_id}|{subtask_id}"),
            None => format!("{thread_key}|{task_id}|task"),
        },
        _ => format!("{thread_key}|board"),
    }
}

/// Click work in Tasks belongs to the place it started (one task, or the board, of one thread).
/// Leaving that place, or starting newer work, makes the pending work stale.
#[derive(Debug, Clone, Default)]
pub struct TasksNavigationGuard {
    place: Option<String>,
    latest: u64,
}

/// A started piece of click work; check it with [`TasksNavigationGuard::is_current`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NavigationTicket(u64);

impl TasksNavigationGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn enter(&mut self, next: &str) {
        if self.place.as_deref() == Some(next) {
            return;
        }
        self.place = Some(next.to_owned());
        self.latest += 1;
    }

    pub fn leave(&mut self) {
        self.place = None;
        self.latest += 1;
    }

    /// Starts work; the ticket stays current until something newer happens.
    pub fn begin(&mut self) -> NavigationTicket {
        self.latest += 1;
        NavigationTicket(self.latest)
    }

    pub fn is_current(&self, ticket: NavigationTicket) -> bool {
        ticket.0 == self.latest
    }
}

/// What to do before navigating to an agent's environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareStep {
    /// The environment is known: enable it and go.
    Enable,
    /// Pair with this environment first, then enable it. If pairing fails, show
    /// [`PrepareError::PairingFailed`].
    Connect(OrbitEnvironment),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PrepareError {
    #[error("This workspace is asleep. Wake it in Connections, then try again.")]
    Asleep,
    #[error("This environment is not paired or is no longer available in Orbit.")]
    Unavailable,
    #[error("Could not pair with this environment. Open Connections to reconnect it.")]
    PairingFailed,
}

/// Port of `prepareOrbitConversationEnvironment`: pairs only a requested, authorized
/// environment, and refuses stopped or missing destinations. `environments` is `None` when the
/// Orbit list is not available.
pub fn prepare_conversation_environment(
    environment_id: &str,
    known: bool,
    environments: Option<&[OrbitEnvironment]>,
) -> Result<PrepareStep, PrepareError> {
    let environment = environments.and_then(|list| {
        list.iter()
            .find(|entry| entry.environment_id == environment_id)
    });
    if environment.is_some_and(|e| e.power_state == Some(PowerState::Stopped)) {
        return Err(PrepareError::Asleep);
    }
    if known {
        return Ok(PrepareStep::Enable);
    }
    environment
        .cloned()
        .map(PrepareStep::Connect)
        .ok_or(PrepareError::Unavailable)
}

/// Whether opening `target` from `source` hands the Tasks place over to another thread.
pub fn needs_handoff(source: &ConversationRef, target: &ConversationRef) -> bool {
    source != target
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_orbit::tasks::EnvironmentStatus;

    #[test]
    fn drops_pending_clicks_once_the_user_leaves() {
        let mut guard = TasksNavigationGuard::new();
        guard.enter("thread|482");
        let still_here = guard.begin();
        guard.leave();
        guard.enter("thread|board");
        guard.enter("thread|470");
        assert!(!guard.is_current(still_here));

        let subtask = tasks_navigation_place("thread", Some((Some(482), Some(484))));
        let task = tasks_navigation_place("thread", Some((Some(482), None)));
        assert_ne!(subtask, task);
        assert_eq!(tasks_navigation_place("thread", None), "thread|board");
        assert_eq!(
            tasks_navigation_place("thread", Some((None, None))),
            "thread|board"
        );
        guard.enter(&subtask);
        let from_subtask = guard.begin();
        guard.enter(&task);
        assert!(!guard.is_current(from_subtask));

        guard.enter("thread|470");
        let current = guard.begin();
        guard.enter("thread|470");
        assert!(guard.is_current(current));
        guard.begin();
        assert!(!guard.is_current(current));
    }

    fn environment(power_state: PowerState) -> OrbitEnvironment {
        OrbitEnvironment {
            environment_id: "remote".to_owned(),
            label: "remote".to_owned(),
            url: "https://remote".to_owned(),
            server_version: None,
            registered_by: None,
            registered_at: None,
            status: EnvironmentStatus::Registered,
            instance_id: None,
            power_state: Some(power_state),
            project_id: None,
            project_name: None,
            project_slug: None,
            instance_name: None,
            node_name: None,
            instance_url: None,
        }
    }

    #[test]
    fn pairs_only_a_requested_environment_and_refuses_stopped_or_missing_ones() {
        let running = [environment(PowerState::Running)];
        assert_eq!(
            prepare_conversation_environment("remote", false, Some(&running)),
            Ok(PrepareStep::Connect(running[0].clone()))
        );
        assert_eq!(
            prepare_conversation_environment("remote", true, Some(&running)),
            Ok(PrepareStep::Enable)
        );
        let stopped = [environment(PowerState::Stopped)];
        let asleep = prepare_conversation_environment("remote", true, Some(&stopped));
        assert_eq!(asleep, Err(PrepareError::Asleep));
        assert!(
            asleep
                .err()
                .map(|e| e.to_string())
                .is_some_and(|m| m.contains("asleep"))
        );
        let missing = prepare_conversation_environment("remote", false, Some(&[]));
        assert!(
            missing
                .err()
                .map(|e| e.to_string())
                .is_some_and(|m| m.contains("no longer available"))
        );
        assert!(
            PrepareError::PairingFailed
                .to_string()
                .contains("Could not pair")
        );
        assert_eq!(
            prepare_conversation_environment("origin", true, None),
            Ok(PrepareStep::Enable)
        );
        let a = ConversationRef {
            environment_id: "e".to_owned(),
            thread_id: "t".to_owned(),
        };
        assert!(!needs_handoff(&a, &a.clone()));
    }
}
