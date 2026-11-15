//! Live output of a foreground Bash call, as `ClaudeTaskOutputTail.ts` reads it: the SDK holds
//! a command's stdout until its tool result, so the provider tails the file Claude Code writes
//! for the `task_started` task (`<root>/<project>/<session>/tasks/<task>.output`) every 250 ms.
//! The layout is Claude Code's own and can change; a tail that finds nothing gives no live
//! output, and the row still gets the final output from the tool result.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use conn_provider::ProviderEvent;
use serde_json::{Map, Value};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

const POLL: Duration = Duration::from_millis(250);
/// Bounds discovery when Claude never writes the file.
const MAX_LOCATE_ATTEMPTS: u32 = 40;
/// Skips ahead of fast writers; only the tail is shown.
const MAX_READ_BYTES: u64 = 256 * 1024;
/// How long a stop waits for the last read.
pub(crate) const STOP_WAIT: Duration = Duration::from_secs(5);

/// `claudeTaskOutputRoot`: Claude Code's per-user temp root. Its macOS build uses `/tmp` and
/// ignores `TMPDIR`; other builds read `TMPDIR`, `TMP`, `TEMP` from the environment the CLI
/// starts with. `CLAUDE_CODE_TMPDIR` wins; a relative value is relative to the CLI's cwd.
pub(crate) fn output_root(env: &Map<String, Value>, cwd: Option<&Path>) -> PathBuf {
    let var = |key: &str| {
        env.get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    let fallback = if cfg!(target_os = "macos") {
        "/tmp"
    } else {
        var("TMPDIR")
            .or_else(|| var("TMP"))
            .or_else(|| var("TEMP"))
            .unwrap_or("/tmp")
    };
    let base = var("CLAUDE_CODE_TMPDIR")
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(fallback);
    let base = Path::new(base);
    let resolved = if base.is_absolute() {
        base.to_path_buf()
    } else {
        cwd.map_or_else(|| base.to_path_buf(), |c| c.join(base))
    };
    resolved.join(format!("claude-{}", rustix::process::getuid().as_raw()))
}

/// A path segment the CLI chose; anything that could leave the root is refused.
fn plain_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// A running tail. Dropping it stops the task.
#[derive(Debug)]
pub(crate) struct Tail {
    stop: watch::Sender<bool>,
    done: JoinHandle<()>,
}

impl Tail {
    /// Asks for a last read and waits for it (at most [`STOP_WAIT`]).
    pub(crate) async fn finish(mut self) {
        let _ = self.stop.send(true);
        if tokio::time::timeout(STOP_WAIT, &mut self.done)
            .await
            .is_err()
        {
            self.done.abort();
        }
    }
}

impl Drop for Tail {
    fn drop(&mut self) {
        self.done.abort();
    }
}

pub(crate) struct Target {
    pub root: PathBuf,
    pub session_id: String,
    pub task_id: String,
    pub thread_id: String,
    pub item_id: String,
}

/// Starts tailing; `None` when the ids could not name a file under the root.
pub(crate) fn spawn(target: Target, events: mpsc::Sender<ProviderEvent>) -> Option<Tail> {
    if !plain_segment(&target.session_id) || !plain_segment(&target.task_id) {
        return None;
    }
    let (stop, stopped) = watch::channel(false);
    let done = tokio::spawn(run(target, events, stopped));
    Some(Tail { stop, done })
}

/// Waits one poll interval; true when a stop was asked (now or before).
async fn pause(stopped: &mut watch::Receiver<bool>) -> bool {
    if *stopped.borrow() {
        return true;
    }
    tokio::select! {
        changed = stopped.changed() => changed.is_err() || *stopped.borrow(),
        () = tokio::time::sleep(POLL) => false,
    }
}

fn locate(root: &Path, session: &str, task: &str) -> Option<PathBuf> {
    let projects = std::fs::read_dir(root).ok()?;
    projects.flatten().find_map(|project| {
        let candidate = project
            .path()
            .join(session)
            .join("tasks")
            .join(format!("{task}.output"));
        candidate.is_file().then_some(candidate)
    })
}

/// Reads from `offset` (or the last [`MAX_READ_BYTES`]) to the end. Returns the start and the
/// bytes; `None` when nothing new or the file is unreadable.
fn read_from(file: &Path, offset: u64) -> Option<(u64, Vec<u8>)> {
    let size = std::fs::metadata(file).ok()?.len();
    let offset = if size < offset { 0 } else { offset };
    if size <= offset {
        return (size < offset).then(|| (0, Vec::new()));
    }
    let start = if size - offset > MAX_READ_BYTES {
        size - MAX_READ_BYTES
    } else {
        offset
    };
    let mut handle = std::fs::File::open(file).ok()?;
    handle.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    handle.take(size - start).read_to_end(&mut bytes).ok()?;
    Some((start, bytes))
}

/// A streaming UTF-8 decoder like `TextDecoder("utf-8", {fatal: false})`: invalid bytes become
/// U+FFFD; an incomplete code point at the end waits for the next read.
#[derive(Default)]
struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    fn decode(&mut self, bytes: &[u8]) -> String {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(bytes);
        let keep = incomplete_tail(&data);
        let split = data.len() - keep;
        self.pending = data.split_off(split);
        String::from_utf8_lossy(&data).into_owned()
    }

    fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&rest).into_owned()
    }
}

