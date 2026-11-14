//! Annotations: comments a person pins on a page or a device screen, a queue an agent works
//! through. Behaviour follows `apps/server/src/annotations/AnnotationStore.ts`.
//!
//! The files are the T3 server's: `<state-dir>/annotations/<project>/<id>.json` records,
//! `<id>.<png|jpg|webp>` screenshots, `_sequence.json` and `_deleted.json`. Each call reads the
//! project's folder under the project's lock and writes what changed; nothing stays in memory
//! between calls but one lock and one change counter per project that was used.

use std::{
    collections::{BTreeSet, HashMap},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};

use conn_contract::{AnnotationCapture, AnnotationRemoveInputScope, to_json};
use conn_engine::BoxFuture;
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, mpsc, watch};

use crate::clock::Clock;

/// The most annotations one project keeps. The T3 server has no limit; a bound keeps each
/// call's folder read and each list on the wire small.
pub const MAX_PER_PROJECT: usize = 1_000;
const SCREENSHOT_EXTENSIONS: [&str; 3] = ["jpg", "png", "webp"];
/// The largest screenshot, decoded. The T3 server has no cap. A full-page capture is a few
/// megabytes; this cap refuses a larger one with a clear error before it is decoded, well
/// below the 16 MiB WebSocket message limit, so one call holds at most this much.
pub const MAX_SCREENSHOT_BYTES: usize = 8 * 1024 * 1024;
/// The most removed ids `_deleted.json` keeps per project; the oldest go first. The T3 server
/// keeps every one. Ten times [`MAX_PER_PROJECT`], so a removal never drops its own ids.
pub const MAX_TOMBSTONES: usize = 10 * MAX_PER_PROJECT;

/// The contract's annotation errors, each with its `_tag` and fields.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AnnotationError {
    #[error("This project is not on this server.")]
    ProjectNotFound { project_id: String },
    #[error("{reason}")]
    Store { reason: String },
    #[error("Annotation {id} is gone. The user may have removed it; do not recreate it.")]
    NotFound { project_id: String, id: String },
    #[error("Annotation {id} is {status}; it must be {expected}. Read the list again.")]
    Conflict {
        id: String,
        status: String,
        expected: String,
    },
    #[error("Annotation {id} was removed.")]
    Removed { id: String },
    #[error("{reason}")]
    Invalid { reason: String },
}

impl AnnotationError {
    fn store(reason: &str) -> impl Fn(io::Error) -> Self + '_ {
        move |error| {
            eprintln!("annotations: {reason} {error}");
            Self::Store {
                reason: reason.to_owned(),
            }
        }
    }

    fn invalid(reason: &str) -> Self {
        Self::Invalid {
            reason: reason.to_owned(),
        }
    }

    /// The error as the contract encodes it: its tag and fields, no message.
    pub fn to_contract(&self) -> Value {
        match self {
            Self::ProjectNotFound { project_id } => {
                json!({"_tag": "AnnotationProjectNotFoundError", "projectId": project_id})
            }
            Self::Store { reason } => json!({"_tag": "AnnotationStoreError", "reason": reason}),
            Self::NotFound { project_id, id } => {
                json!({"_tag": "AnnotationNotFoundError", "projectId": project_id, "id": id})
            }
            Self::Conflict {
                id,
                status,
                expected,
            } => {
                json!({"_tag": "AnnotationConflictError", "id": id, "status": status, "expected": expected})
            }
            Self::Removed { id } => json!({"_tag": "AnnotationRemovedError", "id": id}),
            Self::Invalid { reason } => json!({"_tag": "AnnotationInvalidError", "reason": reason}),
        }
    }
}

/// `AnnotationId`: `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$`. Ids name files, so every id is
/// checked before any path is built from it.
pub fn is_annotation_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.len() <= 200
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// A defect over RPC, as the schema refuses such an id; here so no path is built from it.
fn require_id(id: &str) -> Result<(), AnnotationError> {
    if is_annotation_id(id) {
        Ok(())
    } else {
        Err(AnnotationError::invalid("Invalid annotation id."))
    }
}

/// Whether a project exists here (`ProjectService.getById`).
pub trait ProjectLookup: Send + Sync + std::fmt::Debug {
    fn exists(&self, project_id: String) -> BoxFuture<'_, Result<bool, String>>;
}

