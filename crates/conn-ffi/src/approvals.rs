//! The approval card above the composer, ported from Conn mobile's `PendingApprovalCard.tsx` and
//! `ThreadPendingApproval` (`client-runtime/src/state/threadRequests.ts`), so the SwiftUI view
//! only draws.

use conn_contract::{
    OrchestrationV2TurnItemApprovalRequestFullAccessOverride as FullAccessOverride,
    ProviderApprovalDecision, ProviderApprovalOption,
};
use conn_state::{ThreadState, TimelineEntry, request_kind_label};

use crate::types::FfiApprovalDecision;

/// The product name in UI copy (`appName()`).
const APP_NAME: &str = "Conn";

/// A full-width button's colours (mobile `Button` tones).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiButtonTone {
    Primary,
    Secondary,
    Danger,
}

/// One answer button on the approval card.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiApprovalOption {
    pub decision: FfiApprovalDecision,
    pub label: String,
    /// Allow once is primary, decline is danger, the rest are secondary.
    pub tone: FfiButtonTone,
}

/// A pending approval as the card above the composer shows it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiPendingApproval {
    /// The approval's timeline entry.
    pub entry_id: String,
    /// Server request id to pass to [`crate::ConnCore::respond_approval`].
    pub request_id: String,
    /// The app the agent asks about, or else the request kind (`command`, `file-change`, ...).
    pub title: String,
    /// What the agent wants to do (the approval's prompt).
    pub detail: Option<String>,
    pub reason: Option<String>,
    /// Why the agent asks although the run has full access. The card hides it behind
    /// "Why am I being asked this?".
    pub full_access_explanation: Option<String>,
    /// The first option warning, shown above the buttons.
    pub warning: Option<String>,
    pub options: Vec<FfiApprovalOption>,
    /// The provider still waits for this answer. When it does not, the buttons are off and the
    /// card says the provider process is gone.
    pub answerable: bool,
}

/// Every approval that still waits for an answer, in timeline order. The card shows the first.
pub(crate) fn pending_approvals(thread: &ThreadState) -> Vec<FfiPendingApproval> {
    thread
        .pending_approvals()
        .into_iter()
        .map(|pending| {
            let details = thread.approval_details(&pending.entry_id);
            let title = details
                .and_then(|d| d.app_name.clone())
                .or_else(|| details.map(|d| request_kind_label(d.request_kind).to_owned()))
                .unwrap_or_else(|| entry_title(thread, &pending.entry_id));
            let options = match details.and_then(|d| d.options.as_deref()) {
                Some(options) => options.iter().map(map_option).collect(),
                None => default_options(),
            };
            FfiPendingApproval {
                entry_id: pending.entry_id,
                request_id: pending.request_id,
                title,
                detail: details.and_then(|d| d.prompt.clone()),
                reason: details.and_then(|d| d.reason.clone()),
                full_access_explanation: details
                    .and_then(|d| d.full_access_override)
                    .map(full_access_explanation),
                warning: details
                    .and_then(|d| d.options.as_deref())
                    .and_then(first_warning),
                options,
                answerable: pending.answerable,
            }
        })
        .collect()
}

/// The approval entry's own title, for an approval whose item has not arrived.
fn entry_title(thread: &ThreadState, entry_id: &str) -> String {
    thread
        .entries
        .iter()
        .find_map(|entry| match entry {
            TimelineEntry::Approval { id, title, .. } if id == entry_id => Some(title.clone()),
            _ => None,
        })
        .unwrap_or_else(|| "Approval requested".to_owned())
}

/// Conn's three answers when the provider names none.
fn default_options() -> Vec<FfiApprovalOption> {
    [
        (FfiApprovalDecision::Accept, "Allow once"),
        (FfiApprovalDecision::AcceptForSession, "Allow session"),
        (FfiApprovalDecision::Decline, "Decline"),
    ]
    .into_iter()
    .map(|(decision, label)| FfiApprovalOption {
        decision,
        label: label.to_owned(),
        tone: tone(decision),
    })
    .collect()
}

fn map_option(option: &ProviderApprovalOption) -> FfiApprovalOption {
    let decision = match option.decision {
        ProviderApprovalDecision::Accept => FfiApprovalDecision::Accept,
        ProviderApprovalDecision::AcceptForSession => FfiApprovalDecision::AcceptForSession,
        ProviderApprovalDecision::AcceptAlways => FfiApprovalDecision::AcceptAlways,
        ProviderApprovalDecision::Decline => FfiApprovalDecision::Decline,
        ProviderApprovalDecision::Cancel => FfiApprovalDecision::Cancel,
    };
    FfiApprovalOption {
        decision,
        label: option.label.clone(),
        tone: tone(decision),
    }
}

fn tone(decision: FfiApprovalDecision) -> FfiButtonTone {
    match decision {
        FfiApprovalDecision::Accept => FfiButtonTone::Primary,
        FfiApprovalDecision::Decline => FfiButtonTone::Danger,
        FfiApprovalDecision::AcceptForSession
        | FfiApprovalDecision::AcceptAlways
        | FfiApprovalDecision::Cancel => FfiButtonTone::Secondary,
    }
}

