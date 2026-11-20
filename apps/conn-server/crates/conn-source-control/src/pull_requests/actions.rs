//! GitHub panel writes and candidate reads, with fresh access checks for every operation.

use super::normalize::{array, nodes, text, trimmed};
use super::{Client, Error, Lookup, generated};
use crate::http::Method;
use serde_json::{Value, json};

/// Successful writes refresh the panel; failed writes still discard stale reads.
pub fn is_mutation(method: &str) -> bool {
    matches!(
        method,
        "comment"
            | "replyToThread"
            | "updateComment"
            | "setReaction"
            | "setThreadResolution"
            | "submitReview"
            | "requestReviewers"
            | "setLabels"
            | "update"
    )
}

/// Rejects empty writes before resolving a project or a GitHub credential.
pub fn validate(method: &str, input: &Value) -> Result<(), Error> {
    let detail = match method {
        "comment" | "updateComment" if text(input, "body").trim().is_empty() => {
            Some("A comment cannot be empty.")
        }
        "replyToThread" if text(input, "body").trim().is_empty() => {
            Some("A reply cannot be empty.")
        }
        "update"
            if ["title", "body", "maintainerCanModify"]
                .iter()
                .all(|key| input.get(key).is_none()) =>
        {
            Some("Nothing was changed.")
        }
        "submitReview"
            if text(input, "verdict") != "approve"
                && text(input, "body").trim().is_empty()
                && array(input.get("comments")).is_empty() =>
        {
            Some("A review needs a summary or at least one comment.")
        }
        _ => None,
    };
    detail.map_or(Ok(()), |detail| Err(Error::Failed(detail.into())))
}

