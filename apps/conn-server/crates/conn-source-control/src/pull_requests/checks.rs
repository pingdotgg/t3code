//! CI log tails and check re-runs for GitHub Actions jobs, as T3's `readCheckLogs` and
//! `rerunChecks` (`GitHubPullRequestApi.ts`) and `tailLogLines` / `gitHubActionsJobId`
//! (`source-control-core/src/server/PullRequestProvider.ts`).

use std::collections::{BTreeSet, HashMap};

use super::{Client, Error, HTTP_SLOTS, Lookup};
use crate::{
    hosts::github,
    http::{self, Method},
};
use serde_json::{Value, json};

const CHECK_LOG_MAX_BYTES: usize = 16 * 1024 * 1024;
/// Keeps one minified or progress-bar line from filling the agent's context (UTF-16 units).
const LOG_TAIL_MAX_CHARS: usize = 32_000;
const NOT_A_JOB_LOG: &str =
    "This check is not a GitHub Actions job, so GitHub holds no log for it.";
const NOT_A_JOB: &str = "This check is not a GitHub Actions job, so GitHub cannot re-run it.";
const ONE_JOB_AT_A_TIME: &str =
    "GitHub re-runs one job of a run at a time. Re-run this one after the other finishes.";
const FAILED_CONCLUSIONS: [&str; 4] = ["failure", "cancelled", "timed_out", "startup_failure"];
/// T3 reads up to four logs or jobs at once.
const CONCURRENCY: usize = 4;

/// `gitHubActionsJobId`: the job id in a check's Actions URL, else a check run's id.
pub fn actions_job_id(url: Option<&str>) -> Option<String> {
    let url = url?;
    // `/\/runs\/\d+\/jobs?\/(\d+)(?:[/?#]|$)/`, anywhere in the URL.
    let mut rest = url;
    while let Some(at) = rest.find("/runs/") {
        let after = rest.get(at + "/runs/".len()..).unwrap_or_default();
        if let Some((_, tail)) = digits(after)
            && let Some(tail) = tail
                .strip_prefix("/jobs/")
                .or_else(|| tail.strip_prefix("/job/"))
            && let Some((id, end)) = digits(tail)
            && ends_segment(end)
        {
            return Some(id.to_owned());
        }
        rest = after;
    }
    // `/^https:\/\/[^/]+\/[^/]+\/[^/]+\/runs\/(\d+)(?:[/?#]|$)/`.
    let rest = url.strip_prefix("https://")?;
    let mut parts = rest.splitn(4, '/');
    let (host, owner, name, tail) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if host.is_empty() || owner.is_empty() || name.is_empty() {
        return None;
    }
    let (id, end) = digits(tail.strip_prefix("runs/")?)?;
    ends_segment(end).then(|| id.to_owned())
}

fn digits(text: &str) -> Option<(&str, &str)> {
    let end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    let id = text.get(..end).filter(|d| !d.is_empty())?;
    Some((id, text.get(end..).unwrap_or_default()))
}

fn ends_segment(rest: &str) -> bool {
    rest.is_empty() || rest.starts_with(['/', '?', '#'])
}

/// `tailLogLines`: the last `lines` lines, at most 32,000 UTF-16 units.
pub fn tail_log_lines(text: &str, lines: usize) -> (String, bool) {
    let text = text.strip_suffix('\n').unwrap_or(text);
    let all: Vec<&str> = text.split('\n').collect();
    let start = all.len().saturating_sub(lines);
    let log = all.get(start..).unwrap_or_default().join("\n");
    let units: usize = log.chars().map(char::len_utf16).sum();
    if units > LOG_TAIL_MAX_CHARS {
        // `slice(-32000)`: keep the last units, never half a character.
        let mut kept = 0;
        let mut cut = log.len();
        for (index, ch) in log.char_indices().rev() {
            if kept + ch.len_utf16() > LOG_TAIL_MAX_CHARS {
                break;
            }
            kept += ch.len_utf16();
            cut = index;
        }
        return (log.get(cut..).unwrap_or_default().to_owned(), true);
    }
    (log, all.len() > lines)
}

/// A check's job id, its run id, and why it cannot be re-run.
type Located = (Option<String>, Option<i64>, Option<String>);

/// A check failure that belongs to that check: GitHub's not-found and response errors. Sign-in,
/// rate-limit and transport failures fail the whole call.
fn per_check(error: github::ApiError) -> Result<String, github::ApiError> {
    match error {
        github::ApiError::NotFound { .. } | github::ApiError::Response { .. } => {
            Ok(error.message())
        }
        other => Err(other),
    }
}

