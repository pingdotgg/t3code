//! The composer's model chip and the model list of Conn mobile's thread settings sheet
//! (`ThreadComposer.tsx` `ComposerModelControl`, `ThreadSettingsSheet.tsx`,
//! `thread-settings-sheet-state.ts`), mapped from conn-state's thread catalog
//! (`ServerConfigState::thread_catalog`) so the SwiftUI views only draw. Which models a thread
//! may pick is conn-state's call; this module only lays them out.

use conn_contract::{ModelSelection, OrchestrationV2AppThread};
use conn_state::ThreadShell;
use conn_state::providers::{ModelCatalog, ModelOption};
use conn_state::thread_models::ThreadModelScope;

/// Drivers whose sections start expanded (`PRIMARY_PROVIDER_DRIVERS`).
const PRIMARY_DRIVERS: [&str; 3] = ["claudeAgent", "codex", "antigravity"];

/// One model row (`ModelRowContent`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiModelPickerRow {
    pub instance_id: String,
    pub model: String,
    pub label: String,
    /// The sub-provider, or empty.
    pub subtitle: String,
    pub is_default: bool,
    pub is_legacy: bool,
    /// The checkmark: the pending pick, else the thread's model.
    pub selected: bool,
}

/// One provider section: its header and, unless collapsed, its rows.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiModelPickerSection {
    pub instance_id: String,
    pub driver: String,
    pub label: String,
    pub collapsible: bool,
    pub collapsed: bool,
    pub model_count: u32,
    pub models: Vec<FfiModelPickerRow>,
}

/// The chip and the sheet for one thread.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiModelPicker {
    /// False until the server's provider list and the thread's scope (shell row or detail)
    /// arrived; the sheet shows its loading state.
    pub loaded: bool,
    /// The thread's provider driver, for the chip's icon (`ProviderIcon`).
    pub selected_driver: Option<String>,
    /// The thread's model name, for the chip's accessibility label.
    pub selected_label: Option<String>,
    pub sections: Vec<FfiModelPickerSection>,
    /// The sheet's confirm button saves (`Save`) rather than closes (`Done`).
    pub has_pending: bool,
}

/// What Save did (`commitPendingModel`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiModelSave {
    /// The thread switched to the picked model.
    Saved,
    /// The pick is the thread's model already; nothing was sent.
    Unchanged,
    /// The thread's catalog no longer offers the pick; nothing was sent and the sheet stays open.
    Unavailable,
    /// The thread's project and provider are not known yet (no shell row, no detail); nothing
    /// was sent.
    NotReady,
}

/// [`model_to_save`]'s answer: the selection to send, or why nothing is sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SaveDecision {
    Send { instance_id: String, model: String },
    Unchanged,
    Unavailable,
    NotReady,
}

impl FfiModelPicker {
    /// Nothing to offer yet: the provider list or the thread's scope is still loading.
    pub(crate) fn loading() -> Self {
        Self {
            loaded: false,
            selected_driver: None,
            selected_label: None,
            sections: Vec::new(),
            has_pending: false,
        }
    }
}

/// The thread a picker serves, read from its shell row.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PickerThread {
    pub instance_id: Option<String>,
    pub model: Option<String>,
    /// A started thread keeps its provider and continuation group.
    pub started: bool,
    pub project_id: Option<String>,
    /// The worktree, else the project's root (`useSelectedThreadWorktree`).
    pub cwd: Option<String>,
}

impl PickerThread {
    /// From the thread's shell row. `cwd` is the worktree; [`Self::or_project_root`] fills it.
    pub(crate) fn from_shell(thread: &ThreadShell) -> Self {
        Self::from_parts(
            &thread.model_selection,
            &thread.provider_instance_id,
            &thread.project_id,
            thread.worktree_path.as_deref(),
            thread.latest_run_id.is_some(),
        )
    }

