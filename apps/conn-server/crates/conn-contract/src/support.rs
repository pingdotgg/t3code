//! Building blocks the generated code uses. Hand-written; `tools/gen-contract.mjs` targets them.

use serde::de::{self, Deserializer, Unexpected};
use serde::{Deserialize, Serialize, Serializer};

/// Any JSON value. Used for `Schema.Json`/`Unknown`/`Defect` and for shapes the generator could
/// not map exactly (listed in `generated/report.json`).
pub type Json = serde_json::Value;

/// A shape the generator could not map exactly. It keeps the raw JSON so nothing is lost; each
/// use is listed under `opaque` in `generated/report.json`.
pub type Opaque = serde_json::Value;

/// A JSON object with free keys (`Schema.Record`).
pub type Map<K, V> = std::collections::BTreeMap<K, V>;

/// `Schema.Never`: no value decodes. Methods without a typed error use it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Never {}

/// `Schema.Number` without `isFinite`/`isInt`. JSON has no NaN or infinities, so Effect's JSON
/// codec writes them as the strings `"NaN"`, `"Infinity"` and `"-Infinity"`.
#[derive(Clone, Copy, Debug, Default, PartialEq, PartialOrd)]
pub struct JsNumber(pub f64);

impl Serialize for JsNumber {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let v = self.0;
        if v.is_nan() {
            s.serialize_str("NaN")
        } else if v.is_infinite() {
            s.serialize_str(if v > 0.0 { "Infinity" } else { "-Infinity" })
        } else {
            v.serialize(s)
        }
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl de::Visitor<'_> for V {
            type Value = JsNumber;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a number, \"NaN\", \"Infinity\" or \"-Infinity\"")
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<JsNumber, E> {
                Ok(JsNumber(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<JsNumber, E> {
                Ok(JsNumber(v as f64))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<JsNumber, E> {
                Ok(JsNumber(v as f64))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<JsNumber, E> {
                match v {
                    "NaN" => Ok(JsNumber(f64::NAN)),
                    "Infinity" => Ok(JsNumber(f64::INFINITY)),
                    "-Infinity" => Ok(JsNumber(f64::NEG_INFINITY)),
                    _ => Err(E::invalid_value(Unexpected::Str(v), &self)),
                }
            }
        }
        d.deserialize_any(V)
    }
}

#[doc(hidden)]
pub fn expect_literal<'de, D: Deserializer<'de>>(
    d: D,
    expected: &serde_json::Value,
) -> Result<(), D::Error> {
    let got = serde_json::Value::deserialize(d)?;
    if &got == expected {
        Ok(())
    } else {
        Err(de::Error::custom(format_args!(
            "expected {expected}, got {got}"
        )))
    }
}

/// A type with exactly one value, such as the `"thread.create"` in `type: "thread.create"`.
macro_rules! literal {
    ($name:ident = $value:literal) => {
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name;

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                serde::Serialize::serialize(&$value, s)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                $crate::support::expect_literal(d, &serde_json::json!($value)).map(|()| $name)
            }
        }
    };
}
pub(crate) use literal;

