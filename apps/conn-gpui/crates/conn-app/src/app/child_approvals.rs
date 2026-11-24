//! Approvals of the open thread's children (subagents, side chats, delegated tasks).
//!
//! The shell stream only says that a child waits on an approval (`pendingRuntimeRequest`); the
//! command it asks about lives in the child's own thread stream. As Conn does
//! (`childThreadApprovalsAtom`: "only children asking for approval need a detail subscription"),
//! the app subscribes to a child's thread stream while it asks, reads the approval from that
//! thread's state, and answers on the child thread.

use std::collections::{HashMap, HashSet};

use conn_client::Connection;
use gpui_kit::Context;

use super::ConnApp;
use crate::chat::ChildApprovalCard;

/// What the app keeps between syncs.
#[derive(Default)]
pub(super) struct ChildApprovals {
    /// Child threads subscribed for their approvals, with the connection each runs on.
    subscribed: HashMap<String, ChildSubscription>,
    /// The open thread's subscription at the last sync. Opening another thread ends it.
    last_open: Option<String>,
    /// Why the last answer to a request failed, by request id, until its card goes.
    errors: HashMap<String, String>,
}

struct ChildSubscription {
    connection: Connection,
    ready: bool,
}

/// On a new subscription, the cached detail can still describe a previous approval.
/// Once the detail has the request named by the shell, keep showing the live queue
/// while the two streams deliver later requests at different times.
fn detail_ready(
    ready: &mut bool,
    request_id: &str,
    detail: Option<&conn_state::ThreadState>,
) -> bool {
    *ready =
        *ready || detail.is_some_and(|thread| thread.pending_requests.contains_key(request_id));
    *ready
}

/// The children to subscribe to, and the subscribed ones that no longer ask.
fn plan_subscriptions(wanted: &[&str], subscribed: &[&str]) -> (Vec<String>, Vec<String>) {
    let wanted_set: HashSet<&str> = wanted.iter().copied().collect();
    let subscribed_set: HashSet<&str> = subscribed.iter().copied().collect();
    let add = wanted
        .iter()
        .filter(|id| !subscribed_set.contains(**id))
        .map(|id| (*id).to_owned())
        .collect();
    let stale = subscribed
        .iter()
        .filter(|id| !wanted_set.contains(**id))
        .map(|id| (*id).to_owned())
        .collect();
    (add, stale)
}

impl ConnApp {
    /// Keeps the child subscriptions in step with the shell and returns the cards of the open
    /// thread's pending child approvals. Runs on every event batch.
    pub(super) fn sync_child_approvals(&mut self) -> Vec<ChildApprovalCard> {
        // Opening another thread ended the previous one's stream, a child's included.
        if self.child_approvals.last_open != self.subscribed_thread_id {
            if let Some(previous) = self.child_approvals.last_open.take() {
                self.child_approvals.subscribed.remove(&previous);
            }
            self.child_approvals.last_open = self.subscribed_thread_id.clone();
        }
        let mut children = match self.layout.selected_thread_id.as_deref() {
            Some(thread_id) if self.draft.is_none() => self.shell.child_approval_threads(thread_id),
            _ => Vec::new(),
        };
        let wanted: Vec<&str> = children.iter().map(|child| child.id.as_str()).collect();
        let current: Vec<&str> = self
            .child_approvals
            .subscribed
            .keys()
            .map(String::as_str)
            .collect();
        let (add, stale) = plan_subscriptions(&wanted, &current);
        for id in stale {
            let subscription = self.child_approvals.subscribed.remove(&id);
            // The open thread keeps its own stream.
            if let Some(subscription) = subscription
                && self.subscribed_thread_id.as_deref() != Some(id.as_str())
                && !self.offline.watching(self.cache_env(&id), &id)
            {
                subscription.connection.unsubscribe_thread(&id);
            }
        }
        for id in add {
            let Some(connection) = self.connection_for_thread(&id) else {
                continue;
            };
            self.threads
                .entry(id.clone())
                .or_insert_with(|| conn_state::ThreadState::new(id.clone()));
            connection.subscribe_thread(&id);
            self.child_approvals.subscribed.insert(
                id,
                ChildSubscription {
                    connection,
                    ready: false,
                },
            );
        }

        children.retain(|child| {
            let Some(subscription) = self.child_approvals.subscribed.get_mut(&child.id) else {
                return false;
            };
            detail_ready(
                &mut subscription.ready,
                &child.request_id,
                self.threads.get(&child.id),
            )
        });
        let approvals = conn_state::child_approvals(&children, &self.threads);
        self.child_approvals
            .errors
            .retain(|request_id, _| approvals.iter().any(|a| &a.request_id == request_id));
        approvals
            .iter()
            .map(|approval| {
                ChildApprovalCard::new(
                    approval,
                    self.responding_approvals.contains(&approval.request_id),
                    self.child_approvals
                        .errors
                        .get(&approval.request_id)
                        .cloned(),
                )
            })
            .collect()
    }