impl Client {
    /// Pins permissions and writes to this client's credential; candidate reads bypass panel caches.
    pub async fn action(
        &self,
        lookup: &Lookup,
        method: &str,
        input: &Value,
    ) -> Result<Value, Error> {
        validate(method, input)?;
        if matches!(
            method,
            "comment"
                | "replyToThread"
                | "setThreadResolution"
                | "submitReview"
                | "requestReviewers"
                | "reviewerCandidates"
                | "labelCandidates"
                | "setLabels"
        ) {
            let result = self
                .graphql(&generated::VIEWER_PERMISSIONS, lookup.variables())
                .await?;
            let repo = result
                .get("repository")
                .filter(|v| !v.is_null())
                .ok_or_else(|| {
                    Error::NotFound(format!(
                        "Pull request #{} was not found in {}/{}.",
                        lookup.number, lookup.owner, lookup.name
                    ))
                })?;
            let write = super::detail::can_write_permission(repo.get("viewerPermission"));
            let author = repo.pointer("/pullRequest/viewerDidAuthor") == Some(&Value::Bool(true));
            let refusal = match method {
                "requestReviewers" | "reviewerCandidates" if !write => {
                    Some("You need write access on this repository to ask for a review.")
                }
                "labelCandidates" | "setLabels"
                    if !write
                        && text(repo, "viewerPermission").trim().to_uppercase() != "TRIAGE" =>
                {
                    Some("You need triage access on this repository to change its labels.")
                }
                "setThreadResolution" if !write && !author => Some(
                    "You need write access on this repository, or to have opened this change request, to resolve a review conversation.",
                ),
                "submitReview" if author && text(input, "verdict") == "approve" => {
                    Some("You need write access on this repository to approve a change request.")
                }
                "submitReview" if author && text(input, "verdict") == "request-changes" => Some(
                    "You need write access on this repository to request changes on a change request.",
                ),
                _ => None,
            };
            if let Some(detail) = refusal {
                return Err(Error::Failed(detail.into()));
            }
        }
        let body = input.get("body").cloned().unwrap_or(Value::Null);
        match method {
            "comment" => {
                let id = self.node_id(lookup).await?;
                self.graphql(&generated::ADD_COMMENT, json!({"subjectId":id,"body":body}))
                    .await?;
            }
            "replyToThread" => {
                self.graphql(
                    &generated::ADD_REVIEW_THREAD_REPLY,
                    json!({"threadId":input.get("threadId"),"body":body}),
                )
                .await?;
            }
            "setThreadResolution" => {
                self.graphql(
                    if input.get("resolved") == Some(&Value::Bool(true)) {
                        &generated::RESOLVE_REVIEW_THREAD
                    } else {
                        &generated::UNRESOLVE_REVIEW_THREAD
                    },
                    json!({"threadId":input.get("threadId")}),
                )
                .await?;
            }
            "setReaction" => {
                let id = if let Some(id) = input.get("subjectId") {
                    self.check_subject(lookup, id).await?;
                    id.clone()
                } else {
                    self.node_id(lookup).await?
                };
                let content = match text(input, "content") {
                    "thumbs-up" => "THUMBS_UP",
                    "thumbs-down" => "THUMBS_DOWN",
                    "laugh" => "LAUGH",
                    "hooray" => "HOORAY",
                    "confused" => "CONFUSED",
                    "heart" => "HEART",
                    "rocket" => "ROCKET",
                    "eyes" => "EYES",
                    _ => return Err(Error::Failed("Unknown reaction.".into())),
                };
                self.graphql(
                    if input.get("reacted") == Some(&Value::Bool(true)) {
                        &generated::ADD_REACTION
                    } else {
                        &generated::REMOVE_REACTION
                    },
                    json!({"subjectId":id,"content":content}),
                )
                .await?;
            }
            "updateComment" => {
                let id = input.get("commentId").cloned().unwrap_or(Value::Null);
                self.check_subject(lookup, &id).await?;
                self.graphql(
                    if text(input, "kind") == "issue-comment" {
                        &generated::UPDATE_ISSUE_COMMENT
                    } else {
                        &generated::UPDATE_REVIEW_COMMENT
                    },
                    json!({"commentId":id,"body":body}),
                )
                .await?;
            }
            "update" => {
                let mut variables = json!({"pullRequestId":self.node_id(lookup).await?});
                if let Some(fields) = variables.as_object_mut() {
                    for key in ["title", "body", "maintainerCanModify"] {
                        if let Some(value) = input.get(key) {
                            fields.insert(key.into(), value.clone());
                        }
                    }
                }
                self.graphql(&generated::UPDATE_PULL_REQUEST, variables)
                    .await?;
            }
            "submitReview" => {
                self.write(
                    Method::Post,
                    &format!("{}/reviews", lookup.path()),
                    Some(review_submission(input)?),
                )
                .await?;
            }
            "requestReviewers" => {
                self.write(
                    if input.get("requested") == Some(&Value::Bool(true)) {
                        Method::Post
                    } else {
                        Method::Delete
                    },
                    &format!("{}/requested_reviewers", lookup.path()),
                    Some(reviewer_request(array(input.get("reviewers")))),
                )
                .await?;
            }
            "setLabels" => {
                let path = format!(
                    "repos/{}/{}/issues/{}/labels",
                    lookup.owner, lookup.name, lookup.number
                );
                if input.get("applied") == Some(&Value::Bool(true)) {
                    self.write(
                        Method::Post,
                        &path,
                        Some(json!({"labels":input.get("labels")})),
                    )
                    .await?;
                } else {
                    for label in array(input.get("labels")) {
                        let label = label
                            .as_str()
                            .ok_or_else(|| Error::Failed("Invalid label.".into()))?;
                        self.write(
                            Method::Delete,
                            &format!("{path}/{}", super::diff::encode(label)),
                            None,
                        )
                        .await?;
                    }
                }
            }
            "reviewerCandidates" => {
                let mut vars = lookup.variables();
                vars["query"] = input.get("query").cloned().unwrap_or(Value::Null);
                let result = self.graphql(&generated::REVIEWER_CANDIDATES, vars).await?;
                return reviewer_candidates(&result, input.get("query").and_then(Value::as_str))
                    .ok_or_else(|| {
                        Error::NotFound(format!(
                            "Pull request #{} was not found in {}/{}.",
                            lookup.number, lookup.owner, lookup.name
                        ))
                    });
            }
            "labelCandidates" => {
                let result = self
                    .graphql(&generated::LABEL_CANDIDATES, lookup.variables())
                    .await?;
                return label_candidates(&result).ok_or_else(|| {
                    Error::NotFound(format!(
                        "Pull request #{} was not found in {}/{}.",
                        lookup.number, lookup.owner, lookup.name
                    ))
                });
            }
            _ => return Err(Error::Failed("Unsupported pull request operation.".into())),
        }
        Ok(Value::Null)
    }

