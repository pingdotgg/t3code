//! Locks shared by workflows that mutate a workspace.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
/// Per-workspace locks, so two captures of one folder do not race (`withWorkspaceLock`).
/// An entry lives while someone holds or waits for it.
#[derive(Debug, Default)]
pub struct WorkspaceLocks {
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Debug)]
pub struct WorkspaceLock<'a> {
    owner: &'a WorkspaceLocks,
    key: String,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl Drop for WorkspaceLock<'_> {
    fn drop(&mut self) {
        drop(self.guard.take());
        let mut locks = crate::lock(&self.owner.locks);
        if locks
            .get(&self.key)
            .is_some_and(|entry| Arc::strong_count(entry) == 1)
        {
            locks.remove(&self.key);
        }
    }
}

impl WorkspaceLocks {
    pub async fn workspace(&self, cwd: &str) -> WorkspaceLock<'_> {
        let entry = crate::lock(&self.locks)
            .entry(cwd.to_owned())
            .or_default()
            .clone();
        let guard = entry.lock_owned().await;
        WorkspaceLock {
            owner: self,
            key: cwd.to_owned(),
            guard: Some(guard),
        }
    }

    pub fn held(&self) -> usize {
        crate::lock(&self.locks).len()
    }
}
