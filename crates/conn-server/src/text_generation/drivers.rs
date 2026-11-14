//! The two text generator APIs, as `textGeneratorDrivers.ts` calls them: OpenAI-compatible
//! (`/chat/completions`, `/models`) and Anthropic (`/messages`, `/models` with pages).
//!
//! Each call opens one connection through `conn_source_control::http` and follows no
//! redirect, because a redirect could carry the key to another origin. Errors are worded for
//! the person who configured the generator and never hold the key.

use std::time::Duration;

use conn_contract::TextGeneratorModel;
use conn_source_control::{
    Secret,
    http::{self, HttpRequest, HttpResponse, Method},
};
use serde_json::Value;

use super::js;

/// `GENERATE_TIMEOUT`.
pub const GENERATE_TIMEOUT: Duration = Duration::from_secs(120);
/// `LIST_MODELS_TIMEOUT`, for the whole list with every page.
pub const LIST_MODELS_TIMEOUT: Duration = Duration::from_secs(25);
/// `MAX_MODEL_PAGES`.
const MAX_MODEL_PAGES: usize = 10;
/// `ANTHROPIC_VERSION`.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// The T3 server reads a whole answer; this server stops at 8 MiB, after decoding, and a
/// longer answer reads as one it could not read.
const MAX_ANSWER_BYTES: usize = 8 * 1024 * 1024;

/// The headers Node's `fetch` (undici) adds to each request the T3 server sends. An endpoint
/// sees them, so this server sends the same. `connection: keep-alive` is sent as fetch sends
/// it, though this client opens one connection per request.
const FETCH_HEADERS: [(&str, &str); 6] = [
    ("accept", "*/*"),
    ("accept-language", "*"),
    ("sec-fetch-mode", "cors"),
    ("user-agent", "node"),
    ("accept-encoding", "gzip, deflate"),
    ("connection", "keep-alive"),
];

/// Decodes an answer as fetch does for `content-encoding: gzip` (or `x-gzip`) and `deflate`
/// (zlib, or raw deflate when the first byte is not a zlib header). `None` when it does not
/// decode or grows past [`MAX_ANSWER_BYTES`]: the answer then reads as unreadable, as a
/// failed `response.json` does in T3.
fn decode_body(encoding: Option<&str>, body: Vec<u8>) -> Option<Vec<u8>> {
    use std::io::Read;
    let encoding = encoding.map(|e| e.trim().to_ascii_lowercase());
    let limit = u64::try_from(MAX_ANSWER_BYTES).unwrap_or(u64::MAX) + 1;
    let mut out = Vec::new();
    let read = match encoding.as_deref() {
        None | Some("" | "identity") => return Some(body),
        Some("gzip" | "x-gzip") => flate2::read::MultiGzDecoder::new(body.as_slice())
            .take(limit)
            .read_to_end(&mut out),
        Some("deflate") if body.first().is_some_and(|b| b & 0x0f == 0x08) => {
            flate2::read::ZlibDecoder::new(body.as_slice())
                .take(limit)
                .read_to_end(&mut out)
        }
        Some("deflate") => flate2::read::DeflateDecoder::new(body.as_slice())
            .take(limit)
            .read_to_end(&mut out),
        // An encoding fetch does not decode: the body stays as it came.
        Some(_) => return Some(body),
    };
    (read.is_ok() && out.len() <= MAX_ANSWER_BYTES).then_some(out)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    OpenAiCompatible,
    Anthropic,
}

impl Kind {
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "openaiCompatible" => Some(Self::OpenAiCompatible),
            "anthropic" => Some(Self::Anthropic),
            _ => None,
        }
    }
}

/// Where a text generator is reached, with its key already read. `Debug` hides the key.
#[derive(Clone, Debug)]
pub struct Connection {
    pub kind: Kind,
    pub base_url: String,
    /// May be empty: an OpenAI-compatible API without a key gets no `authorization` header.
    pub api_key: Secret,
    /// Names the generator in errors: its label, else its host.
    pub label: String,
}

/// Why a model API call failed, as `TextGeneratorRequestError.detail`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestError(pub String);

impl Connection {
    fn endpoint(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }

    fn reach_error(&self) -> RequestError {
        RequestError(format!(
            "Couldn't reach {}. Check the base URL and your connection.",
            self.label
        ))
    }

    fn unreadable(&self) -> RequestError {
        RequestError(format!(
            "{} returned a reply T3 Code couldn't read.",
            self.label
        ))
    }

