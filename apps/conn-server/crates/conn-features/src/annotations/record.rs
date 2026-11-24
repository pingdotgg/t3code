//! One annotation file as T3's disk reader decodes it: `Schema.fromJsonString(AnnotationRecord)`
//! in `AnnotationStore.ts`, with the schema in `packages/contracts/src/annotations.ts`.
//!
//! The rules serde would otherwise relax: a typed optional field is absent, never `null`; an
//! enum is its string; a struct is an object, not an array; a number is a JSON number;
//! `projectId` is trimmed and not blank; a record has no `screenshot`. Unknown fields are
//! dropped, as Effect's struct decoder drops them.

use serde::{
    Deserialize, Deserializer, Serialize,
    de::{DeserializeOwned, Error as _},
};
use serde_json::{Map, Number, Value};

/// `AnnotationRecord`.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    comment: String,
    #[serde(default, deserialize_with = "source")]
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pathname: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    element: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    element_path: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    x: Option<Number>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    y: Option<Number>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<Number>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<Number>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    bounding_box: Option<Object<Rect>>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    is_fixed: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<Number>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    component: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    components: Option<Vec<Object<Frame>>>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    controller: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    route: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    react: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    screen_size: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    scroll_position: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    breakpoint: Option<String>,
    /// `Schema.Unknown`: `null` is a value here and stays.
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    appearance: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    change: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<Map<String, Value>>,
    /// `Schema.optional(Schema.Never)`: any value refuses the record.
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    screenshot: Option<Never>,
    #[serde(deserialize_with = "project_id")]
    project_id: String,
    number: Number,
    revision: Number,
    #[serde(deserialize_with = "status")]
    status: String,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    question: Option<bool>,
    has_screenshot: bool,
    created_at: String,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    claimed_at: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
}

/// `AnnotationRect`.
#[derive(Debug, Deserialize, Serialize)]
struct Rect {
    x: Number,
    y: Number,
    width: Number,
    height: Number,
}

/// `AnnotationComponentFrame`.
#[derive(Debug, Deserialize, Serialize)]
struct Frame {
    name: String,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<Number>,
}

/// No value decodes as this.
#[derive(Debug, Deserialize, Serialize)]
enum Never {}

/// A struct that only a JSON object decodes as; serde's derive also takes an array.
#[derive(Debug, Serialize)]
#[serde(transparent)]
struct Object<T>(T);

impl<'de, T: DeserializeOwned> Deserialize<'de> for Object<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let fields = Map::<String, Value>::deserialize(deserializer)?;
        serde_json::from_value(Value::Object(fields))
            .map(Object)
            .map_err(D::Error::custom)
    }
}

/// An optional field that is present: its value must decode, so `null` is refused.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// A `Schema.Literals` value: one of `allowed`, as a string.
fn literal<'de, D: Deserializer<'de>>(
    deserializer: D,
    allowed: &[&str],
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if allowed.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(D::Error::custom(format!("expected one of {allowed:?}")))
    }
}

fn status<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    literal(deserializer, &["todo", "in_progress", "done"])
}

fn source<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    literal(deserializer, &["browser", "device"]).map(Some)
}

/// `ProjectId`: a `TrimmedNonEmptyString`, decoded trimmed.
fn project_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    match conn_support::text::js_trim(&value) {
        "" => Err(D::Error::custom("expected a non-blank project id")),
        trimmed => Ok(trimmed.to_owned()),
    }
}

/// The record as T3 decodes it, or why T3 would skip it.
pub(super) fn decode(record: Map<String, Value>) -> Result<Map<String, Value>, serde_json::Error> {
    let record: Record = serde_json::from_value(Value::Object(record))?;
    match serde_json::to_value(record)? {
        Value::Object(record) => Ok(record),
        _ => Err(serde_json::Error::custom("a record encodes as an object")),
    }
}
