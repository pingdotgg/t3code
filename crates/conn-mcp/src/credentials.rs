//! Agent credentials, as `McpSessionRegistry.ts` keeps them: a random token per provider
//! session, stored only as its SHA-256, valid while used at least once a day. Bounded: the
//! oldest record goes when the table is full.

use std::{collections::HashMap, time::Instant};

use sha2::{Digest, Sha256};

use crate::ThreadCaller;

/// `/mcp` sits outside environment auth, so an idle token stops working (TS: 24 hours).
const LIVENESS_MS: u128 = 24 * 60 * 60 * 1000;
/// Live provider sessions on one server; far above what a container runs.
const MAX_RECORDS: usize = 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct ThreadCredentialRequest {
    pub thread_id: String,
    pub provider_instance_id: String,
    /// A delegated child task.
    pub subagent: bool,
}

struct Record {
    caller: ThreadCaller,
    last_alive: Instant,
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
                .min_by_key(|(_, r)| r.last_alive)
                .map(|(k, _)| *k)
        {
            self.records.remove(&oldest);
        }
        // Hex, never a dot: TS tells provider tokens from session tokens (`a.b`) that way.
        let token = crate::random_hex(32);
        let caller = ThreadCaller {
            thread_id: request.thread_id,
            provider_session_id: crate::uuid_v4(),
            provider_instance_id: request.provider_instance_id,
            subagent: request.subagent,
        };
        self.records.insert(
            hash(&token),
            Record {
                caller: caller.clone(),
                last_alive: Instant::now(),
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
        if record.last_alive.elapsed().as_millis() > LIVENESS_MS {
            record.expired = true;
            return None;
        }
        record.last_alive = Instant::now();
        Some(record.caller.clone())
    }

    pub(crate) fn touch(&mut self, thread_id: &str) {
        for record in self.records.values_mut() {
            if record.caller.thread_id == thread_id {
                record.last_alive = Instant::now();
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
            record.last_alive = record
                .last_alive
                .checked_sub(by)
                .unwrap_or(record.last_alive);
        }
    }
}
