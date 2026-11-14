//! Ids, time and randomness, shaped like `IdAllocatorV2` in
//! `packages/provider-core/src/server/IdAllocator.ts`. Each id helper takes the driver kind.

pub use conn_support::{time::iso_from_ms, uuid_v4};

/// `encodeURIComponent`: keeps `A-Z a-z 0-9 - _ . ! ~ * ' ( )`, percent-encodes the rest.
pub fn encode_component(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for byte in part.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `joinId`: `prefix:part:part`, each part encoded.
pub fn join_id(prefix: &str, parts: &[&str]) -> String {
    let mut out = String::from(prefix);
    for part in parts {
        out.push(':');
        out.push_str(&encode_component(part));
    }
    out
}

pub fn provider_thread_id(driver: &str, native_thread_id: &str) -> String {
    join_id(
        "provider-thread",
        &["provider", driver, "native-thread", native_thread_id],
    )
}

pub fn provider_turn_id(driver: &str, native_turn_id: &str) -> String {
    join_id(
        "provider-turn",
        &["provider", driver, "native-turn", native_turn_id],
    )
}

pub fn node_from_item(driver: &str, native_item_id: &str) -> String {
    join_id("node", &["provider", driver, "native-item", native_item_id])
}

pub fn message_from_item(driver: &str, native_item_id: &str) -> String {
    join_id(
        "message",
        &["provider", driver, "native-item", native_item_id],
    )
}

pub fn turn_item_from_item(driver: &str, native_item_id: &str) -> String {
    join_id(
        "turn-item",
        &["provider", driver, "native-item", native_item_id],
    )
}

pub fn approval_node(request_id: &str) -> String {
    join_id("node", &["runtime-request", request_id])
}

pub fn approval_turn_item(request_id: &str) -> String {
    join_id("turn-item", &["runtime-request", request_id])
}

/// `allocate.runtimeRequest`: derived from the turn and native id, plus a uuid.
pub fn runtime_request_id(
    driver: &str,
    provider_turn_id: &str,
    native_request_id: &str,
    uuid: &str,
) -> String {
    format!(
        "{}:{uuid}",
        join_id(
            "runtime-request",
            &[
                "provider",
                driver,
                "provider-turn",
                provider_turn_id,
                "native-request",
                native_request_id,
            ],
        )
    )
}

/// `allocate.plan`: `plan:thread:<thread>:provider:<driver>[:run:<run>]:<uuid>`.
pub fn plan_id(thread_id: &str, run_id: Option<&str>, driver: &str, uuid: &str) -> String {
    let mut parts = vec!["thread", thread_id, "provider", driver];
    if let Some(run_id) = run_id {
        parts.extend(["run", run_id]);
    }
    format!("{}:{uuid}", join_id("plan", &parts))
}

/// Time and randomness a mapper needs, injectable so recorded-session tests are exact.
pub trait Env: Send {
    /// ISO-8601 UTC with milliseconds, like `DateTime.formatIso`.
    fn now(&mut self) -> String;
    /// Milliseconds since the epoch.
    fn now_ms(&mut self) -> u64;
    fn uuid(&mut self) -> String;
}

#[derive(Debug, Default)]
pub struct SystemEnv;

impl Env for SystemEnv {
    fn now(&mut self) -> String {
        iso_from_ms(self.now_ms())
    }
    fn now_ms(&mut self) -> u64 {
        conn_support::time::now_ms()
    }
    fn uuid(&mut self) -> String {
        uuid_v4()
    }
}

/// A fixed clock at the epoch and counting uuids, like the TS test harness's `TestClock`.
#[derive(Debug, Default)]
pub struct FixedEnv {
    next: u64,
}

impl Env for FixedEnv {
    fn now(&mut self) -> String {
        iso_from_ms(0)
    }
    fn now_ms(&mut self) -> u64 {
        0
    }
    fn uuid(&mut self) -> String {
        self.next += 1;
        format!("00000000-0000-4000-8000-{:012}", self.next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_the_ts_allocator() {
        assert_eq!(
            provider_turn_id("codex", "01a0d5eb-f176"),
            "provider-turn:provider:codex:native-turn:01a0d5eb-f176"
        );
        assert_eq!(
            node_from_item("claudeAgent", "msg_1:text:0"),
            "node:provider:claudeAgent:native-item:msg_1%3Atext%3A0"
        );
        assert_eq!(encode_component("a b/c'(x)"), "a%20b%2Fc'(x)");
        assert_eq!(
            runtime_request_id("codex", "provider-turn:x", "exec-1", "u"),
            "runtime-request:provider:codex:provider-turn:provider-turn%3Ax:native-request:exec-1:u"
        );
    }
}