/// One project's folder, read whole for each call.
struct ProjectData {
    dir: PathBuf,
    last_number: u64,
    revision: u64,
    deleted: BTreeSet<String>,
    /// The removed ids in the file's order, oldest first.
    deleted_order: Vec<String>,
    records: Vec<Map<String, Value>>,
}

fn number(record: &Map<String, Value>, key: &str) -> u64 {
    record.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn text<'a>(record: &'a Map<String, Value>, key: &str) -> &'a str {
    record.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn read_if_exists(path: &Path) -> io::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    conn_support::fs::write_atomic(path, bytes, 0o644)
}

impl ProjectData {
    /// `load`: the sequence, the removed ids, and every record whose file names its id. A
    /// removal that stopped before it deleted its files finishes here.
    fn load(dir: PathBuf) -> io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let invalid = |what: &str| io::Error::new(io::ErrorKind::InvalidData, what.to_owned());
        let sequence: Value = match read_if_exists(&dir.join("_sequence.json"))? {
            Some(text) => serde_json::from_str(&text).map_err(|_| invalid("_sequence.json"))?,
            None => json!({"lastNumber": 0, "revision": 0}),
        };
        let deleted_order: Vec<String> = match read_if_exists(&dir.join("_deleted.json"))? {
            Some(text) => serde_json::from_str(&text).map_err(|_| invalid("_deleted.json"))?,
            None => Vec::new(),
        };
        let deleted: BTreeSet<String> = deleted_order.iter().cloned().collect();
        let mut data = Self {
            last_number: sequence["lastNumber"].as_u64().unwrap_or(0),
            revision: sequence["revision"].as_u64().unwrap_or(0),
            deleted,
            deleted_order,
            records: Vec::new(),
            dir,
        };
        for entry in std::fs::read_dir(&data.dir)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json") else {
                continue;
            };
            if name.starts_with('_') || !is_annotation_id(id) {
                continue;
            }
            if data.deleted.contains(id) {
                let _ = std::fs::remove_file(data.record_path(id));
                data.remove_screenshots(id, None);
                continue;
            }
            let record = std::fs::read_to_string(data.dir.join(&name))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok());
            let Some(Value::Object(record)) = record else {
                eprintln!("annotations: skipped an unreadable annotation file {name}");
                continue;
            };
            if text(&record, "id") != id {
                continue;
            }
            data.last_number = data.last_number.max(number(&record, "number"));
            data.revision = data.revision.max(number(&record, "revision"));
            data.records.push(record);
        }
        data.records.sort_by_key(|r| number(r, "number"));
        Ok(data)
    }

    fn record_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn screenshot_file(&self, id: &str, extension: &str) -> PathBuf {
        self.dir.join(format!("{id}.{extension}"))
    }

    fn remove_screenshots(&self, id: &str, keep: Option<&str>) {
        for extension in SCREENSHOT_EXTENSIONS {
            if Some(extension) != keep {
                let _ = std::fs::remove_file(self.screenshot_file(id, extension));
            }
        }
    }

    fn find(&self, id: &str) -> Option<&Map<String, Value>> {
        self.records.iter().find(|r| text(r, "id") == id)
    }

    fn save_sequence(&mut self, last_number: u64, revision: u64) -> io::Result<()> {
        let body = json!({"lastNumber": last_number, "revision": revision}).to_string();
        write(&self.dir.join("_sequence.json"), body.as_bytes())?;
        self.last_number = last_number;
        self.revision = revision;
        Ok(())
    }

    /// `save`: the record with the next revision, then the sequence.
    fn save(
        &mut self,
        mut record: Map<String, Value>,
        last_number: u64,
    ) -> Result<Map<String, Value>, AnnotationError> {
        let failed = AnnotationError::store("Could not save the annotation.");
        let revision = self.revision + 1;
        record.insert("revision".into(), json!(revision));
        let id = text(&record, "id").to_owned();
        write(
            &self.record_path(&id),
            Value::Object(record.clone()).to_string().as_bytes(),
        )
        .map_err(&failed)?;
        self.save_sequence(last_number, revision).map_err(&failed)?;
        match self.records.iter_mut().find(|r| text(r, "id") == id) {
            Some(slot) => *slot = record.clone(),
            None => self.records.push(record.clone()),
        }
        Ok(record)
    }

    fn list(&self) -> Vec<Value> {
        let mut records = self.records.clone();
        records.sort_by_key(|r| number(r, "number"));
        records.into_iter().map(Value::Object).collect()
    }
}

