//! Agent uploads share the client store; a staged upload may only be discarded by its owner.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use conn_contract::{AttachmentCreateUploadUrlInput, from_json, to_json};
use conn_files::attachments::{self, UploadRequest};
use serde_json::{Value, json};

use super::{Args, Cx, ToolResult, fail, internal, str_arg};
use crate::view;

const OWNER_TTL_MS: u64 = 24 * 60 * 60_000 + attachments::UPLOAD_URL_TTL_MS;
// Unlike T3, ownership is capped at 4,096 entries and released after a successful send.
const MAX_PENDING_OWNERS: usize = 4096;

#[derive(Default)]
pub(crate) struct UploadOwners(HashMap<String, (String, u64)>);

impl UploadOwners {
    #[cfg(test)]
    pub(crate) fn pending_count(&self) -> usize {
        self.0.len()
    }

    fn sweep(&mut self, now: u64) {
        self.0
            .retain(|_, (_, at)| now.saturating_sub(*at) <= OWNER_TTL_MS);
    }

    fn available(&mut self, now: u64) -> Result<(), super::ToolError> {
        self.sweep(now);
        if self.0.len() >= MAX_PENDING_OWNERS {
            return Err(internal("pending upload owner limit reached"));
        }
        Ok(())
    }

    fn insert(&mut self, id: String, owner: String, now: u64) -> Result<(), super::ToolError> {
        self.available(now)?;
        self.0.insert(id, (owner, now));
        Ok(())
    }
}

fn owner(cx: &Cx<'_>) -> String {
    cx.caller_thread_id()
        .map_or_else(|| cx.caller.namespace(), str::to_owned)
}

pub(super) async fn prepare(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.writing_caller().await?;
    let files = cx
        .config()
        .files
        .clone()
        .ok_or_else(|| internal("attachment store unavailable"))?;
    let input: AttachmentCreateUploadUrlInput =
        from_json(args.get("upload").cloned().unwrap_or_default()).map_err(internal)?;
    let request = UploadRequest::from(input);
    request.validate().map_err(internal)?;
    let now = attachments::now_ms();
    let upload_files = files.clone();
    let result = tokio::task::spawn_blocking(move || {
        upload_files
            .attachments
            .create_upload(&upload_files.signer, &request, now)
    })
    .await
    .map_err(internal)?;
    register_upload(
        &cx.service.upload_owners,
        files,
        result.attachment_id.clone(),
        owner(cx),
        now,
    )
    .await?;
    let mut result = to_json(&result);
    if let Some(origin) = cx.origin {
        result["uploadUrl"] = json!(format!(
            "{origin}{}",
            result["relativeUrl"].as_str().unwrap_or_default()
        ));
    }
    Ok(result)
}

async fn register_upload(
    owners: &Mutex<UploadOwners>,
    files: Arc<conn_files::Files>,
    id: String,
    owner: String,
    now: u64,
) -> Result<(), super::ToolError> {
    let inserted = crate::lock(owners).insert(id.clone(), owner, now);
    if let Err(error) = inserted {
        tokio::task::spawn_blocking(move || files.attachments.delete_pending(&id))
            .await
            .map_err(internal)?;
        return Err(error);
    }
    Ok(())
}

pub(super) async fn discard(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.writing_caller().await?;
    let id = str_arg(args, "attachmentId").unwrap_or_default();
    let owned = crate::lock(&cx.service.upload_owners)
        .0
        .get(id)
        .is_some_and(|(prepared_by, _)| *prepared_by == owner(cx));
    if !owned {
        return Err(fail(
            "invalid_request",
            "Only the caller that prepared a pending upload can discard it.",
        ));
    }
    let files = cx
        .config()
        .files
        .clone()
        .ok_or_else(|| internal("attachment store unavailable"))?;
    let attachment_id = id.to_owned();
    tokio::task::spawn_blocking(move || files.attachments.delete_pending(&attachment_id))
        .await
        .map_err(internal)?;
    crate::lock(&cx.service.upload_owners).0.remove(id);
    Ok(json!({}))
}

