//! Conn-styled floating model picker (`ProviderModelPicker` / `ModelPickerContent` parity).
//!
//! Populated from `server.getConfig` (`conn_contract::ServerConfig.providers`).
//! Renders as a floating `dropdown-glass` surface (`12px` radius, `shell_overlay` fill,
//! `glass_divider` 1px border, `8px` row radius, `shell_highlight` hover).

use conn_contract::{
    ServerConfig, ServerProviderState, ServerProvidersItemItem, ServerProvidersItemItemModelsItem,
    ServerProvidersItemItemModelsItemCapabilitiesOptionDescriptorsItem as OptionDescriptor,
};
use conn_theme::Tokens;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, Entity, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use super::super::color::{hsla, hsla_alpha};
use super::super::icons;
use super::Composer;
use super::actions::FollowUpBehavior;
use super::footer::{
    RuntimeModeOption, popover_surface, render_permissions_section, runtime_mode_option,
};
use super::menus::SkillEntry;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// Popup corner radius matching Conn's `rounded-xl` (`12px`) on `dropdown-glass`.
const PICKER_RADIUS_PX: f32 = 12.0;
/// Row corner radius matching Conn's `rounded-lg` (`8px`).
const PICKER_ROW_RADIUS_PX: f32 = 8.0;
/// Popup width matching `max-w-90` (`360px`).
const PICKER_WIDTH_PX: f32 = 360.0;
/// Fixed docked popup height matching `h-86.5` (`346px`).
const PICKER_MAX_HEIGHT_PX: f32 = 346.0;
/// Left provider sidebar width matching `w-11` (`44px`).
const SIDEBAR_WIDTH_PX: f32 = 44.0;
/// Docked effort column width (`w-48`).
const EFFORT_COLUMN_WIDTH_PX: f32 = 192.0;
/// Superheroicons concepts for `ZapIcon` and `ListPlus`.
const ICON_FAST: &str = "superhero/fast.svg";
const ICON_QUEUE: &str = "superhero/list-add.svg";

/// Superheroicons 16/solid paths used by the model picker.
pub(super) const ICON_SEARCH: &str = "superhero/search.svg";
pub(super) const ICON_CHECK: &str = "superhero/check.svg";

/// Reasoning ids (`REASONING_EFFORT_OPTION_IDS` + `"thinking"`).
const REASONING_DESCRIPTOR_IDS: [&str; 7] = [
    "reasoningEffort",
    "effort",
    "reasoning",
    "variant",
    "reasoning_effort",
    "thinking_level",
    "thinking",
];

/// One choice of a select option descriptor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SelectChoice {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) description: Option<String>,
    pub(crate) is_default: bool,
}

/// A model option descriptor (`ProviderOptionDescriptor`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ModelOptionDescriptor {
    Select {
        id: String,
        label: String,
        choices: Vec<SelectChoice>,
        current_value: Option<String>,
        prompt_injected: Vec<String>,
        reasoning_role: bool,
    },
    Boolean {
        id: String,
        label: String,
        current_value: Option<bool>,
    },
}

impl ModelOptionDescriptor {
    /// Descriptor id.
    #[must_use]
    pub(crate) fn id(&self) -> &str {
        match self {
            Self::Select { id, .. } | Self::Boolean { id, .. } => id,
        }
    }

    /// Descriptor label.
    #[must_use]
    pub(crate) fn label(&self) -> &str {
        match self {
            Self::Select { label, .. } | Self::Boolean { label, .. } => label,
        }
    }

    /// `isReasoningControl`.
    #[must_use]
    pub(crate) fn is_reasoning(&self) -> bool {
        matches!(
            self,
            Self::Select {
                reasoning_role: true,
                ..
            }
        ) || REASONING_DESCRIPTOR_IDS.contains(&self.id())
    }

    /// `selectableProviderOptionChoices`: choices minus prompt-injected values.
    #[must_use]
    pub(crate) fn selectable_choices(&self) -> Vec<&SelectChoice> {
        match self {
            Self::Select {
                choices,
                prompt_injected,
                ..
            } => choices
                .iter()
                .filter(|c| !prompt_injected.contains(&c.id))
                .collect(),
            Self::Boolean { .. } => Vec::new(),
        }
    }

    /// Current select value: the user's pick, the server's current value, the default, or the
    /// first choice.
    #[must_use]
    pub(crate) fn select_value<'a>(&'a self, selected: Option<&'a OptionMap>) -> Option<&'a str> {
        let Self::Select {
            id,
            choices,
            current_value,
            ..
        } = self
        else {
            return None;
        };
        selected
            .and_then(|opts| opts.get(id))
            .and_then(serde_json::Value::as_str)
            .or(current_value.as_deref())
            .or_else(|| choices.iter().find(|c| c.is_default).map(|c| c.id.as_str()))
            .or_else(|| choices.first().map(|c| c.id.as_str()))
    }

    /// Current boolean value.
    #[must_use]
    pub(crate) fn bool_value(&self, selected: Option<&OptionMap>) -> bool {
        let Self::Boolean {
            id, current_value, ..
        } = self
        else {
            return false;
        };
        selected
            .and_then(|opts| opts.get(id))
            .and_then(serde_json::Value::as_bool)
            .or(*current_value)
            .unwrap_or(false)
    }

    /// `getProviderOptionCurrentLabel`.
    #[must_use]
    pub(crate) fn current_label(&self, selected: Option<&OptionMap>) -> Option<String> {
        match self {
            Self::Select { choices, .. } => {
                let value = self.select_value(selected)?;
                choices
                    .iter()
                    .find(|c| c.id == value)
                    .map(|c| c.label.clone())
            }
            Self::Boolean { label, .. } => Some(format!(
                "{label} {}",
                if self.bool_value(selected) {
                    "On"
                } else {
                    "Off"
                }
            )),
        }
    }
}

/// User-selected model options (`modelSelection.options`).
pub(crate) type OptionMap = serde_json::Map<String, serde_json::Value>;

/// The docked effort column's controls (`columnControls` + `splitSpeed`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ColumnControls<'a> {
    /// Codex `serviceTier` select shown as the footer speed control.
    pub(crate) speed_select: Option<&'a ModelOptionDescriptor>,
    /// Claude `fastMode` boolean shown as the footer speed control.
    pub(crate) fast_toggle: Option<&'a ModelOptionDescriptor>,
    /// The reasoning control listed under the column header.
    pub(crate) effort: Option<&'a ModelOptionDescriptor>,
    /// Other selects and switches below the levels.
    pub(crate) others: Vec<&'a ModelOptionDescriptor>,
}

/// What the trigger shows after the model name (`describeComposerEffort`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct EffortSummary {
    /// Effort word (`effortDisplay = "label"`, Conn's default).
    pub(crate) word: Option<String>,
    /// `Fast` / `Ultrafast` bolt.
    pub(crate) speed: Option<&'static str>,
    /// Secondary context window label (e.g. `1M`).
    pub(crate) context_window: Option<String>,
    /// Joined trait labels for the tooltip (`buildTraitsTriggerDisplay.label`).
    pub(crate) detail: Option<String>,
}