    /// From the thread's detail projection, for a thread the shell does not list (opened by link,
    /// or an older settled one): it carries the project and worktree, so the project's provider
    /// switches still apply.
    pub(crate) fn from_projection(thread: &OrchestrationV2AppThread, started: bool) -> Self {
        Self::from_parts(
            &thread.model_selection,
            &thread.provider_instance_id,
            &thread.project_id,
            thread.worktree_path.as_deref(),
            started,
        )
    }

    fn from_parts(
        selection: &ModelSelection,
        provider_instance_id: &str,
        project_id: &str,
        worktree_path: Option<&str>,
        started: bool,
    ) -> Self {
        let non_empty = |value: &str| Some(value.to_owned()).filter(|value| !value.is_empty());
        Self {
            instance_id: selection
                .instance_id
                .clone()
                .flatten()
                .and_then(|value| value.as_str().map(str::to_owned))
                .or_else(|| non_empty(provider_instance_id))
                .filter(|id| !id.is_empty()),
            model: selection.model.as_str().and_then(non_empty),
            started,
            project_id: non_empty(project_id),
            cwd: worktree_path.and_then(non_empty),
        }
    }

    /// Without a worktree the thread runs in its project's root.
    pub(crate) fn or_project_root(mut self, root: impl FnOnce(&str) -> Option<String>) -> Self {
        if self.cwd.is_none() {
            self.cwd = self
                .project_id
                .as_deref()
                .and_then(root)
                .filter(|root| !root.is_empty());
        }
        self
    }

    /// The scope conn-state narrows the catalog to.
    pub(crate) fn scope(&self) -> ThreadModelScope<'_> {
        ThreadModelScope {
            project_id: self.project_id.as_deref(),
            cwd: self.cwd.as_deref(),
            locked_instance_id: self
                .started
                .then_some(self.instance_id.as_deref())
                .flatten(),
        }
    }

    fn applies(&self, model: &ModelOption) -> bool {
        self.instance_id.as_deref() == Some(model.instance_id.as_str())
            && self.model.as_deref() == Some(model.slug.as_str())
    }
}

/// The sheet's view state that lives in Swift.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PickerInput<'a> {
    pub query: &'a str,
    /// Sections the user toggled away from their default (`providerExpansionOverrides`).
    pub toggled: &'a [String],
    /// The row tapped but not saved yet, as `(instance_id, model)`.
    pub pending: Option<(&'a str, &'a str)>,
}

/// `buildThreadSettingsCatalogItems` over the thread's catalog: offered providers, minus hidden
/// models, legacy models unless picked, and anything the search misses. Favorites, filters and
/// sub-provider headers are not ported yet.
pub(crate) fn build_model_picker(
    catalog: &ModelCatalog,
    loaded: bool,
    thread: &PickerThread,
    input: &PickerInput<'_>,
) -> FfiModelPicker {
    let displayed = |m: &ModelOption| match input.pending {
        Some((instance, model)) => m.instance_id == instance && m.slug == model,
        None => thread.applies(m),
    };
    let query = input.query.trim().to_lowercase();
    let narrowed = !query.is_empty();

    let sections = catalog
        .providers
        .iter()
        .filter(|group| group.offers_models())
        .filter_map(|group| {
            let models: Vec<&ModelOption> = group
                .models
                .iter()
                .filter(|m| !catalog.is_hidden(m))
                .filter(|m| !m.is_legacy || displayed(m))
                .filter(|m| matches_query(m, &group.display_name, &query))
                .collect();
            if models.is_empty() {
                return None;
            }
            let default_expanded = PRIMARY_DRIVERS.contains(&group.driver.as_str())
                || group.models.iter().any(|m| thread.applies(m));
            let overridden = input.toggled.contains(&group.instance_id);
            let collapsed = !narrowed && (default_expanded == overridden);
            Some(FfiModelPickerSection {
                instance_id: group.instance_id.clone(),
                driver: group.driver.clone(),
                label: group.display_name.clone(),
                collapsible: !narrowed,
                collapsed,
                model_count: u32::try_from(models.len()).unwrap_or(u32::MAX),
                models: if collapsed {
                    Vec::new()
                } else {
                    models
                        .into_iter()
                        .map(|m| FfiModelPickerRow {
                            instance_id: m.instance_id.clone(),
                            model: m.slug.clone(),
                            label: m.name.clone(),
                            subtitle: m.sub_provider.clone().unwrap_or_default(),
                            is_default: m.is_default,
                            is_legacy: m.is_legacy,
                            selected: displayed(m),
                        })
                        .collect()
                },
            })
        })
        .collect();

    let selected_driver = thread
        .instance_id
        .as_deref()
        .and_then(|id| catalog.driver_for_instance(id))
        .map(str::to_owned);
    let selected_label = thread.model.as_deref().map(|slug| {
        catalog
            .find_model(thread.instance_id.as_deref(), slug)
            .map_or_else(|| slug.to_owned(), |m| m.name.clone())
    });
    let has_pending = input.pending.is_some_and(|(instance, model)| {
        thread.instance_id.as_deref() != Some(instance) || thread.model.as_deref() != Some(model)
    });

    FfiModelPicker {
        loaded,
        selected_driver,
        selected_label,
        sections,
        has_pending,
    }
}

