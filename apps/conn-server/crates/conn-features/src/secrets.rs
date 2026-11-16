//! Secret request answers in T3's store, behind project-scoped, one-use references.

use conn_contract::{SecretRequestAnswerInput, SecretRequestAnswerInputAnswer, ThreadId};
use conn_engine::Engine;
use conn_support::{hex::hex, hmac::hmac_sha256, secret_store};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, Semaphore};

use crate::clock::Clock;

/// T3 expires saved answers and shell files after 24 hours.
const TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Bounds simultaneous waits and retained disk entries without keeping answers in memory.
const MAX_REQUESTS: usize = 64;
const MAX_STORED: usize = 1024;

#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("secret request: {0}")]
pub struct SecretError(pub &'static str);

impl SecretError {
    pub fn to_contract(self) -> Value {
        json!({"_tag":"SecretRequestError", "reason":self.0})
    }
    pub fn message(self) -> String {
        texts()
            .get("errors")
            .and_then(|v| v.get(self.0))
            .and_then(Value::as_str)
            .unwrap_or("Could not use the secret.")
            .to_owned()
    }
}

fn texts() -> Value {
    serde_json::from_str(include_str!("secret-texts.json")).unwrap_or(Value::Null)
}

pub fn unsaved_note(status: &str) -> Value {
    texts()
        .get("notes")
        .and_then(|n| n.get(status))
        .cloned()
        .unwrap_or(Value::Null)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    project_id: String,
    value: String,
    saved_at: i64,
}

struct Inner {
    dir: PathBuf,
    engine: Arc<dyn Engine>,
    clock: Arc<dyn Clock>,
    lock: Mutex<()>,
    waits: Arc<Semaphore>,
}

#[derive(Clone)]
pub struct SecretRequests(Arc<Inner>);

impl std::fmt::Debug for SecretRequests {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretRequests")
            .field("dir", &self.0.dir)
            .finish_non_exhaustive()
    }
}