fn require_status(record: &Map<String, Value>, expected: &str) -> Result<(), AnnotationError> {
    let status = text(record, "status");
    if status == expected {
        Ok(())
    } else {
        Err(AnnotationError::Conflict {
            id: text(record, "id").to_owned(),
            status: status.to_owned(),
            expected: expected.to_owned(),
        })
    }
}

/// A decoded `data:image/...;base64,` screenshot.
struct Screenshot {
    extension: &'static str,
    bytes: Vec<u8>,
}

/// Why a screenshot was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
enum ScreenshotError {
    #[error("The screenshot must be a base64 PNG, JPEG or WebP data URL.")]
    Invalid,
    #[error("The screenshot is larger than 8 MB.")]
    TooLarge,
}

/// `SCREENSHOT_DATA_URL`: PNG, JPEG or WebP; whitespace in the data is ignored. Refuses a
/// screenshot over [`MAX_SCREENSHOT_BYTES`] before it decodes it. Blocking: call it on a
/// blocking thread.
fn decode_screenshot(data_url: &str) -> Result<Screenshot, ScreenshotError> {
    let invalid = ScreenshotError::Invalid;
    let rest = data_url.strip_prefix("data:image/").ok_or(invalid)?;
    let (kind, data) = rest.split_once(";base64,").ok_or(invalid)?;
    let extension = match kind {
        "png" => "png",
        "webp" => "webp",
        "jpg" | "jpeg" => "jpg",
        _ => return Err(invalid),
    };
    let compact: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Err(invalid);
    }
    if compact.len() / 4 * 3 > MAX_SCREENSHOT_BYTES + 3 {
        return Err(ScreenshotError::TooLarge);
    }
    let bytes = conn_support::base64::decode(&compact).ok_or(invalid)?;
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err(ScreenshotError::TooLarge);
    }
    Ok(Screenshot { extension, bytes })
}

/// The project's folder name under the annotations root: `directoryFor`, with a name made
/// only of dots escaped.
fn folder_name(project_id: &str) -> String {
    let name: String = project_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.bytes().all(|b| b == b'.') {
        name.replace('.', "%2E")
    } else {
        name
    }
}

/// One folder's lock and change counter.
#[derive(Debug)]
struct Entry {
    lock: Mutex<()>,
    changes: watch::Sender<u64>,
}

/// The annotation store. Clones share it.
#[derive(Clone, Debug)]
pub struct Annotations {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    root: PathBuf,
    clock: Arc<dyn Clock>,
    projects: Arc<dyn ProjectLookup>,
    /// One entry per folder that was used; projects are few and bounded by the engine.
    entries: StdMutex<HashMap<String, Arc<Entry>>>,
}

impl Annotations {
    pub fn new(state_dir: &Path, clock: Arc<dyn Clock>, projects: Arc<dyn ProjectLookup>) -> Self {
        Self {
            inner: Arc::new(Inner {
                root: state_dir.join("annotations"),
                clock,
                projects,
                entries: StdMutex::new(HashMap::new()),
            }),
        }
    }

    /// `directoryFor`: characters outside `[A-Za-z0-9._-]` become `_`. Unlike the T3 server,
    /// a name made only of dots (`.`, `..`) has each dot written as `%2E`, so no project id
    /// names the annotations root or the state folder; no other name can hold a `%`. The
    /// result must be one folder right under the root, or the call is refused.
    fn directory(&self, project_id: &str) -> Result<(String, PathBuf), AnnotationError> {
        let name = folder_name(project_id);
        let dir = self.inner.root.join(&name);
        let one_child = matches!(
            Path::new(&name).components().collect::<Vec<_>>().as_slice(),
            [std::path::Component::Normal(part)] if *part == name.as_str()
        );
        if one_child && dir.parent() == Some(self.inner.root.as_path()) {
            Ok((name, dir))
        } else {
            Err(AnnotationError::invalid(
                "This project id cannot name a folder.",
            ))
        }
    }

    fn now(&self) -> String {
        conn_support::time::iso_from_millis(self.inner.clock.now_ms())
    }