/// An Effect union of structs told apart by one string field. Each variant's struct keeps that
/// field (as a `lit` type), so a struct also encodes correctly on its own.
///
/// `dispatch` maps tag values to the members to try, in contract order. `fallback` members have a
/// plain-string tag (forward-compatible unions); they are tried only for tags no member names.
macro_rules! tagged_union {
    (
        $name:ident, $tag:literal,
        variants { $($variant:ident($ty:ty)),* $(,)? },
        dispatch { $($($value:literal)|+ => [$($dv:ident($dty:ty)),+]),* $(,)? },
        fallback [$($fv:ident($fty:ty)),* $(,)?]
    ) => {
        #[derive(Clone, Debug, PartialEq)]
        pub enum $name {
            $($variant($ty)),*
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                match self {
                    $(Self::$variant(v) => serde::Serialize::serialize(v, s)),*
                }
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                use serde::de::Error;
                let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
                // Each failed member keeps the first error (`first.or`), without a `mut` that is
                // unused when a union has no fallback members.
                let first_error: Option<serde_json::Error> =
                    match value.get($tag).and_then(serde_json::Value::as_str) {
                        $(Some($($value)|+) => {
                            let first: Option<serde_json::Error> = None;
                            $(let first = match <$dty as serde::Deserialize>::deserialize(&value) {
                                Ok(v) => return Ok(Self::$dv(v)),
                                Err(e) => first.or(Some(e)),
                            };)+
                            first
                        })*
                        _ => {
                            let first: Option<serde_json::Error> = None;
                            $(let first = match <$fty as serde::Deserialize>::deserialize(&value) {
                                Ok(v) => return Ok(Self::$fv(v)),
                                Err(e) => first.or(Some(e)),
                            };)*
                            first
                        }
                    };
                Err(match first_error {
                    Some(e) => D::Error::custom(e),
                    None => D::Error::custom(format_args!(
                        concat!(stringify!($name), ": unknown `", $tag, "` {}"),
                        value.get($tag).unwrap_or(&serde_json::Value::Null)
                    )),
                })
            }
        }
    };
}
pub(crate) use tagged_union;

/// An Effect union of structs without a tag, where each member has a required key no other
/// member has. The first member whose key is present decodes the value.
macro_rules! keyed_union {
    ($name:ident, { $($key:literal => $variant:ident($ty:ty)),* $(,)? }) => {
        #[derive(Clone, Debug, PartialEq)]
        pub enum $name {
            $($variant($ty)),*
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                match self {
                    $(Self::$variant(v) => serde::Serialize::serialize(v, s)),*
                }
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                use serde::de::Error;
                let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
                $(if value.get($key).is_some() {
                    return <$ty as serde::Deserialize>::deserialize(&value).map(Self::$variant).map_err(D::Error::custom);
                })*
                Err(D::Error::custom(concat!(stringify!($name), ": no known key")))
            }
        }
    };
}
pub(crate) use keyed_union;

/// A union of number literals, such as `30 | 60`.
macro_rules! number_literals {
    ($name:ident, { $($variant:ident = $value:literal),* $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),*
        }

        impl $name {
            pub fn value(self) -> f64 {
                match self {
                    $(Self::$variant => $value),*
                }
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                let v = self.value();
                if v.fract() == 0.0 { s.serialize_i64(v as i64) } else { s.serialize_f64(v) }
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                use serde::de::Error;
                let v = <f64 as serde::Deserialize>::deserialize(d)?;
                $(if v == $value { return Ok(Self::$variant); })*
                Err(D::Error::custom(format_args!(concat!(stringify!($name), ": unexpected {}"), v)))
            }
        }
    };
}
pub(crate) use number_literals;

/// An Effect union whose members have different JSON kinds (string, number, object, ...).
macro_rules! kind_union {
    ($name:ident, { $($kind:ident => $variant:ident($ty:ty)),* $(,)? }) => {
        #[derive(Clone, Debug, PartialEq)]
        pub enum $name {
            $($variant($ty)),*
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                match self {
                    $(Self::$variant(v) => serde::Serialize::serialize(v, s)),*
                }
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                use serde::de::Error;
                let value = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
                let kind = $crate::support::kind_of(&value);
                $(if kind == stringify!($kind) {
                    return serde_json::from_value(value).map(Self::$variant).map_err(D::Error::custom);
                })*
                Err(D::Error::custom(format_args!(
                    concat!("no variant of ", stringify!($name), " takes a JSON {}"),
                    kind
                )))
            }
        }
    };
}
pub(crate) use kind_union;

#[doc(hidden)]
pub fn kind_of(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// `Schema.optional(Schema.NullOr(T))`: a missing key is `None`, `null` is `Some(None)`.
pub mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}