impl SecretRequests {
    pub fn new(state_dir: &Path, engine: Arc<dyn Engine>, clock: Arc<dyn Clock>) -> Self {
        let service = Self(Arc::new(Inner {
            dir: state_dir.join("secrets"),
            engine,
            clock,
            lock: Mutex::new(()),
            waits: Arc::new(Semaphore::new(MAX_REQUESTS)),
        }));
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let weak = Arc::downgrade(&service.0);
            runtime.spawn(async move {
                loop {
                    let Some(inner) = weak.upgrade() else {
                        return;
                    };
                    let service = Self(inner);
                    let _ = service.disk(sweep).await;
                    drop(service);
                    tokio::time::sleep(Duration::from_secs(60 * 60)).await;
                }
            });
        }
        service
    }

    pub fn reserve(&self) -> Result<tokio::sync::OwnedSemaphorePermit, SecretError> {
        self.0
            .waits
            .clone()
            .try_acquire_owned()
            .map_err(|_| SecretError("store_failed"))
    }

    async fn disk<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Path, i64) -> Result<T, SecretError> + Send + 'static,
    ) -> Result<T, SecretError> {
        let dir = self.0.dir.clone();
        let now = self.0.clock.now_ms();
        tokio::task::spawn_blocking(move || f(&dir, now))
            .await
            .map_err(|_| SecretError("store_failed"))?
    }

    async fn projection(&self, thread: &str) -> Result<Value, SecretError> {
        self.0
            .engine
            .get_thread_projection(ThreadId::from(thread))
            .await
            .map_err(|_| SecretError("load_failed"))
    }

    pub async fn answer(&self, input: SecretRequestAnswerInput) -> Result<(), SecretError> {
        let records = self.projection(&input.thread_id).await?;
        let item = turn_item(&records, &input.turn_item_id);
        let Some(item) = item.filter(|i| {
            i.get("type").and_then(Value::as_str) == Some("secret_request")
                && i.get("runId").is_some_and(Value::is_string)
                && i.get("nodeId").is_some_and(Value::is_string)
        }) else {
            return Err(SecretError("not_found"));
        };
        if item.get("secretStatus").and_then(Value::as_str) != Some("pending") {
            return Err(SecretError("already_answered"));
        }
        let run = item
            .get("runId")
            .and_then(Value::as_str)
            .and_then(|id| run(&records, id));
        if run.is_none_or(|r| terminal(r.get("status").and_then(Value::as_str))) {
            return Err(SecretError("agent_stopped"));
        }
        let secret = match input.answer {
            SecretRequestAnswerInputAnswer::Save(save) => Some(save.secret),
            SecretRequestAnswerInputAnswer::Decline(_) => None,
            SecretRequestAnswerInputAnswer::Reference(_) => {
                return Err(SecretError("reference_unreadable"));
            }
        };
        let thread = input.thread_id.clone();
        let id = input.turn_item_id.clone();
        let project = records
            .get("thread")
            .and_then(|t| t.get("projectId"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let saved = secret.is_some();
        if let Some(value) = secret {
            self.disk(move |dir, now| {
                sweep(dir, now)?;
                let name = store_name(&ref_for(dir, &thread, &id)?);
                if secret_store::read(dir, &name)
                    .map_err(|_| SecretError("store_failed"))?
                    .is_none()
                {
                    check_capacity(dir)?;
                    let bytes = serde_json::to_vec(&Stored {
                        project_id: project,
                        value,
                        saved_at: now,
                    })
                    .map_err(|_| SecretError("store_failed"))?;
                    create(dir, &name, &bytes).map_err(|_| SecretError("store_failed"))?;
                }
                Ok(())
            })
            .await?;
        }
        let status = if saved { "saved" } else { "declined" };
        let mut command = item.clone();
        if let Some(fields) = command.as_object_mut() {
            fields.insert(
                "commandId".into(),
                json!(format!("secret-request:{}:{status}", input.turn_item_id)),
            );
            fields.insert("turnItemId".into(), json!(input.turn_item_id));
            fields.insert("secretStatus".into(), json!(status));
        }
        if self.0.engine.record_secret_request(command).await.is_err() {
            if saved
                && self
                    .remove_answer(&input.thread_id, &input.turn_item_id)
                    .await
                    .is_err()
            {
                eprintln!("Could not delete a secret request value");
            }
            return Err(SecretError("record_failed"));
        }
        if saved {
            let current = self.projection(&input.thread_id).await?;
            let recorded = turn_item(&current, &input.turn_item_id);
            if recorded
                .is_some_and(|i| i.get("secretStatus").and_then(Value::as_str) != Some("saved"))
            {
                if self
                    .remove_answer(&input.thread_id, &input.turn_item_id)
                    .await
                    .is_err()
                {
                    eprintln!("Could not delete a secret request value");
                }
                return Err(SecretError("agent_stopped"));
            }
        }
        Ok(())
    }

    async fn remove_answer(&self, thread: &str, item: &str) -> Result<(), SecretError> {
        let (thread, item) = (thread.to_owned(), item.to_owned());
        self.disk(move |dir, _| {
            secret_store::remove(dir, &store_name(&ref_for(dir, &thread, &item)?))
                .map_err(|_| SecretError("store_failed"))
        })
        .await
    }

    pub async fn saved_ref(&self, thread: &str, item: &str) -> Result<Option<String>, SecretError> {
        let (thread, item) = (thread.to_owned(), item.to_owned());
        self.disk(move |dir, _| {
            let reference = ref_for(dir, &thread, &item)?;
            Ok(secret_store::read(dir, &store_name(&reference))
                .map_err(|_| SecretError("read_failed"))?
                .map(|_| reference))
        })
        .await
    }

    pub async fn consume(&self, reference: &str, project: &str) -> Result<String, SecretError> {
        let _lock = self.0.lock.lock().await;
        let (reference, project) = (reference.to_owned(), project.to_owned());
        self.disk(move |dir, now| {
            let value = read_ref(dir, &reference, &project, now)?;
            secret_store::remove(dir, &store_name(&reference))
                .map_err(|_| SecretError("consume_failed"))?;
            Ok(value)
        })
        .await
    }

    pub async fn save_to_file(&self, thread: &str, item: &str) -> Result<String, SecretError> {
        let records = self.projection(thread).await?;
        let card = turn_item(&records, item);
        if !card.is_some_and(|i| {
            i.get("type").and_then(Value::as_str) == Some("secret_request")
                && i.get("secretStatus").and_then(Value::as_str) == Some("saved")
                && i.get("delivery").and_then(Value::as_str) == Some("file")
        }) {
            return Err(SecretError("not_a_file_request"));
        }
        let project = records
            .get("thread")
            .and_then(|t| t.get("projectId"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let (thread, item) = (thread.to_owned(), item.to_owned());
        let _lock = self.0.lock.lock().await;
        self.disk(move |dir, now| {
            let reference = ref_for(dir, &thread, &item)?;
            let file = file_path(dir, &reference)?;
            if !file.try_exists().map_err(|_| SecretError("store_failed"))? {
                let value = read_ref(dir, &reference, &project, now)?;
                write_file(dir, &file, &value)?;
            }
            secret_store::remove(dir, &store_name(&reference))
                .map_err(|_| SecretError("consume_failed"))?;
            Ok(file.to_string_lossy().into_owned())
        })
        .await
    }

    pub async fn save_pasted(
        &self,
        thread: &str,
        namespace: &str,
        key: &str,
        value: String,
    ) -> Result<String, SecretError> {
        self.disk(sweep).await?;
        let thread = thread.to_owned();
        let key = format!("pasted\0{namespace}\0{key}");
        let _lock = self.0.lock.lock().await;
        self.disk(move |dir, _| {
            let file = file_path(dir, &ref_for(dir, &thread, &key)?)?;
            if !file.try_exists().map_err(|_| SecretError("store_failed"))? {
                check_capacity(dir)?;
                write_file(dir, &file, &value)?;
            }
            Ok(file.to_string_lossy().into_owned())
        })
        .await
    }
}

pub fn turn_item<'a>(projection: &'a Value, id: &str) -> Option<&'a Value> {
    projection
        .get("turnItems")?
        .as_array()?
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
}

pub fn run<'a>(projection: &'a Value, id: &str) -> Option<&'a Value> {
    projection
        .get("runs")?
        .as_array()?
        .iter()
        .find(|run| run.get("id").and_then(Value::as_str) == Some(id))
}