/// `options.find((option) => option.warning)?.warning`.
fn first_warning(options: &[ProviderApprovalOption]) -> Option<String> {
    options
        .iter()
        .filter_map(|option| option.warning.as_deref())
        .find(|warning| !warning.is_empty())
        .map(str::to_owned)
}

/// `fullAccessOverrideExplanation`.
fn full_access_explanation(override_kind: FullAccessOverride) -> String {
    match override_kind {
        FullAccessOverride::AskRule => {
            "Full access skips approvals, but an ask rule in the agent's \
             own settings matches this action, so it still asks. Remove or narrow that rule to \
             stop these prompts."
                .to_owned()
        }
        FullAccessOverride::ProviderCheck => format!(
            "Full access skips approvals, but the agent still stops for a few safety checks of \
             its own that no setting can skip, such as a delete whose path it can't verify. \
             {APP_NAME} can't turn these off, so check the request and approve it if it's what \
             you expect."
        ),
    }
}

#[cfg(test)]
mod tests {
    use conn_contract::from_json;
    use conn_state::ThreadStreamItem;
    use serde_json::{Value, json};

    use super::*;

    fn frames() -> Vec<Value> {
        serde_json::from_str(include_str!(
            "../../conn-state/tests/fixtures/thread_permission_stream.json"
        ))
        .expect("fixture JSON")
    }

    fn card_index(frames: &[Value]) -> usize {
        frames
            .iter()
            .position(|f| f["event"]["payload"]["type"] == "approval_request")
            .expect("fixture has an approval card")
    }

    fn replay(frames: &[Value]) -> ThreadState {
        let mut state = ThreadState::default();
        for frame in frames {
            let item: ThreadStreamItem = from_json(frame.clone()).expect("thread stream item");
            state.apply(item);
        }
        state
    }

    #[test]
    fn a_plain_approval_gets_the_request_kind_and_conns_three_answers() {
        let frames = frames();
        let approvals = pending_approvals(&replay(&frames[..=card_index(&frames)]));
        assert_eq!(approvals.len(), 1, "one pending approval");
        let approval = &approvals[0];
        assert_eq!(approval.title, "command", "no app name: the request kind");
        assert_eq!(
            approval.detail.as_deref(),
            Some("echo conn-recording"),
            "prompt"
        );
        assert!(approval.answerable, "the provider waits");
        let buttons: Vec<_> = approval
            .options
            .iter()
            .map(|o| (o.label.as_str(), o.tone))
            .collect();
        assert_eq!(
            buttons,
            vec![
                ("Allow once", FfiButtonTone::Primary),
                ("Allow session", FfiButtonTone::Secondary),
                ("Decline", FfiButtonTone::Danger),
            ],
            "default answers"
        );
        assert_eq!(approval.warning, None, "no warning");
        assert_eq!(approval.full_access_explanation, None, "no override");
    }

    #[test]
    fn provider_options_app_warning_and_override_come_from_the_approval_item() {
        let mut frames = frames();
        let index = card_index(&frames);
        let card = &mut frames[index]["event"]["payload"];
        card["appName"] = json!("GitHub");
        card["reason"] = json!("Needs network");
        card["fullAccessOverride"] = json!("provider_check");
        card["options"] = json!([
            { "decision": "acceptAlways", "label": "Always allow" },
            { "decision": "cancel", "label": "Stop", "warning": "" },
            { "decision": "decline", "label": "Skip", "warning": "The run stops here." }
        ]);
        let approvals = pending_approvals(&replay(&frames[..=index]));
        let approval = &approvals[0];
        assert_eq!(approval.title, "GitHub", "app name wins");
        assert_eq!(approval.reason.as_deref(), Some("Needs network"), "reason");
        assert_eq!(
            approval.warning.as_deref(),
            Some("The run stops here."),
            "first non-empty warning"
        );
        let decisions: Vec<_> = approval
            .options
            .iter()
            .map(|o| (o.decision, o.tone))
            .collect();
        assert_eq!(
            decisions,
            vec![
                (FfiApprovalDecision::AcceptAlways, FfiButtonTone::Secondary),
                (FfiApprovalDecision::Cancel, FfiButtonTone::Secondary),
                (FfiApprovalDecision::Decline, FfiButtonTone::Danger),
            ],
            "provider answers in order"
        );
        assert!(
            approval
                .full_access_explanation
                .as_deref()
                .is_some_and(|text| text.contains("Conn can't turn these off")),
            "provider check explanation names the app"
        );
    }

    #[test]
    fn a_request_the_provider_cannot_answer_stays_but_is_not_answerable() {
        let mut frames = frames();
        let index = card_index(&frames);
        let request_index = frames
            .iter()
            .position(|f| f["event"]["type"] == "runtime-request.updated")
            .expect("fixture has a runtime request");
        frames[request_index]["event"]["payload"]["responseCapability"] =
            json!({ "type": "not_resumable", "reason": "provider session ended" });
        let approvals = pending_approvals(&replay(&frames[..=index]));
        assert_eq!(approvals.len(), 1, "still pending");
        assert!(!approvals[0].answerable, "nobody waits for the answer");
    }
}
