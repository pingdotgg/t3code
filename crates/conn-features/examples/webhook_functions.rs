//! The webhook template, filter and signature functions on JSON lines, for
//! `tools/webhook-diff.mjs`, which runs the T3 server's own functions on the same cases.
//!
//! Each input line is one case: `{"op": "render" | "redactHeaders" | "redactQuery" |
//! "filter" | "verify" | "resolve", ...}`. Each output line is the answer, or
//! `{"error": "..."}` for a line that does not parse. A request is `{method, path, query,
//! headers: [[name, value], ...], bodyText}`.

use std::io::{self, BufRead, Write};

use conn_contract::{ScheduledTaskWebhookFilter, ScheduledTaskWebhookSignature};
use conn_features::scheduled::webhook::{filter, template, verify};
use serde::Deserialize;
use serde_json::{Value, json};
use template::WebhookRequest;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestInput {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body_text: String,
}

impl From<RequestInput> for WebhookRequest {
    fn from(input: RequestInput) -> Self {
        WebhookRequest {
            method: input.method,
            path: input.path,
            query: input.query,
            headers: input.headers,
            body_text: input.body_text,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Case {
    #[serde(rename_all = "camelCase")]
    Render {
        template: String,
        request: RequestInput,
        frame_id: String,
        raw: bool,
    },
    RedactHeaders {
        headers: Vec<(String, String)>,
    },
    RedactQuery {
        query: String,
    },
    Filter {
        filters: Vec<ScheduledTaskWebhookFilter>,
        request: RequestInput,
    },
    #[serde(rename_all = "camelCase")]
    Verify {
        signature: ScheduledTaskWebhookSignature,
        secret: String,
        headers: Vec<(String, String)>,
        body_text: String,
    },
    Resolve {
        request: RequestInput,
        expression: String,
    },
}

fn answer(case: Case) -> Value {
    match case {
        Case::Render {
            template,
            request,
            frame_id,
            raw,
        } => {
            let rendered =
                template::render_webhook_prompt(&template, &request.into(), &frame_id, raw);
            json!({ "prompt": rendered.prompt, "missing": rendered.missing })
        }
        Case::RedactHeaders { headers } => json!(template::redact_headers(&headers)),
        Case::RedactQuery { query } => json!(template::redact_query(&query)),
        Case::Filter { filters, request } => {
            match filter::find_failed_webhook_filter(&filters, &request.into()) {
                None => json!({ "failed": null }),
                Some(failed) => json!({
                    "failed": { "index": failed.index, "path": failed.path },
                    "description": filter::describe_failed_webhook_filter(&failed),
                }),
            }
        }
        Case::Verify {
            signature,
            secret,
            headers,
            body_text,
        } => json!(verify::verify_webhook_signature(
            &signature,
            &secret,
            &headers,
            body_text.as_bytes()
        )),
        Case::Resolve {
            request,
            expression,
        } => {
            let value = template::resolve_expression(&request.into(), &expression);
            json!({ "value": value.map(|value| value.to_pretty_string()) })
        }
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let output = match serde_json::from_str::<Case>(&line) {
            Ok(case) => answer(case),
            Err(error) => json!({ "error": error.to_string() }),
        };
        writeln!(stdout, "{output}")?;
    }
    stdout.flush()
}