    /// Forgets the subscriptions of a connection that is gone.
    pub(super) fn reset_child_approvals(&mut self) {
        self.child_approvals = ChildApprovals::default();
    }

    /// Answers `request_id` on the child thread `thread_id`: the same `runtime-request.respond`
    /// the thread's own approvals use (`threadEnvironment.respondToApproval`).
    pub(crate) fn respond_child_approval(
        &mut self,
        thread_id: &str,
        request_id: &str,
        decision: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection_for_thread(thread_id) else {
            return;
        };
        let command = match crate::commands::respond_approval(thread_id, request_id, decision) {
            Ok(command) => command,
            Err(e) => {
                eprintln!("child approval: could not build runtime-request.respond: {e}");
                return;
            }
        };
        if !self.responding_approvals.insert(request_id.to_owned()) {
            return;
        }
        self.child_approvals.errors.remove(request_id);
        self.sync_chat(cx);
        cx.notify();
        let request_id = request_id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = connection.dispatch_command(command).await;
            let _ = this.update(cx, |app, cx| {
                app.responding_approvals.remove(&request_id);
                if let Err(err) = result {
                    app.child_approvals
                        .errors
                        .insert(request_id, crate::commands::format_client_error(&err));
                }
                app.sync_chat(cx);
                cx.notify();
            });
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resubscribed_child_waits_for_its_new_request_before_showing_cached_cards() {
        let mut detail = conn_state::ThreadState::default();
        detail
            .pending_requests
            .insert("first".into(), Default::default());
        let mut ready = false;
        assert!(detail_ready(&mut ready, "first", Some(&detail)));

        // A new subscription starts while the thread cache still holds the previous command.
        let mut ready = false;
        assert!(!detail_ready(&mut ready, "second", Some(&detail)));
        detail.pending_requests.remove("first");
        assert!(!detail_ready(&mut ready, "second", Some(&detail)));
        detail
            .pending_requests
            .insert("second".into(), Default::default());
        assert!(detail_ready(&mut ready, "second", Some(&detail)));

        // A third request joins an active subscription. The second card stays in place.
        assert!(detail_ready(&mut ready, "third", Some(&detail)));
    }

    #[test]
    fn subscribes_new_children_and_drops_the_ones_that_stopped_asking() {
        let (add, stale) = plan_subscriptions(&["a", "b"], &[]);
        assert_eq!(add, ["a", "b"]);
        assert!(stale.is_empty());

        let (add, stale) = plan_subscriptions(&["b", "c"], &["a", "b"]);
        assert_eq!(add, ["c"]);
        assert_eq!(stale, ["a"]);

        let (add, stale) = plan_subscriptions(&[], &["a"]);
        assert!(add.is_empty());
        assert_eq!(stale, ["a"]);
    }
}