/// One selectable model belonging to a provider instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModelOption {
    pub(crate) instance_id: String,
    pub(crate) driver: String,
    pub(crate) provider_display_name: String,
    pub(crate) slug: String,
    pub(crate) name: String,
    pub(crate) short_name: Option<String>,
    pub(crate) sub_provider: Option<String>,
    pub(crate) is_default: bool,
    pub(crate) is_legacy: bool,
    pub(crate) is_new: bool,
    pub(crate) descriptors: Vec<ModelOptionDescriptor>,
}

impl ModelOption {
    /// Compact trigger label (`getTriggerDisplayModelName`): `"Gemini 4 Neon"` -> `"4 Neon"`,
    /// `"Claude Sonnet 4.6"` -> `"Sonnet 4.6"`, `"GPT-5.4"` stays.
    #[must_use]
    pub(crate) fn trigger_label(&self) -> String {
        let short = self
            .short_name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .or_else(|| model_short_name(&self.name, native_model_families(&self.driver)));
        strip_leading_qualifier(
            short.as_deref().unwrap_or(&self.name),
            self.sub_provider.as_deref(),
        )
    }

    /// Full display label (`getDisplayModelName`).
    #[must_use]
    pub(crate) fn display_label(&self) -> String {
        strip_leading_qualifier(&self.name, self.sub_provider.as_deref())
    }

    /// `columnControls(provider, selects, toggles)`.
    #[must_use]
    pub(crate) fn column_controls(&self) -> ColumnControls<'_> {
        let speed_select = (self.driver == "codex")
            .then(|| {
                self.descriptors.iter().find(|d| {
                    d.id() == "serviceTier" && matches!(d, ModelOptionDescriptor::Select { .. })
                })
            })
            .flatten();
        let fast_toggle = self
            .descriptors
            .iter()
            .find(|d| d.id() == "fastMode" && matches!(d, ModelOptionDescriptor::Boolean { .. }));
        let is_speed = |d: &&ModelOptionDescriptor| {
            speed_select.is_some_and(|s| std::ptr::eq(s, *d))
                || fast_toggle.is_some_and(|f| std::ptr::eq(f, *d))
        };
        // Selects first, then switches (`columnSelects`, `columnToggles`).
        let mut controls: Vec<&ModelOptionDescriptor> = self
            .descriptors
            .iter()
            .filter(|d| matches!(d, ModelOptionDescriptor::Select { .. }) && !is_speed(d))
            .collect();
        controls.extend(
            self.descriptors
                .iter()
                .filter(|d| matches!(d, ModelOptionDescriptor::Boolean { .. }) && !is_speed(d)),
        );
        let effort = controls.iter().copied().find(|d| d.is_reasoning());
        let others = controls
            .into_iter()
            .filter(|d| effort.is_none_or(|e| !std::ptr::eq(e, *d)))
            .collect();
        ColumnControls {
            speed_select,
            fast_toggle,
            effort,
            others,
        }
    }

    /// The speed label (`Fast` / `Ultrafast`) when a speed option is on.
    #[must_use]
    pub(crate) fn speed_label(&self, selected: Option<&OptionMap>) -> Option<&'static str> {
        let controls = self.column_controls();
        if let Some(fast) = controls.fast_toggle {
            return fast.bool_value(selected).then_some("Fast");
        }
        let speed = controls.speed_select?;
        let value = speed.select_value(selected)?;
        let ModelOptionDescriptor::Select { choices, .. } = speed else {
            return None;
        };
        let current = choices.iter().find(|c| c.id == value)?;
        match current.label.as_str() {
            "Ultrafast" => Some("Ultrafast"),
            "Fast" => Some("Fast"),
            _ => None,
        }
    }

    /// `describeComposerEffort` with `effortDisplay = "label"`.
    #[must_use]
    pub(crate) fn effort_summary(&self, selected: Option<&OptionMap>) -> EffortSummary {
        let controls = self.column_controls();
        let speed = self.speed_label(selected);
        let word = controls.effort.and_then(|d| d.current_label(selected));
        let context_window = self
            .descriptors
            .iter()
            .find(|d| d.id() == "contextWindow")
            .and_then(|d| d.current_label(selected));
        let mut labels: Vec<String> = Vec::new();
        let mut reasoning_index = None;
        for descriptor in &self.descriptors {
            if controls
                .fast_toggle
                .is_some_and(|f| std::ptr::eq(f, descriptor))
                || controls
                    .speed_select
                    .is_some_and(|s| std::ptr::eq(s, descriptor))
            {
                continue;
            }
            if let Some(label) = descriptor.current_label(selected).filter(|l| !l.is_empty()) {
                if reasoning_index.is_none()
                    && descriptor.is_reasoning()
                    && matches!(descriptor, ModelOptionDescriptor::Select { .. })
                {
                    reasoning_index = Some(labels.len());
                }
                labels.push(label);
            }
        }
        if let Some(speed) = speed {
            match reasoning_index {
                Some(index) => labels[index] = format!("{} {speed}", labels[index]),
                None => labels.push(speed.to_owned()),
            }
        }
        let detail = if labels.is_empty() {
            (controls.fast_toggle.is_some() || controls.speed_select.is_some())
                .then(|| speed.unwrap_or("Normal").to_owned())
        } else {
            Some(labels.join(" · "))
        };
        EffortSummary {
            word,
            speed,
            context_window,
            detail,
        }
    }
}

/// Native model families per driver (`providerClients` `modelFamilies`).
fn native_model_families(driver: &str) -> &'static [&'static str] {
    match driver {
        "codex" => &["GPT-", "GPT "],
        "claudeAgent" => &["Claude "],
        "antigravity" => &["Gemini "],
        "cursor" | "grok" => &["Grok "],
        "muse" => &["Muse "],
        _ => &[],
    }
}

const FAMILY_PREFIXES: [&str; 6] = ["Claude ", "GPT-", "GPT ", "Gemini ", "Muse ", "Grok "];
const VARIANT_WORDS: [&str; 29] = [
    "pro",
    "flash",
    "mini",
    "max",
    "lite",
    "nano",
    "ultra",
    "plus",
    "fast",
    "turbo",
    "preview",
    "latest",
    "thinking",
    "reasoning",
    "build",
    "code",
    "image",
    "vision",
    "audio",
    "live",
    "custom",
    "tools",
    "exp",
    "experimental",
    "chat",
    "tts",
    "stt",
    "non",
    "transcribe",
];

