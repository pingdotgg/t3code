//! Change request actions on GitHub: T3's `runPullRequestAction` (`GitHubPullRequestApi.ts`)
//! for merge, auto-merge, branch updates, ready/draft, close/reopen and revert, and the
//! permission read the service checks first (`getViewerPermissions`).
//!
//! Not built: deleting the source branch, approving fork workflows and stack actions. The panel
//! does not advertise them and refuses them with T3's texts.

use super::{
    Client, Error, Lookup, detail::can_write_permission, generated, merge_message, normalize::text,
};
use serde_json::{Value, json};

/// `found`: GitHub answered, but not with this pull request (`GitHubApiNotFoundError`).
pub(super) fn found(result: &Value) -> Result<&Value, Error> {
    result
        .pointer("/repository/pullRequest")
        .filter(|value| !value.is_null())
        .ok_or_else(|| {
            Error::NotFound(
                "GitHub could not find the requested resource, or the credential cannot see it."
                    .into(),
            )
        })
}

/// The actions this server runs, in T3's capability order.
pub const SERVED: [&str; 9] = [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
];
pub const MERGE_METHODS: [&str; 3] = ["merge", "squash", "rebase"];
pub const UPDATE_METHODS: [&str; 2] = ["merge", "rebase"];

/// `IMMEDIATELY_MERGEABLE`: states in which `gh pr merge --auto` merges at once.
const IMMEDIATELY_MERGEABLE: [&str; 3] = ["CLEAN", "HAS_HOOKS", "UNSTABLE"];

/// `ACTION_ACCESS_REFUSALS` (`PullRequestService.ts`).
pub fn access_refusal(action: &str) -> &'static str {
    match action {
        "merge" => "You need write access on this repository to merge.",
        "ready" => {
            "You need write access on this repository, or to have opened this change request, to mark it ready for review."
        }
        "draft" => {
            "You need write access on this repository, or to have opened this change request, to return it to a draft."
        }
        "close" => {
            "You need write access on this repository, or to have opened this change request, to close it."
        }
        "update-branch" => {
            "You need write access on this repository, or to have opened this change request, to update its branch."
        }
        "reopen" => {
            "You need write access on this repository, or to have opened this change request, to reopen it."
        }
        "enable-auto-merge" => {
            "Auto-merge needs write access on this repository, and the repository has to allow it."
        }
        "disable-auto-merge" => {
            "You need write access on this repository to stop it being merged for you once it is ready."
        }
        "revert" => "You need write access on this repository to open a revert pull request.",
        _ => "You do not have permission to do that on this change request.",
    }
}

/// `toViewerPermissions` and `gitHubViewerPermissions` of a `ViewerPermissions` answer: the
/// light read, without branch update or merge readiness.
pub fn light_viewer_permissions(result: &Value) -> Option<Value> {
    let repository = result.get("repository").filter(|r| !r.is_null())?;
    let pull_request = repository.get("pullRequest").filter(|p| !p.is_null());
    let can_write = can_write_permission(repository.get("viewerPermission"));
    let can_triage = can_write
        || repository
            .get("viewerPermission")
            .and_then(Value::as_str)
            .is_some_and(|p| p.trim().eq_ignore_ascii_case("TRIAGE"));
    let can_delete = can_write_permission(
        pull_request.and_then(|p| p.pointer("/headRepository/viewerPermission")),
    );
    let can_update =
        pull_request.and_then(|p| p.get("viewerCanUpdate")) != Some(&Value::Bool(false));
    let did_author =
        pull_request.and_then(|p| p.get("viewerDidAuthor")) == Some(&Value::Bool(true));
    let mut actions: Vec<&str> = Vec::new();
    if can_delete {
        actions.push("delete-branch");
    }
    if can_write {
        actions.push("merge");
        if repository.get("autoMergeAllowed") == Some(&Value::Bool(true)) {
            actions.push("enable-auto-merge");
        }
        actions.extend(["disable-auto-merge", "revert", "approve-workflows"]);
    }
    if can_update {
        actions.extend(["ready", "draft", "close", "reopen"]);
    }
    let verdicts = if did_author {
        vec!["comment"]
    } else {
        vec!["comment", "approve", "request-changes"]
    };
    let mut permissions = json!({
        "actions": actions, "comment": true, "resolve": can_write || did_author,
        "verdicts": verdicts, "requestReviewers": can_write, "labels": can_triage,
    });
    if can_write {
        permissions["stackRebase"] = json!(true);
    }
    Some(permissions)
}

fn merge_method(input: &Value) -> &'static str {
    match text(input, "mergeMethod") {
        "squash" => "SQUASH",
        "rebase" => "REBASE",
        _ => "MERGE",
    }
}