    pub(super) async fn node_id(&self, lookup: &Lookup) -> Result<Value, Error> {
        let result = self
            .graphql(&generated::PULL_REQUEST_NODE_ID, lookup.variables())
            .await?;
        super::run_action::found(&result)?
            .get("id")
            .filter(|id| id.is_string())
            .cloned()
            .ok_or_else(|| Error::Failed("The pull request's node id could not be read.".into()))
    }

    async fn check_subject(&self, lookup: &Lookup, id: &Value) -> Result<(), Error> {
        let mut vars = lookup.variables();
        vars["subjectId"] = id.clone();
        let result = self.graphql(&generated::PULL_REQUEST_SUBJECT, vars).await?;
        if subject_belongs(&result) {
            Ok(())
        } else {
            Err(Error::Failed(
                "The named subject did not belong to the named pull request.".into(),
            ))
        }
    }

    async fn write(&self, method: Method, path: &str, body: Option<Value>) -> Result<(), Error> {
        self.request(
            method,
            path,
            body,
            "application/vnd.github+json",
            8 * 1024 * 1024,
        )
        .await?;
        Ok(())
    }
}

pub(super) fn subject_belongs(result: &Value) -> bool {
    let expected = result
        .pointer("/repository/pullRequest/id")
        .and_then(Value::as_str);
    let node = result.get("node").unwrap_or(&Value::Null);
    let actual = match text(node, "__typename") {
        "IssueComment" => node.pointer("/pullRequest/id"),
        "PullRequestReviewComment" => node.pointer("/reviewCommentPullRequest/id"),
        "PullRequestReview" => node.pointer("/reviewPullRequest/id"),
        _ => node.get("id"),
    }
    .and_then(Value::as_str);
    expected.is_some() && expected == actual
}

pub(super) fn review_submission(input: &Value) -> Result<Value, Error> {
    let event = match text(input, "verdict") {
        "approve" => "APPROVE",
        "request-changes" => "REQUEST_CHANGES",
        "comment" => "COMMENT",
        _ => return Err(Error::Failed("Unknown review verdict.".into())),
    };
    let comments = array(input.get("comments")).iter().map(|comment| {
        let end = position(comment.get("position").unwrap_or(&Value::Null))?;
        let mut out = json!({"path":comment.get("path"),"body":comment.get("body"),"line":end.0,"side":end.1});
        if let Some(start) = comment.get("startPosition").map(position).transpose()? && start != end {
            out["start_line"] = json!(start.0);
            out["start_side"] = json!(start.1);
        }
        Ok(out)
    }).collect::<Result<Vec<_>,Error>>()?;
    Ok(json!({"event":event,"body":input.get("body"),"comments":comments}))
}

fn position(value: &Value) -> Result<(u64, &'static str), Error> {
    let left = text(value, "kind") == "deleted"
        || (text(value, "kind") == "context" && text(value, "side") == "left");
    let line = value
        .get(if left { "oldLine" } else { "newLine" })
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(|| Error::Failed("Invalid review position.".into()))?;
    Ok((line, if left { "LEFT" } else { "RIGHT" }))
}

pub(super) fn reviewer_request(reviewers: &[Value]) -> Value {
    json!({"reviewers":reviewers.iter().filter(|r|text(r,"kind")=="user").map(|r|r.get("id")).collect::<Vec<_>>(),"team_reviewers":reviewers.iter().filter(|r|text(r,"kind")=="team").map(|r|r.get("id")).collect::<Vec<_>>()})
}