pub fn terminal(status: Option<&str>) -> bool {
    !matches!(
        status,
        Some("preparing" | "starting" | "running" | "waiting" | "queued")
    )
}

fn create(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    secret_store::ensure_dir(dir)?;
    let partial = dir.join(format!("{name}.{}.tmp", conn_support::uuid_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        match std::fs::hard_link(&partial, dir.join(format!("{name}.bin"))) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            other => other,
        }
    })();
    let _ = std::fs::remove_file(partial);
    result
}

fn ref_for(dir: &Path, thread: &str, item: &str) -> Result<String, SecretError> {
    let salt = match secret_store::read(dir, "secret-request-salt")
        .map_err(|_| SecretError("store_failed"))?
    {
        Some(salt) => salt,
        None => {
            let mut bytes = [0; 32];
            getrandom::fill(&mut bytes).map_err(|_| SecretError("store_failed"))?;
            create(dir, "secret-request-salt", &bytes).map_err(|_| SecretError("store_failed"))?;
            secret_store::read(dir, "secret-request-salt")
                .map_err(|_| SecretError("store_failed"))?
                .ok_or(SecretError("store_failed"))?
        }
    };
    let tag = hmac_sha256(
        hex(&salt).as_bytes(),
        format!("{thread}\0{item}").as_bytes(),
    );
    Ok(format!(
        "secret-ref:{}",
        hex(&tag).chars().take(32).collect::<String>()
    ))
}

