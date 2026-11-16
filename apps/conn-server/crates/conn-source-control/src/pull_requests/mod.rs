//! GitHub's PR panel, using T3's credential resolver and generated GraphQL documents.

use crate::{
    Secret,
    hosts::{
        DiscoveryContext, github,
        github_graphql::{Operation, generated},
    },
    http::{self, HttpRequest, Method},
};

use serde_json::{Value, json};

mod activity;

pub mod actions;

mod detail;

pub mod diff;

pub mod listing;

pub mod normalize;

mod stack;

#[cfg(test)]
mod tests;

static CLI_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

static HTTP_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

const UNAUTHENTICATED: &str = "GitHub has no working credential for this host. Run `gh auth login`, or check the account and hosts in Settings → Source Control.";

const MISSING: &str = "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI (https://cli.github.com/) and run `gh auth login`.";

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("GitHub CLI is missing")]
    Missing,
    #[error("GitHub is not signed in")]
    Unauthenticated,
    #[error("{0}")]
    Failed(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    RepositoryNotFound(String, &'static str),
}

impl Error {
    pub fn access_hint(&self) -> Option<&'static str> {
        if let Self::RepositoryNotFound(_, hint) = self {
            Some(hint)
        } else {
            None
        }
    }
    pub fn to_contract(&self, operation: &str) -> Value {
        match self {
            Self::Missing | Self::Unauthenticated => {
                json!({"_tag":"PullRequestUnavailableError", "reason":if *self == Self::Missing {"cli-missing"} else {"cli-unauthenticated"}, "provider":"github", "requirement":if *self == Self::Missing {MISSING} else {UNAUTHENTICATED}})
            }
            Self::Failed(detail)
            | Self::Forbidden(detail)
            | Self::NotFound(detail)
            | Self::RepositoryNotFound(detail, _) => {
                let reason = match self {
                    Self::Forbidden(_) => "forbidden",
                    Self::NotFound(_) | Self::RepositoryNotFound(_, _) => "not-found",
                    _ => "failed",
                };
                let mut value = json!({"_tag":"PullRequestOperationError","operation":operation,"detail":detail,
                    "cause":{"_tag":"PullRequestProviderError","provider":"github","operation":operation,"reason":reason,"detail":detail}});
                if reason == "not-found" {
                    value["reason"] = json!(reason);
                }
                if let Some(hint) = self.access_hint() {
                    value["cause"]["accessHint"] = json!(hint);
                }
                value
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct Lookup {
    pub owner: String,
    pub name: String,
    pub number: u32,
}
impl Lookup {
    pub fn new(repository: &str, number: u64) -> Result<Self, Error> {
        let (owner, name) = repository
            .trim()
            .split_once('/')
            .ok_or_else(invalid_selector)?;

        let valid = |s: &str| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        };

        if !valid(owner) || !valid(name) || !(1..=2_147_483_647).contains(&number) {
            return Err(invalid_selector());
        }
        Ok(Self {
            owner: owner.into(),
            name: name.into(),
            number: number as u32,
        })
    }
    fn variables(&self) -> Value {
        json!({"owner":self.owner,"name":self.name,"number":self.number})
    }
    fn path(&self) -> String {
        format!("repos/{}/{}/pulls/{}", self.owner, self.name, self.number)
    }
}
fn invalid_selector() -> Error {
    Error::Failed("A repository was named that GitHub cannot address.".into())
}

/// One credential is pinned across every read of an operation, including routing verification.
#[derive(Clone, Debug)]
pub struct Client {
    host: String,
    root: String,
    token: Secret,
    credential_source: github::CredentialSource,
}
impl Client {
    pub async fn connect(context: DiscoveryContext<'_>, host: &str) -> Result<Self, Error> {
        let host = host.trim().to_lowercase();

        if !github::is_github_host(&host) {
            return Err(Error::Unauthenticated);
        }
        let _slot = CLI_SLOTS
            .acquire()
            .await
            .map_err(|_| Error::Failed("GitHub CLI is unavailable.".into()))?;

        let (token, credential_source) = github::credential_with_source(context, &host)
            .await
            .map_err(|e| match e {
                github::CredentialError::CliMissing => Error::Missing,
                _ => Error::Unauthenticated,
            })?;

        let root = context
            .endpoints
            .github_rest
            .clone()
            .unwrap_or_else(|| github::rest_root(&host));

        Ok(Self {
            host,
            root,
            token,
            credential_source,
        })
    }

    pub fn same_credential(&self, other: &Self) -> bool {
        self.host == other.host && self.token == other.token
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        accept: &str,
        limit: usize,
    ) -> Result<http::HttpResponse, Error> {
        let mut request = HttpRequest::new(
            method,
            url::Url::parse(&format!("{}/", self.root))
                .and_then(|u| u.join(path))
                .map_err(|_| Error::Failed("Invalid GitHub API URL.".into()))?
                .to_string(),
        )
        .header("accept", accept)
        .header("x-github-api-version", github::API_VERSION)
        .header("user-agent", github::USER_AGENT)
        .secret_header("authorization", "Bearer ", self.token.clone());

        request.max_response_bytes = limit;

        if accept != "application/vnd.github+json" {
            request.timeout = std::time::Duration::from_secs(60);
        }
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(
                serde_json::to_vec(&body)
                    .map_err(|_| Error::Failed("Could not encode the GitHub request.".into()))?,
            );
        }
        let _slot = HTTP_SLOTS
            .acquire()
            .await
            .map_err(|_| Error::Failed("GitHub is unavailable.".into()))?;

        let response = http::send(request)
            .await
            .map_err(|_| Error::Failed(format!("Could not reach GitHub at {}.", self.host)))?;

        let raw: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);

        let errors = normalize::array(raw.get("errors"));

        if response.status == 401 {
            return Err(Error::Unauthenticated);
        }
        if response.status == 429
            || (response.status == 403
                && (response.header("x-ratelimit-remaining") == Some("0")
                    || response.text().to_lowercase().contains("rate limit")))
            || errors
                .iter()
                .any(|e| normalize::text(e, "type") == "RATE_LIMITED")
        {
            return Err(Error::Failed("GitHub API rate limit exceeded.".into()));
        }
        if response.status == 404 {
            return Err(Error::RepositoryNotFound(
                "GitHub could not find the requested resource, or the credential cannot see it."
                    .into(),
                self.credential_source.access_hint(),
            ));
        }
        if !(200..300).contains(&response.status) {
            let messages = if path.ends_with("graphql") {
                Vec::new()
            } else {
                rest_error_messages(&raw)
            };
            let detail = if messages.is_empty() {
                format!("GitHub returned HTTP {}.", response.status)
            } else {
                format!("GitHub returned an error: {}", messages.join("; "))
            };
            return Err(if response.status == 403 {
                Error::Forbidden(detail)
            } else {
                Error::Failed(detail)
            });
        }
        Ok(response)
    }

    pub async fn graphql(
        &self,
        operation: &Operation,
        mut variables: Value,
    ) -> Result<Value, Error> {
        let path = if self.root.ends_with("/api/v3") {
            "../graphql"
        } else {
            "graphql"
        };

        for attempt in 0..2 {
            let response = self
                .request(
                    Method::Post,
                    path,
                    Some(json!({"query":operation.document,"operationName":operation.name,"variables":variables})),
                    "application/vnd.github+json",
                    8 * 1024 * 1024,
                )
                .await?;

            if response.truncated {
                return Err(Error::Failed(
                    "GitHub's response was too large to read.".into(),
                ));
            }
            let raw: Value = serde_json::from_slice(&response.body)
                .map_err(|_| Error::Failed("Could not read GitHub's response.".into()))?;

            let errors = normalize::array(raw.get("errors"));

            let missing_pull_ref = |error: &Value| {
                normalize::text(error, "type") == "NOT_FOUND"
                    && error.get("path")
                        == Some(&json!(["repository", "pullRequest", "baseRef", "compare"]))
            };

            let refused_reviewer = |error: &Value| {
                let path = normalize::array(error.get("path"));

                normalize::text(error, "type") == "FORBIDDEN"
                    && path.len() == 6
                    && path.first().and_then(Value::as_str) == Some("repository")
                    && path.get(1).and_then(Value::as_str) == Some("pullRequest")
                    && path.get(2).and_then(Value::as_str) == Some("reviewRequests")
                    && path.get(3).and_then(Value::as_str) == Some("nodes")
                    && path.get(4).and_then(Value::as_u64).is_some()
                    && path.get(5).and_then(Value::as_str) == Some("requestedReviewer")
            };

            if !errors.is_empty() && !errors.iter().all(missing_pull_ref) {
                if attempt == 0
                    && variables
                        .get("requestedReviewers")
                        .and_then(Value::as_u64)
                        .is_some_and(|n| n > 0)
                    && errors
                        .iter()
                        .all(|e| missing_pull_ref(e) || refused_reviewer(e))
                {
                    variables["requestedReviewers"] = json!(0);

                    continue;
                }
                let messages: Vec<_> = errors
                    .iter()
                    .filter_map(|e| {
                        let message = e.get("message")?.as_str()?;
                        let path = normalize::array(e.get("path"));
                        if path.is_empty() {
                            Some(message.to_owned())
                        } else {
                            Some(format!(
                                "{message} (at {})",
                                path.iter()
                                    .map(|part| part
                                        .as_str()
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| part.to_string()))
                                    .collect::<Vec<_>>()
                                    .join(".")
                            ))
                        }
                    })
                    .collect();
                if errors.iter().all(is_not_found_lookup) {
                    let missing = "GitHub could not find the requested resource, or the credential cannot see it.";
                    return Err(Error::RepositoryNotFound(
                        if messages.is_empty() {
                            missing.into()
                        } else {
                            format!("{missing} GitHub said: {}", messages.join("; "))
                        },
                        self.credential_source.access_hint(),
                    ));
                }
                let forbidden = errors
                    .iter()
                    .any(|e| normalize::text(e, "type") == "FORBIDDEN")
                    && errors
                        .iter()
                        .all(|e| matches!(normalize::text(e, "type"), "FORBIDDEN" | "NOT_FOUND"));
                let detail = if messages.is_empty() {
                    format!("GitHub returned HTTP {}.", response.status)
                } else {
                    format!("GitHub returned an error: {}", messages.join("; "))
                };
                return Err(if forbidden {
                    Error::Forbidden(detail)
                } else {
                    Error::Failed(detail)
                });
            }
            return raw
                .get("data")
                .filter(|v| !v.is_null())
                .cloned()
                .ok_or_else(|| Error::Failed("Could not read GitHub's response.".into()));
        }
        Err(Error::Failed("Could not read GitHub's response.".into()))
    }
    pub(super) async fn rest(&self, path: &str) -> Result<Value, Error> {
        let response = self
            .request(
                Method::Get,
                path,
                None,
                "application/vnd.github+json",
                8 * 1024 * 1024,
            )
            .await?;

        if response.truncated {
            return Err(Error::Failed(
                "GitHub's response was too large to read.".into(),
            ));
        }
        serde_json::from_slice(&response.body)
            .map_err(|_| Error::Failed("Could not read GitHub's response.".into()))
    }
    pub async fn identity(&self) -> Result<Value, Error> {
        let identity = match self.rest("user").await {
            Err(Error::Failed(s)) if s == "GitHub returned HTTP 403." => {
                let result = self
                    .graphql(&generated::ROUTING_IDENTITY_VIEWER, json!({}))
                    .await?;

                json!({"id":result.pointer("/viewer/databaseId"),"login":result.pointer("/viewer/login")})
            }
            result => result?,
        };

        let id = identity
            .get("id")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0);

        let viewer = normalize::text(&identity, "login");

        match id {
            Some(id) if !viewer.trim().is_empty() => {
                Ok(json!({"accountId":id.to_string(),"viewer":viewer}))
            }
            _ => Err(Error::Failed(
                "The signed-in account could not be verified.".into(),
            )),
        }
    }
    pub async fn summary(&self, lookup: &Lookup) -> Result<Value, Error> {
        let mut variables = lookup.variables();

        variables["stacks"] = json!(self.host == "github.com");

        let result = self
            .graphql(&generated::PULL_REQUEST_SUMMARY, variables)
            .await?;

        Ok(normalize::summary(
            pull_request(&result, lookup)?,
            &self.host,
        ))
    }
    pub async fn preview(&self, lookup: &Lookup) -> Result<Value, Error> {
        let result = self
            .graphql(&generated::PULL_REQUEST_PREVIEW, lookup.variables())
            .await?;

        let raw = pull_request(&result, lookup)?;

        Ok(
            json!({"number":raw.get("number"),"title":raw.get("title"),"url":raw.get("url"),"state":normalize::state(raw),"isDraft":raw.get("isDraft"),"createdAt":raw.get("createdAt"),"author":normalize::actor(raw.get("author"),&self.host)}),
        )
    }
    pub async fn stats(&self, lookup: &Lookup) -> Result<Value, Error> {
        let result = self
            .graphql(&generated::PULL_REQUEST_STATS, lookup.variables())
            .await?;

        let raw = pull_request(&result, lookup)?;

        Ok(
            json!({"number":lookup.number,"additions":raw.get("additions"),"deletions":raw.get("deletions")}),
        )
    }
    pub async fn stats_batch(&self, lookups: &[Lookup]) -> Result<Vec<(usize, Value)>, Error> {
        let mut stats = Vec::new();

        for (batch_index, batch) in lookups.chunks(100).enumerate() {
            let query = generated::PULL_REQUEST_STATS
                .render_slices(batch.len())
                .map_err(|_| {
                    Error::Failed("Could not build GitHub's statistics request.".into())
                })?;

            let mut variables = serde_json::Map::new();

            for (index, lookup) in batch.iter().enumerate() {
                for (key, value) in lookup.variables().as_object().into_iter().flatten() {
                    variables.insert(format!("_{index}_{key}"), value.clone());
                }
            }
            let response = self
                .request(
                    Method::Post,
                    if self.root.ends_with("/api/v3") {
                        "../graphql"
                    } else {
                        "graphql"
                    },
                    Some(json!({"query":query,"variables":variables})),
                    "application/vnd.github+json",
                    8 * 1024 * 1024,
                )
                .await?;

            let raw: Value = serde_json::from_slice(&response.body).map_err(|_| {
                Error::Failed("GitHub returned an unreadable listPullRequestStats response.".into())
            })?;

            for (index, lookup) in batch.iter().enumerate() {
                if let Some(pr) = raw
                    .get("data")
                    .and_then(|d| d.get(format!("_{index}_repository")))
                    .and_then(|r| r.get("pullRequest"))
                    && let (Some(additions), Some(deletions)) = (
                        pr.get("additions").and_then(Value::as_u64),
                        pr.get("deletions").and_then(Value::as_u64),
                    )
                {
                    stats.push((
                        batch_index * 100 + index,
                        json!({"number":lookup.number,"additions":additions,"deletions":deletions}),
                    ));
                }
            }
        }
        Ok(stats)
    }
    pub async fn files_viewed(&self, lookup: &Lookup) -> Result<Value, Error> {
        self.file_pages(lookup, true).await
    }
    pub async fn change_breakdown(&self, lookup: &Lookup) -> Result<Value, Error> {
        let files = self.file_pages(lookup, false).await?;

        Ok(normalize::breakdown(&files))
    }
    async fn file_pages(&self, lookup: &Lookup, viewed: bool) -> Result<Value, Error> {
        let mut variables = lookup.variables();

        let mut files = Vec::new();

        let mut cursor = Value::Null;

        for _ in 0..5 {
            variables["after"] = cursor;

            let result = self
                .graphql(
                    if viewed {
                        &generated::PULL_REQUEST_FILES_VIEWED
                    } else {
                        &generated::PULL_REQUEST_FILE_STATS
                    },
                    variables.clone(),
                )
                .await?;

            let connection = result
                .pointer("/repository/pullRequest/files")
                .unwrap_or(&Value::Null);

            files.extend(normalize::nodes(connection).iter().filter(|f| !normalize::text(f,"path").is_empty()).map(|f| if viewed {json!({"path":f.get("path"),"state":match normalize::text(f,"viewerViewedState").trim().to_uppercase().as_str() {"VIEWED"=>"viewed","DISMISSED"=>"dismissed",_=>"unviewed"}})} else {json!({"path":f.get("path"),"additions":f.get("additions"),"deletions":f.get("deletions")})}));

            cursor = normalize::cursor(connection);

            if cursor.is_null() {
                break;
            }
        }
        Ok(json!({"files":files,"truncated":!cursor.is_null()}))
    }
    pub async fn set_files_viewed(&self, lookup: &Lookup, files: &[Value]) -> Result<(), Error> {
        if files.is_empty() {
            return Ok(());
        }
        let result = self
            .graphql(&generated::PULL_REQUEST_NODE_ID, lookup.variables())
            .await?;

        let id = pull_request(&result, lookup)?
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Failed("The pull request's node id could not be read.".into()))?;

        for file in files {
            self.graphql(
                &generated::SET_FILE_VIEWED,
                json!({"pullRequestId":id,"path":file.get("path"),"viewed":file.get("viewed")}),
            )
            .await?;
        }
        Ok(())
    }
}
fn pull_request<'a>(result: &'a Value, lookup: &Lookup) -> Result<&'a Value, Error> {
    result
        .pointer("/repository/pullRequest")
        .filter(|v| !v.is_null())
        .ok_or_else(|| {
            Error::NotFound(format!(
                "Pull request #{} was not found in {}/{}.",
                lookup.number, lookup.owner, lookup.name
            ))
        })
}