impl Client {
    /// `getViewerPermissions`: the light read, or for a branch update the detail read, which
    /// falls back to the light one unless GitHub rate-limited it.
    pub async fn viewer_permissions(
        &self,
        lookup: &Lookup,
        include_update_branch: bool,
    ) -> Result<Value, Error> {
        if include_update_branch {
            match self.detail(lookup).await {
                Ok(detail) => return Ok(detail["viewerPermissions"].clone()),
                Err(Error::RateLimited) => return Err(Error::RateLimited),
                Err(_) => {}
            }
        }
        let result = self
            .graphql(&generated::VIEWER_PERMISSIONS, lookup.variables())
            .await?;
        light_viewer_permissions(&result).ok_or_else(|| {
            Error::NotFound(
                "GitHub could not find the requested resource, or the credential cannot see it."
                    .into(),
            )
        })
    }

    /// `runPullRequestAction` for the served actions. `remove_agent_credits` comes from the
    /// project's `removeAgentCreditsOnMerge` setting.
    pub async fn run_action(
        &self,
        lookup: &Lookup,
        input: &Value,
        remove_agent_credits: bool,
    ) -> Result<(), Error> {
        let action = text(input, "action");
        let simple = match action {
            "disable-auto-merge" => Some(&generated::DISABLE_PULL_REQUEST_AUTO_MERGE),
            "ready" => Some(&generated::MARK_PULL_REQUEST_READY_FOR_REVIEW),
            "draft" => Some(&generated::CONVERT_PULL_REQUEST_TO_DRAFT),
            "close" => Some(&generated::CLOSE_PULL_REQUEST),
            "reopen" => Some(&generated::REOPEN_PULL_REQUEST),
            "revert" => Some(&generated::REVERT_PULL_REQUEST),
            _ => None,
        };
        if let Some(operation) = simple {
            let id = self.node_id(lookup).await?;
            self.graphql(operation, json!({"pullRequestId": id}))
                .await?;
            return Ok(());
        }
        if !matches!(action, "merge" | "enable-auto-merge" | "update-branch") {
            return Err(Error::Failed(format!(
                "This host cannot {action} a change request."
            )));
        }
        // Fresh head and merge-queue state decide the mutation's revision and route.
        let mut variables = lookup.variables();
        variables["headRef"] = json!(format!("refs/pull/{}/head", lookup.number));
        let result = self
            .graphql(&generated::PULL_REQUEST_ACTION_STATE, variables)
            .await?;
        let state = found(&result)?;
        if action == "update-branch" {
            if state.pointer("/baseRef/compare/behindBy") == Some(&json!(0)) {
                return Ok(());
            }
            let method = if text(input, "updateMethod") == "rebase" {
                "REBASE"
            } else {
                "MERGE"
            };
            self.graphql(
                &generated::UPDATE_PULL_REQUEST_BRANCH,
                json!({"pullRequestId": state.get("id"), "expectedHeadOid": state.get("headRefOid"),
                    "updateMethod": method}),
            )
            .await?;
            return Ok(());
        }
        let mut body: Option<String> = None;
        let mut expected_head: Option<Value> = None;
        if remove_agent_credits && text(input, "mergeMethod") != "rebase" {
            let mut variables = lookup.variables();
            variables["method"] = json!(if text(input, "mergeMethod") == "squash" {
                "SQUASH"
            } else {
                "MERGE"
            });
            let result = self
                .graphql(&generated::PULL_REQUEST_MERGE_MESSAGE, variables)
                .await?;
            let message = found(&result)?;
            // GitHub's merge queue chooses its own message and ignores custom text.
            if message.get("isMergeQueueEnabled") != Some(&Value::Bool(true)) {
                let original = text(message, "viewerMergeBodyText");
                let cleaned = merge_message::remove_agent_credits(original);
                if cleaned != original {
                    body = Some(cleaned);
                    expected_head = message.get("headRefOid").cloned();
                }
            }
        }
        let merge_state = text(state, "mergeStateStatus").to_uppercase();
        // Merge queues always use auto-merge. A PR that became ready since detail loaded
        // merges directly, matching `gh pr merge --auto`.
        let auto = state.get("isMergeQueueEnabled") == Some(&Value::Bool(true))
            || (action == "enable-auto-merge"
                && !IMMEDIATELY_MERGEABLE.contains(&merge_state.as_str()));
        let mut merge =
            json!({"pullRequestId": state.get("id"), "mergeMethod": merge_method(input)});
        if let Some(head) = input
            .get("expectedHeadSha")
            .filter(|h| !h.is_null())
            .cloned()
            .or(expected_head)
        {
            merge["expectedHeadOid"] = head;
        }
        if let Some(body) = body {
            merge["commitBody"] = json!(body);
        }
        self.graphql(
            if auto {
                &generated::ENABLE_PULL_REQUEST_AUTO_MERGE
            } else {
                &generated::MERGE_PULL_REQUEST
            },
            json!({"input": merge}),
        )
        .await?;
        Ok(())
    }
}
