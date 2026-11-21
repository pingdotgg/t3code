//! Blocking HTTP download of the pinned CEF minimal archive over rustls.

use crate::WebError;
use crate::archive::{self, Archive, Layout};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// Downloads and installs `archive` into `layout`, reporting integer progress
/// percentages (`0..=100`) to `progress`.
pub(crate) fn install(
    archive: &Archive,
    layout: &Layout,
    progress: &mut dyn FnMut(u8),
) -> Result<(), WebError> {
    let pin = archive.pin();
    if archive::is_installed(layout, &pin) {
        progress(100);
        return Ok(());
    }

    let part = layout.download_file(archive.file);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_per_read(Some(Duration::from_secs(60)))
        .user_agent("conn-gpui (web runtime)")
        .build()
        .into();

    let response = agent
        .get(&archive.url())
        .call()
        .map_err(|e| WebError::Download(format!("failed to reach CEF CDN: {e}")))?;

    let mut body = response.into_body().into_reader();
    let total = pin.bytes;
    let cancel = AtomicBool::new(false);
    let mut last_percent: Option<u8> = None;

    progress(0);
    archive::receive(
        &mut body,
        &part,
        &pin,
        &mut |received| {
            let pct = received
                .min(total)
                .saturating_mul(100)
                .checked_div(total)
                .and_then(|v| u8::try_from(v).ok())
                .unwrap_or(0);
            if last_percent != Some(pct) {
                last_percent = Some(pct);
                progress(pct);
            }
        },
        &cancel,
    )?;

    let installed = archive::install_from_file(&part, &pin, layout);
    let _ = std::fs::remove_file(&part);
    if let Some(dir) = part.parent() {
        let _ = std::fs::remove_dir(dir);
    }
    installed
}
