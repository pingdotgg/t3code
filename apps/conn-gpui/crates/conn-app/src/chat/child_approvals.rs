//! The data of one approval card in the request stack: an approval of the open thread or of one
//! of its children (subagents, side chats, delegated tasks), as `ChildThreadApprovals.tsx` and
//! `ComposerPendingApprovalActions` show them above the composer. Drawing is in
//! `request_stack.rs`.

use conn_contract::{
    OrchestrationV2TurnItemApprovalRequestFullAccessOverride as FullAccessOverride,
    ProviderApprovalDecision,
};
use gpui_kit::Context;

use super::{ChatView, request_stack};

pub(super) const GONE_NOTE: &str =
    "Provider process is gone. Interrupt or restart the child thread to respond.";

/// One answer a card offers: the decision sent to the request's thread and its label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApprovalChoice {
    pub decision: &'static str,
    pub label: String,
    pub warning: Option<String>,
}

/// One pending approval, ready to draw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChildApprovalCard {
    /// The thread the request belongs to; `runtime-request.respond` goes to it.
    pub thread_id: String,
    pub request_id: String,
    /// The timeline entry of an approval of the open thread. `None` for a child's approval.
    pub entry_id: Option<String>,
    /// The child's title; empty for an approval of the open thread.
    pub title: String,
    /// The command (or request kind) to approve.
    pub detail: String,
    /// The provider's request kind or note that came with the command (own approvals only).
    pub hint: Option<String>,
    pub app_name: Option<String>,
    pub reason: Option<String>,
    pub full_access_note: Option<&'static str>,
    /// The provider session still waits for the answer.
    pub answerable: bool,
    pub responding: bool,
    pub error: Option<String>,
    pub choices: Vec<ApprovalChoice>,
}

impl ChildApprovalCard {
    pub(crate) fn new(
        approval: &conn_state::ChildApproval,
        responding: bool,
        error: Option<String>,
    ) -> Self {
        let details = &approval.details;
        let choices = match &details.options {
            Some(options) => options
                .iter()
                .map(|option| ApprovalChoice {
                    decision: decision_wire(option.decision),
                    label: option.label.clone(),
                    warning: option.warning.clone(),
                })
                .collect(),
            None => default_choices(),
        };
        Self {
            thread_id: approval.thread_id.clone(),
            request_id: approval.request_id.clone(),
            entry_id: None,
            title: approval.title.clone(),
            detail: approval.detail.clone(),
            hint: None,
            app_name: details.app_name.clone(),
            reason: details.reason.clone(),
            full_access_note: details.full_access_override.map(full_access_note),
            answerable: approval.answerable,
            responding,
            error,
            choices,
        }
    }

    /// A pending approval of the open thread `thread_id`. `command` is the approval entry's
    /// title and `hint` its detail (the request kind, or a note).
    pub(crate) fn own(
        thread_id: &str,
        approval: &conn_state::PendingApproval,
        command: &str,
        hint: Option<&str>,
        details: Option<&conn_state::ApprovalDetails>,
    ) -> Self {
        let details = details.cloned().unwrap_or(conn_state::ApprovalDetails {
            request_kind: conn_contract::ProviderRequestKind::Command,
            prompt: None,
            reason: None,
            full_access_override: None,
            app_name: None,
            options: None,
        });
        let mut card = Self::new(
            &conn_state::ChildApproval {
                thread_id: thread_id.to_owned(),
                title: String::new(),
                request_id: approval.request_id.clone(),
                detail: command.to_owned(),
                details,
                answerable: approval.answerable,
            },
            false,
            None,
        );
        card.entry_id = Some(approval.entry_id.clone());
        card.hint = hint.map(str::to_owned);
        card
    }

    /// The Decline and Approve answers, in the provider's order.
    pub(super) fn primary(&self) -> impl Iterator<Item = &ApprovalChoice> {
        self.choices
            .iter()
            .filter(|c| matches!(c.decision, "decline" | "accept"))
    }

    /// Everything else, behind More.
    pub(super) fn more(&self) -> Vec<&ApprovalChoice> {
        self.choices
            .iter()
            .filter(|c| !matches!(c.decision, "decline" | "accept"))
            .collect()
    }
}

/// `DEFAULT_APPROVAL_OPTIONS`.
fn default_choices() -> Vec<ApprovalChoice> {
    [
        ("cancel", "Cancel"),
        ("decline", "Decline"),
        ("acceptForSession", "Always allow this session"),
        ("accept", "Approve"),
    ]
    .into_iter()
    .map(|(decision, label)| ApprovalChoice {
        decision,
        label: label.to_owned(),
        warning: None,
    })
    .collect()
}