    fn too_slow(&self) -> RequestError {
        RequestError(format!("{} took too long to respond.", self.label))
    }

    fn with_auth(&self, request: HttpRequest) -> HttpRequest {
        match self.kind {
            Kind::OpenAiCompatible if self.api_key.expose().is_empty() => request,
            Kind::OpenAiCompatible => {
                request.secret_header("authorization", "Bearer ", self.api_key.clone())
            }
            // `setHeader("x-api-key", apiKey)` sends the header also when the key is empty.
            Kind::Anthropic => request
                .secret_header("x-api-key", "", self.api_key.clone())
                .header("anthropic-version", ANTHROPIC_VERSION),
        }
    }

    /// `sendJson`: one request, a 2xx JSON answer, or a readable error.
    async fn send_json(
        &self,
        request: HttpRequest,
        timeout: Duration,
    ) -> Result<Value, RequestError> {
        let request = FETCH_HEADERS
            .iter()
            .fold(request, |request, &(name, value)| {
                request.header(name, value)
            });
        let request = HttpRequest {
            max_response_bytes: MAX_ANSWER_BYTES,
            ..request.timeout(timeout)
        };
        let response = http::send(request).await.map_err(|error| match error {
            http::HttpError::Timeout { .. } => self.too_slow(),
            _ => self.reach_error(),
        })?;
        if is_redirect(&response) {
            return Err(self.reach_error());
        }
        let body: Option<Value> = if response.truncated {
            None
        } else {
            let encoding = response.header("content-encoding").map(str::to_owned);
            // Inflating up to 8 MiB is CPU work: off the runtime thread.
            let decoded = match encoding {
                None => Some(response.body),
                Some(encoding) => {
                    let body = response.body;
                    tokio::task::spawn_blocking(move || decode_body(Some(&encoding), body))
                        .await
                        .ok()
                        .flatten()
                }
            };
            decoded.and_then(|bytes| serde_json::from_slice(&bytes).ok())
        };
        if !(200..300).contains(&response.status) {
            let message = body
                .as_ref()
                .and_then(|b| b.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str);
            return Err(RequestError(describe_status(
                &self.label,
                response.status,
                message,
            )));
        }
        body.ok_or_else(|| self.unreadable())
    }

    /// `driver.generate`: the model's text reply to one user message.
    pub async fn generate(&self, model: &str, prompt: &str) -> Result<String, RequestError> {
        let work = async {
            match self.kind {
                Kind::OpenAiCompatible => self.generate_openai(model, prompt).await,
                Kind::Anthropic => self.generate_anthropic(model, prompt).await,
            }
        };
        tokio::time::timeout(GENERATE_TIMEOUT, work)
            .await
            .unwrap_or_else(|_| Err(self.too_slow()))
    }