/// `commitPendingModel`: Save sends the pick only while the thread's catalog offers it.
pub(crate) fn model_to_save(
    catalog: &ModelCatalog,
    thread: &PickerThread,
    instance_id: &str,
    model: &str,
) -> SaveDecision {
    if thread.instance_id.as_deref() == Some(instance_id) && thread.model.as_deref() == Some(model)
    {
        SaveDecision::Unchanged
    } else if catalog.offers(instance_id, model) {
        SaveDecision::Send {
            instance_id: instance_id.to_owned(),
            model: model.to_owned(),
        }
    } else {
        SaveDecision::Unavailable
    }
}

/// `modelMatchesCatalogQuery`: label, sub-provider, slug or provider name.
fn matches_query(model: &ModelOption, provider_label: &str, query: &str) -> bool {
    query.is_empty()
        || [
            model.name.as_str(),
            model.sub_provider.as_deref().unwrap_or_default(),
            model.slug.as_str(),
            provider_label,
        ]
        .iter()
        .any(|value| value.to_lowercase().contains(query))
}

#[cfg(test)]
mod tests {
    use conn_contract::ServerProvidersItemItem;
    use serde_json::{Value, json};

    use super::*;

    fn provider(
        id: &str,
        driver: &str,
        name: &str,
        models: Value,
    ) -> Option<ServerProvidersItemItem> {
        let value = json!({
            "instanceId": id,
            "driver": driver,
            "displayName": name,
            "enabled": true,
            "installed": true,
            "status": "ready",
            "auth": { "status": "authenticated" },
            "checkedAt": "2026-11-24T00:00:00Z",
            "models": models,
        });
        Some(serde_json::from_value(value).expect("provider decodes"))
    }

    fn catalog() -> ModelCatalog {
        ModelCatalog::from_providers(&[
            provider(
                "claudeAgent",
                "claudeAgent",
                "Claude",
                json!([
                    { "slug": "sonnet", "name": "Claude Sonnet 4.5", "isCustom": false, "isDefault": true },
                    { "slug": "opus-3", "name": "Claude Opus 3", "isCustom": false, "isLegacy": true },
                ]),
            ),
            provider(
                "grok",
                "grok",
                "Grok",
                json!([{ "slug": "grok-build", "name": "Grok Build", "isCustom": false }]),
            ),
        ])
    }

    fn thread(instance: &str, model: &str) -> PickerThread {
        PickerThread {
            instance_id: Some(instance.to_owned()),
            model: Some(model.to_owned()),
            ..PickerThread::default()
        }
    }

