use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::time::Duration;

use libwebauthn::ops::webauthn::{
    GetAssertionRequest, JsonFormat, MakeCredentialRequest, OriginValidation, PublicSuffixList,
    RelatedOrigins, RequestOrigin, RequestSettings, WebAuthnIDLResponse,
};
use libwebauthn::transport::hybrid::channel::{HybridUxUpdate, PxpUpdate};
use libwebauthn::transport::hybrid::known_devices::EphemeralDeviceInfoStore;
use libwebauthn::transport::hybrid::qr_code_device::{
    PxpQrCodeDevice, PxpTransports, QrCodeOperationHint,
};
use libwebauthn::transport::{Channel, ChannelSettings, Device};
use libwebauthn::webauthn::WebAuthn;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    operation: Operation,
    origin: String,
    public_key: Value,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Create,
    Get,
}

struct SuffixList;

impl PublicSuffixList for SuffixList {
    fn public_suffix(&self, host: &str) -> Option<String> {
        psl::suffix_str(host).map(str::to_owned)
    }
}

fn emit(event: Value) -> io::Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &event)?;
    writeln!(out)?;
    out.flush()
}

async fn ceremony(request: Request) -> Result<Value, Box<dyn std::error::Error>> {
    let origin: RequestOrigin = request.origin.as_str().try_into()?;
    let settings = RequestSettings {
        origin: OriginValidation::Validate {
            public_suffix_list: &SuffixList,
            related_origins: RelatedOrigins::Disabled,
        },
    };
    let options = serde_json::to_string(&request.public_key)?;
    // Validate the request before generating a QR code or scanning Bluetooth.
    let get = match request.operation {
        Operation::Get => Some(GetAssertionRequest::prepare(&origin, &options, &settings).await?),
        Operation::Create => None,
    };
    let create = match request.operation {
        Operation::Create => {
            Some(MakeCredentialRequest::prepare(&origin, &options, &settings).await?)
        }
        Operation::Get => None,
    };
    let hint = match request.operation {
        Operation::Get => QrCodeOperationHint::GetAssertionRequest,
        Operation::Create => QrCodeOperationHint::MakeCredential,
    };
    let mut device = PxpQrCodeDevice::new_persistent(
        hint,
        Arc::new(EphemeralDeviceInfoStore::default()),
        PxpTransports::CloudAssistedOnly,
    )?;
    emit(json!({"type": "qr", "url": device.qr_code.to_string()}))?;
    let mut channel = device.channel(ChannelSettings::default()).await?;
    let mut updates = channel.get_ux_update_receiver();
    tokio::spawn(async move {
        while let Ok(update) = updates.recv().await {
            if matches!(update, HybridUxUpdate::PxpUpdate(PxpUpdate::Connected)) {
                let _ = emit(json!({"type": "connected"}));
            }
        }
    });
    let result = if let Some(get) = get {
        let response = channel.webauthn_get_assertion(&get).await?;
        // Hybrid authenticators select the account on the phone.
        if response.assertions.len() != 1 {
            return Err("The phone must select one passkey".into());
        }
        let assertion = response.assertions.first().ok_or("No assertion returned")?;
        assertion.to_json_string(&get, JsonFormat::default())?
    } else if let Some(create) = create {
        let response = channel.webauthn_make_credential(&create).await?;
        response.to_json_string(&create, JsonFormat::default())?
    } else {
        return Err("Missing ceremony".into());
    };
    channel.close().await;
    Ok(serde_json::from_str(&result)?)
}

#[tokio::main]
async fn main() {
    let result = async {
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line)?;
        let request: Request = serde_json::from_str(&line)?;
        let timeout = request
            .public_key
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(120_000)
            .clamp(1, 3_600_000);
        match tokio::time::timeout(Duration::from_millis(timeout), ceremony(request)).await {
            Ok(result) => result,
            Err(_) => Err("Passkey request timed out".into()),
        }
    }
    .await;
    let event = match result {
        Ok(credential) => json!({"type": "result", "credential": credential}),
        Err(error) => json!({"type": "error", "message": error.to_string()}),
    };
    let _ = emit(event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_unrelated_and_public_suffix_relying_parties_before_discovery() {
        let origin: RequestOrigin = "https://account.example.com".try_into().unwrap();
        let settings = RequestSettings {
            origin: OriginValidation::Validate {
                public_suffix_list: &SuffixList,
                related_origins: RelatedOrigins::Disabled,
            },
        };
        assert!(
            GetAssertionRequest::prepare(
                &origin,
                r#"{"rpId":"example.com","challenge":"AQID"}"#,
                &settings
            )
            .await
            .is_ok()
        );
        for (origin, rp_id) in [
            ("https://account.example.com", "elsewhere.com"),
            ("https://account.example.com", "com"),
            ("https://tenant.github.io", "github.io"),
            ("https://badexample.com", "example.com"),
        ] {
            let request = Request {
                operation: Operation::Get,
                origin: origin.into(),
                public_key: json!({"rpId": rp_id, "challenge": "AQID"}),
            };
            assert!(ceremony(request).await.is_err());
        }
    }
}
