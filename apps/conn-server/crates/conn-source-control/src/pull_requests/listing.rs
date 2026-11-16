//! Repository pages, completion options, and T3's timestamp-boundary cursors.
use super::{
    Client, Error, Lookup, generated,
    normalize::{self, array, cursor, nodes, text, trimmed},
};
use crate::hosts::github_graphql::Operation;
use serde_json::{Value, json};
fn phrase(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
fn qualifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "").trim())
}

#[derive(Clone, Debug)]
pub struct Cursor {
    boundary: String,
    delivered: u64,
    seen: Vec<u64>,
}
impl Cursor {
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let mut parts = raw.split('|');
        let boundary = parts.next().unwrap_or("");
        let delivered = parts
            .next()
            .and_then(|s| if s.len() <= 9 { s.parse().ok() } else { None });
        let seen = parts.next().unwrap_or("");
        let timestamp = valid_boundary(boundary);
        let seen = if seen.is_empty() {
            Some(Vec::new())
        } else {
            seen.split(',')
                .map(|s| if s.len() <= 9 { s.parse().ok() } else { None })
                .collect::<Option<Vec<u64>>>()
        };
        match (delivered, seen) {
            (Some(delivered), Some(seen))
                if timestamp
                    && parts.next().is_none_or(|resume| {
                        !resume.is_empty()
                            && resume.len() <= 128
                            && resume
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"_.:~+-".contains(&b))
                    })
                    && parts.next().is_none() =>
            {
                Ok(Self {
                    boundary: boundary.into(),
                    delivered,
                    seen,
                })
            }
            _ => Err(Error::Failed(
                "The list could not be carried on from where it left off.".into(),
            )),
        }
    }
    fn next(&self, items: &[Value], delivered: usize) -> Option<String> {
        let boundary = items.iter().map(|i| text(i, "updatedAt")).min()?;
        let mut seen = if boundary == self.boundary {
            self.seen.clone()
        } else {
            Vec::new()
        };
        for n in items
            .iter()
            .filter(|i| text(i, "updatedAt") == boundary)
            .filter_map(|i| i.get("number").and_then(Value::as_u64))
        {
            if !seen.contains(&n) {
                seen.push(n);
            }
        }
        Some(format!(
            "{boundary}|{}|{}",
            self.delivered + delivered as u64,
            seen.iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(",")
        ))
    }
}
fn valid_boundary(value: &str) -> bool {
    if conn_support::time::millis_from_iso(value).is_none() {
        return false;
    }
    let Some((date, time)) = value.split_once('T') else {
        return false;
    };
    if date.len() != 10 || date.split('-').map(str::len).collect::<Vec<_>>() != [4, 2, 2] {
        return false;
    }
    let time = time
        .trim_end_matches('Z')
        .split(['+', '-'])
        .next()
        .unwrap_or("");
    let fields: Vec<_> = time.split(':').collect();
    if fields.len() != 3 {
        return false;
    }
    let (seconds, fraction) = fields
        .last()
        .copied()
        .unwrap_or("")
        .split_once('.')
        .map_or((fields.last().copied().unwrap_or(""), None), |(s, f)| {
            (s, Some(f))
        });
    fields.first().is_some_and(|v| v.len() == 2)
        && fields.get(1).is_some_and(|v| v.len() == 2)
        && seconds.len() == 2
        && fraction.is_none_or(|v| (1..=9).contains(&v.len()))
}
fn filter_query(input: &Value, viewer: &str) -> Vec<String> {
    let Some(f) = input.get("filters") else {
        return Vec::new();
    };
    let mut values = Vec::new();
    for group in array(f.get("labels")) {
        let names: Vec<_> = array(Some(group))
            .iter()
            .filter_map(Value::as_str)
            .map(qualifier)
            .collect();
        if !names.is_empty() {
            values.push(format!("label:{}", names.join(",")));
        }
    }
    for name in array(f.get("excludedLabels"))
        .iter()
        .filter_map(Value::as_str)
    {
        values.push(format!("-label:{}", qualifier(name)));
    }
    if let Some(a) = f.get("author").and_then(Value::as_str) {
        values.push(format!(
            "author:{}",
            qualifier(
                if a.trim().trim_start_matches('@').eq_ignore_ascii_case("me") {
                    viewer
                } else {
                    a
                }
            )
        ));
    }
    if let Some(d) = f.get("draft").and_then(Value::as_str) {
        values.push(format!("draft:{}", d == "only"));
    }
    if let Some(r) = f.get("review").and_then(Value::as_str) {
        values.push(format!(
            "review:{}",
            match r {
                "changes-requested" => "changes_requested",
                "review-required" => "required",
                r => r,
            }
        ));
    }
    if let Some(c) = f.get("checks").and_then(Value::as_str) {
        values.push(format!(
            "status:{}",
            if c == "passing" { "success" } else { "failure" }
        ));
    }
    values
}
fn query(repository: &str, input: &Value, viewer: &str, previous: Option<&Cursor>) -> String {
    let mut parts = vec!["is:pr".into()];
    match text(input, "state") {
        "open" => parts.push("is:open".into()),
        "closed" => parts.extend(["is:closed".into(), "is:unmerged".into()]),
        "merged" => parts.push("is:merged".into()),
        _ => {}
    }
    match text(input, "involvement") {
        "authored" => parts.push(format!("author:{viewer}")),
        "reviewing" => parts.push(format!("review-requested:{viewer}")),
        _ => {}
    }
    let q = text(input, "query").trim();
    if !q.is_empty() {
        parts.push(phrase(q));
    }
    if let Some(c) = previous {
        parts.push(format!("updated:<= {}", c.boundary).replace("<= ", "<="));
    }
    parts.extend(filter_query(input, viewer));
    parts.push("sort:updated-desc".into());
    parts.push(format!("repo:{repository}"));
    parts.join(" ")
}
pub fn matches(item: &Value, input: &Value, viewer: &str) -> bool {
    if !["all", ""].contains(&text(input, "state")) && text(input, "state") != text(item, "state") {
        return false;
    }
    let logins = array(item.get("reviewRequestLogins"));
    let author = item
        .pointer("/author/login")
        .and_then(Value::as_str)
        .unwrap_or("");
    match text(input, "involvement") {
        "authored" if !author.eq_ignore_ascii_case(viewer) => return false,
        "reviewing"
            if item.get("hasTeamReviewRequest") != Some(&Value::Bool(true))
                && !logins
                    .iter()
                    .any(|n| n.as_str().is_some_and(|s| s.eq_ignore_ascii_case(viewer))) =>
        {
            return false;
        }
        _ => {}
    }
    let Some(f) = input.get("filters") else {
        return true;
    };
    if let Some(d) = f.get("draft")
        && item.get("isDraft").and_then(Value::as_bool) != Some(d.as_str() == Some("only"))
    {
        return false;
    }
    if let Some(r) = f.get("review")
        && ((r.as_str() == Some("none") && !item.get("reviewDecision").is_none_or(Value::is_null))
            || (r.as_str() != Some("none") && item.get("reviewDecision") != Some(r)))
    {
        return false;
    }
    if let Some(c) = f.get("checks")
        && item.get("checksState") != Some(c)
    {
        return false;
    }
    if let Some(a) = f.get("author").and_then(Value::as_str) {
        let a = if a.trim().trim_start_matches('@').eq_ignore_ascii_case("me") {
            viewer
        } else {
            a
        };
        if !author.eq_ignore_ascii_case(a) {
            return false;
        }
    }
    let holds = |name: &Value| {
        array(item.get("labels")).iter().any(|l| {
            text(l, "name")
                .trim()
                .eq_ignore_ascii_case(name.as_str().unwrap_or("").trim())
        })
    };
    array(f.get("labels"))
        .iter()
        .all(|group| array(Some(group)).iter().any(holds))
        && !array(f.get("excludedLabels")).iter().any(holds)
}
pub fn row(raw: &Value, host: &str) -> Option<Value> {
    if raw
        .get("number")
        .and_then(Value::as_u64)
        .is_none_or(|n| n == 0)
        || [
            "title",
            "url",
            "headRefName",
            "baseRefName",
            "createdAt",
            "updatedAt",
        ]
        .iter()
        .any(|k| text(raw, k).trim().is_empty())
    {
        return None;
    }
    let mut value = normalize::summary(raw, host);
    value["additions"] = raw.get("additions").cloned().unwrap_or_else(|| json!(0));
    value["deletions"] = raw.get("deletions").cloned().unwrap_or_else(|| json!(0));
    if let Some(o) = value.as_object_mut() {
        for key in ["closedAt", "mergedAt", "changedFiles"] {
            o.remove(key);
        }
    }
    value["createdAt"] = raw.get("createdAt").cloned().unwrap_or(Value::Null);
    value["labels"] = json!(normalize::labels(raw.get("labels").unwrap_or(&Value::Null)));
    let requests: Vec<_> = nodes(raw.get("reviewRequests").unwrap_or(&Value::Null))
        .iter()
        .filter_map(|n| n.get("requestedReviewer"))
        .collect();
    value["reviewRequestLogins"] = json!(
        requests
            .iter()
            .filter_map(|r| r.get("login"))
            .collect::<Vec<_>>()
    );
    value["hasTeamReviewRequest"] = json!(requests.iter().any(|r| !text(r, "slug").is_empty()));
    Some(value)
}
struct ListPage {
    items: Vec<Value>,
    fetched: Vec<Value>,
    truncated: bool,
}
struct PageRequest<'a> {
    operation: &'a Operation,
    variables: Value,
    connection: &'static str,
    limit: usize,
}
impl Client {
    pub async fn list(
        &self,
        repository: &str,
        input: &Value,
        viewer: &str,
        previous: Option<&Cursor>,
    ) -> Result<Value, Error> {
        let lookup = Lookup::new(repository, 1)?;
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(99)
            .min(500) as usize;
        let search = PageRequest {
            operation: &generated::PULL_REQUEST_SEARCH,
            variables: json!({"q":query(repository,input,viewer,previous),"first":100,"stacks":self.host=="github.com","stats":false}),
            connection: "/search",
            limit,
        };
        let mut page = self.list_pages(search, input, viewer, previous).await?;
        if page.items.is_empty() && previous.is_none() && text(input, "query").is_empty() {
            let states = match text(input, "state") {
                "open" => json!(["OPEN"]),
                "closed" => json!(["CLOSED"]),
                "merged" => json!(["MERGED"]),
                _ => Value::Null,
            };
            let repository = PageRequest {
                operation: &generated::PULL_REQUEST_LIST,
                variables: json!({"owner":lookup.owner,"name":lookup.name,"states":states,"first":100,"stacks":self.host=="github.com","stats":true}),
                connection: "/repository/pullRequests",
                limit,
            };
            page = self.list_pages(repository, input, viewer, None).await?;
        }
        let ListPage {
            mut items,
            fetched,
            truncated,
        } = page;
        items.sort_by(|a, b| text(b, "updatedAt").cmp(text(a, "updatedAt")));
        items.truncate(limit);
        let empty = Cursor {
            boundary: String::new(),
            delivered: 0,
            seen: Vec::new(),
        };
        let next = if truncated {
            previous.unwrap_or(&empty).next(
                if items.len() < limit {
                    &fetched
                } else {
                    &items
                },
                items.len(),
            )
        } else {
            None
        };
        Ok(json!({"items":items,"truncated":truncated,"nextCursor":next}))
    }
    async fn list_pages(
        &self,
        mut request: PageRequest<'_>,
        input: &Value,
        viewer: &str,
        previous: Option<&Cursor>,
    ) -> Result<ListPage, Error> {
        let mut page = ListPage {
            items: Vec::new(),
            fetched: Vec::new(),
            truncated: false,
        };
        request.variables["after"] = Value::Null;
        for _ in 0..10 {
            let result = self
                .graphql(request.operation, request.variables.clone())
                .await?;
            let connection = result.pointer(request.connection).unwrap_or(&Value::Null);
            let rows: Vec<_> = nodes(connection)
                .iter()
                .filter_map(|r| row(r, &self.host))
                .collect();
            page.items.extend(
                rows.iter()
                    .filter(|row| {
                        matches(row, input, viewer)
                            && previous.is_none_or(|cursor| {
                                text(row, "updatedAt") != cursor.boundary
                                    || !cursor.seen.contains(
                                        &row.get("number").and_then(Value::as_u64).unwrap_or(0),
                                    )
                            })
                    })
                    .cloned(),
            );
            page.fetched.extend(rows);
            let after = cursor(connection);
            page.truncated = !after.is_null() || page.items.len() > request.limit;
            if page.items.len() > request.limit || after.is_null() {
                break;
            }
            request.variables["after"] = after;
        }
        Ok(page)
    }
    pub async fn filter_options(&self, repository: &str, input: &Value) -> Result<Value, Error> {
        let lookup = Lookup::new(repository, 1)?;
        let kind = text(input, "kind");
        let query = text(input, "query").trim();
        let mut vars = lookup.variables();
        vars["query"] = if query.is_empty() {
            Value::Null
        } else {
            json!(query)
        };
        let operation = match kind {
            "labels" => &generated::REPOSITORY_LABELS,
            "authors" => &generated::REPOSITORY_AUTHORS,
            _ => &generated::REPOSITORY_REFERENCES,
        };
        if kind == "references" {
            if text(input, "sigil") == "!" {
                return Ok(json!({"items":[],"truncated":false}));
            }
            let number = query
                .parse::<u32>()
                .ok()
                .filter(|n| *n > 0 && *n <= 2_147_483_647);
            vars["q"] = json!(
                if query.is_empty() || query.bytes().all(|b| b.is_ascii_digit()) {
                    format!("repo:{repository} sort:updated-desc")
                } else {
                    format!(
                        "repo:{repository} in:title {} sort:updated-desc",
                        phrase(query)
                    )
                }
            );
            vars["number"] = json!(number.unwrap_or(1));
            vars["exact"] = json!(number.is_some());
        }
        let result = self.graphql(operation, vars).await?;
        let conn = match kind {
            "labels" => result.pointer("/repository/labels"),
            "authors" => result.pointer("/repository/mentionableUsers"),
            _ => result.get("search"),
        }
        .unwrap_or(&Value::Null);
        let mut raws = nodes(conn).to_vec();
        if kind == "references"
            && let Some(exact) = result
                .pointer("/repository/issueOrPullRequest")
                .filter(|v| !v.is_null())
        {
            raws.insert(0, exact.clone());
        }
        let items: Vec<_> = raws
            .iter()
            .filter_map(|raw| filter_option(raw, kind, &self.host))
            .collect();

        Ok(
            json!({"items":items,"truncated":conn.pointer("/pageInfo/hasNextPage")==Some(&Value::Bool(true))}),
        )
    }
}

fn filter_option(raw: &Value, kind: &str, host: &str) -> Option<Value> {
    match kind {
        "labels" => (!trimmed(raw.get("name")).is_null())
            .then(|| json!({"name":trimmed(raw.get("name")),"color":trimmed(raw.get("color"))})),
        "authors" => {
            let actor = normalize::actor(Some(raw), host);
            (!actor.is_null()).then_some(actor)
        }
        _ => {
            let (kind, state) = match text(raw, "__typename") {
                "Issue" => (
                    "issue",
                    if text(raw, "issueState") == "OPEN" {
                        "open"
                    } else {
                        "closed"
                    },
                ),
                "PullRequest" => (
                    "change-request",
                    match text(raw, "pullRequestState") {
                        "OPEN" => "open",
                        "CLOSED" => "closed",
                        _ => "merged",
                    },
                ),
                _ => return None,
            };
            Some(json!({
                "reference": format!("#{}", raw.get("number").unwrap_or(&Value::Null)),
                "kind": kind, "number":raw.get("number"), "title":raw.get("title"), "state":state
            }))
        }
    }
}