/// The decision as `runtime-request.respond` spells it.
fn decision_wire(decision: ProviderApprovalDecision) -> &'static str {
    match decision {
        ProviderApprovalDecision::Accept => "accept",
        ProviderApprovalDecision::AcceptForSession => "acceptForSession",
        ProviderApprovalDecision::AcceptAlways => "acceptAlways",
        ProviderApprovalDecision::Decline => "decline",
        ProviderApprovalDecision::Cancel => "cancel",
    }
}

/// `fullAccessOverrideExplanation`, with the app name filled in.
fn full_access_note(override_kind: FullAccessOverride) -> &'static str {
    match override_kind {
        FullAccessOverride::AskRule => {
            "Full access skips approvals, but an ask rule in the agent's own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts."
        }
        FullAccessOverride::ProviderCheck => {
            "Full access skips approvals, but the agent still stops for a few safety checks of its own that no setting can skip, such as a delete whose path it can't verify. Conn can't turn these off, so check the request and approve it if it's what you expect."
        }
    }
}

impl ChatView {
    /// The cards of the open thread's children, replaced whole on every sync.
    pub(crate) fn set_child_approvals(
        &mut self,
        cards: Vec<ChildApprovalCard>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.child_approvals == cards {
            return;
        }
        self.child_approvals = cards;
        self.refresh_request_stack();
        cx.notify();
    }

    /// An answer to an approval of the open thread failed: its buttons work again, with the
    /// reason under them. A thread that was left meanwhile has nothing to show.
    pub(crate) fn approval_response_failed(
        &mut self,
        entry_id: &str,
        message: String,
        cx: &mut Context<'_, Self>,
    ) {
        if !request_stack::has_own_approval(&self.own_approvals, entry_id) {
            return;
        }
        self.approval_responding.remove(entry_id);
        self.approval_errors.insert(entry_id.to_owned(), message);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_state::ApprovalDetails;

    fn approval(details: ApprovalDetails) -> conn_state::ChildApproval {
        conn_state::ChildApproval {
            thread_id: "child".to_owned(),
            title: "Review #278".to_owned(),
            request_id: "req".to_owned(),
            detail: "rm -rf target".to_owned(),
            details,
            answerable: true,
        }
    }

    fn details(options: Option<Vec<conn_contract::ProviderApprovalOption>>) -> ApprovalDetails {
        ApprovalDetails {
            request_kind: conn_contract::ProviderRequestKind::Command,
            prompt: Some("rm -rf target".to_owned()),
            reason: None,
            full_access_override: None,
            app_name: None,
            options,
        }
    }

    #[test]
    fn default_options_show_decline_and_approve_with_the_rest_behind_more() {
        let card = ChildApprovalCard::new(&approval(details(None)), false, None);
        let primary: Vec<_> = card.primary().map(|c| c.label.as_str()).collect();
        let more: Vec<_> = card.more().iter().map(|c| c.label.clone()).collect();
        assert_eq!(primary, ["Decline", "Approve"]);
        assert_eq!(more, ["Cancel", "Always allow this session"]);
    }

    #[test]
    fn provider_options_keep_their_own_labels_and_wire_decisions() {
        let option = |decision, label: &str| conn_contract::ProviderApprovalOption {
            decision,
            label: label.to_owned(),
            warning: None,
        };
        let card = ChildApprovalCard::new(
            &approval(details(Some(vec![
                option(ProviderApprovalDecision::AcceptAlways, "Always"),
                option(ProviderApprovalDecision::Accept, "Yes"),
                option(ProviderApprovalDecision::Decline, "No"),
            ]))),
            false,
            Some("boom".to_owned()),
        );
        let primary: Vec<_> = card
            .primary()
            .map(|c| (c.decision, c.label.as_str()))
            .collect();
        assert_eq!(primary, [("accept", "Yes"), ("decline", "No")]);
        assert_eq!(card.more()[0].decision, "acceptAlways");
        assert_eq!(card.error.as_deref(), Some("boom"));
    }

    #[test]
    fn an_approval_of_the_open_thread_answers_on_its_own_entry() {
        let pending = conn_state::PendingApproval {
            entry_id: "entry".to_owned(),
            request_id: "req".to_owned(),
            answerable: false,
            supports_feedback: false,
        };
        let card =
            ChildApprovalCard::own("thread", &pending, "rm -rf target", Some("command"), None);
        assert_eq!(card.entry_id.as_deref(), Some("entry"));
        assert_eq!(card.thread_id, "thread");
        assert_eq!(card.hint.as_deref(), Some("command"));
        assert!(card.title.is_empty());
        assert!(!card.answerable);
        assert_eq!(card.choices.len(), 4);
    }
}