/// The length of an unfinished UTF-8 sequence at the end of `data` (0 to 3 bytes).
fn incomplete_tail(data: &[u8]) -> usize {
    for back in 1..=3.min(data.len()) {
        let Some(&byte) = data.get(data.len() - back) else {
            return 0;
        };
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let needed = match byte {
            b if b & 0xE0 == 0xC0 => 2,
            b if b & 0xF0 == 0xE0 => 3,
            b if b & 0xF8 == 0xF0 => 4,
            _ => return 0,
        };
        return if back < needed { back } else { 0 };
    }
    0
}

async fn run(
    target: Target,
    events: mpsc::Sender<ProviderEvent>,
    mut stopped: watch::Receiver<bool>,
) {
    let emit = |chunk: String| {
        let events = events.clone();
        let (thread_id, item_id) = (target.thread_id.clone(), target.item_id.clone());
        async move {
            if !chunk.is_empty() {
                let _ = events
                    .send(ProviderEvent::CommandOutputDelta {
                        thread_id: thread_id.as_str().into(),
                        item_id: item_id.as_str().into(),
                        chunk,
                    })
                    .await;
            }
        }
    };
    let mut file = None;
    for attempt in 0.. {
        let (root, session, task) = (
            target.root.clone(),
            target.session_id.clone(),
            target.task_id.clone(),
        );
        file = tokio::task::spawn_blocking(move || locate(&root, &session, &task))
            .await
            .ok()
            .flatten();
        if file.is_some() || attempt + 1 >= MAX_LOCATE_ATTEMPTS || pause(&mut stopped).await {
            break;
        }
    }
    let Some(file) = file else {
        return;
    };
    let mut decoder = Decoder::default();
    let mut offset = 0u64;
    let mut last = *stopped.borrow();
    loop {
        let path = file.clone();
        let read = tokio::task::spawn_blocking(move || read_from(&path, offset))
            .await
            .ok()
            .flatten();
        if let Some((start, bytes)) = read {
            if start < offset || (start == 0 && bytes.is_empty()) {
                // The file shrank: start over.
                decoder = Decoder::default();
            }
            let skipped = start > offset;
            let mut first = 0;
            if skipped {
                // Skipped output must not splice two lines; drop a cut code point.
                decoder = Decoder::default();
                while bytes.get(first).is_some_and(|b| b & 0xC0 == 0x80) {
                    first += 1;
                }
            }
            offset = start + bytes.len() as u64;
            let body = bytes.get(first..).unwrap_or_default();
            let mut text = decoder.decode(body);
            if skipped {
                text.insert(0, '\n');
            }
            emit(text).await;
        }
        if last {
            emit(decoder.finish()).await;
            return;
        }
        last = pause(&mut stopped).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_keeps_split_code_points() {
        let mut d = Decoder::default();
        let bytes = "é✓".as_bytes();
        assert_eq!(d.decode(&bytes[..1]), "");
        assert_eq!(d.decode(&bytes[1..3]), "é");
        assert_eq!(d.decode(&bytes[3..]), "✓");
        assert_eq!(d.decode(&[0xFF, b'a']), "\u{FFFD}a");
        assert_eq!(d.decode(&[0xE2]), "");
        assert_eq!(d.finish(), "\u{FFFD}");
    }

    #[test]
    fn root_follows_claude_task_output_root() {
        let mut env = Map::new();
        env.insert("CLAUDE_CODE_TMPDIR".into(), Value::from("rel"));
        let root = output_root(&env, Some(Path::new("/work")));
        assert!(root.starts_with("/work/rel"));
        assert!(
            root.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("claude-"))
        );
        assert!(!plain_segment("../x") && !plain_segment("a/b") && plain_segment("b1x-2_3"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_tail_streams_the_file_and_reads_once_more_on_stop() {
        let root = std::env::temp_dir().join(format!("conn-claude-tail-{}", std::process::id()));
        let tasks = root.join("project").join("session-1").join("tasks");
        std::fs::create_dir_all(&tasks).unwrap();
        let file = tasks.join("task-1.output");
        std::fs::write(&file, "line 1\n").unwrap();
        let (tx, mut rx) = mpsc::channel(16);
        let tail = spawn(
            Target {
                root: root.clone(),
                session_id: "session-1".into(),
                task_id: "task-1".into(),
                thread_id: "thread".into(),
                item_id: "item".into(),
            },
            tx,
        )
        .unwrap();
        let first = rx.recv().await.unwrap();
        assert!(
            matches!(first, ProviderEvent::CommandOutputDelta { ref chunk, .. } if chunk == "line 1\n")
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .and_then(|mut f| std::io::Write::write_all(&mut f, b"line 2\n"))
            .unwrap();
        tail.finish().await;
        let second = rx.recv().await.unwrap();
        assert!(
            matches!(second, ProviderEvent::CommandOutputDelta { ref chunk, .. } if chunk == "line 2\n")
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
