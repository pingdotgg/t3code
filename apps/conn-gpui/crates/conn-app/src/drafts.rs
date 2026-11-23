//! New-thread drafts the app holds: the open draft's state, the parked drafts behind it, the
//! project slots that say which draft a project opens, and the file that keeps them across a
//! restart. The text and attachments of a draft live in the composer's draft store, under the
//! draft's id.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use conn_contract::ChatAttachment;
use conn_state::{
    ProjectDraftSlots, Retarget, SidebarDraftRow, draft_has_content, keeps_displaced_draft,
    persists_across_restart, retarget_draft,
};
use serde::{Deserialize, Serialize};

/// State of a brand-new thread draft being composed before `orchestration.launchThread`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DraftThreadState {
    pub(crate) draft_id: String,
    /// The connected environment the draft was made in.
    pub(crate) environment_id: String,
    pub(crate) project_id: String,
    pub(crate) created_at_ms: u64,
    pub(crate) model_instance_id: Option<String>,
    pub(crate) model_slug: Option<String>,
    pub(crate) model_options: Option<serde_json::Map<String, serde_json::Value>>,
    pub(crate) runtime_mode: String,
    pub(crate) interaction_mode: String,
    pub(crate) use_worktree: bool,
    /// Base ref for a new worktree, or the branch the local checkout was switched to.
    pub(crate) branch: Option<String>,
    /// Reuse this existing worktree (`Previous worktree`, or a ref checked out in one).
    pub(crate) worktree_path: Option<String>,
    /// `Start from remote` for a new worktree's base.
    pub(crate) start_from_origin: bool,
    #[serde(skip)]
    pub(crate) launching: bool,
}

/// A fresh draft id.
#[must_use]
pub(crate) fn new_draft_id() -> String {
    conn_client::commands::new_thread_id().replacen("thread", "draft", 1)
}

/// Milliseconds since the Unix epoch.
#[must_use]
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The drafts the app is not showing, and which draft each project opens.
#[derive(Debug, Default)]
pub(crate) struct DraftBook {
    parked: HashMap<String, DraftThreadState>,
    slots: ProjectDraftSlots,
    /// The open draft's sidebar row, taken when it opened.
    frozen_active: Option<SidebarDraftRow>,
}

impl DraftBook {
    /// Parks a draft that is no longer open. A launching draft stays so its launch can finish.
    pub(crate) fn park(&mut self, draft: DraftThreadState) {
        self.parked.insert(draft.draft_id.clone(), draft);
    }

    /// Takes a parked draft out to open it.
    pub(crate) fn take(&mut self, draft_id: &str) -> Option<DraftThreadState> {
        self.parked.remove(draft_id)
    }

    /// Takes the draft `project_key` opens out of the parked set. A launching draft is not
    /// reused: its thread is about to replace it.
    pub(crate) fn take_for_project(&mut self, project_key: &str) -> Option<DraftThreadState> {
        let draft_id = self.slots.draft_for(project_key)?.to_owned();
        if self.parked.get(&draft_id)?.launching {
            return None;
        }
        self.parked.remove(&draft_id)
    }

    /// Moves `draft_id` to `target_project_key` when it holds content (`selectProject`).
    pub(crate) fn retarget(
        &mut self,
        draft_id: &str,
        target_project_key: &str,
        has_content: bool,
    ) -> Retarget {
        retarget_draft(&mut self.slots, draft_id, target_project_key, has_content)
    }

    /// The project key that opens `draft_id`, if one does.
    pub(crate) fn project_key_of(&self, draft_id: &str) -> Option<String> {
        self.slots.project_of(draft_id).map(str::to_owned)
    }

    /// No draft opens from `project_key`.
    pub(crate) fn slot_is_free(&self, project_key: &str) -> bool {
        self.slots.draft_for(project_key).is_none()
    }

    /// Points `project_key` at `draft_id`. Returns the draft that sat there, now unmapped.
    pub(crate) fn map(&mut self, project_key: &str, draft_id: &str) -> Option<String> {
        self.slots.assign(project_key, draft_id)
    }