impl Client {
    async fn api(
        &self,
        method: Method,
        path: &str,
        options: github::RestOptions<'_>,
    ) -> Result<http::HttpResponse, github::ApiError> {
        let _slot = HTTP_SLOTS
            .acquire()
            .await
            .map_err(|_| github::ApiError::Request {
                host: self.host.clone(),
            })?;
        github::rest(
            github::RestRequest {
                host: &self.host,
                method,
                path,
                body: None,
            },
            self.token.clone(),
            Some(&self.root),
            options,
        )
        .await
    }

    /// `readCheckLogs`: each named check's log tail; a check that is not an Actions job, or
    /// whose log GitHub will not give, carries a `detail` instead.
    pub async fn check_logs(
        &self,
        lookup: &Lookup,
        checks: &[Value],
        tail_lines: usize,
    ) -> Result<Vec<Value>, Error> {
        let mut out = Vec::with_capacity(checks.len());
        for chunk in checks.chunks(CONCURRENCY) {
            let reads = chunk
                .iter()
                .map(|check| self.check_log(lookup, check, tail_lines));
            for result in futures_util::future::join_all(reads).await {
                out.push(result?);
            }
        }
        Ok(out)
    }

    async fn check_log(
        &self,
        lookup: &Lookup,
        check: &Value,
        tail_lines: usize,
    ) -> Result<Value, Error> {
        let reference = json!({"name": check.get("name"), "url": check.get("url")});
        let with = |log: Value, truncated: bool, detail: Value| {
            let mut entry = reference.clone();
            entry["log"] = log;
            entry["truncated"] = json!(truncated);
            entry["detail"] = detail;
            entry
        };
        let Some(job) = actions_job_id(check.get("url").and_then(Value::as_str)) else {
            return Ok(with(Value::Null, false, json!(NOT_A_JOB_LOG)));
        };
        let path = format!(
            "repos/{}/{}/actions/jobs/{job}/logs",
            lookup.owner, lookup.name
        );
        let options = github::RestOptions {
            limit: CHECK_LOG_MAX_BYTES,
            timeout: std::time::Duration::from_secs(60),
            follow_redirects: true,
            ..github::RestOptions::default()
        };
        match self.api(Method::Get, &path, options).await {
            Ok(response) => {
                let (log, cut) = tail_log_lines(&response.text(), tail_lines);
                let detail = if response.truncated {
                    json!("The log is too large; this is from its start.")
                } else {
                    Value::Null
                };
                Ok(with(json!(log), cut || response.truncated, detail))
            }
            Err(error) => match per_check(error) {
                Ok(detail) => Ok(with(Value::Null, false, json!(detail))),
                Err(error) => Err(self.api_error(error)),
            },
        }
    }

    /// `rerunChecks`: re-runs each named check's Actions job. Jobs of one run go together:
    /// the run's failed jobs when they are exactly the selection, else the first job alone.
    pub async fn rerun_checks(
        &self,
        lookup: &Lookup,
        checks: &[Value],
    ) -> Result<Vec<Value>, Error> {
        let root = format!("repos/{}/{}/actions", lookup.owner, lookup.name);
        // (check, job id, run id, detail)
        let mut located: Vec<(&Value, Located)> = Vec::with_capacity(checks.len());
        for chunk in checks.chunks(CONCURRENCY) {
            let reads = chunk.iter().map(|check| self.locate_job(&root, check));
            for (check, result) in chunk
                .iter()
                .zip(futures_util::future::join_all(reads).await)
            {
                located.push((check, result?));
            }
        }
        // Runs in first-seen order, with their jobs.
        let mut runs: Vec<(i64, Vec<String>)> = Vec::new();
        for (_, (job, run, _)) in &located {
            let (Some(job), Some(run)) = (job, run) else {
                continue;
            };
            match runs.iter_mut().find(|(id, _)| id == run) {
                Some((_, jobs)) => jobs.push(job.clone()),
                None => runs.push((*run, vec![job.clone()])),
            }
        }
        let mut outcomes: HashMap<String, Option<String>> = HashMap::new();
        for (run, jobs) in &runs {
            let Some((first, rest)) = jobs.split_first() else {
                continue;
            };
            if !rest.is_empty() {
                let failed = self.failed_jobs(&root, *run).await?;
                if failed.len() == jobs.len() && jobs.iter().all(|job| failed.contains(job)) {
                    let detail = self
                        .post(&format!("{root}/runs/{run}/rerun-failed-jobs"))
                        .await?;
                    for job in jobs {
                        outcomes.insert(job.clone(), detail.clone());
                    }
                    continue;
                }
            }
            let detail = self.post(&format!("{root}/jobs/{first}/rerun")).await?;
            outcomes.insert(first.clone(), detail);
            for job in rest {
                outcomes.insert(job.clone(), Some(ONE_JOB_AT_A_TIME.to_owned()));
            }
        }
        Ok(located
            .into_iter()
            .map(|(check, (job, run, detail))| {
                let outcome = if run.is_none() {
                    detail
                } else {
                    job.and_then(|job| outcomes.get(&job).cloned().flatten())
                };
                json!({"name": check.get("name"), "rerun": run.is_some() && outcome.is_none(),
                    "detail": outcome})
            })
            .collect())
    }

