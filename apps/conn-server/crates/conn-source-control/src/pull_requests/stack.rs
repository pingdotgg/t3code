use super::{Client, Error, Lookup, normalize};
use serde::Deserialize;
use serde_json::{Value, json};

impl Client {
    /// Reads detailed stack layers; GitHub's 404 alone means stacks are unsupported.
    pub async fn stack(&self, lookup: &Lookup) -> Result<Value, Error> {
        let path = format!("repos/{}/{}/stacks", lookup.owner, lookup.name);
        let read = async {
            let raw = self
                .rest(&format!("{path}?pull_request={}", lookup.number))
                .await?;
            let stack = decode(&raw)?;
            let Some(number) = stack.get("number").and_then(Value::as_i64) else {
                return Ok(Value::Null);
            };
            let raw = self.rest(&format!("{path}/{number}")).await?;
            decode(&json!([raw]))
        }
        .await;
        match read {
            Err(Error::NotFound(_) | Error::RepositoryNotFound(_, _)) => Ok(Value::Null),
            other => other,
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Id {
    Number(i64),
    Text(String),
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Base {
    Text(String),
    Ref { r#ref: String },
}
#[derive(Deserialize)]
struct Head {
    r#ref: String,
    #[serde(default, deserialize_with = "present")]
    sha: Option<String>,
}
#[derive(Deserialize)]
struct Layer {
    number: i64,
    head: Head,
    #[serde(default, deserialize_with = "present")]
    title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    draft: Option<bool>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    merged_at: Option<String>,
}
#[derive(Deserialize)]
struct Stack {
    #[serde(default)]
    id: Option<Id>,
    #[serde(default)]
    node_id: Option<String>,
    number: i64,
    url: String,
    #[serde(default)]
    html_url: Option<String>,
    base: Base,
    pull_requests: Vec<Layer>,
}

fn present<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(decoder).map(Some)
}

pub(super) fn decode(raw: &Value) -> Result<Value, Error> {
    let stacks: Vec<Stack> = serde_json::from_value(raw.clone()).map_err(|_| {
        Error::Failed("GitHub returned an unreadable getPullRequestStack response.".into())
    })?;
    let Some(stack) = stacks.into_iter().next() else {
        return Ok(Value::Null);
    };
    let id = match stack.id {
        Some(Id::Number(id)) => id.to_string(),
        Some(Id::Text(id)) => id,
        None => stack
            .node_id
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_owned())
            .unwrap_or_else(|| stack.number.to_string()),
    };
    let base = match stack.base {
        Base::Text(base) => base,
        Base::Ref { r#ref } => r#ref,
    };
    let layers: Vec<_> = stack.pull_requests.into_iter().map(|layer| {
        let mut value = json!({"number":layer.number,"headBranch":layer.head.r#ref,"state":normalize::state(&json!({"state":layer.state,"mergedAt":layer.merged_at}))});
        if let Some(fields) = value.as_object_mut() {
            if let Some(title)=layer.title{fields.insert("title".into(),json!(title));}
            if let Some(draft)=layer.draft{fields.insert("isDraft".into(),json!(draft));}
            if let Some(sha)=layer.head.sha{fields.insert("headSha".into(),json!(sha));}
        }
        value
    }).collect();
    Ok(
        json!({"id":id,"number":stack.number,"url":stack.html_url.filter(|s|!s.trim().is_empty()).map(|s|s.trim().to_owned()).unwrap_or(stack.url),"base":base,"layers":layers}),
    )
}