    #[cfg(test)]
    pub(crate) fn is_mapped(&self, draft_id: &str) -> bool {
        self.slots.is_mapped(draft_id)
    }

    /// A new connection ends every launch in flight: its result is ignored from now on.
    pub(crate) fn clear_launching(&mut self) {
        for draft in self.parked.values_mut() {
            draft.launching = false;
        }
    }

    pub(crate) fn get(&self, draft_id: &str) -> Option<&DraftThreadState> {
        self.parked.get(draft_id)
    }

    pub(crate) fn get_mut(&mut self, draft_id: &str) -> Option<&mut DraftThreadState> {
        self.parked.get_mut(draft_id)
    }

    /// Removes a draft for good: from the parked set and from the project slots.
    pub(crate) fn forget(&mut self, draft_id: &str) -> Option<DraftThreadState> {
        self.slots.release(draft_id);
        self.parked.remove(draft_id)
    }

    pub(crate) fn set_frozen_active(&mut self, row: Option<SidebarDraftRow>) {
        self.frozen_active = row;
    }

    pub(crate) fn frozen_active(&self) -> Option<&SidebarDraftRow> {
        self.frozen_active.as_ref()
    }

    /// The open draft moved to another project; its frozen row follows.
    pub(crate) fn set_frozen_project(&mut self, project_id: &str) {
        if let Some(row) = &mut self.frozen_active {
            project_id.clone_into(&mut row.project_id);
        }
    }

    /// Drops parked drafts that no project opens and that hold nothing (`setLogicalProject-
    /// DraftThreadId` deletes the draft it displaces unless it has content). Returns their ids.
    pub(crate) fn drop_unreachable(&mut self, has_content: impl Fn(&str) -> bool) -> Vec<String> {
        let doomed: Vec<String> = self
            .parked
            .values()
            .filter(|draft| {
                !self.slots.is_mapped(&draft.draft_id)
                    && !keeps_displaced_draft(has_content(&draft.draft_id), draft.launching)
            })
            .map(|draft| draft.draft_id.clone())
            .collect();
        for id in &doomed {
            self.parked.remove(id);
        }
        doomed
    }

    /// Parks the drafts of a saved file and restores the project slots.
    pub(crate) fn restore(&mut self, saved: SavedDrafts) -> Vec<(String, DraftContent)> {
        let mut contents = Vec::with_capacity(saved.drafts.len());
        for SavedDraft { session, content } in saved.drafts {
            contents.push((session.draft_id.clone(), content));
            self.parked.insert(session.draft_id.clone(), session);
        }
        for (project_key, draft_id) in saved.slots {
            if self.parked.contains_key(&draft_id) {
                self.slots.assign(&project_key, &draft_id);
            }
        }
        contents
    }

    /// Everything that outlives a restart, given every draft the app holds.
    pub(crate) fn capture(
        &self,
        open: Option<&DraftThreadState>,
        contents: &HashMap<String, DraftContent>,
        thread_contents: Vec<(String, DraftContent)>,
    ) -> SavedDrafts {
        let mut drafts: Vec<SavedDraft> = self
            .parked
            .values()
            .chain(open)
            .filter(|draft| {
                let content = contents.get(&draft.draft_id);
                persists_across_restart(
                    self.slots.is_mapped(&draft.draft_id),
                    content.is_some_and(DraftContent::has_content),
                    draft.launching,
                )
            })
            .map(|draft| SavedDraft {
                session: draft.clone(),
                content: contents.get(&draft.draft_id).cloned().unwrap_or_default(),
            })
            .collect();
        drafts.sort_by(|a, b| a.session.draft_id.cmp(&b.session.draft_id));
        let kept: Vec<&str> = drafts.iter().map(|d| d.session.draft_id.as_str()).collect();
        let slots = self
            .slots
            .iter()
            .filter(|(_, draft_id)| kept.contains(draft_id))
            .map(|(project, draft_id)| (project.to_owned(), draft_id.to_owned()))
            .collect();
        let mut threads: Vec<(String, DraftContent)> = thread_contents
            .into_iter()
            .filter(|(_, content)| content.has_content())
            .collect();
        threads.sort_by(|a, b| a.0.cmp(&b.0));
        SavedDrafts {
            version: DRAFT_FILE_VERSION,
            drafts,
            slots,
            threads,
        }
    }
}