/// `VERSION = /^v?\d+(?:\.\d+)*[a-z]?$/i`.
fn is_version_word(word: &str) -> bool {
    let word = word
        .strip_prefix(['v', 'V'])
        .filter(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
        .unwrap_or(word);
    let word = match word.char_indices().last() {
        Some((idx, c)) if c.is_ascii_alphabetic() => &word[..idx],
        _ => word,
    };
    !word.is_empty()
        && word
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// Words that are not versions, ignoring parenthesized text (`nonVersionWords`).
fn non_version_words(text: &str) -> Vec<String> {
    let mut depth = 0_u32;
    let cleaned: String = text
        .chars()
        .map(|c| match c {
            '(' => {
                depth += 1;
                ' '
            }
            ')' => {
                depth = depth.saturating_sub(1);
                ' '
            }
            _ if depth > 0 => ' ',
            _ => c,
        })
        .collect();
    cleaned
        .split(|c: char| c.is_whitespace() || c == '-')
        .filter(|w| !w.is_empty() && !is_version_word(w))
        .map(str::to_owned)
        .collect()
}

fn names_model(text: &str) -> bool {
    non_version_words(text)
        .iter()
        .any(|word| !VARIANT_WORDS.contains(&word.to_ascii_lowercase().as_str()))
}

/// Strips a leading `Vendor: ` prefix (`VENDOR_PREFIX`).
fn strip_vendor_prefix(name: &str) -> &str {
    let Some((vendor, rest)) = name.split_once(": ") else {
        return name;
    };
    let valid_vendor = vendor.len() <= 25
        && vendor.starts_with(|c: char| c.is_ascii_uppercase())
        && vendor.chars().all(|c| {
            c.is_alphanumeric() || c == '_' || c == '.' || c == '&' || c == '-' || c == ' '
        });
    if valid_vendor && rest.starts_with(|c: char| !c.is_whitespace()) {
        rest
    } else {
        name
    }
}

/// `modelShortName(name, nativeFamilies)`.
#[must_use]
pub(crate) fn model_short_name(name: &str, native_families: &[&str]) -> Option<String> {
    let unprefixed = strip_vendor_prefix(name);
    let without_family = FAMILY_PREFIXES
        .iter()
        .find(|prefix| unprefixed.starts_with(*prefix))
        .and_then(|prefix| {
            let rest = unprefixed[prefix.len()..].trim();
            let keep = if native_families.contains(prefix) {
                !non_version_words(rest).is_empty()
            } else {
                names_model(rest)
            };
            keep.then(|| {
                if rest.contains(char::is_whitespace) {
                    rest.to_owned()
                } else {
                    rest.replace('-', " ")
                }
            })
        });
    let short = without_family.unwrap_or_else(|| {
        if names_model(unprefixed) {
            unprefixed.to_owned()
        } else {
            name.to_owned()
        }
    });
    (short != name).then_some(short)
}

/// `stripLeadingQualifier(value, subProvider)`.
fn strip_leading_qualifier(value: &str, qualifier: Option<&str>) -> String {
    let Some(qualifier) = qualifier.map(str::trim).filter(|q| !q.is_empty()) else {
        return value.to_owned();
    };
    let lower_value = value.to_lowercase();
    let lower_qualifier = qualifier.to_lowercase();
    if !lower_value.starts_with(&lower_qualifier) || value.len() < qualifier.len() {
        return value.to_owned();
    }
    let rest = &value[qualifier.len()..];
    let trimmed = rest.trim_start();
    let had_space = trimmed.len() != rest.len();
    let after_sep = trimmed
        .strip_prefix(['.', ':', '/', '-'])
        .map(str::trim_start);
    let stripped = match after_sep {
        Some(after) => after,
        None if had_space => trimmed,
        None => return value.to_owned(),
    };
    let stripped = stripped.trim();
    if stripped.is_empty() {
        value.to_owned()
    } else {
        stripped.to_owned()
    }
}

/// One provider instance group returned by `server.getConfig`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderGroup {
    pub(crate) instance_id: String,
    pub(crate) driver: String,
    pub(crate) display_name: String,
    pub(crate) enabled: bool,
    pub(crate) ready: bool,
    pub(crate) models: Vec<ModelOption>,
    /// User-invocable provider skills for the `$` menu.
    pub(crate) skills: Vec<SkillEntry>,
    /// Runtime modes the provider supports (empty: all).
    pub(crate) supported_runtime_modes: Vec<String>,
    /// True when the provider advertises `/compact` (`providerSupportsManualCompaction`).
    pub(crate) supports_compact: bool,
}

/// Parsed provider and model catalog from `server.getConfig`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ModelCatalog {
    pub(crate) providers: Vec<ProviderGroup>,
}

impl ModelCatalog {
    /// Builds a [`ModelCatalog`] from a typed `conn_contract::ServerConfig`.
    #[must_use]
    pub(crate) fn from_server_config(config: &ServerConfig) -> Self {
        Self::from_providers(&config.providers)
    }

    /// Builds a [`ModelCatalog`] from `ServerConfig::providers`.
    #[must_use]
    pub(crate) fn from_providers(providers: &[Option<ServerProvidersItemItem>]) -> Self {
        let mut groups = Vec::new();
        for item in providers.iter().flatten() {
            if !item.enabled && item.models.is_empty() {
                continue;
            }
            let display_name = item
                .display_name
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format_driver_name(&item.driver));
            let ready =
                item.enabled && item.installed && matches!(item.status, ServerProviderState::Ready);
            let models = item
                .models
                .iter()
                .map(|m| model_option_from_contract(item, &display_name, m))
                .collect();
            let skills = item
                .skills
                .iter()
                .flatten()
                .filter_map(SkillEntry::from_contract)
                .collect();
            let supported_runtime_modes = item
                .supported_runtime_modes
                .iter()
                .flatten()
                .flatten()
                .filter_map(|mode| conn_contract::to_json(mode).as_str().map(str::to_owned))
                .collect();
            let supports_compact = item
                .slash_commands
                .iter()
                .flatten()
                .any(|command| command.name == "compact");
            groups.push(ProviderGroup {
                instance_id: item.instance_id.clone(),
                driver: item.driver.clone(),
                display_name,
                enabled: item.enabled,
                ready,
                models,
                skills,
                supported_runtime_modes,
                supports_compact,
            });
        }
        Self { providers: groups }
    }

    /// Returns the preferred default model across available providers:
    /// first ready provider's `is_default` model, else first model of a ready provider,
    /// else any `is_default` model, else the very first model in the catalog.
    #[must_use]
    pub(crate) fn default_model(&self) -> Option<&ModelOption> {
        self.providers
            .iter()
            .filter(|p| p.ready)
            .flat_map(|p| p.models.iter())
            .find(|m| m.is_default)
            .or_else(|| {
                self.providers
                    .iter()
                    .filter(|p| p.ready)
                    .flat_map(|p| p.models.iter())
                    .next()
            })
            .or_else(|| {
                self.providers
                    .iter()
                    .flat_map(|p| p.models.iter())
                    .find(|m| m.is_default)
            })
            .or_else(|| self.providers.iter().flat_map(|p| p.models.iter()).next())
    }

    /// Looks up a model by `(instance_id, slug)` or by `slug` / short alias alone.
    #[must_use]
    pub(crate) fn find_model(
        &self,
        instance_id: Option<&str>,
        model_slug: &str,
    ) -> Option<&ModelOption> {
        let exact = |m: &&ModelOption| m.slug == model_slug || m.name == model_slug;
        if let Some(id) = instance_id
            && let Some(group) = self.providers.iter().find(|p| p.instance_id == id)
            && let Some(found) = group.models.iter().find(exact)
        {
            return Some(found);
        }
        if let Some(found) = self
            .providers
            .iter()
            .flat_map(|p| p.models.iter())
            .find(exact)
        {
            return Some(found);
        }
        let needle = model_slug.trim().to_ascii_lowercase();
        if needle.is_empty() {
            return None;
        }
        let alias = |m: &&ModelOption| {
            m.short_name
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case(&needle))
                || m.slug.to_ascii_lowercase().contains(&needle)
        };
        if let Some(id) = instance_id
            && let Some(group) = self.providers.iter().find(|p| p.instance_id == id)
            && let Some(found) = group.models.iter().find(alias)
        {
            return Some(found);
        }
        self.providers
            .iter()
            .flat_map(|p| p.models.iter())
            .find(alias)
    }

    /// Returns the models visible for the active provider tab and search query.
    ///
    /// When `query` is non-empty, searches across all providers (matching `ModelPickerContent.tsx`).
    /// When `query` is empty, filters to `selected_provider` (or all providers if `None`).
    #[must_use]
    pub(crate) fn filtered_models(
        &self,
        selected_provider: Option<&str>,
        query: &str,
    ) -> Vec<&ModelOption> {
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            let needle = trimmed.to_ascii_lowercase();
            return self
                .providers
                .iter()
                .flat_map(|p| p.models.iter())
                .filter(|m| {
                    m.name.to_ascii_lowercase().contains(&needle)
                        || m.slug.to_ascii_lowercase().contains(&needle)
                        || m.provider_display_name
                            .to_ascii_lowercase()
                            .contains(&needle)
                        || m.sub_provider
                            .as_deref()
                            .is_some_and(|sp| sp.to_ascii_lowercase().contains(&needle))
                })
                .collect();
        }

        if let Some(id) = selected_provider
            && let Some(group) = self.providers.iter().find(|p| p.instance_id == id)
        {
            return group.models.iter().collect();
        }

        self.providers
            .iter()
            .flat_map(|p| p.models.iter())
            .collect()
    }
}

