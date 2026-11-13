//! MCP sessions (`Mcp-Session-Id`) of protocol 2025-06-18: `initialize` opens one, every
//! later request names it, `DELETE` ends it. A session carries no state but its owner, so
//! each costs a few dozen bytes. Bounded: idle sessions expire, and the least recently used
//! goes when the table is full.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const MAX_SESSIONS: usize = 256;
const IDLE: Duration = Duration::from_secs(24 * 60 * 60);

struct Session {
    /// The caller's namespace: a session answers only the credential that opened it.
    owner: String,
    last_used: Instant,
}

#[derive(Default)]
pub struct Sessions {
    sessions: HashMap<String, Session>,
}

pub enum Lookup {
    Found,
    Unknown,
}

impl Sessions {
    pub fn open(&mut self, owner: String) -> String {
        let now = Instant::now();
        self.sessions
            .retain(|_, s| now.duration_since(s.last_used) < IDLE);
        if self.sessions.len() >= MAX_SESSIONS
            && let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, s)| s.last_used)
                .map(|(id, _)| id.clone())
        {
            self.sessions.remove(&oldest);
        }
        let id = crate::uuid_v4();
        self.sessions.insert(
            id.clone(),
            Session {
                owner,
                last_used: now,
            },
        );
        id
    }

    pub fn touch(&mut self, id: &str, owner: &str) -> Lookup {
        match self.sessions.get_mut(id) {
            Some(session) if session.owner == owner && session.last_used.elapsed() < IDLE => {
                session.last_used = Instant::now();
                Lookup::Found
            }
            _ => Lookup::Unknown,
        }
    }

    pub fn close(&mut self, id: &str, owner: &str) -> Lookup {
        match self.sessions.get(id) {
            Some(session) if session.owner == owner => {
                self.sessions.remove(id);
                Lookup::Found
            }
            _ => Lookup::Unknown,
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.sessions.len()
    }
}
