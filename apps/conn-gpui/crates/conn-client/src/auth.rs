use std::time::Duration;

use serde::Deserialize;
use url::{Url, form_urlencoded};

const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TOKEN_TYPE: &str = "urn:t3:params:oauth:token-type:environment-bootstrap";
const REQUESTED_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const CLIENT_LABEL: &str = "conn-gpui";
const CLIENT_DEVICE_TYPE: &str = "desktop";
const TOKEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug)]
pub(crate) enum TokenExchangeError {
    /// Server rejected the pairing code (4xx); retrying the same single-use code cannot succeed.
    Rejected(String),
    /// Transient transport or server error; safe to retry with backoff.
    Retryable(String),
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

/// Exchanges a single-use pairing code for a bearer access token via `POST /oauth/token`.
pub(crate) async fn exchange_pairing_code(
    http: &reqwest::Client,
    http_base_url: &Url,
    code: &str,
) -> Result<String, TokenExchangeError> {
    let token_url = http_base_url
        .join("oauth/token")
        .map_err(|err| TokenExchangeError::Rejected(format!("invalid token url: {err}")))?;

    let form_body = form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", GRANT_TYPE)
        .append_pair("subject_token", code)
        .append_pair("subject_token_type", SUBJECT_TOKEN_TYPE)
        .append_pair("requested_token_type", REQUESTED_TOKEN_TYPE)
        .append_pair("client_label", CLIENT_LABEL)
        .append_pair("client_device_type", CLIENT_DEVICE_TYPE)
        .finish();

    let response = http
        .post(token_url)
        .timeout(TOKEN_REQUEST_TIMEOUT)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(form_body)
        .send()
        .await
        .map_err(|err| TokenExchangeError::Retryable(format!("token exchange request: {err}")))?;

    let status = response.status();
    if status.is_success() {
        let parsed: TokenResponse = response.json().await.map_err(|err| {
            TokenExchangeError::Retryable(format!("invalid token exchange json: {err}"))
        })?;
        if parsed.access_token.is_empty() {
            return Err(TokenExchangeError::Rejected(
                "server returned empty access_token".to_owned(),
            ));
        }
        return Ok(parsed.access_token);
    }

    let body = response.text().await.unwrap_or_default();
    let message = if body.is_empty() {
        format!("token exchange failed with HTTP {status}")
    } else {
        format!("token exchange failed with HTTP {status}: {body}")
    };

    if status.is_client_error() {
        Err(TokenExchangeError::Rejected(message))
    } else {
        Err(TokenExchangeError::Retryable(message))
    }
}
