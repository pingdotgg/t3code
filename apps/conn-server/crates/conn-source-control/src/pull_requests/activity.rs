use super::{
    Client, Error, Lookup, generated,
    normalize::{self, array, cursor, nodes, text, trimmed},
    pull_request,
};
use serde_json::{Value, json};
fn reactions(raw: &Value, viewer: &str) -> Vec<Value> {
    array(raw.get("reactionGroups")).iter().filter_map(|group| {
        let content=match text(group,"content").trim().to_uppercase().as_str(){"THUMBS_UP"=>"thumbs-up","THUMBS_DOWN"=>"thumbs-down","LAUGH"=>"laugh","HOORAY"=>"hooray","CONFUSED"=>"confused","HEART"=>"heart","ROCKET"=>"rocket","EYES"=>"eyes",_=>return None};
        let reactors=group.get("reactors").unwrap_or(&Value::Null);
let logins:Vec<&str>=nodes(reactors).iter().map(|r|text(r,"login").trim()).filter(|s|!s.is_empty()).collect();
        let count=reactors.get("totalCount").and_then(Value::as_u64).unwrap_or(0).max(logins.len() as u64);
if count==0{return None;
}
        Some(json!({"content":content,"count":count,"actors":logins.into_iter().filter(|l|!l.eq_ignore_ascii_case(viewer)).collect::<Vec<_>>(),"viewerHasReacted":group.get("viewerHasReacted")==Some(&Value::Bool(true))}))
    }).collect()
}
fn thread_comment(raw: &Value, viewer: &str, host: &str) -> Value {
    let mut value = json!({"id":raw.get("id"),"author":normalize::actor(raw.get("author"),host),"body":raw.get("body"),"createdAt":raw.get("createdAt"),"editedAt":raw.get("lastEditedAt").unwrap_or(&Value::Null),"url":trimmed(raw.get("url")),"reactions":reactions(raw,viewer)});
    if let Some(url) = raw
        .pointer("/pullRequestReview/url")
        .filter(|v| !trimmed(Some(v)).is_null())
    {
        value["reviewUrl"] = url.clone();
    }
    value
}
fn threads(connection: &Value, viewer: &str, host: &str) -> Vec<Value> {
    nodes(connection).iter().filter_map(|thread|{
        let loaded=nodes(thread.get("comments").unwrap_or(&Value::Null));
let visible:Vec<_>=loaded.iter().filter(|c|c.get("isMinimized")!=Some(&Value::Bool(true))).collect();
        if text(thread,"path").trim().is_empty()||text(thread,"id").trim().is_empty()||visible.is_empty(){return None;
}
        let count=thread.pointer("/comments/totalCount").and_then(Value::as_u64).unwrap_or(loaded.len() as u64).saturating_sub((loaded.len()-visible.len()) as u64);
        let mut value=json!({"id":trimmed(thread.get("id")),"path":trimmed(thread.get("path")),"line":thread.get("line").filter(|l|l.as_u64().is_some_and(|n|n>0)),"side":if text(thread,"diffSide").eq_ignore_ascii_case("LEFT"){"left"}else{"right"},"isResolved":thread.get("isResolved"),"isOutdated":thread.get("isOutdated"),"comments":visible.into_iter().map(|c|thread_comment(c,viewer,host)).collect::<Vec<_>>(),"commentCount":count});
        let next=cursor(thread.get("comments").unwrap_or(&Value::Null));
if !next.is_null(){value["nextCommentsCursor"]=next;
}Some(value)
    }).collect()
}
fn commits(raw: &Value, host: &str) -> Vec<Value> {
    nodes(raw).iter().filter_map(|c|{
        let commit=c.get("commit")?;
 if text(commit,"oid").trim().is_empty()||text(commit,"committedDate").trim().is_empty(){return None;
}
        let authors:Vec<Value>=nodes(commit.get("authors").unwrap_or(&Value::Null)).iter().filter_map(|a|{
            let login=a.pointer("/user/login").and_then(Value::as_str).filter(|s|!s.trim().is_empty()).unwrap_or_else(||text(a,"name"));
            if login.trim().is_empty(){return None;
}Some(normalize::actor(Some(&json!({"login":login,"name":a.get("name"),"avatarUrl":a.get("avatarUrl")})),host))
        }).collect();
        Some(json!({"oid":commit.get("oid"),"messageHeadline":commit.get("messageHeadline"),"committedDate":commit.get("committedDate"),"authors":authors}))
    }).collect()
}
impl Client {
    pub async fn thread_comments(
        &self,
        lookup: &Lookup,
        thread_id: &str,
        after: Option<&str>,
    ) -> Result<Value, Error> {
        let mut vars = lookup.variables();
        vars["threadId"] = json!(thread_id);
        vars["after"] = json!(after);
        let result = self
            .graphql(&generated::REVIEW_THREAD_COMMENTS, vars)
            .await?;
        let node = result.get("node").unwrap_or(&Value::Null);
        let belongs = text(node, "__typename") == "PullRequestReviewThread"
            && node.pointer("/pullRequest/id").is_some()
            && node.pointer("/pullRequest/id") == result.pointer("/repository/pullRequest/id");
        if !belongs {
            return Err(Error::Failed(
                "The named subject did not belong to the named pull request.".into(),
            ));
        }
        let viewer = result
            .pointer("/viewer/login")
            .and_then(Value::as_str)
            .unwrap_or("");
        let connection = node.get("comments").unwrap_or(&Value::Null);
        let loaded = nodes(connection);
        let visible: Vec<_> = loaded
            .iter()
            .filter(|c| c.get("isMinimized") != Some(&Value::Bool(true)))
            .collect();
        Ok(
            json!({"comments":visible.iter().map(|c|thread_comment(c,viewer,&self.host)).collect::<Vec<_>>(),"hiddenCount":loaded.len()-visible.len(),"nextCursor":cursor(connection)}),
        )
    }
    pub async fn activity(&self, lookup: &Lookup) -> Result<Value, Error> {
        let mut vars = lookup.variables();
        let mut comments = Vec::new();
        let mut author = Value::Null;
        let mut commit_list = Vec::new();
        let mut ids = Vec::new();
        let mut comments_after = Value::Null;
        let mut reviews_after = Value::Null;
        let mut with_comments = true;
        let mut with_reviews = true;
        for page in 0..10 {
            vars["head"] = json!(page == 0);
            vars["withComments"] = json!(with_comments);
            vars["withReviews"] = json!(with_reviews);
            vars["commentsAfter"] = comments_after;
            vars["reviewsAfter"] = reviews_after;
            let result = self
                .graphql(&generated::PULL_REQUEST_ACTIVITY, vars.clone())
                .await?;
            let pr = pull_request(&result, lookup)?;
            if page == 0 {
                author = normalize::actor(pr.get("author"), &self.host);
                commit_list = commits(pr.get("commits").unwrap_or(&Value::Null), &self.host);
                ids = nodes(pr.get("commits").unwrap_or(&Value::Null))
                    .iter()
                    .filter(|n| {
                        n.pointer("/commit/parents/totalCount")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            <= 1
                    })
                    .filter_map(|n| n.pointer("/commit/id").cloned())
                    .collect();
            }
            for (key, review) in [("comments", false), ("reviews", true)] {
                for remark in nodes(pr.get(key).unwrap_or(&Value::Null)) {
                    if remark.get("isMinimized") == Some(&Value::Bool(true)) {
                        continue;
                    }
                    let created = if review {
                        remark.get("submittedAt")
                    } else {
                        remark.get("createdAt")
                    };
                    let verdict = matches!(
                        text(remark, "state"),
                        "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED"
                    );
                    if trimmed(created).is_null()
                        || (review && text(remark, "body").trim().is_empty() && !verdict)
                    {
                        continue;
                    }
                    comments.push(json!({"id":remark.get("id"),"kind":if review{"review"}else{"issue-comment"},"author":normalize::actor(remark.get("author"),&self.host),"body":text(remark,"body"),"createdAt":created,"editedAt":remark.get("lastEditedAt").unwrap_or(&Value::Null),"url":trimmed(remark.get("url")),"path":null,"reviewState":if review{trimmed(remark.get("state"))}else{Value::Null}}));
                }
            }
            comments_after = cursor(pr.get("comments").unwrap_or(&Value::Null));
            reviews_after = cursor(pr.get("reviews").unwrap_or(&Value::Null));
            with_comments &= !comments_after.is_null();
            with_reviews &= !reviews_after.is_null();
            if !with_comments && !with_reviews {
                break;
            }
        }
        if !ids.is_empty()
            && let Ok(stats) = self
                .graphql(&generated::PULL_REQUEST_COMMIT_STATS, json!({"ids":ids}))
                .await
        {
            for stat in array(stats.get("nodes")) {
                if let Some(commit) = commit_list
                    .iter_mut()
                    .find(|c| text(c, "oid") == text(stat, "oid"))
                {
                    commit["additions"] = json!(
                        stat.get("additions")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                            .max(0)
                    );
                    commit["deletions"] = json!(
                        stat.get("deletions")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                            .max(0)
                    );
                }
            }
        }
        let mut thread_vars = lookup.variables();
        thread_vars["requestedReviewers"] = json!(50);
        let first = self
            .graphql(&generated::REVIEW_THREADS, thread_vars.clone())
            .await;
        let mut review_threads = Vec::new();
        let mut reviewers = Vec::new();
        let mut pr_reactions = Vec::new();
        let mut thread_truncated = true;
        let mut dismissal_map = std::collections::BTreeMap::new();
        if let Ok(first) = first {
            let pr = pull_request(&first, lookup)?;
            let viewer = first
                .pointer("/viewer/login")
                .and_then(Value::as_str)
                .unwrap_or("");
            pr_reactions = reactions(pr, viewer);
            let mut dismissal_connection =
                pr.get("reviewDismissals").cloned().unwrap_or(Value::Null);
            for _ in 0..10 {
                for d in nodes(&dismissal_connection) {
                    if let Some(id) = d.pointer("/review/id").and_then(Value::as_str) {
                        dismissal_map.insert(id.to_owned(), trimmed(d.get("dismissalMessage")));
                    }
                }
                let after = cursor(&dismissal_connection);
                if after.is_null() {
                    break;
                }
                thread_vars["after"] = after;
                let next = self
                    .graphql(&generated::REVIEW_DISMISSALS, thread_vars.clone())
                    .await?;
                dismissal_connection = next
                    .pointer("/repository/pullRequest/timelineItems")
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            for comment in &mut comments {
                let raw = nodes(
                    pr.get(if text(comment, "kind") == "review" {
                        "reviews"
                    } else {
                        "comments"
                    })
                    .unwrap_or(&Value::Null),
                )
                .iter()
                .find(|r| r.get("id") == comment.get("id"));
                if let Some(raw) = raw {
                    comment["reactions"] = json!(reactions(raw, viewer));
                    if !trimmed(raw.get("lastEditedAt")).is_null() {
                        comment["editedAt"] = trimmed(raw.get("lastEditedAt"));
                    }
                    if let Some(a) = raw.get("author").filter(|a| !a.is_null()) {
                        comment["author"] = normalize::actor(Some(a), &self.host);
                    }
                }
            }
            for candidate in nodes(pr.get("reviewRequests").unwrap_or(&Value::Null))
                .iter()
                .filter_map(|r| r.get("requestedReviewer"))
                .chain(
                    nodes(pr.get("latestReviews").unwrap_or(&Value::Null))
                        .iter()
                        .filter(|r| r.get("isMinimized") != Some(&Value::Bool(true)))
                        .filter_map(|r| r.get("author")),
                )
            {
                let mut actor = normalize::actor(Some(candidate), &self.host);
                if actor.is_null() && !text(candidate, "combinedSlug").is_empty() {
                    actor = json!({"login":text(candidate,"combinedSlug"),"name":trimmed(candidate.get("teamName")),"avatarUrl":trimmed(candidate.get("teamAvatarUrl"))});
                }
                if !actor.is_null()
                    && !reviewers
                        .iter()
                        .any(|r: &Value| r.get("login") == actor.get("login"))
                {
                    reviewers.push(actor);
                }
            }
            let mut connection = pr.get("reviewThreads").cloned().unwrap_or(Value::Null);
            for _ in 0..10 {
                review_threads.extend(threads(&connection, viewer, &self.host));
                let next = cursor(&connection);
                thread_truncated = !next.is_null();
                if next.is_null() {
                    break;
                }
                thread_vars["after"] = next;
                let page = self
                    .graphql(&generated::REVIEW_THREAD_PAGES, thread_vars.clone())
                    .await?;
                connection = page
                    .pointer("/repository/pullRequest/reviewThreads")
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            let enriched = commits(pr.get("commits").unwrap_or(&Value::Null), &self.host);
            if !enriched.is_empty() {
                for commit in &mut commit_list {
                    if let Some(other) = enriched.iter().find(|c| c.get("oid") == commit.get("oid"))
                    {
                        commit["authors"] =
                            other.get("authors").cloned().unwrap_or_else(|| json!([]));
                    }
                }
            }
        } else if let Err(error) = first
            && matches!(error, Error::RateLimited)
        {
            return Err(error);
        }
        let comment_count = comments.len() as u64
            + review_threads
                .iter()
                .filter_map(|t| t.get("commentCount").and_then(Value::as_u64))
                .sum::<u64>();
        for thread in &review_threads {
            for c in array(thread.get("comments")) {
                comments.push(json!({"id":c.get("id"),"kind":"review-comment","author":c.get("author"),"body":c.get("body"),"createdAt":c.get("createdAt"),"editedAt":c.get("editedAt"),"url":c.get("url"),"path":thread.get("path"),"reviewState":null,"reactions":c.get("reactions")}));
            }
        }
        for comment in &mut comments {
            if text(comment, "kind") == "review"
                && text(comment, "reviewState") == "DISMISSED"
                && text(comment, "body").trim().is_empty()
                && let Some(body) = dismissal_map.get(text(comment, "id"))
            {
                comment["body"] = body.clone();
            }
            if comment.get("reactions").is_none() {
                comment["reactions"] = json!([]);
            }
        }
        comments.sort_by(|a, b| text(a, "createdAt").cmp(text(b, "createdAt")));
        let truncated = with_comments
            || with_reviews
            || thread_truncated
            || review_threads
                .iter()
                .any(|t| t.get("nextCommentsCursor").is_some());
        Ok(
            json!({"author":author,"reviewers":reviewers,"comments":comments,"commentCount":comment_count,"commentsTruncated":truncated,"reviewThreadsTruncated":thread_truncated,"reviewThreads":review_threads,"commits":commit_list,"reactions":pr_reactions}),
        )
    }
}
