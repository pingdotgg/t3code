//! New-thread drafts: which draft a project's "New thread" opens, what a retarget does to the
//! draft it displaces, and which drafts outlive a restart (Conn `composerDraftStore`).
//!
//! A draft has its own id, apart from its project. The project only points at it
//! ([`ProjectDraftSlots`], Conn's `logicalProjectDraftThreadKeyByLogicalProjectKey`). A draft
//! that no project points at is an unmapped draft: it stays in the sidebar while it has content.

use std::collections::BTreeMap;

/// Key of a project on one environment (Conn `scopedProjectKey`).
#[must_use]
pub fn project_draft_key(environment_id: &str, project_id: &str) -> String {
    format!("{environment_id}:{project_id}")
}

/// The draft each project's "New thread" opens. One draft per project, and a draft sits behind
/// at most one project.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectDraftSlots {
    by_project: BTreeMap<String, String>,
}

impl ProjectDraftSlots {
    /// Rebuilds the slots from persisted `(project key, draft id)` pairs.
    #[must_use]
    pub fn from_pairs(pairs: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut slots = Self::default();
        for (project_key, draft_id) in pairs {
            slots.assign(&project_key, &draft_id);
        }
        slots
    }

    /// The draft `project_key` opens (`getDraftSessionByLogicalProjectKey`).
    #[must_use]
    pub fn draft_for(&self, project_key: &str) -> Option<&str> {
        self.by_project.get(project_key).map(String::as_str)
    }

    /// The project that points at `draft_id`, if any.
    #[must_use]
    pub fn project_of(&self, draft_id: &str) -> Option<&str> {
        self.by_project
            .iter()
            .find_map(|(project, id)| (id == draft_id).then_some(project.as_str()))
    }

    #[must_use]
    pub fn is_mapped(&self, draft_id: &str) -> bool {
        self.project_of(draft_id).is_some()
    }

    /// Points `project_key` at `draft_id` (`setLogicalProjectDraftThreadId`). The draft leaves
    /// any project it sat behind. Returns the draft that sat behind `project_key` before, now
    /// unmapped; the caller keeps or drops it ([`keeps_displaced_draft`]).
    pub fn assign(&mut self, project_key: &str, draft_id: &str) -> Option<String> {
        self.release(draft_id);
        self.by_project
            .insert(project_key.to_owned(), draft_id.to_owned())
    }

    /// Unmaps `draft_id` (`removeDraftThreadReferences`).
    pub fn release(&mut self, draft_id: &str) {
        self.by_project.retain(|_, id| id != draft_id);
    }

    /// `(project key, draft id)` pairs in project-key order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.by_project
            .iter()
            .map(|(p, d)| (p.as_str(), d.as_str()))
    }
}

/// What the hero's project picker does with the open draft (`DraftHeroHeadline` `selectProject`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Retarget {
    /// The draft is empty. It stays behind its own project, and the target project's own draft
    /// opens (`openProjectDraft`), so an empty draft never overwrites that project's draft.
    OpenProjectDraft,
    /// The draft moves to the target project. `displaced` is the draft that sat there; it
    /// becomes an unmapped draft.
    Move { displaced: Option<String> },
}

/// Applies a retarget of `draft_id` to `target_project_key` to `slots`.
pub fn retarget_draft(
    slots: &mut ProjectDraftSlots,
    draft_id: &str,
    target_project_key: &str,
    has_content: bool,
) -> Retarget {
    if !has_content {
        return Retarget::OpenProjectDraft;
    }
    Retarget::Move {
        displaced: slots.assign(target_project_key, draft_id),
    }
}

/// A displaced draft is kept, as an unmapped draft, while it holds content or a launch is in
/// flight. Otherwise it is dropped.
#[must_use]
pub fn keeps_displaced_draft(has_content: bool, launching: bool) -> bool {
    has_content || launching
}