    async fn require_project(&self, project_id: &str) -> Result<(), AnnotationError> {
        match self.inner.projects.exists(project_id.to_owned()).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(AnnotationError::ProjectNotFound {
                project_id: project_id.to_owned(),
            }),
            Err(error) => {
                eprintln!("annotations: Could not read the project. {error}");
                Err(AnnotationError::Store {
                    reason: "Could not read the project.".into(),
                })
            }
        }
    }

    /// The entry of a folder name, so two project ids that map to one folder share one lock.
    fn entry(&self, folder: &str) -> Arc<Entry> {
        let mut entries = match self.inner.entries.lock() {
            Ok(entries) => entries,
            Err(poisoned) => poisoned.into_inner(),
        };
        entries
            .entry(folder.to_owned())
            .or_insert_with(|| {
                Arc::new(Entry {
                    lock: Mutex::new(()),
                    changes: watch::channel(0).0,
                })
            })
            .clone()
    }

    /// `withProject`: runs `work` alone in the project on a blocking thread, then tells
    /// subscribers when it changed the revision.
    async fn with_project<T: Send + 'static>(
        &self,
        project_id: &str,
        work: impl FnOnce(&mut ProjectData) -> Result<T, AnnotationError> + Send + 'static,
    ) -> Result<T, AnnotationError> {
        self.require_project(project_id).await?;
        let (folder, dir) = self.directory(project_id)?;
        let entry = self.entry(&folder);
        let _guard = entry.lock.lock().await;
        let (result, changed) = tokio::task::spawn_blocking(move || {
            let mut data = ProjectData::load(dir)
                .map_err(AnnotationError::store("Could not read the annotations."))?;
            let before = data.revision;
            let result = work(&mut data)?;
            Ok::<_, AnnotationError>((result, data.revision != before))
        })
        .await
        .map_err(|_| AnnotationError::Store {
            reason: "Could not read the annotations.".into(),
        })??;
        if changed {
            entry.changes.send_modify(|v| *v = v.wrapping_add(1));
        }
        Ok(result)
    }

    /// `list`: sorted by number.
    pub async fn list(&self, project_id: &str) -> Result<Value, AnnotationError> {
        let annotations = self
            .with_project(project_id, |data| Ok(data.list()))
            .await?;
        Ok(json!({ "annotations": annotations }))
    }

    /// `subscribe`: the list now, then after each change in the project. A slow reader sees
    /// only the newest list.
    pub async fn subscribe(
        &self,
        project_id: &str,
    ) -> Result<mpsc::Receiver<Result<Value, AnnotationError>>, AnnotationError> {
        self.require_project(project_id).await?;
        let (folder, _) = self.directory(project_id)?;
        let mut changes = self.entry(&folder).changes.subscribe();
        let first = self.list(project_id).await?;
        let (tx, rx) = mpsc::channel(1);
        let store = self.clone();
        let project_id = project_id.to_owned();
        tokio::spawn(async move {
            changes.borrow_and_update();
            if tx.send(Ok(first)).await.is_err() {
                return;
            }
            loop {
                tokio::select! {
                    changed = changes.changed() => if changed.is_err() { return },
                    () = tx.closed() => return,
                }
                changes.borrow_and_update();
                let list = store.list(&project_id).await;
                let failed = list.is_err();
                if tx.send(list).await.is_err() || failed {
                    return;
                }
            }
        });
        Ok(rx)
    }

    /// `create`: a new id gets the next number; an existing id takes the new capture and keeps
    /// its number, status and times. A removed id is refused.
    pub async fn create(
        &self,
        project_id: &str,
        capture: AnnotationCapture,
    ) -> Result<Value, AnnotationError> {
        let comment = capture.comment.trim().to_owned();
        if comment.is_empty() {
            return Err(AnnotationError::invalid("An annotation needs a comment."));
        }
        let mut capture = capture;
        let image = match capture.screenshot.take() {
            None => None,
            Some(url) => Some(
                tokio::task::spawn_blocking(move || decode_screenshot(&url))
                    .await
                    .unwrap_or(Err(ScreenshotError::Invalid))
                    .map_err(|error| AnnotationError::invalid(&error.to_string()))?,
            ),
        };
        let mut fields = match to_json(&capture) {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        let id = text(&fields, "id").to_owned();
        require_id(&id)?;
        let now = self.now();
        let project = project_id.to_owned();
        self.with_project(project_id, move |data| {
            if data.deleted.contains(&id) {
                return Err(AnnotationError::Removed { id });
            }
            let existing = data.find(&id).cloned();
            if existing.is_none() && data.records.len() >= MAX_PER_PROJECT {
                return Err(AnnotationError::invalid(
                    "This project has 1000 annotations. Remove some first.",
                ));
            }
            if let Some(image) = &image {
                write(&data.screenshot_file(&id, image.extension), &image.bytes)
                    .map_err(AnnotationError::store("Could not save the screenshot."))?;
                data.remove_screenshots(&id, Some(image.extension));
            }
            let number = existing
                .as_ref()
                .map_or(data.last_number + 1, |e| number(e, "number"));
            fields.insert("comment".into(), json!(comment));
            fields.insert("projectId".into(), json!(project));
            fields.insert("number".into(), json!(number));
            let kept = |key: &str| existing.as_ref().and_then(|e| e.get(key)).cloned();
            fields.insert(
                "status".into(),
                kept("status").unwrap_or_else(|| json!("todo")),
            );
            let had_screenshot = existing
                .as_ref()
                .is_some_and(|e| e.get("hasScreenshot") == Some(&json!(true)));
            fields.insert(
                "hasScreenshot".into(),
                json!(image.is_some() || had_screenshot),
            );
            fields.insert(
                "createdAt".into(),
                kept("createdAt").unwrap_or_else(|| json!(now)),
            );
            for key in ["summary", "question", "claimedAt", "completedAt"] {
                if let Some(value) = kept(key) {
                    fields.insert(key.into(), value);
                }
            }
            let last = data.last_number.max(number);
            data.save(fields, last).map(Value::Object)
        })
        .await
    }

    /// `remove`: `ids`, else every record; `scope` `done` keeps only done ones, `idle`
    /// everything not in progress. Ids are recorded as removed first, so a stopped removal
    /// finishes on the next load.
    pub async fn remove(
        &self,
        project_id: &str,
        ids: Option<Vec<String>>,
        scope: Option<AnnotationRemoveInputScope>,
    ) -> Result<Vec<String>, AnnotationError> {
        self.with_project(project_id, move |data| {
            let failed = AnnotationError::store("Could not remove the annotations.");
            let candidates: Vec<&Map<String, Value>> = match &ids {
                None => data.records.iter().collect(),
                Some(ids) => ids
                    .iter()
                    .filter(|id| is_annotation_id(id))
                    .filter_map(|id| data.find(id))
                    .collect(),
            };
            let removed: Vec<String> = candidates
                .into_iter()
                .filter(|r| match scope {
                    Some(AnnotationRemoveInputScope::Done) => text(r, "status") == "done",
                    Some(AnnotationRemoveInputScope::Idle) => text(r, "status") != "in_progress",
                    None => true,
                })
                .map(|r| text(r, "id").to_owned())
                .collect();
            if removed.is_empty() {
                return Ok(removed);
            }
            let mut order = data.deleted_order.clone();
            order.extend(
                removed
                    .iter()
                    .filter(|id| !data.deleted.contains(*id))
                    .cloned(),
            );
            let excess = order.len().saturating_sub(MAX_TOMBSTONES);
            order.drain(..excess);
            let body = Value::from(order.clone()).to_string();
            write(&data.dir.join("_deleted.json"), body.as_bytes()).map_err(&failed)?;
            data.deleted = order.iter().cloned().collect();
            data.deleted_order = order;
            let (last, revision) = (data.last_number, data.revision + 1);
            data.save_sequence(last, revision).map_err(&failed)?;
            for id in &removed {
                data.records.retain(|r| text(r, "id") != id);
                let _ = std::fs::remove_file(data.record_path(id));
                data.remove_screenshots(id, None);
            }
            Ok(removed)
        })
        .await
    }

    /// `claim`: by id only from `todo` (a claim by id answers a question, so its marker and
    /// question go); without an id, the oldest todo that is not a question, or `None`.
    pub async fn claim(
        &self,
        project_id: &str,
        id: Option<String>,
    ) -> Result<Option<Value>, AnnotationError> {
        if let Some(id) = &id {
            require_id(id)?;
        }
        let now = self.now();
        let project = project_id.to_owned();
        self.with_project(project_id, move |data| {
            let target = match &id {
                None => {
                    let waiting = data.records.iter().find(|r| {
                        text(r, "status") == "todo" && r.get("question") != Some(&json!(true))
                    });
                    match waiting {
                        Some(record) => record.clone(),
                        None => return Ok(None),
                    }
                }
                Some(id) => {
                    let record =
                        data.find(id)
                            .cloned()
                            .ok_or_else(|| AnnotationError::NotFound {
                                project_id: project.clone(),
                                id: id.clone(),
                            })?;
                    require_status(&record, "todo")?;
                    record
                }
            };
            let mut next = target;
            let question = next.remove("question");
            let summary = next.remove("summary");
            next.remove("completedAt");
            if question != Some(json!(true))
                && let Some(summary) = summary
            {
                next.insert("summary".into(), summary);
            }
            next.insert("status".into(), json!("in_progress"));
            next.insert("claimedAt".into(), json!(now));
            let last = data.last_number;
            data.save(next, last).map(|r| Some(Value::Object(r)))
        })
        .await
    }

    /// `complete`: from `in_progress`; a done annotation is answered unchanged.
    pub async fn complete(
        &self,
        project_id: &str,
        id: String,
        summary: Option<String>,
    ) -> Result<Value, AnnotationError> {
        require_id(&id)?;
        let now = self.now();
        let project = project_id.to_owned();
        self.with_project(project_id, move |data| {
            let current = data.find(&id).cloned().ok_or(AnnotationError::NotFound {
                project_id: project,
                id,
            })?;
            if text(&current, "status") == "done" {
                return Ok(Value::Object(current));
            }
            require_status(&current, "in_progress")?;
            let mut next = current;
            if let Some(text) = summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                next.insert("summary".into(), json!(text));
            }
            next.insert("status".into(), json!("done"));
            next.insert("completedAt".into(), json!(now));
            let last = data.last_number;
            data.save(next, last).map(Value::Object)
        })
        .await
    }

    /// `release`: back to `todo` from `in_progress`; a todo annotation is answered unchanged.
    /// A question needs its text as summary.
    pub async fn release(
        &self,
        project_id: &str,
        id: String,
        summary: Option<String>,
        question: bool,
    ) -> Result<Value, AnnotationError> {
        require_id(&id)?;
        let text_summary = summary
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if question && text_summary.is_none() {
            return Err(AnnotationError::invalid(
                "A question needs the question as summary.",
            ));
        }
        let project = project_id.to_owned();
        self.with_project(project_id, move |data| {
            let current = data.find(&id).cloned().ok_or(AnnotationError::NotFound {
                project_id: project,
                id,
            })?;
            if text(&current, "status") == "todo" {
                return Ok(Value::Object(current));
            }
            require_status(&current, "in_progress")?;
            let mut next = current;
            for key in ["claimedAt", "completedAt", "question"] {
                next.remove(key);
            }
            if let Some(summary) = text_summary {
                next.insert("summary".into(), json!(summary));
            }
            if question {
                next.insert("question".into(), json!(true));
            }
            next.insert("status".into(), json!("todo"));
            let last = data.last_number;
            data.save(next, last).map(Value::Object)
        })
        .await
    }

    /// `screenshotPath`: the screenshot file of an annotation that has one.
    pub async fn screenshot_path(
        &self,
        project_id: &str,
        id: String,
    ) -> Result<Option<PathBuf>, AnnotationError> {
        require_id(&id)?;
        self.with_project(project_id, move |data| {
            if data.find(&id).and_then(|r| r.get("hasScreenshot")) != Some(&json!(true)) {
                return Ok(None);
            }
            Ok(SCREENSHOT_EXTENSIONS
                .iter()
                .map(|extension| data.screenshot_file(&id, extension))
                .find(|file| file.exists()))
        })
        .await
    }
}

/// [`ProjectLookup`] on the engine's shell: a project that is not deleted.
#[derive(Clone)]
pub struct EngineProjects(pub Arc<dyn conn_engine::Engine>);

impl std::fmt::Debug for EngineProjects {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EngineProjects")
    }
}

impl ProjectLookup for EngineProjects {
    fn exists(&self, project_id: String) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            let shell = self.0.shell_snapshot().await.map_err(|e| match e {
                conn_engine::EngineError::Internal(message) => message,
                conn_engine::EngineError::Rejected(_) => "The shell snapshot was refused.".into(),
            })?;
            Ok(shell["projects"].as_array().is_some_and(|projects| {
                projects
                    .iter()
                    .any(|p| p["id"] == project_id.as_str() && p["deletedAt"].is_null())
            }))
        })
    }
}

#[cfg(test)]
mod tests;