fn model_option_from_contract(
    provider: &ServerProvidersItemItem,
    display_name: &str,
    model: &ServerProvidersItemItemModelsItem,
) -> ModelOption {
    let descriptors = model
        .capabilities
        .as_ref()
        .and_then(|caps| caps.option_descriptors.as_deref())
        .unwrap_or_default()
        .iter()
        .filter_map(|desc| match desc {
            OptionDescriptor::Select(sel) if !sel.options.is_empty() => {
                Some(ModelOptionDescriptor::Select {
                    id: sel.id.clone(),
                    label: sel.label.clone(),
                    choices: sel
                        .options
                        .iter()
                        .map(|o| SelectChoice {
                            id: o.id.clone(),
                            label: o.label.clone(),
                            description: o.description.clone(),
                            is_default: o.is_default == Some(true),
                        })
                        .collect(),
                    current_value: sel.current_value.clone(),
                    prompt_injected: sel.prompt_injected_values.clone().unwrap_or_default(),
                    reasoning_role: sel.role.is_some(),
                })
            }
            OptionDescriptor::Boolean(b) => Some(ModelOptionDescriptor::Boolean {
                id: b.id.clone(),
                label: b.label.clone(),
                current_value: b.current_value,
            }),
            _ => None,
        })
        .collect();
    ModelOption {
        instance_id: provider.instance_id.clone(),
        driver: provider.driver.clone(),
        provider_display_name: display_name.to_owned(),
        slug: model.slug.clone(),
        name: model.name.clone(),
        short_name: model.short_name.clone(),
        sub_provider: model.sub_provider.clone(),
        is_default: model.is_default.unwrap_or(false),
        is_legacy: model.is_legacy.unwrap_or(false),
        is_new: model.badge.is_some(),
        descriptors,
    }
}

fn format_driver_name(driver: &str) -> String {
    match driver {
        "claudeAgent" => "Claude".to_owned(),
        "codex" => "Codex".to_owned(),
        "antigravity" => "Antigravity".to_owned(),
        "opencode" => "OpenCode".to_owned(),
        other => other.to_owned(),
    }
}

/// Parameters for rendering the docked model picker popup.
pub(super) struct ModelPickerView<'a> {
    pub(super) catalog: &'a ModelCatalog,
    pub(super) loading: bool,
    pub(super) error: Option<&'a str>,
    pub(super) active_instance_id: Option<&'a str>,
    pub(super) active_model: &'a str,
    pub(super) selected_provider: Option<&'a str>,
    pub(super) search_input: &'a Entity<InputState>,
    pub(super) query: &'a str,
    pub(super) highlighted_index: usize,
    pub(super) tokens: &'a Tokens,
    /// The selected model, whose levels the effort column lists.
    pub(super) selected: Option<&'a ModelOption>,
    pub(super) selected_options: Option<&'a OptionMap>,
    pub(super) runtime_mode: &'a str,
    pub(super) runtime_options: &'a [RuntimeModeOption],
    pub(super) permissions_open: bool,
    pub(super) permission_preview: Option<&'static str>,
    pub(super) follow_up: FollowUpBehavior,
}

