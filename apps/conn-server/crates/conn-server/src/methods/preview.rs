//! The client and the agent use the same server-owned tabs.
use super::Deps;
use crate::table::{Failure, MethodTable};
use conn_contract::rpc::preview::list::Payload as PreviewListInput;
use conn_contract::{
    PreviewAdjustInput, PreviewClearProfileInput, PreviewCloseInput, PreviewOpenInput,
    PreviewReportProfilesInput, PreviewReportStatusInput, PreviewResizeInput, to_json,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(preview) = deps.preview.clone() else {
        return;
    };
    let browser = preview.clone();
    table.on_disconnect(move |id| browser.disconnect_client(id));
    let browser = preview.clone();
    table.unary("preview.list", move |_, input: PreviewListInput| {
        let browser = browser.clone();
        async move { Ok(browser.list(&input.thread_id)) }
    });
    let browser = preview.clone();
    table.unary("preview.close", move |_, input: PreviewCloseInput| {
        let browser = browser.clone();
        async move {
            browser
                .close(&input.thread_id, input.tab_id.as_deref())
                .await
                .map_err(|e| Failure::die(e.to_string()))
        }
    });
    let browser = preview.clone();
    table.unary("preview.resize", move |_, input: PreviewResizeInput| {
        let browser = browser.clone();
        async move {
            browser
                .resize(&input.thread_id, &input.tab_id, to_json(&input.viewport))
                .await
                .map_err(|_| lookup(&input.thread_id, &input.tab_id))
        }
    });
    let browser = preview.clone();
    table.unary(
        "preview.reportProfiles",
        move |ctx, input: PreviewReportProfilesInput| {
            let browser = browser.clone();
            async move {
                browser
                    .report_profiles(
                        ctx.connection_id,
                        input.profiles.iter().map(to_json).collect(),
                        input.default_profile_id,
                        to_json(&input.recording_frame_rate).as_u64(),
                    )
                    .await
                    .map_err(|e| Failure::die(e.to_string()))
            }
        },
    );
    let browser = preview.clone();
    table.unary("preview.open", move |_, input: PreviewOpenInput| {
        let browser = browser.clone();
        async move {
            if let Some(url) = &input.url
                && let Err(error) = conn_preview::tabs::preview_url(url) {
                    let mut failure = json!({"_tag":"PreviewInvalidUrlError","inputLength":error.length,"reason":error.reason,"cause":{"name":"PreviewUrlNormalizationError","message":error.to_string()}});
                    if let Some(protocol) = error.protocol { failure["protocol"] = json!(protocol); }
                    return Err(Failure::Fail(failure));
                }
            let value = to_json(&input);
            // Desktop relay methods stay unregistered on the headless Linux server.
            if value.get("runtime").and_then(Value::as_str) != Some("server") { return Err(Failure::die("Desktop preview tabs are not supported by this server. Use runtime server.")); }
            browser.open_client(&input.thread_id, value).await.map_err(|e| Failure::die(e.to_string()))
        }
    });
    let browser = preview.clone();
    table.unary("preview.adjust", move |_, input: PreviewAdjustInput| {
        let browser = browser.clone();
        async move {
            browser
                .adjust(&input.thread_id, &input.tab_id, &to_json(&input))
                .await
                .map_err(|_| lookup(&input.thread_id, &input.tab_id))
        }
    });
    let browser = preview.clone();
    table.unary("preview.clearProfile", move |_, input: PreviewClearProfileInput| {
        let browser = browser.clone();
        async move { browser.clear_profile(&input.profile_id).await.map_err(|e| Failure::Fail(json!({"_tag":"PreviewClearProfileError","profileId":input.profile_id,"cause":{"name":"Error","message":e.to_string()}}))) }
    });
    let browser = preview.clone();
    table.unary(
        "preview.reportStatus",
        move |_, input: PreviewReportStatusInput| {
            let browser = browser.clone();
            async move {
                if browser
                    .snapshot_for(&input.thread_id, &input.tab_id)
                    .is_some()
                {
                    Err::<(), _>(Failure::Fail(
                        json!({"_tag":"PreviewControlRequiredError","tabId":input.tab_id}),
                    ))
                } else {
                    Err(lookup(&input.thread_id, &input.tab_id))
                }
            }
        },
    );
    table.stream("subscribePreviewEvents", move |_, _: Value| {
        let mut events = preview.subscribe();
        async move {
            let (tx, rx) = mpsc::channel(16);
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        () = tx.closed() => break,
                        event = events.recv() => match event {
                            Ok(event) => if tx.send(Ok(event)).await.is_err() { break; },
                            Err(_) => break,
                        }
                    }
                }
            });
            Ok(rx)
        }
    });
}
fn lookup(thread: &str, tab: &str) -> Failure {
    Failure::Fail(json!({"_tag":"PreviewSessionLookupError","threadId":thread,"tabId":tab}))
}

#[cfg(test)]
mod tests;