    async fn locate_job(&self, root: &str, check: &Value) -> Result<Located, Error> {
        let Some(job) = actions_job_id(check.get("url").and_then(Value::as_str)) else {
            return Ok((None, None, Some(NOT_A_JOB.to_owned())));
        };
        let path = format!("{root}/jobs/{job}");
        match self
            .api(Method::Get, &path, github::RestOptions::default())
            .await
        {
            Ok(response) => {
                let run = serde_json::from_slice::<Value>(&response.body)
                    .ok()
                    .and_then(|body| body.get("run_id").and_then(json_number));
                Ok(match run {
                    Some(run) => (Some(job), Some(run), None),
                    None => (Some(job), None, Some(NOT_A_JOB.to_owned())),
                })
            }
            Err(error) => match per_check(error) {
                Ok(detail) => Ok((Some(job), None, Some(detail))),
                Err(error) => Err(self.api_error(error)),
            },
        }
    }

    /// The run's latest failed jobs; empty when the run has more jobs than one page shows or
    /// GitHub will not list them.
    async fn failed_jobs(&self, root: &str, run: i64) -> Result<BTreeSet<String>, Error> {
        let path = format!("{root}/runs/{run}/jobs?filter=latest&per_page=100");
        let response = match self
            .api(Method::Get, &path, github::RestOptions::default())
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return per_check(error)
                    .map(|_| BTreeSet::new())
                    .map_err(|error| self.api_error(error));
            }
        };
        let Ok(body) = serde_json::from_slice::<Value>(&response.body) else {
            return Ok(BTreeSet::new());
        };
        let (Some(total), Some(jobs)) = (
            body.get("total_count").and_then(json_number),
            body.get("jobs").and_then(Value::as_array),
        ) else {
            return Ok(BTreeSet::new());
        };
        if usize::try_from(total).map_or(true, |total| total > jobs.len()) {
            return Ok(BTreeSet::new());
        }
        let mut failed = BTreeSet::new();
        for job in jobs {
            let Some(id) = job.get("id").and_then(json_number) else {
                return Ok(BTreeSet::new());
            };
            let conclusion = match job.get("conclusion") {
                Some(Value::String(text)) => text.as_str(),
                Some(Value::Null) => "",
                _ => return Ok(BTreeSet::new()),
            };
            if FAILED_CONCLUSIONS.contains(&conclusion) {
                failed.insert(id.to_string());
            }
        }
        Ok(failed)
    }

    /// A re-run request: `None` when GitHub took it, else why it refused.
    async fn post(&self, path: &str) -> Result<Option<String>, Error> {
        match self
            .api(Method::Post, path, github::RestOptions::default())
            .await
        {
            Ok(_) => Ok(None),
            Err(error) => per_check(error)
                .map(Some)
                .map_err(|error| self.api_error(error)),
        }
    }
}

/// `Schema.Number` read from JSON: an integral number (job and run ids are integers).
fn json_number(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.fract() == 0.0)
            .map(|n| n as i64)
    })
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn job_ids_as_t3_reads_them() {
        let id = |url: &str| actions_job_id(Some(url));
        assert_eq!(
            id("https://github.com/a/b/actions/runs/12/job/34"),
            Some("34".into())
        );
        assert_eq!(
            id("https://github.com/a/b/actions/runs/12/jobs/34?pr=1"),
            Some("34".into())
        );
        assert_eq!(id("https://github.com/a/b/runs/56"), Some("56".into()));
        assert_eq!(id("https://github.com/a/b/runs/56#step"), Some("56".into()));
        assert_eq!(id("https://github.com/a/b/actions/runs/12/job/34x"), None);
        assert_eq!(id("https://github.com/a/b/c/runs/56"), None);
        assert_eq!(id("http://github.com/a/b/runs/56"), None);
        assert_eq!(id("https://ci.example.com/build/1"), None);
        assert_eq!(actions_job_id(None), None);
    }

    #[test]
    fn tails_as_t3_does() {
        assert_eq!(tail_log_lines("a\nb\nc\n", 2), ("b\nc".into(), true));
        assert_eq!(tail_log_lines("a\nb", 5), ("a\nb".into(), false));
        assert_eq!(tail_log_lines("a\n\n", 5), ("a\n".into(), false));
        let long = "é".repeat(40_000);
        let (log, cut) = tail_log_lines(&long, 1);
        assert!(cut);
        assert_eq!(log.chars().count(), 32_000);
    }
}