/// Renders Conn's docked model picker: model list, effort column (`w-48`), and picker footer.
pub(super) fn render_model_picker(
    view: &ModelPickerView<'_>,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let tokens = view.tokens;
    let glass_bg = hsla(tokens.shell_overlay);
    let glass_divider = hsla(tokens.glass_divider);
    let highlight_bg = hsla(tokens.shell_highlight);
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);

    let is_searching = !view.query.trim().is_empty();
    let show_sidebar = !is_searching && view.catalog.providers.len() > 1;
    let effective_provider = view
        .selected_provider
        .or(view.active_instance_id)
        .or_else(|| {
            view.catalog
                .providers
                .first()
                .map(|p| p.instance_id.as_str())
        });
    let models = view.catalog.filtered_models(effective_provider, view.query);

    let mut content = div()
        .flex()
        .flex_row()
        .flex_none()
        .w(px(PICKER_WIDTH_PX))
        .h(px(PICKER_MAX_HEIGHT_PX))
        .overflow_hidden();

    if show_sidebar {
        let mut rail = div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(SIDEBAR_WIDTH_PX))
            .p(px(4.0))
            .gap(px(4.0))
            .border_r_1()
            .border_color(glass_divider)
            .bg(hsla_alpha(tokens.muted, 0.30));

        for provider in &view.catalog.providers {
            let is_selected = effective_provider == Some(provider.instance_id.as_str());
            let provider_id = provider.instance_id.clone();
            let icon_color = if is_selected { fg } else { muted };
            let mut btn = div()
                .id(SharedString::from(format!(
                    "model-picker-provider-{}",
                    provider.instance_id
                )))
                .relative()
                .flex()
                .items_center()
                .justify_center()
                .w_full()
                .h(px(36.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .hover(move |s| s.bg(highlight_bg))
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.select_picker_provider(provider_id.clone(), cx);
                }))
                .child(crate::icons::provider_mark(
                    &provider.driver,
                    18.0,
                    icon_color,
                ));

            if is_selected {
                btn = btn.child(
                    div()
                        .absolute()
                        .right(px(0.0))
                        .w(px(3.0))
                        .h(px(20.0))
                        .rounded_full()
                        .bg(hsla(tokens.primary)),
                );
            }
            rail = rail.child(btn);
        }
        content = content.child(rail);
    }

    let search_row = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .px(px(10.0))
        .py(px(8.0))
        .border_b_1()
        .border_color(glass_divider)
        .child(icons::icon(ICON_SEARCH, 14.0, muted))
        .child(
            div().flex_1().min_w_0().child(
                Input::new(view.search_input)
                    .appearance(false)
                    .pl(px(0.0))
                    .text_size(px(13.0))
                    .line_height(px(20.0)),
            ),
        );

    let mut list = div()
        .id("model-picker-list")
        .flex()
        .flex_col()
        .gap(px(2.0))
        .p(px(6.0))
        .flex_1()
        .min_h_0()
        .overflow_y_scroll();

    if view.loading && models.is_empty() {
        list = list.child(
            div()
                .px(px(10.0))
                .py(px(14.0))
                .text_size(px(13.0))
                .line_height(px(20.0))
                .text_color(muted)
                .child("Loading models..."),
        );
    } else if let Some(err) = view.error
        && models.is_empty()
    {
        list = list.child(
            div()
                .px(px(10.0))
                .py(px(14.0))
                .text_size(px(13.0))
                .line_height(px(20.0))
                .text_color(hsla(tokens.destructive))
                .child(err.to_owned()),
        );
    } else if models.is_empty() {
        list = list.child(
            div()
                .px(px(10.0))
                .py(px(14.0))
                .text_size(px(13.0))
                .line_height(px(20.0))
                .text_color(muted)
                .child("No models found"),
        );
    } else {
        for (idx, model) in models.iter().enumerate() {
            let is_active = model.slug == view.active_model
                && view
                    .active_instance_id
                    .is_none_or(|id| id == model.instance_id);
            let is_highlighted = idx == view.highlighted_index;
            let instance_id = model.instance_id.clone();
            let slug = model.slug.clone();

            let mut row = div()
                .id(SharedString::from(format!(
                    "model-picker-row-{}-{}",
                    model.instance_id, model.slug
                )))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .w_full()
                .min_w_0()
                .px(px(8.0))
                .py(px(6.0))
                .rounded(px(PICKER_ROW_RADIUS_PX))
                .cursor_pointer()
                .hover(move |s| s.bg(highlight_bg))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.pick_model(instance_id.clone(), slug.clone(), cx);
                }))
                .child(crate::icons::provider_mark(
                    &model.driver,
                    16.0,
                    if is_active { fg } else { muted },
                ));

            if is_highlighted {
                row = row.bg(highlight_bg);
            }

            let mut label_group = div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.0))
                        .line_height(px(20.0))
                        .font_weight(if is_active {
                            FontWeight::MEDIUM
                        } else {
                            FontWeight::NORMAL
                        })
                        .text_color(fg)
                        .child(model.display_label()),
                );

            if let Some(sub) = model.sub_provider.as_deref() {
                label_group = label_group.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(muted)
                        .child(sub.to_owned()),
                );
            }

            if model.is_new {
                label_group = label_group.child(
                    div()
                        .flex_none()
                        .px(px(4.0))
                        .py(px(1.0))
                        .rounded(px(4.0))
                        .bg(hsla_alpha(tokens.info, 0.15))
                        .text_size(px(10.0))
                        .line_height(px(14.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(hsla(tokens.info_foreground))
                        .child("New"),
                );
            }

            row = row.child(label_group).child(
                div()
                    .flex_none()
                    .size(px(14.0))
                    .when(is_active, |el| el.child(icons::icon(ICON_CHECK, 14.0, fg))),
            );
            list = list.child(row);
        }
    }

    let right_column = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .child(search_row)
        .child(list);

    content = content.child(right_column);

    let row = div()
        .flex()
        .flex_row()
        .h(px(PICKER_MAX_HEIGHT_PX))
        .child(content)
        .child(render_effort_column(view, cx));

    div()
        .id("composer-model-picker-popup")
        .flex()
        .flex_col()
        .w(px(PICKER_WIDTH_PX + EFFORT_COLUMN_WIDTH_PX))
        .rounded(px(PICKER_RADIUS_PX))
        .bg(glass_bg)
        .border_1()
        .border_color(glass_divider)
        .shadow_lg()
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            div()
                .rounded_t(px(PICKER_RADIUS_PX))
                .overflow_hidden()
                .child(row),
        )
        .child(render_picker_footer(view, cx))
        .into_any_element()
}

/// Header label of the effort column (`descriptor.label`, `Options`, or `Effort`).
fn effort_column_header(controls: Option<&ColumnControls<'_>>) -> String {
    match controls {
        Some(c) => match c.effort {
            Some(effort) => effort.label().to_owned(),
            None if !c.others.is_empty() => "Options".to_owned(),
            None => "Effort".to_owned(),
        },
        None => "Effort".to_owned(),
    }
}

/// `ComposerEffortColumn`: header aligned with the search row, reasoning levels, then options.
fn render_effort_column(view: &ModelPickerView<'_>, cx: &mut Context<'_, Composer>) -> AnyElement {
    let tokens = view.tokens;
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let divider = hsla_alpha(tokens.border, 0.70);
    let row_hover = hsla_alpha(tokens.foreground, 0.09);
    let controls = view.selected.map(ModelOption::column_controls);
    let model_label = view
        .selected
        .map(ModelOption::trigger_label)
        .unwrap_or_else(|| view.active_model.to_owned());

    let header = div().flex_none().px(px(12.0)).pt(px(10.0)).child(
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .h(px(33.0))
            .pb(px(6.0))
            .border_b_1()
            .border_color(divider)
            .text_size(px(13.0))
            .line_height(px(20.0))
            .child(
                div()
                    .text_color(muted)
                    .child(effort_column_header(controls.as_ref())),
            )
            .child(
                div()
                    .ml_auto()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(muted)
                    .child(model_label),
            ),
    );

    let mut rows = div()
        .id("model-picker-effort-rows")
        .flex()
        .flex_col()
        .gap(px(2.0))
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .px(px(8.0))
        .pt(px(10.0))
        .pb(px(6.0));

    let no_effort = || {
        div()
            .flex()
            .items_center()
            .h(px(32.0))
            .px(px(8.0))
            .text_size(px(13.0))
            .text_color(muted)
            .child("No effort levels")
    };

    match (view.selected, controls.as_ref()) {
        (Some(model), Some(c)) if c.effort.is_some() || !c.others.is_empty() => {
            if let Some(effort) = c.effort {
                rows = rows.children(render_effort_rows(
                    model,
                    effort,
                    view.selected_options,
                    tokens,
                    fg,
                    muted,
                    row_hover,
                    cx,
                ));
            }
            if !c.others.is_empty() {
                let mut others = div().flex().flex_col().gap(px(2.0));
                if c.effort.is_some() {
                    others = others
                        .mt(px(4.0))
                        .pt(px(4.0))
                        .border_t_1()
                        .border_color(divider);
                }
                for descriptor in &c.others {
                    others = others.child(render_option_row(
                        model,
                        descriptor,
                        view.selected_options,
                        fg,
                        muted,
                        row_hover,
                        tokens,
                        cx,
                    ));
                }
                rows = rows.child(others);
            }
        }
        _ => rows = rows.child(no_effort()),
    }

    div()
        .flex()
        .flex_col()
        .flex_none()
        .w(px(EFFORT_COLUMN_WIDTH_PX))
        .h_full()
        .border_l_1()
        .border_color(divider)
        .bg(hsla_alpha(tokens.muted, 0.40))
        .child(header)
        .child(rows)
        .into_any_element()
}

