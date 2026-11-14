//! JSON with object keys in insertion order, for the frames we write to an agent.
//!
//! The workspace's `serde_json` sorts object keys (no `preserve_order`), while the T3 server
//! writes them in the order its code builds them. The agent sees those bytes, so every frame
//! we send is built from [`J`], which keeps the order. Values that came from the agent and go
//! back unchanged stay a plain [`Value`] inside it.

use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum J {
    Obj(Vec<(String, J)>),
    Arr(Vec<J>),
    V(Value),
}

impl J {
    pub(crate) fn str(text: impl Into<String>) -> Self {
        Self::V(Value::String(text.into()))
    }

    /// Appends a field; the builder style keeps call sites in T3's order.
    pub(crate) fn with(mut self, key: &str, value: impl Into<J>) -> Self {
        if let Self::Obj(fields) = &mut self {
            fields.push((key.to_owned(), value.into()));
        }
        self
    }

    /// Appends a field when `value` is some.
    pub(crate) fn with_opt(self, key: &str, value: Option<impl Into<J>>) -> Self {
        match value {
            Some(value) => self.with(key, value),
            None => self,
        }
    }

    pub(crate) fn to_line(&self) -> String {
        // Serializing this type cannot fail: every key is a string.
        serde_json::to_string(self).unwrap_or_default()
    }

    /// The same JSON as a sorted [`Value`], for comparisons in tests and for logs.
    pub(crate) fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// An empty object, to build on with [`J::with`].
pub(crate) fn obj() -> J {
    J::Obj(Vec::new())
}

impl From<Value> for J {
    fn from(value: Value) -> Self {
        Self::V(value)
    }
}

impl From<&str> for J {
    fn from(value: &str) -> Self {
        Self::str(value)
    }
}

impl From<String> for J {
    fn from(value: String) -> Self {
        Self::str(value)
    }
}

impl From<bool> for J {
    fn from(value: bool) -> Self {
        Self::V(Value::Bool(value))
    }
}

impl From<i64> for J {
    fn from(value: i64) -> Self {
        Self::V(Value::from(value))
    }
}

impl From<Vec<J>> for J {
    fn from(value: Vec<J>) -> Self {
        Self::Arr(value)
    }
}

impl Serialize for J {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Obj(fields) => {
                let mut map = serializer.serialize_map(Some(fields.len()))?;
                for (key, value) in fields {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
            Self::Arr(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Self::V(value) => value.serialize(serializer),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_insertion_order() {
        let frame = obj()
            .with("protocolVersion", 2)
            .with("info", obj().with("name", "t3-code"))
            .with("capabilities", obj())
            .with_opt("missing", None::<J>);
        assert_eq!(
            frame.to_line(),
            r#"{"protocolVersion":2,"info":{"name":"t3-code"},"capabilities":{}}"#
        );
    }
}