fn is_not_found_lookup(error: &Value) -> bool {
    if normalize::text(error, "type") != "NOT_FOUND" {
        return false;
    }
    let Some(path) = error.get("path") else {
        return true;
    };
    let path = normalize::array(Some(path));
    path.iter().skip(1).all(Value::is_number)
        || (path.len() == 2
            && path.first().and_then(Value::as_str) == Some("repository")
            && matches!(
                path.get(1).and_then(Value::as_str),
                Some("pullRequest" | "issueOrPullRequest")
            ))
}

fn rest_error_messages(raw: &Value) -> Vec<String> {
    if !raw.is_object()
        || raw.get("message").is_some_and(|v| !v.is_string())
        || raw.get("errors").is_some_and(|v| !v.is_array())
    {
        return Vec::new();
    }
    let mut messages: Vec<_> = raw
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .into_iter()
        .collect();
    for error in normalize::array(raw.get("errors")) {
        if let Some(message) = error.as_str() {
            messages.push(message.into());
            continue;
        }
        if !error.is_object()
            || ["message", "field", "code"]
                .iter()
                .any(|key| error.get(key).is_some_and(|v| !v.is_string()))
        {
            return Vec::new();
        }
        if let Some(message) = error.get("message").and_then(Value::as_str) {
            messages.push(message.into());
        } else if let (Some(field), Some(code)) = (
            error.get("field").and_then(Value::as_str),
            error.get("code").and_then(Value::as_str),
        ) {
            messages.push(format!("{field} {code}"));
        }
    }
    messages
}