/// Reasoning radio rows (`EffortRows`).
#[expect(clippy::too_many_arguments, reason = "row styling inputs")]
fn render_effort_rows(
    model: &ModelOption,
    effort: &ModelOptionDescriptor,
    selected: Option<&OptionMap>,
    tokens: &Tokens,
    fg: gpui_kit::Hsla,
    muted: gpui_kit::Hsla,
    row_hover: gpui_kit::Hsla,
    cx: &mut Context<'_, Composer>,
) -> Vec<AnyElement> {
    let mut out = Vec::new();
    match effort {
        ModelOptionDescriptor::Boolean { id, .. } => {
            let current = effort.bool_value(selected);
            for value in [true, false] {
                let option_id = id.clone();
                out.push(
                    column_row(
                        SharedString::from(format!("model-picker-effort-{id}-{value}")),
                        if value { "On" } else { "Off" }.to_owned(),
                        current == value,
                        false,
                        fg,
                        muted,
                        row_hover,
                    )
                    .on_click(cx.listener(move |composer, _, _, cx| {
                        composer.set_model_option(
                            option_id.clone(),
                            serde_json::Value::Bool(value),
                            cx,
                        );
                    }))
                    .into_any_element(),
                );
            }
        }
        ModelOptionDescriptor::Select { id, .. } => {
            let value = effort.select_value(selected).map(str::to_owned);
            for choice in effort.selectable_choices() {
                let option_id = id.clone();
                let choice_id = choice.id.clone();
                let mut row = column_row(
                    SharedString::from(format!(
                        "model-picker-effort-{}-{}-{}",
                        model.slug, id, choice.id
                    )),
                    choice.label.clone(),
                    value.as_deref() == Some(choice.id.as_str()),
                    choice.is_default,
                    fg,
                    muted,
                    row_hover,
                )
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.set_model_option(
                        option_id.clone(),
                        serde_json::Value::String(choice_id.clone()),
                        cx,
                    );
                }));
                if let Some(description) = &choice.description {
                    row = row.conn_tooltip(description.clone(), tokens);
                }
                out.push(row.into_any_element());
            }
        }
    }
    out
}

/// `ColumnRow`: `h-8` label, `Default` hint, and trailing check.
fn column_row(
    id: SharedString,
    label: String,
    selected: bool,
    is_default: bool,
    fg: gpui_kit::Hsla,
    muted: gpui_kit::Hsla,
    row_hover: gpui_kit::Hsla,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id.clone())
        .a11y_button(id, label.clone())
        .aria_selected(selected)
        .flex()
        .flex_none()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .h(px(32.0))
        .w_full()
        .px(px(8.0))
        .rounded(px(4.0))
        .cursor_pointer()
        .text_size(px(13.0))
        .line_height(px(20.0))
        .text_color(fg)
        .hover(move |s| s.bg(row_hover))
        .child(div().flex_1().min_w_0().truncate().child(label))
        .when(selected, |el| el.child(icons::icon(ICON_CHECK, 14.0, fg)))
        .when(!selected && is_default, |el| {
            el.child(
                div()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(gpui_kit::Hsla {
                        a: muted.a * 0.7,
                        ..muted
                    })
                    .child("Default"),
            )
        })
}

/// `OptionMenuRow` / `OptionSwitchRow`: a select cycles to its next choice, a switch toggles.
#[expect(clippy::too_many_arguments, reason = "row styling inputs")]
fn render_option_row(
    model: &ModelOption,
    descriptor: &ModelOptionDescriptor,
    selected: Option<&OptionMap>,
    fg: gpui_kit::Hsla,
    muted: gpui_kit::Hsla,
    row_hover: gpui_kit::Hsla,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let id = descriptor.id().to_owned();
    let row_id = SharedString::from(format!("model-picker-option-{}-{id}", model.slug));
    let base = div()
        .id(row_id)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .px(px(8.0))
        .py(px(4.0))
        .rounded(px(4.0))
        .cursor_pointer()
        .hover(move |s| s.bg(row_hover));
    let text = |value: String| {
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .child(
                div()
                    .truncate()
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color(muted)
                    .child(descriptor.label().to_owned()),
            )
            .child(
                div()
                    .truncate()
                    .text_size(px(13.0))
                    .line_height(px(20.0))
                    .text_color(fg)
                    .child(value),
            )
    };
    match descriptor {
        ModelOptionDescriptor::Boolean { .. } => {
            let checked = descriptor.bool_value(selected);
            let track = if checked {
                hsla(tokens.switch_on)
            } else {
                hsla_alpha(tokens.input, 0.80)
            };
            base.a11y_button(
                SharedString::from(format!("model-picker-switch-{id}")),
                descriptor.label().to_owned(),
            )
            .aria_selected(checked)
            .on_click(cx.listener(move |composer, _, _, cx| {
                composer.set_model_option(id.clone(), serde_json::Value::Bool(!checked), cx);
            }))
            .child(text(if checked { "On" } else { "Off" }.to_owned()))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .w(px(28.0))
                    .h(px(16.0))
                    .p(px(2.0))
                    .rounded_full()
                    .bg(track)
                    .when(checked, |el| el.justify_end())
                    .child(
                        div()
                            .size(px(12.0))
                            .rounded_full()
                            .bg(hsla(tokens.background)),
                    ),
            )
            .into_any_element()
        }
        ModelOptionDescriptor::Select { .. } => {
            let choices = descriptor.selectable_choices();
            let current = descriptor.select_value(selected).map(str::to_owned);
            let current_label = choices
                .iter()
                .find(|c| Some(c.id.as_str()) == current.as_deref())
                .map(|c| c.label.clone())
                .unwrap_or_default();
            let next = choices
                .iter()
                .position(|c| Some(c.id.as_str()) == current.as_deref())
                .map_or(0, |i| (i + 1) % choices.len().max(1));
            let next_id = choices.get(next).map(|c| c.id.clone());
            base.a11y_button(
                SharedString::from(format!("model-picker-select-{id}")),
                format!("{}: {current_label}", descriptor.label()),
            )
            .on_click(cx.listener(move |composer, _, _, cx| {
                if let Some(next_id) = next_id.clone() {
                    composer.set_model_option(id.clone(), serde_json::Value::String(next_id), cx);
                }
            }))
            .child(text(current_label))
            .child(icons::icon(icons::CARET_RIGHT, 14.0, muted))
            .into_any_element()
        }
    }
}

