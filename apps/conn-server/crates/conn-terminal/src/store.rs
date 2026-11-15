//! Scrollback on disk, so a terminal reopened after a server restart shows what it showed.
//!
//! One plain UTF-8 file per terminal: `<dir>/<fnv(thread)>-<fnv(terminal)>.log`. Writes append
//! the new tail and rewrite the file once it grows past twice the history cap, as
//! `apps/server` does. The files are bounded by the history cap; nothing else is kept.

use std::{
    fs, io,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

pub(crate) struct Store {
    dir: PathBuf,
}

impl Store {
    pub(crate) fn new(dir: PathBuf) -> Self {
        Self { dir }
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
        let Ok(mut file) = fs::File::open(self.path(thread_id, terminal_id)) else {
            return String::new();
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let start = len.saturating_sub(max_bytes as u64);
        let mut bytes = Vec::new();
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_to_end(&mut bytes).is_err() {
            return String::new();
        }
        let skip = bytes
            .iter()
            .take_while(|b| (*b & 0b1100_0000) == 0b1000_0000)
            .count();
        String::from_utf8_lossy(&bytes[skip..]).into_owned()
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
    }

    pub(crate) fn delete_thread(&self, thread_id: &str) {
        let prefix = format!("{:016x}-", fnv(thread_id));
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
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
        let store = Store::new(dir.clone());
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
}