/// One attachment of a draft that finished uploading: the server's descriptor of it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DraftAttachment {
    pub(crate) name: String,
    pub(crate) size_bytes: usize,
    pub(crate) attachment: ChatAttachment,
}

/// Unsent text and uploaded attachments of one draft.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct DraftContent {
    pub(crate) text: String,
    pub(crate) attachments: Vec<DraftAttachment>,
}

impl DraftContent {
    pub(crate) fn has_content(&self) -> bool {
        draft_has_content(&self.text, self.attachments.len())
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct SavedDraft {
    session: DraftThreadState,
    content: DraftContent,
}

const DRAFT_FILE_VERSION: u32 = 1;

/// The drafts file: every draft that outlives a restart, and the project slots.
#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct SavedDrafts {
    version: u32,
    drafts: Vec<SavedDraft>,
    slots: Vec<(String, String)>,
    /// Unsent input of started threads, by thread id (Conn keeps these in the same store).
    #[serde(default)]
    threads: Vec<(String, DraftContent)>,
}

impl SavedDrafts {
    /// Takes the started threads' unsent input out of the file.
    pub(crate) fn take_threads(&mut self) -> Vec<(String, DraftContent)> {
        std::mem::take(&mut self.threads)
    }

    pub(crate) fn to_json(&self) -> Option<String> {
        serde_json::to_string(self).ok()
    }

    /// Parses a drafts file. A file from another version, or a broken one, loads as none.
    pub(crate) fn from_json(json: &str) -> Option<Self> {
        let saved: Self = serde_json::from_str(json).ok()?;
        (saved.version == DRAFT_FILE_VERSION).then_some(saved)
    }
}

/// Where drafts are kept: `drafts.json` beside the other `conn-gpui` files, or under
/// `CONN_GPUI_CONFIG_DIR`. Unit tests keep nothing on disk.
#[must_use]
pub(crate) fn drafts_file_path() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("drafts.json"));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(home.join("Library/Application Support/conn-gpui/drafts.json"))
}

/// Reads the drafts file; a missing or unreadable one gives none.
pub(crate) fn load_saved_drafts(path: &Path) -> Option<SavedDrafts> {
    SavedDrafts::from_json(&std::fs::read_to_string(path).ok()?)
}

