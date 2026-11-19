//! Review guide rows: the ones this server wrote (`review-guides.sqlite` in the state folder,
//! T3's `pull_request_review_guides` table) and, when it has none for a pull request, the rows
//! a T3 server left in its own database, read without caching them or writing that database.

use super::{Failure, operation_error};
use conn_contract::{PullRequestReviewGuide, from_json, to_json};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::path::PathBuf;

// Bound stored rows to 8 MiB; T3 does not cap its stored guide JSON.
const MAX_GUIDE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
#[error("Could not read the stored review guide.")]
struct ReadError;

/// The file this server keeps its own guides in.
pub(super) const OWN_FILE: &str = "review-guides.sqlite";

pub(super) async fn load(
    paths: Vec<PathBuf>,
    host: String,
    repository: String,
    number: u32,
) -> Result<Value, Failure> {
    tokio::task::spawn_blocking(move || {
        for path in paths {
            if let Some(guide) = read(path, &host, &repository, number)? {
                return Ok(Some(guide));
            }
        }
        Ok::<_, ReadError>(None)
    })
    .await
    .map_err(|_| operation_error("reviewGuide", "Could not read the stored review guide."))?
    .map(|guide| guide.map_or(Value::Null, |g| to_json(&g)))
    .map_err(|_| operation_error("reviewGuide", "Could not read the stored review guide."))
}

fn read(
    path: PathBuf,
    host: &str,
    repository: &str,
    number: u32,
) -> Result<Option<PullRequestReviewGuide>, ReadError> {
    if !path.try_exists().map_err(|_| ReadError)? {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ReadError)?;
    connection
        .execute_batch("PRAGMA cache_size=-256; PRAGMA mmap_size=0; PRAGMA query_only=ON;")
        .map_err(|_| ReadError)?;
    let table:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='pull_request_review_guides')",[],|row|row.get(0)).map_err(|_|ReadError)?;
    if !table {
        return Ok(None);
    }
    let row:Option<Option<String>>=connection.query_row("SELECT CASE WHEN length(CAST(guide_json AS BLOB)) <= ?4 THEN guide_json ELSE NULL END FROM pull_request_review_guides WHERE host=?1 AND repository=?2 AND number=?3",rusqlite::params![host,repository,number,MAX_GUIDE_BYTES],|row|row.get(0)).optional().map_err(|_|ReadError)?;
    let Some(raw) = row else {
        return Ok(None);
    };
    let raw = raw.ok_or(ReadError)?;
    let mut value: Value = serde_json::from_str(&raw).map_err(|_| ReadError)?;
    normalize_selection(value.get_mut("modelSelection").ok_or(ReadError)?)?;
    let mut guide = from_json::<PullRequestReviewGuide>(value.clone()).map_err(|_| ReadError)?;
    nonblank(&mut guide.head_sha)?;
    for (index, stop) in guide.stops.iter_mut().enumerate() {
        if value
            .get("stops")
            .and_then(|s| s.get(index))
            .and_then(|s| s.get("attention"))
            .is_none()
        {
            return Err(ReadError);
        }
        nonblank(&mut stop.title)?;
        if let Some(attention) = stop.attention.as_mut() {
            nonblank(&mut attention.note)?;
        }
        for excerpt in &mut stop.excerpts {
            nonblank(&mut excerpt.path)?;
            if excerpt.start < 1 || excerpt.end < 1 {
                return Err(ReadError);
            }
        }
        for file in &mut stop.files {
            nonblank(&mut file.path)?;
        }
        for note in &mut stop.notes {
            nonblank(&mut note.path)?;
            nonblank(&mut note.title)?;
            if note.line < 1 {
                return Err(ReadError);
            }
        }
        for question in &mut stop.questions {
            nonblank(question)?;
        }
    }
    Ok(Some(guide))
}

/// `PullRequestReviewGuideRepository.put`: one row per pull request, replaced on a new guide.
pub(super) async fn store(
    path: PathBuf,
    host: String,
    repository: String,
    number: u32,
    guide: Value,
) -> Result<(), String> {
    let text = guide.to_string();
    // A guide the reader would refuse must not replace the readable one.
    if text.len() > MAX_GUIDE_BYTES {
        return Err("The review guide is too large to store.".into());
    }
    tokio::task::spawn_blocking(move || {
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection
            .execute_batch(
                "PRAGMA cache_size=-256; PRAGMA mmap_size=0; PRAGMA busy_timeout=5000;
                 CREATE TABLE IF NOT EXISTS pull_request_review_guides (
                   host TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
                   guide_json TEXT NOT NULL, PRIMARY KEY (host, repository, number)) WITHOUT ROWID;",
            )
            .map_err(|e| e.to_string())?;
        connection
            .execute(
                "INSERT INTO pull_request_review_guides (host, repository, number, guide_json)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (host, repository, number) DO UPDATE SET guide_json = excluded.guide_json",
                rusqlite::params![host, repository, number, text],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn nonblank(value: &mut String) -> Result<(), ReadError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ReadError);
    }
    if trimmed.len() != value.len() {
        *value = trimmed.to_owned();
    }
    Ok(())
}

fn normalize_selection(value: &mut Value) -> Result<(), ReadError> {
    let source = value.as_object().ok_or(ReadError)?;
    fn string(v: Option<&Value>) -> Result<&str, ReadError> {
        v.and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or(ReadError)
    }
    let instance = string(source.get("instanceId").or_else(|| source.get("provider")))?;
    let model = string(source.get("model"))?;
    let mut out = json!({"instanceId":instance,"model":model});
    if let Some(options) = source.get("options").filter(|v| !v.is_null()) {
        let selections = if let Some(options) = options.as_object() {
            options
                .iter()
                .filter_map(|(id, value)| {
                    let id = id.trim();
                    if id.is_empty() {
                        return None;
                    }
                    if let Some(value) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                        Some(json!({"id":id,"value":value}))
                    } else {
                        value.as_bool().map(|value| json!({"id":id,"value":value}))
                    }
                })
                .collect()
        } else {
            options
                .as_array()
                .ok_or(ReadError)?
                .iter()
                .map(|selection| {
                    let id = string(selection.get("id"))?;
                    let value = selection.get("value").ok_or(ReadError)?;
                    let value = if value.is_boolean() {
                        value.clone()
                    } else {
                        json!(string(Some(value))?)
                    };
                    Ok(json!({"id":id,"value":value}))
                })
                .collect::<Result<Vec<_>, ReadError>>()?
        };
        out["options"] = json!(selections);
    }
    *value = out;
    Ok(())
}