    async fn generate_openai(&self, model: &str, prompt: &str) -> Result<String, RequestError> {
        // Written by hand so the keys keep the T3 server's order: `{model, messages}`.
        let body = format!(
            r#"{{"model":{},"messages":[{{"role":"user","content":{}}}]}}"#,
            js::json_string(model),
            js::json_string(prompt)
        );
        let request = self.with_auth(json_post(self.endpoint("/chat/completions"), body));
        let reply = self.send_json(request, GENERATE_TIMEOUT).await?;
        let choices = reply
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| self.unreadable())?;
        let mut first = None;
        for (index, choice) in choices.iter().enumerate() {
            let finish = choice
                .get("finish_reason")
                .ok_or_else(|| self.unreadable())?;
            let content = choice
                .get("message")
                .and_then(|m| m.get("content"))
                .ok_or_else(|| self.unreadable())?;
            if !(finish.is_null() || finish.is_string())
                || !(content.is_null() || content.is_string())
            {
                return Err(self.unreadable());
            }
            if index == 0 {
                first = Some((finish.as_str(), content.as_str()));
            }
        }
        if let Some((Some("length"), _)) = first {
            return Err(RequestError(format!(
                "{} reached its output limit.",
                self.label
            )));
        }
        match first.and_then(|(_, text)| text).map(str::trim) {
            Some(text) if !text.is_empty() => Ok(text.to_owned()),
            _ => Err(RequestError(format!("{} returned no text.", self.label))),
        }
    }

    async fn generate_anthropic(&self, model: &str, prompt: &str) -> Result<String, RequestError> {
        let body = format!(
            r#"{{"model":{},"max_tokens":8192,"messages":[{{"role":"user","content":{}}}]}}"#,
            js::json_string(model),
            js::json_string(prompt)
        );
        let request = self.with_auth(json_post(self.endpoint("/messages"), body));
        let reply = self.send_json(request, GENERATE_TIMEOUT).await?;
        let stop = reply.get("stop_reason").ok_or_else(|| self.unreadable())?;
        let content = reply
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| self.unreadable())?;
        if !(stop.is_null() || stop.is_string()) {
            return Err(self.unreadable());
        }
        let mut text = String::new();
        for block in content {
            let kind = block
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| self.unreadable())?;
            let part = match block.get("text") {
                None => None,
                Some(Value::String(part)) => Some(part.as_str()),
                Some(_) => return Err(self.unreadable()),
            };
            if let (Some(part), "text") = (part, kind) {
                text.push_str(part);
            }
        }
        if stop.as_str() == Some("max_tokens") {
            return Err(RequestError(format!(
                "{} reached its output limit.",
                self.label
            )));
        }
        let text = text.trim();
        if text.is_empty() {
            Err(RequestError(format!("{} returned no text.", self.label)))
        } else {
            Ok(text.to_owned())
        }
    }

    /// `driver.listModels`: the API's models, sorted by id as `localeCompare` sorts.
    pub async fn list_models(&self) -> Result<Vec<TextGeneratorModel>, RequestError> {
        let work = async {
            match self.kind {
                Kind::OpenAiCompatible => self.list_openai().await,
                Kind::Anthropic => self.list_anthropic().await,
            }
        };
        tokio::time::timeout(LIST_MODELS_TIMEOUT, work)
            .await
            .unwrap_or_else(|_| Err(self.too_slow()))
    }

    async fn list_openai(&self) -> Result<Vec<TextGeneratorModel>, RequestError> {
        let request = self.with_auth(HttpRequest::new(Method::Get, self.endpoint("/models")));
        let reply = self.send_json(request, LIST_MODELS_TIMEOUT).await?;
        let entries = model_entries(&reply, "name").ok_or_else(|| self.unreadable())?;
        let mut models: Vec<TextGeneratorModel> = Vec::new();
        for (id, name) in entries {
            if let Some(model) = read_model(&id, name.as_deref()) {
                models.push(model);
            }
        }
        sort_models(&mut models);
        Ok(models)
    }

    async fn list_anthropic(&self) -> Result<Vec<TextGeneratorModel>, RequestError> {
        // A map by id, in first-seen order, as the T3 server's `Map`.
        let mut models: Vec<TextGeneratorModel> = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..MAX_MODEL_PAGES {
            let mut url = format!("{}?limit=1000", self.endpoint("/models"));
            if let Some(after) = after.as_deref().filter(|a| !a.is_empty()) {
                url.push_str("&after_id=");
                url.push_str(&form_encode(after));
            }
            let request = self.with_auth(HttpRequest::new(Method::Get, url));
            let page = self.send_json(request, LIST_MODELS_TIMEOUT).await?;
            let entries = model_entries(&page, "display_name").ok_or_else(|| self.unreadable())?;
            let has_more = match page.get("has_more") {
                None => false,
                Some(Value::Bool(more)) => *more,
                Some(_) => return Err(self.unreadable()),
            };
            let last_id = match page.get("last_id") {
                None | Some(Value::Null) => None,
                Some(Value::String(id)) => Some(id.clone()),
                Some(_) => return Err(self.unreadable()),
            };
            for (id, name) in entries {
                if let Some(model) = read_model(&id, name.as_deref()) {
                    match models.iter_mut().find(|m| m.id == model.id) {
                        Some(existing) => *existing = model,
                        None => models.push(model),
                    }
                }
            }
            match last_id {
                Some(last) if has_more && !last.is_empty() && after.as_deref() != Some(&last) => {
                    after = Some(last);
                }
                _ => break,
            }
        }
        sort_models(&mut models);
        Ok(models)
    }
}

fn json_post(url: String, body: String) -> HttpRequest {
    HttpRequest::new(Method::Post, url)
        .header("content-type", "application/json")
        .body(body.into_bytes())
}

/// `fetch(…, { redirect: "error" })` fails on a redirect status that names a target.
fn is_redirect(response: &HttpResponse) -> bool {
    matches!(response.status, 301 | 302 | 303 | 307 | 308) && response.header("location").is_some()
}