/// `ComposerPickerFooter`: speed segments, follow-up behavior, and the permissions menu.
fn render_picker_footer(view: &ModelPickerView<'_>, cx: &mut Context<'_, Composer>) -> AnyElement {
    let tokens = view.tokens;
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let divider = hsla_alpha(tokens.border, 0.70);
    let row_hover = hsla_alpha(tokens.foreground, 0.09);

    let mut footer = div()
        .flex()
        .flex_row()
        .flex_wrap()
        .items_center()
        .gap(px(8.0))
        .px(px(12.0))
        .py(px(8.0))
        .border_t_1()
        .border_color(divider)
        .bg(hsla_alpha(tokens.muted, 0.40))
        .rounded_b(px(PICKER_RADIUS_PX));

    if let Some(model) = view.selected {
        let controls = model.column_controls();
        let mut segments: Vec<(String, String, serde_json::Value, bool, Option<String>)> =
            Vec::new();
        if let Some(speed) = controls.speed_select {
            let value = speed.select_value(view.selected_options).map(str::to_owned);
            for choice in speed.selectable_choices() {
                segments.push((
                    speed.id().to_owned(),
                    choice.label.clone(),
                    serde_json::Value::String(choice.id.clone()),
                    value.as_deref() == Some(choice.id.as_str()),
                    choice.description.clone(),
                ));
            }
        } else if let Some(fast) = controls.fast_toggle {
            let on = fast.bool_value(view.selected_options);
            for value in [false, true] {
                segments.push((
                    fast.id().to_owned(),
                    if value { "Fast" } else { "Standard" }.to_owned(),
                    serde_json::Value::Bool(value),
                    on == value,
                    None,
                ));
            }
        }
        if !segments.is_empty() {
            let count = segments.len();
            let mut group = segment_group(tokens);
            for (index, (option_id, label, value, checked, description)) in
                segments.into_iter().enumerate()
            {
                let bolt = matches!(label.as_str(), "Fast" | "Ultrafast");
                let mut seg = segment(
                    SharedString::from(format!("model-picker-speed-{index}")),
                    checked,
                    index,
                    count,
                    fg,
                    muted,
                    tokens,
                )
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.set_model_option(option_id.clone(), value.clone(), cx);
                }))
                .when(bolt, |el| {
                    el.child(icons::icon(
                        ICON_FAST,
                        12.0,
                        if checked { fg } else { muted },
                    ))
                })
                .child(label);
                if let Some(description) = description {
                    seg = seg.conn_tooltip(description, tokens);
                }
                group = group.child(seg);
            }
            footer = footer.child(group);
        }
    }

    // Follow-up behavior while a turn runs (`settings.followUpBehavior`).
    let mut follow = segment_group(tokens);
    for (index, behavior) in [FollowUpBehavior::Steer, FollowUpBehavior::Queue]
        .into_iter()
        .enumerate()
    {
        let checked = view.follow_up == behavior;
        follow = follow.child(
            segment(
                SharedString::from(format!("model-picker-follow-up-{}", behavior.verb())),
                checked,
                index,
                2,
                fg,
                muted,
                tokens,
            )
            .on_click(cx.listener(move |composer, _, _, cx| {
                composer.set_follow_up_behavior(behavior, cx);
            }))
            .child(icons::icon(
                match behavior {
                    FollowUpBehavior::Steer => icons::FORWARD,
                    FollowUpBehavior::Queue => ICON_QUEUE,
                },
                12.0,
                if checked { fg } else { muted },
            ))
            .child(behavior.label()),
        );
    }
    footer = footer.child(
        div()
            .id("model-picker-follow-up")
            .child(follow)
            .conn_tooltip("While a turn runs: steer it, or queue after it", tokens),
    );

    // `PermissionsMenu`: current mode icon + label + chevron, opening the section above.
    let current = runtime_mode_option(view.runtime_mode);
    let open = view.permissions_open;
    let mut permissions = div().relative().ml_auto().child(
        div()
            .id("model-picker-permissions-trigger")
            .a11y_button(
                "composer.picker-permissions",
                format!("Permissions: {}", current.label),
            )
            .aria_expanded(open)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .h(px(28.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(if open { fg } else { muted })
            .when(open, |el| el.bg(row_hover))
            .hover(move |s| s.bg(row_hover).text_color(fg))
            .on_click(cx.listener(|composer, _, _, cx| {
                composer.toggle_picker_permissions_menu(cx);
            }))
            .child(icons::icon(
                current.icon,
                14.0,
                if open { fg } else { muted },
            ))
            .child(current.label)
            .child(icons::icon("superhero/chevron-up.svg", 12.0, muted)),
    );
    if open {
        let section = render_permissions_section(
            view.runtime_mode,
            view.runtime_options,
            view.permission_preview,
            "picker",
            tokens,
            cx,
        );
        permissions =
            permissions.child(
                gpui_kit::deferred(div().absolute().bottom_full().right_0().mb(px(4.0)).child(
                    popover_surface("model-picker-permissions-popup", tokens).child(section),
                ))
                .with_priority(4),
            );
    }
    footer.child(permissions).into_any_element()
}

/// `rounded-lg bg-input/40 p-0.5` segmented group.
fn segment_group(tokens: &Tokens) -> gpui_kit::Div {
    div()
        .flex()
        .flex_row()
        .rounded(px(8.0))
        .bg(hsla_alpha(tokens.input, 0.40))
        .p(px(2.0))
}

/// `FOOTER_SEGMENT`: `h-6 px-2 text-xs`, checked `bg-input/72`.
fn segment(
    id: SharedString,
    checked: bool,
    index: usize,
    count: usize,
    fg: gpui_kit::Hsla,
    muted: gpui_kit::Hsla,
    tokens: &Tokens,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let checked_bg = hsla_alpha(tokens.input, 0.72);
    div()
        .id(id.clone())
        .a11y_button(id.clone(), id)
        .aria_selected(checked)
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(4.0))
        .h(px(24.0))
        .px(px(8.0))
        .cursor_pointer()
        .text_size(px(12.0))
        .line_height(px(16.0))
        .text_color(if checked { fg } else { muted })
        .when(index == 0, |el| el.rounded_l(px(6.0)))
        .when(index + 1 == count, |el| el.rounded_r(px(6.0)))
        .when(checked, |el| el.bg(checked_bg))
        .hover(move |s| s.text_color(fg))
}

#[cfg(test)]
mod tests {
    use conn_contract::{ServerProviderAuthStatus, ServerProvidersItemItemAuth};

    use super::*;

    fn sample_provider(
        instance_id: &str,
        driver: &str,
        display_name: &str,
        models: Vec<(&str, &str)>,
    ) -> Option<ServerProvidersItemItem> {
        Some(ServerProvidersItemItem {
            instance_id: instance_id.to_owned(),
            driver: driver.to_owned(),
            display_name: Some(display_name.to_owned()),
            accent_color: None,
            icon_url: None,
            badge_label: None,
            continuation: None,
            show_interaction_mode_toggle: None,
            reports_context_window: None,
            supported_runtime_modes: None,
            supports_conversation_rollback: None,
            supports_text_generation: None,
            setup: None,
            native_sessions: None,
            configurable_providers: None,
            sub_providers: None,
            workspace_rescanned_at: None,
            runtime_paths: None,
            enabled: true,
            installed: true,
            version: None,
            installed_version: None,
            status: ServerProviderState::Ready,
            auth: ServerProvidersItemItemAuth {
                status: ServerProviderAuthStatus::Authenticated,
                r#type: None,
                label: None,
                email: None,
                action: None,
                can_logout: None,
                subscription_sharing: None,
                profile_id: None,
                workspace_id: None,
                endpoint: None,
            },
            checked_at: "2026-11-21T00:00:00Z".to_owned(),
            message: None,
            availability: None,
            unavailable_reason: None,
            models: models
                .into_iter()
                .map(|(slug, name)| ServerProvidersItemItemModelsItem {
                    slug: slug.to_owned(),
                    name: name.to_owned(),
                    short_name: None,
                    sub_provider: None,
                    aliases: None,
                    badge: None,
                    is_custom: false,
                    is_default: None,
                    is_legacy: None,
                    supports_text_generation: None,
                    capabilities: None,
                })
                .collect(),
            update_required_models: None,
            slash_commands: None,
            skills: None,
            workspace_snapshots: None,
            usage_limits: None,
            version_advisory: None,
            compatibility_advisory: None,
            update_state: None,
            catalog_digest: None,
            loaded_catalog_digest: None,
        })
    }