fn is_ref_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn suffix(reference: &str) -> Result<&str, SecretError> {
    reference
        .strip_prefix("secret-ref:")
        .filter(|s| is_ref_id(s))
        .ok_or(SecretError("invalid_ref"))
}
fn store_name(reference: &str) -> String {
    format!(
        "secret-request-{}",
        reference.strip_prefix("secret-ref:").unwrap_or_default()
    )
}
fn file_path(dir: &Path, reference: &str) -> Result<PathBuf, SecretError> {
    Ok(dir.join("files").join(suffix(reference)?))
}
fn read_ref(dir: &Path, reference: &str, project: &str, now: i64) -> Result<String, SecretError> {
    suffix(reference)?;
    let bytes = secret_store::read(dir, &store_name(reference))
        .map_err(|_| SecretError("read_failed"))?
        .ok_or(SecretError("ref_unavailable"))?;
    let stored: Stored =
        serde_json::from_slice(&bytes).map_err(|_| SecretError("ref_unavailable"))?;
    if stored.project_id != project {
        return Err(SecretError("ref_unavailable"));
    }
    if now.saturating_sub(stored.saved_at) > TTL_MS {
        secret_store::remove(dir, &store_name(reference))
            .map_err(|_| SecretError("consume_failed"))?;
        return Err(SecretError("ref_expired"));
    }
    Ok(stored.value)
}
fn write_file(dir: &Path, file: &Path, value: &str) -> Result<(), SecretError> {
    let files = dir.join("files");
    secret_store::ensure_dir(&files).map_err(|_| SecretError("store_failed"))?;
    let partial = file.with_extension("partial");
    let _ = std::fs::remove_file(&partial);
    let result = conn_support::fs::write_atomic_to(&partial, file, value.as_bytes(), 0o600);
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result.map_err(|_| SecretError("store_failed"))
}