pub(super) fn reviewer_candidates(result: &Value, query: Option<&str>) -> Option<Value> {
    let repo = result.get("repository").filter(|v| !v.is_null())?;
    let pr = repo.get("pullRequest").unwrap_or(&Value::Null);
    let author = trimmed(pr.pointer("/author/login"));
    let mut candidates: Vec<Value> = Vec::new();
    for request in nodes(pr.get("reviewRequests").unwrap_or(&Value::Null)) {
        let raw = request.get("requestedReviewer").unwrap_or(&Value::Null);
        let slug = trimmed(raw.get("slug"));
        let team = !slug.is_null();
        let id = if team {
            slug
        } else {
            trimmed(raw.get("login"))
        };
        if id.is_null() {
            continue;
        }
        let kind = if team { "team" } else { "user" };
        let login = trimmed(raw.get("combinedSlug"));
        let candidate = json!({"id":id,"kind":kind,"login":if team&&!login.is_null(){login}else{id.clone()},"name":trimmed(raw.get(if team{"teamName"}else{"name"})),"avatarUrl":trimmed(raw.get(if team{"teamAvatarUrl"}else{"avatarUrl"})),"isRequested":true});
        if let Some(existing) = candidates
            .iter_mut()
            .find(|c| c.get("id") == Some(&id) && text(c, "kind") == kind)
        {
            *existing = candidate;
        } else {
            candidates.push(candidate);
        }
    }
    let users = nodes(repo.get("assignableUsers").unwrap_or(&Value::Null));
    for user in users {
        let login = trimmed(user.get("login"));
        if login.is_null()
            || login == author
            || candidates
                .iter()
                .any(|c| text(c, "kind") == "user" && c.get("id") == Some(&login))
        {
            continue;
        }
        candidates.push(json!({"id":login,"kind":"user","login":login,"name":trimmed(user.get("name")),"avatarUrl":trimmed(user.get("avatarUrl")),"isRequested":false}));
    }
    if query.is_some_and(|q| !q.trim().is_empty()) {
        candidates.retain(|c| {
            text(c, "kind") == "user"
                && users
                    .iter()
                    .any(|u| trimmed(u.get("login")) == c.get("id").cloned().unwrap_or(Value::Null))
        });
    }
    Some(
        json!({"candidates":candidates,"truncated":repo.pointer("/assignableUsers/pageInfo/hasNextPage")==Some(&Value::Bool(true))}),
    )
}

pub(super) fn label_candidates(result: &Value) -> Option<Value> {
    let repo = result.get("repository").filter(|v| !v.is_null())?;
    let mut applied = Vec::new();
    for node in nodes(repo.pointer("/pullRequest/labels").unwrap_or(&Value::Null)) {
        let name = trimmed(node.get("name"));
        if !name.is_null() && !applied.contains(&name) {
            applied.push(name);
        }
    }
    let mut candidates: Vec<Value> = Vec::new();
    for node in nodes(repo.get("labels").unwrap_or(&Value::Null)) {
        let name = trimmed(node.get("name"));
        if name.is_null() {
            continue;
        }
        let candidate = json!({"name":name,"color":trimmed(node.get("color")),"description":trimmed(node.get("description")),"isApplied":applied.contains(&name)});
        if let Some(existing) = candidates.iter_mut().find(|c| c.get("name") == Some(&name)) {
            *existing = candidate;
        } else {
            candidates.push(candidate);
        }
    }
    let missing = applied
        .into_iter()
        .filter(|name| !candidates.iter().any(|c| c.get("name") == Some(name)))
        .map(|name| json!({"name":name,"color":null,"description":null,"isApplied":true}));
    let all: Vec<Value> = missing.chain(candidates.iter().cloned()).collect();
    Some(
        json!({"candidates":all,"truncated":repo.pointer("/labels/pageInfo/hasNextPage")==Some(&Value::Bool(true))}),
    )
}