pub(super) async fn send(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.writes_threads(&[str_arg(args, "threadId")]).await?;
    let id = str_arg(args, "threadId")
        .or_else(|| cx.caller_thread_id())
        .ok_or_else(|| {
            fail(
                "target_required",
                "Pass threadId: this MCP client is not running inside a T3 thread.",
            )
        })?;
    let projection = cx.projection(id).await?;
    if !projection["thread"]["archivedAt"].is_null() {
        return Err(fail(
            "invalid_request",
            "Unarchive the target thread before sending attachments.",
        ));
    }
    let stored: Vec<&Value> = projection["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|m| m["attachments"].as_array().into_iter().flatten())
        .collect();
    let requested = args
        .get("attachments")
        .and_then(Value::as_array)
        .ok_or_else(|| internal("missing attachments"))?;
    let canonical = requested.iter().map(|attachment| {
        if attachment["id"].as_str().and_then(attachments::parse_id).is_some_and(|id| id.segment == attachments::PENDING_SEGMENT) {
            Ok(attachment.clone())
        } else {
            stored.iter().find(|item| item["id"] == attachment["id"]).map(|item| (*item).clone())
                .ok_or_else(|| fail("invalid_request", "Attachments must be pending uploads or already belong to the target thread."))
        }
    }).collect::<Result<Vec<_>, _>>()?;
    let command_id = format!("mcp:{}", conn_support::uuid_v4());
    let active = view::active_run(&projection).map(|r| r["id"].clone());
    let mut command = json!({
        "type":"message.dispatch", "threadId":id, "commandId":command_id,
        "messageId":command_id, "text":str_arg(args,"message").unwrap_or_default(),
        "attachments": canonical,
        "dispatchMode":active.map_or_else(|| json!({"type":"start_immediately"}), |run| json!({"type":"steer_active","targetRunId":run})),
        "createdBy":"agent", "creationSource":"mcp",
    });
    if let Some(sender) = cx.caller_thread_id() {
        command["senderThreadId"] = json!(sender);
    }
    cx.dispatch(command).await?;
    {
        let mut owners = crate::lock(&cx.service.upload_owners);
        for attachment in requested {
            if let Some(id) = attachment["id"].as_str() {
                owners.0.remove(id);
            }
        }
    }
    let projection = cx.projection(id).await?;
    let run = projection["messages"]
        .as_array()
        .and_then(|m| m.iter().find(|m| m["id"] == command_id))
        .and_then(|m| {
            projection["runs"]
                .as_array()?
                .iter()
                .find(|r| r["id"] == m["runId"])
        })
        .ok_or_else(|| internal("attachment message has no run"))?;
    Ok(json!({"threadId":id,"messageId":command_id,"runId":run["id"],"status":run["status"]}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn an_upload_losing_the_last_owner_slot_cleans_up_pending_bytes() {
        let dir = std::env::temp_dir().join(format!("conn-owner-race-{}", conn_support::uuid_v4()));
        let files = Arc::new(conn_files::Files::open(&dir).unwrap());
        let request = UploadRequest::from(
            conn_contract::from_json::<AttachmentCreateUploadUrlInput>(
                json!({"type":"file","name":"a.txt","mimeType":"text/plain","sizeBytes":3}),
            )
            .unwrap(),
        );
        let upload = files.attachments.create_upload(&files.signer, &request, 0);
        let path = dir
            .join("attachments")
            .join(format!("{}.txt", upload.attachment_id));
        std::fs::create_dir_all(dir.join("attachments")).unwrap();
        std::fs::write(&path, b"abc").unwrap();
        let mut full = UploadOwners::default();
        for n in 0..MAX_PENDING_OWNERS {
            full.insert(format!("upload-{n}"), "caller".into(), 0)
                .unwrap();
        }
        let owners = Mutex::new(full);
        assert!(
            register_upload(&owners, files, upload.attachment_id, "caller".into(), 0)
                .await
                .is_err()
        );
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn upload_owners_are_bounded_without_eviction_and_expire_after_the_upload_lifetime() {
        let mut owners = UploadOwners::default();
        for n in 0..MAX_PENDING_OWNERS {
            owners
                .insert(format!("upload-{n}"), "caller".into(), 0)
                .unwrap();
        }
        assert!(
            owners
                .insert("overflow".into(), "other".into(), OWNER_TTL_MS)
                .is_err()
        );
        assert_eq!(
            owners.0.get("upload-0").map(|(owner, _)| owner.as_str()),
            Some("caller")
        );
        owners.0.remove("upload-0");
        owners
            .insert("replacement".into(), "caller".into(), OWNER_TTL_MS)
            .unwrap();
        owners
            .insert("later".into(), "caller".into(), OWNER_TTL_MS + 1)
            .unwrap();
        assert_eq!(owners.0.len(), 2);
    }
}