fn entries(dir: &Path) -> Result<impl Iterator<Item = std::fs::DirEntry>, SecretError> {
    match std::fs::read_dir(dir) {
        Ok(entries) => Ok(Some(entries).into_iter().flatten().filter_map(Result::ok)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(None.into_iter().flatten().filter_map(Result::ok))
        }
        Err(_) => Err(SecretError("store_failed")),
    }
}
fn check_capacity(dir: &Path) -> Result<(), SecretError> {
    let stored = entries(dir)?
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("secret-request-")
        })
        .take(MAX_STORED)
        .count();
    let files = entries(&dir.join("files"))?.take(MAX_STORED).count();
    if stored + files >= MAX_STORED {
        Err(SecretError("store_failed"))
    } else {
        Ok(())
    }
}
fn sweep(dir: &Path, now: i64) -> Result<(), SecretError> {
    for entry in entries(dir)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name
            .strip_prefix("secret-request-")
            .and_then(|s| s.strip_suffix(".bin"))
            .filter(|s| is_ref_id(s))
        {
            let reference = format!("secret-ref:{id}");
            if let Some(bytes) = secret_store::read(dir, &store_name(&reference))
                .map_err(|_| SecretError("read_failed"))?
            {
                let valid = serde_json::from_slice::<Stored>(&bytes)
                    .ok()
                    .is_some_and(|s| now.saturating_sub(s.saved_at) <= TTL_MS);
                if !valid {
                    secret_store::remove(dir, &store_name(&reference))
                        .map_err(|_| SecretError("store_failed"))?;
                }
            }
        }
    }
    for entry in entries(&dir.join("files"))? {
        let name = entry.file_name().to_string_lossy().into_owned();
        let suffix = name.strip_suffix(".partial").unwrap_or(&name);
        if !is_ref_id(suffix) {
            continue;
        }
        let expired = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .is_none_or(|t| {
                i128::from(now) - i128::try_from(t.as_millis()).unwrap_or(i128::MAX)
                    > i128::from(TTL_MS)
            });
        if expired {
            std::fs::remove_file(entry.path()).map_err(|_| SecretError("store_failed"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TestEngine {
        records: Value,
        fail_record_in: Option<PathBuf>,
    }
    impl Engine for TestEngine {
        fn dispatch(
            &self,
            _: conn_contract::Command,
        ) -> conn_engine::BoxFuture<
            '_,
            Result<
                conn_contract::DispatchCommandResult,
                conn_engine::EngineError<conn_contract::DispatchCommandError>,
            >,
        > {
            Box::pin(async { Err(conn_engine::EngineError::Internal("unused".into())) })
        }
        fn subscribe_shell(
            &self,
            _: conn_contract::SubscribeShellInput,
        ) -> conn_engine::BoxFuture<
            '_,
            Result<
                conn_engine::Subscription<
                    conn_contract::ShellStreamItem,
                    conn_contract::GetShellSnapshotError,
                >,
                conn_engine::EngineError<conn_contract::GetShellSnapshotError>,
            >,
        > {
            Box::pin(async { Err(conn_engine::EngineError::Internal("unused".into())) })
        }
        fn subscribe_thread(
            &self,
            _: conn_contract::SubscribeThreadInput,
        ) -> conn_engine::BoxFuture<
            '_,
            Result<
                conn_engine::Subscription<
                    conn_contract::ThreadStreamItem,
                    conn_contract::GetThreadProjectionError,
                >,
                conn_engine::EngineError<conn_contract::GetThreadProjectionError>,
            >,
        > {
            Box::pin(async { Err(conn_engine::EngineError::Internal("unused".into())) })
        }
        fn get_thread_projection(
            &self,
            _: ThreadId,
        ) -> conn_engine::BoxFuture<
            '_,
            Result<Value, conn_engine::EngineError<conn_contract::GetThreadProjectionError>>,
        > {
            Box::pin(std::future::ready(Ok(self.records.clone())))
        }
        fn record_secret_request(
            &self,
            _: Value,
        ) -> conn_engine::BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                if let Some(dir) = &self.fail_record_in {
                    let dir = dir.clone();
                    tokio::task::spawn_blocking(move || {
                        let file = dir.join(format!(
                            "{}.bin",
                            store_name(&ref_for(&dir, "thread", "item").unwrap())
                        ));
                        fs::remove_file(&file).unwrap();
                        fs::create_dir(file).unwrap();
                    })
                    .await
                    .unwrap();
                    Err("record failed".into())
                } else {
                    Ok(())
                }
            })
        }
    }
    fn pending_records() -> Value {
        json!({"thread":{"projectId":"p"},"runs":[{"id":"run","status":"running"}],"turnItems":[{"id":"item","type":"secret_request","threadId":"thread","runId":"run","nodeId":"node","secretStatus":"pending","label":"Key","reason":"Fixture"}]})
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_answer_can_complete_while_an_unrelated_consumer_holds_the_lock() {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        let dir = std::env::temp_dir().join(format!(
            "conn-secret-answer-lock-{}",
            conn_support::uuid_v4()
        ));
        let service = SecretRequests::new(
            &dir,
            Arc::new(TestEngine {
                records: pending_records(),
                fail_record_in: None,
            }),
            Arc::new(crate::clock::SystemClock),
        );
        let _consumer = service.0.lock.lock().await;
        let mut answer = std::pin::pin!(
            service.answer(
                conn_contract::from_json(
                    json!({"threadId":"thread","turnItemId":"item","answer":{"type":"decline"}})
                )
                .unwrap()
            )
        );
        assert!(
            matches!(
                answer
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop())),
                Poll::Ready(Ok(()))
            ),
            "answer must not wait for an unrelated consumer"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_answer_cleanup_does_not_replace_the_record_failure() {
        let dir = std::env::temp_dir().join(format!(
            "conn-secret-record-error-{}",
            conn_support::uuid_v4()
        ));
        let service = SecretRequests::new(
            &dir,
            Arc::new(TestEngine {
                records: pending_records(),
                fail_record_in: Some(dir.join("secrets")),
            }),
            Arc::new(crate::clock::SystemClock),
        );
        let result = service.answer(conn_contract::from_json(json!({"threadId":"thread","turnItemId":"item","answer":{"type":"save","secret":"test-only"}})).unwrap()).await;
        assert_eq!(result.unwrap_err().0, "record_failed");
        drop(service);
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn waits_are_bounded_and_dropping_a_wait_releases_its_slot() {
        let dir =
            std::env::temp_dir().join(format!("conn-secret-bound-{}", conn_support::uuid_v4()));
        fs::create_dir_all(&dir).unwrap();
        let engine = Arc::new(
            conn_engine::SqliteEngine::open(conn_engine::EngineConfig::new(
                dir.join("engine.sqlite"),
            ))
            .unwrap(),
        );
        let service =
            SecretRequests::new(&dir, engine.clone(), Arc::new(crate::clock::SystemClock));
        let mut waits: Vec<_> = (0..MAX_REQUESTS)
            .map(|_| service.reserve().unwrap())
            .collect();
        assert_eq!(service.reserve().unwrap_err().0, "store_failed");
        waits.pop();
        assert!(service.reserve().is_ok());
        drop(service);
        engine.shutdown().await;
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_shell_file_publication_removes_the_partial_file() {
        let root =
            std::env::temp_dir().join(format!("conn-secret-partial-{}", conn_support::uuid_v4()));
        let dir = root.join("secrets");
        let file = dir.join("files").join("a".repeat(32));
        fs::create_dir_all(&file).unwrap();
        assert_eq!(
            write_file(&dir, &file, "test-only").unwrap_err().0,
            "store_failed"
        );
        assert!(
            !file.with_extension("partial").exists(),
            "a failed rename must not leave a secret partial file"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn store_matches_t3_refs_and_records_and_preserves_failed_file_writes() {
        let root =
            std::env::temp_dir().join(format!("conn-secret-interop-{}", conn_support::uuid_v4()));
        let dir = root.join("secrets");
        secret_store::write(&dir, "secret-request-salt", &[0x11; 32]).unwrap();
        let reference = ref_for(&dir, "thread", "item").unwrap();
        let expected = hex(&hmac_sha256("11".repeat(32).as_bytes(), b"thread\0item"));
        assert_eq!(
            reference,
            format!(
                "secret-ref:{}",
                expected.chars().take(32).collect::<String>()
            )
        );
        let name = store_name(&reference);
        let bytes = br#"{"projectId":"p","value":"  exact bytes\t ","savedAt":1000}"#;
        create(&dir, &name, bytes).unwrap();
        create(&dir, &name, b"replacement").unwrap();
        assert_eq!(
            read_ref(&dir, &reference, "p", 1000).unwrap(),
            "  exact bytes\t "
        );
        assert_eq!(
            read_ref(&dir, &reference, "wrong", 1000).unwrap_err().0,
            "ref_unavailable"
        );
        assert_eq!(
            read_ref(&dir, "secret-ref:../secret", "p", 1000)
                .unwrap_err()
                .0,
            "invalid_ref"
        );
        assert_eq!(
            read_ref(&dir, &reference, "p", 1000 + TTL_MS).unwrap(),
            "  exact bytes\t "
        );
        fs::write(dir.join("files"), b"blocks directory").unwrap();
        let file = file_path(&dir, &reference).unwrap();
        assert_eq!(
            write_file(&dir, &file, "value").unwrap_err().0,
            "store_failed"
        );
        assert_eq!(
            read_ref(&dir, &reference, "p", 1000).unwrap(),
            "  exact bytes\t ",
            "failed file write keeps stored value"
        );
        fs::remove_file(dir.join("files")).unwrap();
        assert_eq!(
            read_ref(&dir, &reference, "p", 1001 + TTL_MS)
                .unwrap_err()
                .0,
            "ref_expired"
        );
        assert!(secret_store::read(&dir, &name).unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_sweep_and_capacity_leave_settings_and_unrelated_files_alone() {
        let root =
            std::env::temp_dir().join(format!("conn-secret-sweep-{}", conn_support::uuid_v4()));
        let dir = root.join("secrets");
        secret_store::write(&dir, "provider-env-setting", b"keep").unwrap();
        secret_store::write(
            &dir,
            &format!("secret-request-{}", "a".repeat(32)),
            b"broken record",
        )
        .unwrap();
        let uppercase = format!("secret-request-{}", "B".repeat(32));
        secret_store::write(&dir, &uppercase, b"keep").unwrap();
        secret_store::ensure_dir(&dir.join("files")).unwrap();
        fs::write(dir.join("files/unrelated"), b"keep").unwrap();
        sweep(&dir, i64::MAX).unwrap();
        assert_eq!(
            secret_store::read(&dir, "provider-env-setting").unwrap(),
            Some(b"keep".to_vec())
        );
        assert_eq!(fs::read(dir.join("files/unrelated")).unwrap(), b"keep");
        assert_eq!(
            secret_store::read(&dir, &uppercase).unwrap(),
            Some(b"keep".to_vec()),
            "T3 sweeps lowercase ref ids only"
        );
        for n in 0..MAX_STORED {
            fs::write(dir.join("files").join(format!("{n:032x}")), b"value").unwrap();
        }
        assert_eq!(check_capacity(&dir).unwrap_err().0, "store_failed");
        fs::remove_dir_all(root).unwrap();
    }
}