/// Writes `json` to `path` through a temporary file, readable by the user only (it holds
/// unsent prompts).
pub(crate) fn write_drafts_file(path: &Path, json: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(id: &str, project: &str) -> DraftThreadState {
        DraftThreadState {
            draft_id: id.to_owned(),
            environment_id: "env".to_owned(),
            project_id: project.to_owned(),
            created_at_ms: 1,
            model_instance_id: None,
            model_slug: None,
            model_options: None,
            runtime_mode: "full-access".to_owned(),
            interaction_mode: "default".to_owned(),
            use_worktree: false,
            branch: None,
            worktree_path: None,
            start_from_origin: false,
            launching: false,
        }
    }

    fn content(text: &str) -> DraftContent {
        DraftContent {
            text: text.to_owned(),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn a_project_opens_its_mapped_draft_but_never_a_launching_one() {
        let mut book = DraftBook::default();
        book.park(draft("d1", "a"));
        book.map("env:a", "d1");
        assert_eq!(
            book.take_for_project("env:a").map(|d| d.draft_id),
            Some("d1".to_owned())
        );
        assert!(book.take_for_project("env:a").is_none());

        let mut launching = draft("d2", "b");
        launching.launching = true;
        book.park(launching);
        book.map("env:b", "d2");
        assert!(book.take_for_project("env:b").is_none());
        assert!(book.get("d2").is_some());
    }

    #[test]
    fn a_displaced_draft_stays_unmapped_while_it_has_content_and_goes_when_empty() {
        let mut book = DraftBook::default();
        book.park(draft("keep", "a"));
        book.park(draft("empty", "a"));
        book.map("env:a", "keep");
        assert_eq!(book.map("env:a", "empty"), Some("keep".to_owned()));
        // `keep` was displaced; `empty` now holds the slot.
        let dropped = book.drop_unreachable(|id| id == "keep");
        assert!(dropped.is_empty());
        assert!(book.get("keep").is_some());

        book.map("env:a", "keep");
        let dropped = book.drop_unreachable(|id| id == "keep");
        assert_eq!(dropped, vec!["empty".to_owned()]);
        assert!(book.get("empty").is_none());
    }

    #[test]
    fn forgetting_a_draft_frees_its_project_slot() {
        let mut book = DraftBook::default();
        book.park(draft("d1", "a"));
        book.map("env:a", "d1");
        assert!(book.forget("d1").is_some());
        assert!(!book.is_mapped("d1"));
        assert!(book.take_for_project("env:a").is_none());
    }

    #[test]
    fn saved_drafts_keep_mapped_drafts_and_drafts_with_content_only() {
        let mut book = DraftBook::default();
        book.park(draft("mapped", "a"));
        book.map("env:a", "mapped");
        book.park(draft("unmapped-text", "a"));
        book.park(draft("unmapped-empty", "b"));
        let mut launching = draft("launching", "c");
        launching.launching = true;
        book.park(launching);
        let open = draft("open", "d");
        let contents = HashMap::from([
            ("unmapped-text".to_owned(), content("hello")),
            ("launching".to_owned(), content("sending")),
            ("open".to_owned(), content("typing")),
        ]);
        let saved = book.capture(Some(&open), &contents, Vec::new());
        let ids: Vec<&str> = saved
            .drafts
            .iter()
            .map(|d| d.session.draft_id.as_str())
            .collect();
        assert_eq!(ids, vec!["mapped", "open", "unmapped-text"]);
        assert_eq!(saved.slots, vec![("env:a".to_owned(), "mapped".to_owned())]);
    }

    #[test]
    fn saved_drafts_round_trip_through_json_and_restore_the_slots() {
        let mut book = DraftBook::default();
        book.park(draft("d1", "a"));
        book.map("env:a", "d1");
        book.park(draft("d2", "a"));
        let contents = HashMap::from([("d2".to_owned(), content("unsent idea"))]);
        let json = book
            .capture(
                None,
                &contents,
                vec![
                    ("thread-a".to_owned(), content("half a reply")),
                    ("thread-b".to_owned(), content("  ")),
                ],
            )
            .to_json()
            .expect("serializes");

        let mut restored = DraftBook::default();
        let mut loaded = SavedDrafts::from_json(&json).expect("parses");
        let threads = loaded.take_threads();
        assert_eq!(threads.len(), 1, "empty thread input is not kept");
        assert_eq!(threads[0].0, "thread-a");
        assert_eq!(threads[0].1.text, "half a reply");
        let mut restored_contents = restored.restore(loaded);
        restored_contents.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(restored_contents[1].1.text, "unsent idea");
        assert!(restored.get("d2").is_some_and(|d| !d.launching));
        assert_eq!(
            restored.take_for_project("env:a").map(|d| d.draft_id),
            Some("d1".to_owned())
        );
    }

    #[test]
    fn a_broken_or_foreign_version_file_loads_as_none() {
        assert!(SavedDrafts::from_json("not json").is_none());
        assert!(SavedDrafts::from_json(r#"{"version":99,"drafts":[],"slots":[]}"#).is_none());
        // A file from before thread input was kept has no `threads`.
        assert!(SavedDrafts::from_json(r#"{"version":1,"drafts":[],"slots":[]}"#).is_some());
    }

    #[test]
    fn the_drafts_file_is_written_through_a_temporary_file() {
        let dir = std::env::temp_dir().join(format!("conn-drafts-test-{}", new_draft_id()));
        let path = dir.join("nested/drafts.json");
        write_drafts_file(&path, "{}").expect("writes");
        assert_eq!(std::fs::read_to_string(&path).ok().as_deref(), Some("{}"));
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn draft_ids_are_distinct() {
        assert_ne!(new_draft_id(), new_draft_id());
        assert!(new_draft_id().starts_with("gpui-draft-"));
    }
}
