//! Scrollback on disk, so a terminal reopened after a server restart shows what it showed.
//!
//! One plain UTF-8 file per terminal: `<dir>/<fnv(thread)>-<fnv(terminal)>.log`. Writes append
//! the new tail and rewrite the file once it grows past twice the history cap, as
//! `apps/server` does. The files are bounded by the history cap; nothing else is kept.
//!
//! A terminal with no history here takes the tail of a T3 server's history for it
//! (`<state>/logs/terminals`, named as in `terminal/Manager.ts` `historyPaths`), so a T3 home
//! opened by this server keeps its scrollback. T3's file stays as it is.

use std::{
    fs, io,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub(crate) struct Store {
    dir: PathBuf,
    /// The T3 server's history folder, read when a terminal has no history here.
    t3_dir: Option<PathBuf>,
}

/// `DEFAULT_TERMINAL_ID`: the only terminal T3's oldest file names cover.
const DEFAULT_TERMINAL_ID: &str = "term-1";
/// `MAX_HISTORY_FILENAME_BYTES` in T3's `terminal/Manager.ts`.
const MAX_T3_NAME_BYTES: usize = 143;

impl Store {
    pub(crate) fn new(dir: PathBuf, t3_dir: Option<PathBuf>) -> Self {
        Self { dir, t3_dir }
    }

    /// The T3 server's names for this terminal's history, in the order T3 reads them.
    fn t3_paths(&self, thread_id: &str, terminal_id: &str) -> Vec<PathBuf> {
        let Some(dir) = &self.t3_dir else {
            return Vec::new();
        };
        let terminal = |part: String| (terminal_id != DEFAULT_TERMINAL_ID).then_some(part);
        let encoded = t3_name(
            &t3_encoded_thread(thread_id),
            terminal(b64(terminal_id.as_bytes())),
        );
        let current = if encoded.len() <= MAX_T3_NAME_BYTES {
            encoded.clone()
        } else {
            t3_name(&t3_hashed_thread(thread_id), terminal(t3_hash(terminal_id)))
        };
        let mut names = vec![current, encoded];
        if terminal_id == DEFAULT_TERMINAL_ID
            && let Some(legacy) = t3_legacy_name(thread_id)
        {
            names.push(legacy);
        }
        names.dedup();
        names.into_iter().map(|name| dir.join(name)).collect()
    }

    /// Copies the last `max_bytes` of T3's history for this terminal here when this server
    /// has none yet. The copy appears whole or not at all; T3's file is left as it is.
    /// Blocking: run it on a blocking thread.
    pub(crate) fn adopt_t3(&self, thread_id: &str, terminal_id: &str, max_bytes: usize) {
        let path = self.path(thread_id, terminal_id);
        if path.exists() {
            return;
        }
        let Some(tail) = self
            .t3_paths(thread_id, terminal_id)
            .into_iter()
            .find(|source| source.is_file())
            .and_then(|source| tail(&source, max_bytes).ok())
        else {
            return;
        };
        let _ = self.write(thread_id, terminal_id, &tail);
    }

    fn path(&self, thread_id: &str, terminal_id: &str) -> PathBuf {
        self.dir.join(format!(
            "{:016x}-{:016x}.log",
            fnv(thread_id),
            fnv(terminal_id)
        ))
    }

    /// The last `max_bytes` of the file, starting at a code point.
    pub(crate) fn read(&self, thread_id: &str, terminal_id: &str, max_bytes: usize) -> String {
        tail(&self.path(thread_id, terminal_id), max_bytes).unwrap_or_default()
    }

    /// Appends `tail`, or rewrites the file with `full` when appending would pass `limit`.
    /// Returns the file's new length.
    pub(crate) fn append(
        &self,
        thread_id: &str,
        terminal_id: &str,
        file_len: u64,
        tail: &str,
        full: &str,
        limit: u64,
    ) -> io::Result<u64> {
        if file_len + tail.len() as u64 > limit {
            return self.write(thread_id, terminal_id, full);
        }
        fs::create_dir_all(&self.dir)?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path(thread_id, terminal_id))?;
        file.write_all(tail.as_bytes())?;
        Ok(file_len + tail.len() as u64)
    }

    pub(crate) fn write(&self, thread_id: &str, terminal_id: &str, text: &str) -> io::Result<u64> {
        fs::create_dir_all(&self.dir)?;
        let path = self.path(thread_id, terminal_id);
        let temp = path.with_extension("tmp");
        fs::write(&temp, text)?;
        fs::rename(&temp, &path)?;
        Ok(text.len() as u64)
    }

    pub(crate) fn delete(&self, thread_id: &str, terminal_id: &str) {
        let _ = fs::remove_file(self.path(thread_id, terminal_id));
        for path in self.t3_paths(thread_id, terminal_id) {
            let _ = fs::remove_file(path);
        }
    }

    pub(crate) fn delete_thread(&self, thread_id: &str) {
        let prefix = format!("{:016x}-", fnv(thread_id));
        remove_matching(&self.dir, |name| name.starts_with(&prefix));
        // `deleteAllHistoryForThread`.
        if let Some(dir) = &self.t3_dir {
            let parts = [t3_encoded_thread(thread_id), t3_hashed_thread(thread_id)];
            let legacy = t3_legacy_name(thread_id);
            remove_matching(dir, |name| {
                legacy.as_deref() == Some(name)
                    || parts.iter().any(|part| {
                        name.strip_prefix(part.as_str())
                            .is_some_and(|rest| rest == ".log" || rest.starts_with('_'))
                    })
            });
        }
    }
}