    #[test]
    fn primary_sections_open_and_others_fold_until_toggled() {
        let claude = thread("claudeAgent", "sonnet");
        let picker = build_model_picker(&catalog(), true, &claude, &PickerInput::default());
        assert_eq!(
            picker.selected_driver.as_deref(),
            Some("claudeAgent"),
            "chip icon follows the instance"
        );
        assert_eq!(
            picker.selected_label.as_deref(),
            Some("Claude Sonnet 4.5"),
            "chip names the model"
        );
        let first = &picker.sections[0];
        assert!(!first.collapsed, "a primary driver starts expanded");
        assert_eq!(
            first.models.len(),
            1,
            "legacy models stay out unless selected"
        );
        assert!(
            first.models[0].selected && first.models[0].is_default,
            "the applied model is checked"
        );
        let grok = &picker.sections[1];
        assert!(
            grok.collapsed && grok.models.is_empty(),
            "other drivers start folded"
        );
        assert_eq!(
            grok.model_count, 1,
            "a folded section still counts its models"
        );

        let toggled = ["grok".to_owned()];
        let input = PickerInput {
            toggled: &toggled,
            ..PickerInput::default()
        };
        let opened = build_model_picker(&catalog(), true, &claude, &input);
        assert!(
            !opened.sections[1].collapsed,
            "a toggle opens a folded section"
        );
    }

    #[test]
    fn pending_pick_moves_the_check_and_search_opens_everything() {
        let input = PickerInput {
            query: " build ",
            pending: Some(("grok", "grok-build")),
            ..PickerInput::default()
        };
        let picker = build_model_picker(&catalog(), true, &thread("claudeAgent", "sonnet"), &input);
        assert!(
            picker.has_pending,
            "a pick that differs from the thread is pending"
        );
        assert_eq!(
            picker.sections.len(),
            1,
            "search keeps only matching sections"
        );
        let grok = &picker.sections[0];
        assert!(
            !grok.collapsible && !grok.collapsed,
            "a search shows every match"
        );
        assert!(
            grok.models[0].selected,
            "the pending pick carries the check"
        );
    }

    #[test]
    fn save_sends_only_a_model_the_catalog_still_offers() {
        let claude = thread("claudeAgent", "sonnet");
        assert_eq!(
            model_to_save(&catalog(), &claude, "grok", "grok-build"),
            SaveDecision::Send {
                instance_id: "grok".to_owned(),
                model: "grok-build".to_owned()
            },
            "an offered pick is sent"
        );
        assert_eq!(
            model_to_save(&catalog(), &claude, "claudeAgent", "sonnet"),
            SaveDecision::Unchanged,
            "the thread's own model sends nothing"
        );
        // The pick was offered when tapped, then the provider dropped it before Save.
        let after = ModelCatalog::from_providers(&[
            provider(
                "claudeAgent",
                "claudeAgent",
                "Claude",
                json!([{ "slug": "sonnet", "name": "Claude Sonnet 4.5", "isCustom": false }]),
            ),
            provider("grok", "grok", "Grok", json!([])),
        ]);
        assert_eq!(
            model_to_save(&after, &claude, "grok", "grok-build"),
            SaveDecision::Unavailable,
            "a model removed between select and Save is not sent"
        );
    }

    #[test]
    fn the_scope_locks_a_started_thread_to_its_provider() {
        let started = PickerThread {
            started: true,
            project_id: Some("p".to_owned()),
            cwd: Some("/w".to_owned()),
            ..thread("codex", "gpt")
        };
        let scope = started.scope();
        assert_eq!(
            scope.locked_instance_id,
            Some("codex"),
            "a started thread is locked"
        );
        assert_eq!(
            (scope.project_id, scope.cwd),
            (Some("p"), Some("/w")),
            "project and cwd pass through"
        );
        assert_eq!(
            thread("codex", "gpt").scope().locked_instance_id,
            None,
            "a new thread may switch"
        );
    }
}