    #[test]
    fn catalog_parses_providers_and_filters_by_provider_and_query() {
        let providers = vec![
            sample_provider(
                "claude-1",
                "claudeAgent",
                "Claude",
                vec![("claude-sonnet-4-5", "Claude Sonnet 4.5")],
            ),
            sample_provider(
                "codex-1",
                "codex",
                "Codex",
                vec![("gpt-5.4", "GPT-5.4"), ("gpt-5.3", "GPT-5.3")],
            ),
        ];

        let catalog = ModelCatalog::from_providers(&providers);
        assert_eq!(catalog.providers.len(), 2, "two providers parsed");

        let codex_only = catalog.filtered_models(Some("codex-1"), "");
        assert_eq!(codex_only.len(), 2, "provider filter returns codex models");
        assert_eq!(codex_only[0].slug, "gpt-5.4", "preserves model order");

        let searched = catalog.filtered_models(Some("codex-1"), "sonnet");
        assert_eq!(searched.len(), 1, "search spans across all providers");
        assert_eq!(
            searched[0].instance_id, "claude-1",
            "search finds claude model"
        );
    }

    fn option(driver: &str, name: &str, descriptors: Vec<ModelOptionDescriptor>) -> ModelOption {
        ModelOption {
            instance_id: "i".to_owned(),
            driver: driver.to_owned(),
            provider_display_name: "P".to_owned(),
            slug: name.to_ascii_lowercase(),
            name: name.to_owned(),
            short_name: None,
            sub_provider: None,
            is_default: false,
            is_legacy: false,
            is_new: false,
            descriptors,
        }
    }

    fn select(id: &str, label: &str, choices: &[(&str, &str, bool)]) -> ModelOptionDescriptor {
        ModelOptionDescriptor::Select {
            id: id.to_owned(),
            label: label.to_owned(),
            choices: choices
                .iter()
                .map(|(id, label, is_default)| SelectChoice {
                    id: (*id).to_owned(),
                    label: (*label).to_owned(),
                    description: None,
                    is_default: *is_default,
                })
                .collect(),
            current_value: None,
            prompt_injected: Vec::new(),
            reasoning_role: false,
        }
    }

    #[test]
    fn compact_trigger_labels_match_conn() {
        assert_eq!(
            option("antigravity", "Gemini 4 Neon", vec![]).trigger_label(),
            "4 Neon"
        );
        assert_eq!(
            option("claudeAgent", "Claude Sonnet 4.6", vec![]).trigger_label(),
            "Sonnet 4.6"
        );
        assert_eq!(
            option("codex", "GPT-5.4", vec![]).trigger_label(),
            "GPT-5.4"
        );
        assert_eq!(
            option("codex", "GPT-5.4-Mini", vec![]).trigger_label(),
            "5.4 Mini",
            "native family keeps variant words"
        );
        assert_eq!(
            option("opencode", "Gemini 2.5 Pro", vec![]).trigger_label(),
            "Gemini 2.5 Pro",
            "off-family variants keep the family name"
        );
        assert_eq!(
            option("opencode", "Anthropic: Claude Opus 4", vec![]).trigger_label(),
            "Opus 4",
            "vendor prefix and family stripped"
        );
        let mut with_short = option("claudeAgent", "Claude Haiku 4.5", vec![]);
        with_short.short_name = Some("Haiku".to_owned());
        assert_eq!(with_short.trigger_label(), "Haiku");
        let mut sub = option("opencode", "OpenRouter / Kimi K2", vec![]);
        sub.sub_provider = Some("OpenRouter".to_owned());
        assert_eq!(sub.trigger_label(), "Kimi K2");
    }

    #[test]
    fn effort_column_splits_reasoning_speed_and_options() {
        let model = option(
            "claudeAgent",
            "Claude Sonnet 4.6",
            vec![
                select(
                    "contextWindow",
                    "Context window",
                    &[("200k", "200k", true), ("1m", "1M", false)],
                ),
                select(
                    "effort",
                    "Effort",
                    &[
                        ("low", "Low", false),
                        ("medium", "Medium", true),
                        ("high", "High", false),
                    ],
                ),
                ModelOptionDescriptor::Boolean {
                    id: "fastMode".to_owned(),
                    label: "Fast mode".to_owned(),
                    current_value: Some(false),
                },
            ],
        );
        let controls = model.column_controls();
        assert_eq!(
            controls.effort.map(ModelOptionDescriptor::id),
            Some("effort")
        );
        assert_eq!(
            controls.fast_toggle.map(ModelOptionDescriptor::id),
            Some("fastMode")
        );
        assert_eq!(controls.others.len(), 1, "context window is another option");

        let summary = model.effort_summary(None);
        assert_eq!(summary.word.as_deref(), Some("Medium"));
        assert_eq!(summary.speed, None);
        assert_eq!(summary.context_window.as_deref(), Some("200k"));
        assert_eq!(summary.detail.as_deref(), Some("200k · Medium"));

        let mut picked = OptionMap::new();
        picked.insert(
            "effort".to_owned(),
            serde_json::Value::String("high".to_owned()),
        );
        picked.insert("fastMode".to_owned(), serde_json::Value::Bool(true));
        let summary = model.effort_summary(Some(&picked));
        assert_eq!(summary.word.as_deref(), Some("High"));
        assert_eq!(summary.speed, Some("Fast"));
        assert_eq!(summary.detail.as_deref(), Some("200k · High Fast"));
    }

    #[test]
    fn codex_service_tier_is_the_speed_control() {
        let model = option(
            "codex",
            "GPT-5.4",
            vec![
                select(
                    "reasoningEffort",
                    "Reasoning",
                    &[("low", "Low", false), ("high", "High", true)],
                ),
                select(
                    "serviceTier",
                    "Speed",
                    &[("default", "Standard", true), ("fast", "Fast", false)],
                ),
            ],
        );
        let controls = model.column_controls();
        assert_eq!(
            controls.speed_select.map(ModelOptionDescriptor::id),
            Some("serviceTier")
        );
        assert!(controls.others.is_empty());
        let mut picked = OptionMap::new();
        picked.insert(
            "serviceTier".to_owned(),
            serde_json::Value::String("fast".to_owned()),
        );
        assert_eq!(model.speed_label(Some(&picked)), Some("Fast"));
        assert_eq!(model.speed_label(None), None);
    }
}