/// The last `max_bytes` of a file, starting at a code point.
fn tail(path: &Path, max_bytes: usize) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(max_bytes as u64)))?;
    let mut bytes = Vec::new();
    file.take(max_bytes as u64).read_to_end(&mut bytes)?;
    let skip = bytes
        .iter()
        .take_while(|b| (*b & 0b1100_0000) == 0b1000_0000)
        .count();
    Ok(String::from_utf8_lossy(bytes.get(skip..).unwrap_or_default()).into_owned())
}

fn remove_matching(dir: &Path, matches: impl Fn(&str) -> bool) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if matches(&entry.file_name().to_string_lossy()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn b64(bytes: &[u8]) -> String {
    conn_support::base64::url_encode(bytes)
}

/// `hashId`: SHA-256, base64url.
fn t3_hash(id: &str) -> String {
    b64(&conn_support::hmac::sha256(id.as_bytes()))
}

/// `encodedHistoryThreadPart`.
fn t3_encoded_thread(thread_id: &str) -> String {
    format!("terminal_{}", b64(thread_id.as_bytes()))
}

/// `hashedHistoryThreadPart`.
fn t3_hashed_thread(thread_id: &str) -> String {
    format!("terminal_sha256.{}", t3_hash(thread_id))
}

/// `joinHistoryFileName`.
fn t3_name(thread_part: &str, terminal_part: Option<String>) -> String {
    match terminal_part {
        None => format!("{thread_part}.log"),
        Some(terminal) => format!("{thread_part}_{terminal}.log"),
    }
}

/// `legacyHistoryName`, unless it would alias the current `terminal_` names
/// (`hasLegacyHistoryName`).
fn t3_legacy_name(thread_id: &str) -> Option<String> {
    let safe: String = thread_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    (!safe.to_ascii_lowercase().starts_with("terminal_")).then(|| format!("{safe}.log"))
}

/// FNV-1a, 64 bits: stable across builds and platforms, unlike `std`'s hasher.
fn fnv(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_rewrites_and_deletes() {
        let dir = std::env::temp_dir().join(format!("conn-terminal-store-{}", std::process::id()));
        let store = Store::new(dir.clone(), None);
        assert_eq!(store.read("t", "a", 100), "");
        let len = store.append("t", "a", 0, "hello ", "hello ", 20).unwrap();
        let len = store
            .append("t", "a", len, "world", "hello world", 20)
            .unwrap();
        assert_eq!(store.read("t", "a", 100), "hello world");
        assert_eq!(store.read("t", "a", 5), "world");
        // Past the limit: rewritten from `full`.
        let len = store
            .append("t", "a", len, "0123456789", "xyz", 20)
            .unwrap();
        assert_eq!((len, store.read("t", "a", 100).as_str()), (3, "xyz"));
        store.write("t", "€", "€uro").unwrap();
        assert_eq!(store.read("t", "€", 4), "uro");
        store.write("u", "a", "other").unwrap();
        store.delete_thread("t");
        assert_eq!(store.read("t", "a", 100), "");
        assert_eq!(store.read("t", "€", 100), "");
        assert_eq!(store.read("u", "a", 100), "other");
        store.delete("u", "a");
        assert_eq!(store.read("u", "a", 100), "");
        let _ = fs::remove_dir_all(dir);
    }

    /// T3's history for a terminal (default and named, the oldest name too) shows here, capped
    /// to the history limit, and T3's files stay; deleting a thread removes T3's names for it.
    #[test]
    fn adopts_the_t3_servers_history() {
        let root = std::env::temp_dir().join(format!("conn-terminal-t3-{}", std::process::id()));
        let (dir, t3) = (root.join("terminals"), root.join("logs/terminals"));
        fs::create_dir_all(&t3).unwrap();
        let store = Store::new(dir, Some(t3.clone()));
        let adopted = |thread: &str, terminal: &str| {
            store.adopt_t3(thread, terminal, 100);
            store.read(thread, terminal, 100)
        };
        let current = t3.join(format!("terminal_{}.log", b64(b"thread")));
        fs::write(&current, "from T3\n").unwrap();
        let named = t3.join(format!(
            "terminal_{}_{}.log",
            b64(b"thread"),
            b64(b"term-2")
        ));
        fs::write(&named, "named\n").unwrap();
        fs::write(t3.join("old_thread.log"), "oldest\n").unwrap();
        let long = "x".repeat(120);
        let hashed = t3.join(format!("terminal_sha256.{}.log", t3_hash(&long)));
        fs::write(&hashed, "hashed\n").unwrap();
        // A large log: only the capped tail is copied.
        let large = t3.join(format!("terminal_{}.log", b64(b"large")));
        fs::write(
            &large,
            format!("{}end-of-log\n", "older line\n".repeat(100_000)),
        )
        .unwrap();
        fs::write(t3.join(format!("terminal_{}_x.log", b64(b"gone"))), "gone").unwrap();

        assert_eq!(adopted("thread", "term-1"), "from T3\n");
        assert_eq!(
            fs::read_to_string(&current).unwrap(),
            "from T3\n",
            "T3's file stays"
        );
        assert_eq!(adopted("thread", "term-2"), "named\n");
        assert_eq!(adopted("old thread", "term-1"), "oldest\n");
        assert_eq!(adopted(&long, "term-1"), "hashed\n");
        let copied = adopted("large", "term-1");
        assert!(
            copied.len() <= 100 && copied.ends_with("end-of-log\n"),
            "{copied:?}"
        );
        assert!(fs::metadata(store.path("large", "term-1")).unwrap().len() <= 100);
        // Native history wins over T3's from then on.
        store.write("thread", "term-1", "native\n").unwrap();
        assert_eq!(adopted("thread", "term-1"), "native\n");
        store.delete("thread", "term-1");
        assert!(!current.exists());
        store.delete_thread("gone");
        assert!(fs::read_dir(&t3).unwrap().all(|e| {
            !e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("terminal_{}_", b64(b"gone")))
        }));
        let _ = fs::remove_dir_all(root);
    }
}