/// Whether a draft is saved for the next start: a draft that holds content, or that a project
/// points at (it carries the project's model, mode and workspace choices). A launching draft
/// is not saved, because its launch may already have created the thread.
#[must_use]
pub fn persists_across_restart(mapped: bool, has_content: bool, launching: bool) -> bool {
    !launching && (mapped || has_content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slots(pairs: &[(&str, &str)]) -> ProjectDraftSlots {
        ProjectDraftSlots::from_pairs(
            pairs
                .iter()
                .map(|(project, draft)| ((*project).to_owned(), (*draft).to_owned())),
        )
    }

    #[test]
    fn project_keys_are_scoped_by_environment() {
        assert_eq!(project_draft_key("env", "p"), "env:p");
        assert_ne!(project_draft_key("a", "p"), project_draft_key("b", "p"));
    }

    #[test]
    fn assign_points_a_project_at_one_draft_and_reports_the_displaced_one() {
        let mut slots = ProjectDraftSlots::default();
        assert_eq!(slots.assign("env:a", "d1"), None);
        assert_eq!(slots.draft_for("env:a"), Some("d1"));
        assert_eq!(slots.project_of("d1"), Some("env:a"));
        // Pointing at the same draft again displaces nothing.
        assert_eq!(slots.assign("env:a", "d1"), None);
        // Another draft takes the slot; the first becomes unmapped.
        assert_eq!(slots.assign("env:a", "d2"), Some("d1".to_owned()));
        assert!(!slots.is_mapped("d1"));
        assert!(slots.is_mapped("d2"));
    }

    #[test]
    fn a_draft_sits_behind_one_project_at_a_time() {
        let mut slots = slots(&[("env:a", "d1"), ("env:b", "d2")]);
        assert_eq!(slots.assign("env:b", "d1"), Some("d2".to_owned()));
        assert_eq!(slots.draft_for("env:a"), None);
        assert_eq!(slots.draft_for("env:b"), Some("d1"));
        assert!(!slots.is_mapped("d2"));
        slots.release("d1");
        assert_eq!(slots.iter().count(), 0);
    }

    #[test]
    fn retargeting_a_draft_with_content_displaces_the_targets_own_draft() {
        let mut slots = slots(&[("env:a", "d1"), ("env:b", "d2")]);
        assert_eq!(
            retarget_draft(&mut slots, "d1", "env:b", true),
            Retarget::Move {
                displaced: Some("d2".to_owned())
            }
        );
        assert_eq!(slots.draft_for("env:a"), None);
        assert_eq!(slots.draft_for("env:b"), Some("d1"));
    }

    #[test]
    fn retargeting_to_a_project_without_a_draft_displaces_nothing() {
        let mut slots = slots(&[("env:a", "d1")]);
        assert_eq!(
            retarget_draft(&mut slots, "d1", "env:c", true),
            Retarget::Move { displaced: None }
        );
        assert_eq!(slots.draft_for("env:c"), Some("d1"));
    }

    #[test]
    fn an_empty_draft_never_overwrites_the_targets_draft() {
        let mut slots = slots(&[("env:a", "d1"), ("env:b", "d2")]);
        assert_eq!(
            retarget_draft(&mut slots, "d1", "env:b", false),
            Retarget::OpenProjectDraft
        );
        assert_eq!(slots, self::slots(&[("env:a", "d1"), ("env:b", "d2")]));
    }

    #[test]
    fn displaced_drafts_survive_while_they_hold_content_or_launch() {
        assert!(keeps_displaced_draft(true, false));
        assert!(keeps_displaced_draft(false, true));
        assert!(!keeps_displaced_draft(false, false));
    }

    #[test]
    fn restart_keeps_mapped_drafts_and_drafts_with_content_but_not_launching_ones() {
        assert!(persists_across_restart(true, false, false));
        assert!(persists_across_restart(false, true, false));
        assert!(!persists_across_restart(false, false, false));
        assert!(!persists_across_restart(true, true, true));
    }
}
