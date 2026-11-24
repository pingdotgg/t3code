use super::{
    Client, Error, Lookup, generated,
    normalize::{self, array, cursor, nodes, text, trimmed},
    pull_request,
};
use serde_json::{Value, json};
impl Client {
    pub async fn detail(&self, lookup: &Lookup) -> Result<Value, Error> {
        let mut variables = lookup.variables();
        variables["headRef"] = json!(format!("refs/pull/{}/head", lookup.number));
        variables["required"] = json!(self.host == "github.com");
        variables["requestedReviewers"] = json!(100);
        variables["mergeQueue"] = json!(self.host == "github.com");
        let result = self
            .graphql(&generated::PULL_REQUEST_CORE, variables)
            .await?;
        let raw = pull_request(&result, lookup)?;
        let repo = result.get("repository").unwrap_or(&Value::Null);
        let mut all = nodes(raw.get("commits").unwrap_or(&Value::Null))
            .first()
            .and_then(|c| c.pointer("/commit/statusCheckRollup/contexts"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut contexts = nodes(&all).to_vec();
        let mut after = cursor(&all);
        for _ in 1..10 {
            if after.is_null() {
                break;
            }
            let mut vars = lookup.variables();
            vars["required"] = json!(self.host == "github.com");
            vars["after"] = after.clone();
            let next = self
                .graphql(&generated::PULL_REQUEST_CHECK_CONTEXTS, vars)
                .await?;
            let next_pr = pull_request(&next, lookup)?;
            if next_pr.get("headRefOid") != raw.get("headRefOid") {
                return Err(Error::Failed(
                    "GitHub returned an unreadable getPullRequestDetail response.".into(),
                ));
            }
            all = nodes(next_pr.get("commits").unwrap_or(&Value::Null))
                .first()
                .and_then(|c| c.pointer("/commit/statusCheckRollup/contexts"))
                .cloned()
                .unwrap_or(Value::Null);
            let next = cursor(&all);
            if next == after {
                break;
            }
            contexts.extend_from_slice(nodes(&all));
            after = next;
        }
        let checks = normalize::checks(&contexts);
        let mut detail = normalize::summary(raw, &self.host);
        if let Some(object) = detail.as_object_mut() {
            for key in ["stack", "reviewDecision", "checksState"] {
                object.remove(key);
            }
        }
        detail["createdAt"] = raw.get("createdAt").cloned().unwrap_or(Value::Null);
        detail["body"] = json!(text(raw, "body"));
        detail["headSha"] = trimmed(raw.get("headRefOid"));
        detail["headRepositoryNameWithOwner"] =
            trimmed(raw.pointer("/headRepository/nameWithOwner"));
        detail["maintainerCanModify"] =
            json!(raw.get("maintainerCanModify") == Some(&Value::Bool(true)));
        detail["labels"] = json!(normalize::labels(raw.get("labels").unwrap_or(&Value::Null)));
        let mut reviewers = Vec::new();
        for request in nodes(raw.get("reviewRequests").unwrap_or(&Value::Null)) {
            let actor = request.get("requestedReviewer").unwrap_or(&Value::Null);
            if !text(actor, "login").is_empty() {
                reviewers.push(json!({"login":text(actor,"login"),"name":null,"avatarUrl":null}));
            } else if !text(actor, "combinedSlug").is_empty() {
                reviewers.push(json!({"login":text(actor,"combinedSlug"),"name":trimmed(actor.get("teamName")),"avatarUrl":trimmed(actor.get("teamAvatarUrl"))}));
            }
        }
        detail["reviewers"] = json!(reviewers);
        // Only when the host has them (`mergeCommitSha`, `mergedBy` in T3's detail).
        if let Some(sha) = trimmed(raw.pointer("/mergeCommit/oid")).as_str() {
            detail["mergeCommitSha"] = json!(sha);
        }
        let merged_by = normalize::actor(raw.get("mergedBy"), &self.host);
        if !merged_by.is_null() {
            detail["mergedBy"] = merged_by;
        }
        detail["checks"] = json!(checks);
        let comparison = if normalize::state(raw) == "open" {
            raw.pointer("/baseRef/compare")
        } else {
            None
        };
        let behind = comparison
            .and_then(|c| c.get("behindBy"))
            .and_then(Value::as_u64);
        detail["baseComparison"] = json!(match behind {
            None => "unknown",
            Some(0) => "up-to-date",
            _ => "behind",
        });
        if let Some(n) = behind {
            detail["behindBy"] = json!(n);
        }
        detail["mergeCapabilities"] = merge_capabilities(repo);
        detail["viewerPermissions"] = viewer_permissions(raw, repo);
        if let Some(auto) = raw.get("autoMergeRequest") {
            detail["autoMergeEnabled"] = json!(!auto.is_null());
            let method = text(auto, "mergeMethod").to_lowercase();
            if ["merge", "squash", "rebase"].contains(&method.as_str()) {
                detail["autoMergeMethod"] = json!(method);
            }
        }
        if let Some(removal) = nodes(raw.get("mergeQueueRemovals").unwrap_or(&Value::Null))
            .last()
            .filter(|r| r.get("id").is_some())
        {
            detail["mergeQueueRemoval"] = json!({"id":removal.get("id"),"removedAt":removal.get("createdAt"),"reason":trimmed(removal.get("reason"))});
        }
        self.workflow_checks(lookup, raw, &mut detail).await?;
        Ok(detail)
    }
    async fn workflow_checks(
        &self,
        lookup: &Lookup,
        raw: &Value,
        detail: &mut Value,
    ) -> Result<(), Error> {
        let mut checks = array(detail.get("checks")).to_vec();
        let open = normalize::state(raw) == "open";
        let sha = text(raw, "headRefOid");
        let approvals = if open && raw.get("isCrossRepository") == Some(&Value::Bool(true)) {
            match self.approval_runs(lookup, raw).await {
                Ok(runs) => Some(runs),
                Err(error) if is_rate_limit(&error) => return Err(error),
                Err(_) => None,
            }
        } else {
            Some(Vec::new())
        };
        if open && !sha.is_empty() {
            let path = format!(
                "repos/{}/{}/actions/runs?head_sha={}&per_page=100",
                lookup.owner,
                lookup.name,
                super::diff::encode(sha)
            );
            match self.rest(&path).await {
                Ok(raw) => {
                    for run in array(raw.get("workflow_runs")).iter().filter(|r| {
                        matches!(
                            text(r, "status"),
                            "requested" | "queued" | "pending" | "waiting" | "in_progress"
                        )
                    }) {
                        let id = run.get("id").and_then(Value::as_u64);
                        let represented = checks.iter().any(|c| {
                            matches!(text(c, "status"), "pending" | "action-required")
                                && id.is_some()
                                && workflow_id(text(c, "url")) == id
                        });
                        if !represented {
                            checks.push(workflow_check(
                                run,
                                "pending",
                                "This workflow run has not finished.",
                            ));
                        }
                    }
                }
                Err(error) if is_rate_limit(&error) => return Err(error),
                Err(_) => {}
            }
        }
        if let Some(runs) = approvals {
            detail["workflowApprovalsRequired"] = json!(runs.len());
            for run in runs {
                let id = run.get("id").and_then(Value::as_u64);
                if !checks.iter().any(|c| {
                    text(c, "status") == "action-required"
                        && id.is_some()
                        && workflow_id(text(c, "url")) == id
                }) {
                    checks.push(workflow_check(
                        &run,
                        "action-required",
                        "A maintainer must approve this workflow before it can run.",
                    ));
                }
            }
        } else {
            checks.push(json!({"name":"Workflow approval status","status":"action-required","description":"GitHub could not determine whether workflows are awaiting approval.","url":null,"placeholder":true}));
        }
        detail["checks"] = json!(checks);
        Ok(())
    }
    async fn approval_runs(&self, lookup: &Lookup, raw: &Value) -> Result<Vec<Value>, Error> {
        let sha = text(raw, "headRefOid");
        let owner = raw
            .pointer("/headRepositoryOwner/login")
            .and_then(Value::as_str)
            .unwrap_or("");
        if sha.is_empty() || owner.is_empty() {
            return Err(Error::Failed("Incomplete pull request head.".into()));
        }
        let mut variables = lookup.variables();
        variables["head"] = json!(text(raw, "headRefName"));
        variables["after"] = Value::Null;
        let mut heads = Vec::new();
        for _ in 0..11 {
            let result = self
                .graphql(&generated::PULL_REQUEST_HEADS, variables.clone())
                .await?;
            let connection = result
                .pointer("/repository/pullRequests")
                .unwrap_or(&Value::Null);
            heads.extend_from_slice(nodes(connection));
            let next = cursor(connection);
            if heads.len() > 1000 {
                return Err(Error::Failed(
                    "GitHub returned more than 1000 pull requests for this head branch.".into(),
                ));
            }
            if next.is_null() {
                break;
            }
            if variables.get("after") == Some(&next) {
                return Err(Error::Failed("GitHub repeated a pull request page.".into()));
            }
            variables["after"] = next;
        }
        let matching: Vec<_> = heads
            .iter()
            .filter(|p| {
                text(p, "headRefOid") == sha
                    && p.get("isCrossRepository") == Some(&Value::Bool(true))
                    && p.pointer("/headRepositoryOwner/login")
                        .and_then(Value::as_str)
                        .is_some_and(|login| login.eq_ignore_ascii_case(owner))
            })
            .collect();
        if matching.len() != 1
            || matching
                .first()
                .and_then(|p| p.get("number"))
                .and_then(Value::as_u64)
                != Some(u64::from(lookup.number))
        {
            return Err(Error::Failed("The pull request head is not unique.".into()));
        }
        let mut runs = Vec::new();
        for page in 1..=11 {
            let path = format!(
                "repos/{}/{}/actions/runs?head_sha={}&branch={}&event=pull_request&status=action_required&per_page=100&page={page}",
                lookup.owner,
                lookup.name,
                super::diff::encode(sha),
                super::diff::encode(text(raw, "headRefName"))
            );
            let result = self.rest(&path).await?;
            let page = array(result.get("workflow_runs"));
            runs.extend_from_slice(page);
            if runs.len() > 1000 {
                return Err(Error::Failed(
                    "GitHub returned more than 1000 workflow runs awaiting approval.".into(),
                ));
            }
            if page.len() < 100 {
                break;
            }
        }
        Ok(runs)
    }
}
pub(super) fn can_write_permission(permission: Option<&Value>) -> bool {
    permission == Some(&Value::Null)
        || permission.and_then(Value::as_str).is_some_and(|p| {
            matches!(
                p.trim().to_uppercase().as_str(),
                "ADMIN" | "MAINTAIN" | "WRITE"
            )
        })
}
fn is_rate_limit(error: &Error) -> bool {
    matches!(error, Error::RateLimited)
}
fn workflow_id(url: &str) -> Option<u64> {
    url.split_once("/actions/runs/")?
        .1
        .split('/')
        .next()?
        .parse()
        .ok()
}
fn workflow_check(run: &Value, status: &str, description: &str) -> Value {
    let name = trimmed(run.get("name"));
    json!({"name":if name.is_null(){json!(format!("Workflow run {}",run.get("id").unwrap_or(&Value::Null)))}else{name},"status":status,"description":description,"url":trimmed(run.get("html_url"))})
}

fn merge_capabilities(repo: &Value) -> Value {
    json!({
        "merge": repo.get("mergeCommitAllowed") == Some(&Value::Bool(true)),
        "squash": repo.get("squashMergeAllowed") == Some(&Value::Bool(true)),
        "rebase": repo.get("rebaseMergeAllowed") == Some(&Value::Bool(true))
    })
}
fn viewer_permissions(raw: &Value, repo: &Value) -> Value {
    let can_write = can_write_permission(repo.get("viewerPermission"));
    let can_triage = can_write || text(repo, "viewerPermission") == "TRIAGE";
    let did_author = raw.get("viewerDidAuthor") == Some(&Value::Bool(true));
    let can_update = raw.get("viewerCanUpdate") != Some(&Value::Bool(false));
    let can_delete = can_write_permission(raw.pointer("/headRepository/viewerPermission"))
        && raw.get("headRef").is_some_and(|v| !v.is_null());
    let comparison = if normalize::state(raw) == "open" {
        raw.pointer("/baseRef/compare")
    } else {
        None
    };
    let can_update_branch = comparison.is_some_and(|c| !c.is_null())
        && raw.get("viewerCanUpdateBranch") == Some(&Value::Bool(true));
    let mut actions = Vec::new();
    if can_delete {
        actions.push("delete-branch");
    }
    if can_write {
        actions.push("merge");
        if repo.get("autoMergeAllowed") == Some(&Value::Bool(true))
            && !matches!(
                text(raw, "mergeStateStatus"),
                "CLEAN" | "HAS_HOOKS" | "UNSTABLE"
            )
        {
            actions.push("enable-auto-merge");
        }
        actions.extend(["disable-auto-merge", "revert", "approve-workflows"]);
    }
    if can_update {
        actions.extend(["ready", "draft", "close", "reopen"]);
    }
    if can_update_branch {
        actions.push("update-branch");
    }
    let maintainer_edits = normalize::state(raw) == "open"
        && raw.get("isCrossRepository") == Some(&Value::Bool(true))
        && did_author
        && raw
            .pointer("/headRepositoryOwner/__typename")
            .and_then(Value::as_str)
            == Some("User")
        && raw.get("headRepository").is_some_and(|v| !v.is_null())
        && raw.get("headRef").is_some_and(|v| !v.is_null());
    let verdicts = if did_author {
        vec!["comment"]
    } else {
        vec!["comment", "approve", "request-changes"]
    };
    let mut permissions = json!({
        "actions": actions, "comment": true, "resolve": can_write || did_author,
        "verdicts": verdicts, "requestReviewers": can_write, "labels": can_triage, "maintainerEdits": maintainer_edits
    });
    if can_write {
        permissions["stackRebase"] = json!(true);
    }
    if can_update_branch {
        permissions["updateMethods"] = json!(["merge", "rebase"]);
    }
    permissions
}
