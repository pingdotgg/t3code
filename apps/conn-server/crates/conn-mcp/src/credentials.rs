//! Agent credentials, as `McpSessionRegistry.ts` keeps them: a random token per provider
//! session, stored only as its SHA-256, valid while used at least once a day. Bounded: the
//! oldest record goes when the table is full.

use std::collections::HashMap;

use conn_support::time::Mark;

use sha2::{Digest, Sha256};

use crate::ThreadCaller;

/// `/mcp` sits outside environment auth, so an idle token stops working (TS: 24 hours).
const LIVENESS: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
/// Live provider sessions on one server; far above what a container runs.
const MAX_RECORDS: usize = 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct ThreadCredentialRequest {
    pub thread_id: String,
    pub provider_instance_id: String,
    pub preview: bool,
    /// A delegated child task.
    pub subagent: bool,
}

struct Record {
    caller: ThreadCaller,
    /// Both clocks, so idle time a frozen container's wall clock shows still counts.
    last_alive: Mark,
    /// Set when a request finds the token idle; only `touch` clears it.
    expired: bool,
}

#[derive(Default)]
pub(crate) struct Credentials {
    records: HashMap<[u8; 32], Record>,
}

fn hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

impl Credentials {
    pub(crate) fn issue(&mut self, request: ThreadCredentialRequest) -> (String, ThreadCaller) {
        if self.records.len() >= MAX_RECORDS
            && let Some(oldest) = self
                .records
                .iter()
                .min_by_key(|(_, r)| r.last_alive.mono)
                .map(|(k, _)| *k)
        {
            self.records.remove(&oldest);
        }
        // Hex, never a dot: TS tells provider tokens from session tokens (`a.b`) that way.
        let token = crate::random_hex(32);
        let caller = ThreadCaller {
            thread_id: request.thread_id,
            provider_session_id: conn_support::uuid_v4(),
            provider_instance_id: request.provider_instance_id,
            subagent: request.subagent,
            preview: request.preview,
        };
        self.records.insert(
            hash(&token),
            Record {
                caller: caller.clone(),
                last_alive: Mark::now(),
                expired: false,
            },
        );
        (token, caller)
    }

    pub(crate) fn resolve(&mut self, token: &str) -> Option<ThreadCaller> {
        if token.is_empty() {
            return None;
        }
        let record = self.records.get_mut(&hash(token))?;
        if record.expired {
            return None;
        }
        let now = Mark::now();
        if record.last_alive.elapsed_to(&now) > LIVENESS {
            record.expired = true;
            return None;
        }
        record.last_alive = now;
        Some(record.caller.clone())
    }

    pub(crate) fn touch(&mut self, thread_id: &str) {
        for record in self.records.values_mut() {
            if record.caller.thread_id == thread_id {
                record.last_alive = Mark::now();
                record.expired = false;
            }
        }
    }

    pub(crate) fn revoke(&mut self, matches: impl Fn(&ThreadCaller) -> bool) {
        self.records.retain(|_, record| !matches(&record.caller));
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.records.len()
    }

    #[cfg(test)]
    pub(crate) fn age_all(&mut self, by: std::time::Duration) {
        for record in self.records.values_mut() {
            record.last_alive.mono = record
                .last_alive
                .mono
                .checked_sub(by)
                .unwrap_or(record.last_alive.mono);
            record.last_alive.wall_ms = record.last_alive.wall_ms.saturating_sub(by_ms(by));
        }
    }

    /// Moves only the wall clock forward by `by`, as a frozen container sees on wake.
    #[cfg(test)]
    pub(crate) fn jump_wall(&mut self, by: std::time::Duration) {
        for record in self.records.values_mut() {
            record.last_alive.wall_ms = record.last_alive.wall_ms.saturating_sub(by_ms(by));
        }
    }
}

#[cfg(test)]
fn by_ms(by: std::time::Duration) -> u64 {
    u64::try_from(by.as_millis()).unwrap_or(u64::MAX)
}