/// `describeStatus`.
pub fn describe_status(label: &str, status: u16, message: Option<&str>) -> String {
    let reason = match status {
        401 | 403 => "rejected the API key".to_owned(),
        404 => "couldn't find that model or endpoint".to_owned(),
        429 => "is rate-limiting requests".to_owned(),
        _ => format!("returned HTTP {status}"),
    };
    // `message?.trim().slice(0, 300)`, in UTF-16 units.
    let detail = message.map(|m| js::slice16(m.trim(), 0, 300));
    match detail.filter(|d| !d.is_empty()) {
        Some(detail) => format!("{label} {reason}: {detail}"),
        None => format!("{label} {reason}."),
    }
}

/// `data: [{ id, <name>? }]`, strictly as the schema decodes it.
fn model_entries(reply: &Value, name_key: &str) -> Option<Vec<(String, Option<String>)>> {
    let data = reply.get("data")?.as_array()?;
    let mut entries = Vec::with_capacity(data.len());
    for entry in data {
        let id = entry.get("id")?.as_str()?.to_owned();
        let name = match entry.get(name_key) {
            None => None,
            Some(Value::String(name)) => Some(name.clone()),
            Some(_) => return None,
        };
        entries.push((id, name));
    }
    Some(entries)
}

/// `readModel`: a trimmed id, and the trimmed name or the id.
fn read_model(id: &str, name: Option<&str>) -> Option<TextGeneratorModel> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    let name = name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or(id);
    Some(TextGeneratorModel {
        id: id.to_owned(),
        name: name.to_owned(),
    })
}

/// `sortModels`: by id, as `localeCompare`; a stable sort, as `Array.prototype.sort`.
pub fn sort_models(models: &mut [TextGeneratorModel]) {
    models.sort_by(|left, right| js::locale_compare(&left.id, &right.id));
}

/// `URLSearchParams` encoding of one value.
fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_statuses_as_the_t3_server() {
        assert_eq!(
            describe_status("OpenRouter", 401, Some(" Incorrect API key provided ")),
            "OpenRouter rejected the API key: Incorrect API key provided"
        );
        assert_eq!(
            describe_status("api.test", 404, None),
            "api.test couldn't find that model or endpoint."
        );
        assert_eq!(
            describe_status("x", 500, Some("   ")),
            "x returned HTTP 500."
        );
        assert_eq!(
            describe_status("x", 429, Some(&"y".repeat(400))),
            format!("x is rate-limiting requests: {}", "y".repeat(300))
        );
    }

    #[test]
    fn reads_models_as_read_model() {
        assert_eq!(read_model("  ", None), None);
        let model = read_model(" a ", Some("  ")).unwrap();
        assert_eq!((model.id.as_str(), model.name.as_str()), ("a", "a"));
        assert_eq!(form_encode("a b/c"), "a+b%2Fc");
    }

    #[test]
    fn compressed_answers_decode_as_fetch_decodes_them_within_the_cap() {
        use std::io::Write;
        let json = br#"{"data":[{"id":"m"}]}"#.to_vec();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&json).unwrap();
        let gzip = gzip.finish().unwrap();
        let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        zlib.write_all(&json).unwrap();
        let zlib = zlib.finish().unwrap();
        let mut raw =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        raw.write_all(&json).unwrap();
        let raw = raw.finish().unwrap();
        assert_eq!(decode_body(Some("gzip"), gzip.clone()), Some(json.clone()));
        assert_eq!(decode_body(Some(" X-Gzip "), gzip), Some(json.clone()));
        assert_eq!(decode_body(Some("deflate"), zlib), Some(json.clone()));
        assert_eq!(decode_body(Some("deflate"), raw), Some(json.clone()));
        assert_eq!(decode_body(None, json.clone()), Some(json.clone()));
        assert_eq!(decode_body(Some("br"), json.clone()), Some(json.clone()));
        assert_eq!(decode_body(Some("gzip"), json), None, "not gzip");
        // A small body that inflates past 8 MiB reads as unreadable, not as memory.
        let mut bomb = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        bomb.write_all(&vec![b' '; MAX_ANSWER_BYTES + 1]).unwrap();
        let bomb = bomb.finish().unwrap();
        assert!(bomb.len() < 64 * 1024);
        assert_eq!(decode_body(Some("gzip"), bomb), None);
    }
}
