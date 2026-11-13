//! Rust types for the Conn client contract (`packages/contracts`).
//!
//! Track (b) generates the real types. Until then:
//! - [`methods`] lists every RPC method a client can call, from `methods.json`
//!   (written by `tools/dump-methods.mjs` from `OfficialWsRpcGroup` + `ForkWsRpcGroup`).
//! - [`ids`] holds branded string ids. They are final: generated code must keep these names.
//! - [`placeholder`] holds opaque JSON stand-ins for schemas, named after the contract schema
//!   without the `OrchestrationV2` prefix. Generated structs replace them under the same names.
//!
//! Build and read contract values through [`from_json`] and [`to_json`]. That code compiles
//! against both the placeholders and the generated structs, so tracks can start now.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

pub mod ids;
pub mod placeholder;

pub use ids::*;
pub use placeholder::*;

/// `ORCHESTRATION_PROTOCOL_VERSION` in `packages/contracts/src/environment.ts`. `/ws` answers
/// 426 unless the `orchestrationProtocol` query param equals it.
pub const ORCHESTRATION_PROTOCOL_VERSION: u32 = 2;
pub const ORCHESTRATION_PROTOCOL_QUERY_PARAM: &str = "orchestrationProtocol";

/// One RPC method of the client contract.
#[derive(Clone, Debug, Deserialize)]
pub struct MethodInfo {
    /// The Effect RPC tag, such as `orchestration.dispatchCommand`.
    pub tag: String,
    /// True when the success schema is an `RpcSchema.Stream`.
    pub stream: bool,
    /// `official` (upstream T3) or `fork` (Conn-only).
    pub origin: String,
}

#[derive(Deserialize)]
struct MethodsFile {
    commit: String,
    methods: Vec<MethodInfo>,
}

fn methods_file() -> &'static MethodsFile {
    static FILE: OnceLock<MethodsFile> = OnceLock::new();
    FILE.get_or_init(|| {
        serde_json::from_str(include_str!("../methods.json")).expect("methods.json is valid")
    })
}

/// Every method in the client contract, sorted by tag.
pub fn methods() -> &'static [MethodInfo] {
    &methods_file().methods
}

/// The Conn commit `methods.json` was generated from.
pub fn contract_commit() -> &'static str {
    &methods_file().commit
}

pub fn method(tag: &str) -> Option<&'static MethodInfo> {
    let all = methods();
    all.binary_search_by(|m| m.tag.as_str().cmp(tag))
        .ok()
        .map(|i| &all[i])
}

/// Builds a contract value from JSON in its wire shape.
pub fn from_json<T: DeserializeOwned>(value: Value) -> Result<T, serde_json::Error> {
    serde_json::from_value(value)
}

/// Encodes a contract value to its wire shape.
pub fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("contract values always serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_list_matches_the_contract() {
        let all = methods();
        assert_eq!(all.len(), 235);
        assert_eq!(all.iter().filter(|m| m.stream).count(), 32);
        assert!(
            all.windows(2).all(|w| w[0].tag < w[1].tag),
            "sorted, unique"
        );
        assert!(method("orchestration.subscribeShell").unwrap().stream);
        assert!(!method("orchestration.dispatchCommand").unwrap().stream);
        assert!(method("nope").is_none());
        assert_eq!(contract_commit().len(), 40);
    }

    #[test]
    fn placeholders_round_trip_wire_json() {
        let json = serde_json::json!({"type":"thread.stop","commandId":"c1","threadId":"t1"});
        let command: Command = from_json(json.clone()).unwrap();
        assert_eq!(to_json(&command), json);
        let thread: ThreadId = from_json(serde_json::json!("t1")).unwrap();
        assert_eq!(thread.as_str(), "t1");
    }
}
