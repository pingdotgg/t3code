//! Provider and model catalog from `ServerConfig.providers` (`providerInstances.ts`,
//! `ModelPickerContent.tsx`, `ProviderStatusBanner.tsx`).
//!
//! Pure and GPUI-free, so conn-gpui and the iOS app (`conn-ffi`) read one projection. The live
//! projection of `subscribeServerConfig` events is [`ServerConfigState`].

use crate::model_preferences::{ModelPreferences, sort_models_for_instance};
use conn_contract::{
    ServerConfig, ServerConfigStreamEvent, ServerProviderAuthStatus,
    ServerProviderCompatibilityStatus, ServerProviderState, ServerProvidersItemItem,
    ServerProvidersItemItemAvailability, ServerProvidersItemItemModelsItem,
    ServerProvidersItemItemModelsItemCapabilitiesOptionDescriptorsItem as OptionDescriptor,
    ServerProvidersItemItemSkillsItem,
};

/// `ANTIGRAVITY_DEFAULT_MODEL`: a placeholder slug Conn never lists as a model.
pub const ANTIGRAVITY_DEFAULT_MODEL: &str = "antigravity-default";

/// A provider skill offered by the `$` menu (`ServerProviderSkill`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillEntry {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub short_description: Option<String>,
    pub scope: Option<String>,
    pub path: String,
}

impl SkillEntry {
    /// Builds a skill entry when the skill is user invocable (`isProviderSkillUserInvocable`).
    #[must_use]
    pub fn from_contract(skill: &ServerProvidersItemItemSkillsItem) -> Option<Self> {
        if !skill.enabled || skill.user_invocable == Some(false) {
            return None;
        }
        Some(Self {
            name: skill.name.clone(),
            display_name: skill.display_name.clone(),
            description: skill.description.clone(),
            short_description: skill.short_description.clone(),
            scope: skill.scope.clone(),
            path: skill.path.clone(),
        })
    }

    /// `formatProviderSkillDisplayName`.
    #[must_use]
    pub fn label(&self) -> &str {
        self.display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.name)
    }

    /// Row description: short description, description, `<scope> skill`, or `Run provider skill`.
    #[must_use]
    pub fn row_description(&self) -> String {
        self.short_description
            .clone()
            .or_else(|| self.description.clone())
            .or_else(|| self.scope.as_ref().map(|scope| format!("{scope} skill")))
            .unwrap_or_else(|| "Run provider skill".to_owned())
    }

    /// `resolveProviderSkillSourceKind` badge label.
    #[must_use]
    pub fn source_label(&self) -> &'static str {
        let path = self.path.replace('\\', "/");
        if path.contains("/.codex/plugins/") || path.contains("/.agents/plugins/") {
            return "App";
        }
        match self
            .scope
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("repo" | "repository") => "Repo",
            Some("project" | "workspace" | "local") => "Project",
            Some("user" | "personal") => "Personal",
            Some("system") => "System",
            _ => "Provider",
        }
    }
}

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
pub struct SelectChoice {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub is_default: bool,
}

/// A model option descriptor (`ProviderOptionDescriptor`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelOptionDescriptor {
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
    pub fn id(&self) -> &str {
        match self {
            Self::Select { id, .. } | Self::Boolean { id, .. } => id,
        }
    }

    /// Descriptor label.
    #[must_use]
    pub fn label(&self) -> &str {
        match self {
            Self::Select { label, .. } | Self::Boolean { label, .. } => label,
        }
    }

    /// `isReasoningControl`.
    #[must_use]
    pub fn is_reasoning(&self) -> bool {
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
    pub fn selectable_choices(&self) -> Vec<&SelectChoice> {
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
    pub fn select_value<'a>(&'a self, selected: Option<&'a OptionMap>) -> Option<&'a str> {
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
    pub fn bool_value(&self, selected: Option<&OptionMap>) -> bool {
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
    pub fn current_label(&self, selected: Option<&OptionMap>) -> Option<String> {
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
pub type OptionMap = serde_json::Map<String, serde_json::Value>;

/// The docked effort column's controls (`columnControls` + `splitSpeed`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ColumnControls<'a> {
    /// Codex `serviceTier` select shown as the footer speed control.
    pub speed_select: Option<&'a ModelOptionDescriptor>,
    /// Claude `fastMode` boolean shown as the footer speed control.
    pub fast_toggle: Option<&'a ModelOptionDescriptor>,
    /// The reasoning control listed under the column header.
    pub effort: Option<&'a ModelOptionDescriptor>,
    /// Other selects and switches below the levels.
    pub others: Vec<&'a ModelOptionDescriptor>,
}

/// What the trigger shows after the model name (`describeComposerEffort`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EffortSummary {
    /// Effort word (`effortDisplay = "label"`, Conn's default).
    pub word: Option<String>,
    /// `Fast` / `Ultrafast` bolt.
    pub speed: Option<&'static str>,
    /// Secondary context window label (e.g. `1M`).
    pub context_window: Option<String>,
    /// Joined trait labels for the tooltip (`buildTraitsTriggerDisplay.label`).
    pub detail: Option<String>,
}

/// One selectable model belonging to a provider instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelOption {
    pub instance_id: String,
    pub driver: String,
    pub provider_display_name: String,
    pub slug: String,
    pub name: String,
    pub short_name: Option<String>,
    pub sub_provider: Option<String>,
    pub is_default: bool,
    pub is_legacy: bool,
    pub is_new: bool,
    /// Added by the user in Settings → Providers → Models (`isCustom`). Never hidden.
    pub is_custom: bool,
    /// The server reported capabilities for it. A custom or fallback model may have none.
    pub has_capabilities: bool,
    pub descriptors: Vec<ModelOptionDescriptor>,
}

impl ModelOption {
    /// `describeModelCapabilities`: `Fast mode`, and `No reasoning` when `flag_missing_reasoning`
    /// (other models of the provider reason) and this discovered model has no reasoning control.
    /// Alias slugs (`default`, Cursor's `auto`) defer to the provider, so reasoning is unknown.
    #[must_use]
    pub fn capability_labels(&self, flag_missing_reasoning: bool) -> Vec<&'static str> {
        let mut labels = Vec::new();
        let fast = self.descriptors.iter().any(|descriptor| match descriptor {
            ModelOptionDescriptor::Boolean { id, .. } => id == "fastMode",
            ModelOptionDescriptor::Select { id, choices, .. } => {
                id == "serviceTier"
                    && choices
                        .iter()
                        .any(|choice| choice.id == "fast" || choice.label == "Fast")
            }
        });
        if fast {
            labels.push("Fast mode");
        }
        if flag_missing_reasoning
            && !self.is_custom
            && self.has_capabilities
            && !matches!(self.slug.as_str(), "default" | "auto")
            && !self.has_reasoning_control()
        {
            labels.push("No reasoning");
        }
        labels
    }

    /// Whether a descriptor of this model sets reasoning.
    #[must_use]
    pub fn has_reasoning_control(&self) -> bool {
        self.descriptors
            .iter()
            .any(ModelOptionDescriptor::is_reasoning)
    }

    /// Compact trigger label (`getTriggerDisplayModelName`): `"Gemini 4 Neon"` -> `"4 Neon"`,
    /// `"Claude Sonnet 4.6"` -> `"Sonnet 4.6"`, `"GPT-5.4"` stays.
    #[must_use]
    pub fn trigger_label(&self) -> String {
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
    pub fn display_label(&self) -> String {
        strip_leading_qualifier(&self.name, self.sub_provider.as_deref())
    }

    /// `columnControls(provider, selects, toggles)`.
    #[must_use]
    pub fn column_controls(&self) -> ColumnControls<'_> {
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
    pub fn speed_label(&self, selected: Option<&OptionMap>) -> Option<&'static str> {
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
    pub fn effort_summary(&self, selected: Option<&OptionMap>) -> EffortSummary {
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
pub fn model_short_name(name: &str, native_families: &[&str]) -> Option<String> {
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
pub struct ProviderGroup {
    pub instance_id: String,
    pub driver: String,
    pub display_name: String,
    pub enabled: bool,
    /// `isProviderInstancePickerReady`: only a ready provider lists its models.
    pub ready: bool,
    /// `availability` is not `unavailable`.
    pub available: bool,
    pub installed: bool,
    pub status: ServerProviderState,
    /// The server's own status line (`snapshot.message`).
    pub message: Option<String>,
    /// `auth.status` is `unauthenticated`.
    pub unauthenticated: bool,
    /// `auth.status` as the server sent it.
    pub auth_status: ServerProviderAuthStatus,
    /// `#rrggbb` accent colour of a custom instance (`normalizeProviderAccentColor`).
    pub accent_color: Option<String>,
    /// Another instance shares this driver, or an accent colour is set (`shouldShowInstanceBadge`).
    pub show_badge: bool,
    /// `setup.canAuthenticate`; `None` when the server sent no setup block.
    pub can_authenticate: Option<bool>,
    /// `setup.documentationUrl`.
    pub documentation_url: Option<String>,
    /// The snapshot's own `displayName`, else the humanised driver. The banner names the
    /// provider with it (`status.displayName?.trim() || formatProviderDriverKindLabel(driver)`).
    pub provider_label: String,
    /// `getProviderCompatibilityNote`: one quiet line for a version Orbit should change.
    pub compatibility_note: Option<String>,
    /// The signed-in account's email, for the setup page (`auth.email`).
    pub auth_email: Option<String>,
    /// `auth.type`, for the setup page (`gemini-api-key`, `agent-platform`, ...).
    pub auth_type: Option<String>,
    /// `auth.canLogout`.
    pub can_logout: Option<bool>,
    /// Models this provider's CLI is too old to run (`updateRequiredModels`).
    pub update_required: Vec<UpdateRequiredModel>,
    /// `auth.label`, a product or plan name.
    pub auth_label: Option<String>,
    /// The installed CLI's version.
    pub version: Option<String>,
    /// `hasProviderSetup`: Antigravity always, any other provider when `setup.canAuthenticate`.
    pub has_setup: bool,
    pub models: Vec<ModelOption>,
    /// User-invocable provider skills for the `$` menu.
    pub skills: Vec<SkillEntry>,
    /// Runtime modes the provider supports (empty: all).
    pub supported_runtime_modes: Vec<String>,
    /// True when the provider advertises `/compact` (`providerSupportsManualCompaction`).
    pub supports_compact: bool,
}

/// `isProviderInstancePickerReady`: an enabled, available instance whose status is ready. A
/// warning still offers the models of sub-providers that report no problem of their own.
fn picker_ready(
    enabled: bool,
    available: bool,
    status: ServerProviderState,
    models: &[ModelOption],
    usable_sub_providers: &[&str],
) -> bool {
    if !enabled || !available {
        return false;
    }
    match status {
        ServerProviderState::Ready => true,
        ServerProviderState::Warning => models.iter().any(|model| {
            model
                .sub_provider
                .as_deref()
                .is_some_and(|sub| usable_sub_providers.contains(&sub))
        }),
        ServerProviderState::Error | ServerProviderState::Disabled => false,
    }
}

/// `sortProviderInstanceEntries`: each driver's default instance first (its id is the driver
/// kind), then its custom instances, drivers in the order the server lists them.
fn order_provider_groups(groups: Vec<ProviderGroup>) -> Vec<ProviderGroup> {
    let mut buckets: Vec<(String, Vec<ProviderGroup>)> = Vec::new();
    for group in groups {
        match buckets
            .iter_mut()
            .find(|(driver, _)| *driver == group.driver)
        {
            Some((_, bucket)) => bucket.push(group),
            None => buckets.push((group.driver.clone(), vec![group])),
        }
    }
    buckets
        .into_iter()
        .flat_map(|(_, mut bucket)| {
            bucket.sort_by_key(|group| group.instance_id != group.driver);
            bucket
        })
        .collect()
}

impl ProviderGroup {
    /// `shouldOfferModelPickerSetup`: a provider the user can still set up stays selectable in
    /// the rail while it lists no usable model.
    #[must_use]
    pub fn offers_setup(&self) -> bool {
        self.enabled
            && self.status != ServerProviderState::Disabled
            && self.has_setup
            && (!self.ready
                || !self.installed
                || self.unauthenticated
                || self.models.iter().all(is_synthetic_default))
    }

    /// A rail icon Conn dims and blocks (`opacity-50 cursor-not-allowed`): not ready and nothing
    /// to set up.
    #[must_use]
    pub fn rail_disabled(&self) -> bool {
        !self.ready && !self.offers_setup()
    }

    /// The rail icon's tooltip and accessible label (`describeUnavailableInstance`): the name
    /// while ready, else why the provider is not.
    #[must_use]
    pub fn rail_label(&self) -> String {
        let label = &self.display_name;
        if self.ready {
            return label.clone();
        }
        if (!self.enabled && self.available) || self.status == ServerProviderState::Disabled {
            return format!("{label}: Disabled in settings.");
        }
        if self.status == ServerProviderState::Ready && self.available {
            return label.clone();
        }
        let prefix = match self.status {
            ServerProviderState::Error => "Unavailable",
            ServerProviderState::Warning => "Limited",
            ServerProviderState::Ready | ServerProviderState::Disabled => "Not ready",
        };
        match &self.message {
            Some(message) => format!("{label}: {prefix}. {message}"),
            None => format!("{label}: {prefix}."),
        }
    }

    /// What the list says in place of "No models found" while a set-up-able provider is
    /// selected (`getProviderStatusMessage`). The server's own line comes first.
    #[must_use]
    pub fn setup_notice(&self) -> Option<String> {
        self.offers_setup().then(|| self.status_message())
    }

    /// `getProviderStatusMessage`: the server's own line, else why the provider has no models.
    #[must_use]
    pub fn status_message(&self) -> String {
        if let Some(message) = &self.message {
            return message.clone();
        }
        if !self.installed {
            return format!(
                "{} is not on this environment's PATH. Orbit installs it.",
                humanize_slug(&self.driver)
            );
        }
        if self.unauthenticated {
            return if !self.has_setup {
                "Sign in via the CLI to authenticate again.".to_owned()
            } else if self.driver == "antigravity" {
                "Open provider setup to sign in with Google.".to_owned()
            } else {
                "Open provider setup to sign in.".to_owned()
            };
        }
        let name = &self.provider_label;
        match self.status {
            ServerProviderState::Ready => "No models are available for this provider.".to_owned(),
            ServerProviderState::Error => format!("{name} provider is unavailable."),
            ServerProviderState::Warning | ServerProviderState::Disabled => {
                format!("{name} provider has limited availability.")
            }
        }
    }

    /// The banner above the thread (`ProviderStatusBanner`), or `None` while the provider needs
    /// none. A version warning never raises it on its own: Orbit owns the CLI version.
    #[must_use]
    pub fn banner(&self) -> Option<ProviderBanner> {
        if matches!(
            self.status,
            ServerProviderState::Disabled | ServerProviderState::Ready
        ) {
            return None;
        }
        // Antigravity validates credentials at session start; unknown restart auth is not failure.
        if self.driver == "antigravity"
            && self.installed
            && self.status == ServerProviderState::Warning
            && self.auth_status == ServerProviderAuthStatus::Unknown
        {
            return None;
        }
        let key = [
            self.instance_id.as_str(),
            state_label(self.status),
            auth_status_label(self.auth_status),
            self.message.as_deref().unwrap_or(""),
        ]
        .join("\u{0}");
        let title = if self.status == ServerProviderState::Error && self.unauthenticated {
            format!("{} is unauthenticated", self.provider_label)
        } else {
            format!("{} provider status", self.provider_label)
        };
        Some(ProviderBanner {
            key,
            title,
            message: self.status_message(),
            compatibility_note: self.compatibility_note.clone(),
            warning: self.status == ServerProviderState::Warning,
            offers_setup: self.has_setup,
            instance_id: self.instance_id.clone(),
        })
    }
}

/// The provider status banner's content (`ProviderStatusBanner`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderBanner {
    /// What a dismissal remembers: instance, status, auth status and message. A new status
    /// raises the banner again. Prefix it with the environment to dismiss per environment.
    pub key: String,
    pub title: String,
    pub message: String,
    pub compatibility_note: Option<String>,
    /// A warning, else an error.
    pub warning: bool,
    /// `hasProviderSetup`: show `Open provider setup`.
    pub offers_setup: bool,
    pub instance_id: String,
}

/// `ServerProviderState` as it is on the wire.
fn state_label(state: ServerProviderState) -> &'static str {
    match state {
        ServerProviderState::Ready => "ready",
        ServerProviderState::Warning => "warning",
        ServerProviderState::Error => "error",
        ServerProviderState::Disabled => "disabled",
    }
}

fn auth_status_label(status: ServerProviderAuthStatus) -> &'static str {
    match status {
        ServerProviderAuthStatus::Authenticated => "authenticated",
        ServerProviderAuthStatus::Unauthenticated => "unauthenticated",
        ServerProviderAuthStatus::Unknown => "unknown",
    }
}

/// Conn's synthetic `antigravity-default` option names no model, so the picker never lists it.
fn is_synthetic_default(model: &ModelOption) -> bool {
    model.driver == "antigravity" && model.slug == ANTIGRAVITY_DEFAULT_MODEL
}

/// Parsed provider and model catalog from `server.getConfig`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelCatalog {
    pub providers: Vec<ProviderGroup>,
    /// Disabled providers without models: off the picker, still on the Providers page.
    pub unlisted: Vec<ProviderGroup>,
    /// Every instance the server lists, in server order, disabled and model-less ones too.
    /// Threads keep the id of an instance that left the picker, so lookups read this list.
    pub instances: Vec<ProviderInstanceInfo>,
    /// Favorites, hidden models and order. Hidden models leave the picker but stay findable,
    /// so a thread that uses one still shows its name and options.
    pub preferences: ModelPreferences,
}

/// The picker rail's Favorites tab, as a `selected_provider`. Instance ids start with a
/// letter, so it never names an instance.
pub const FAVORITES_TAB: &str = "@favorites";

impl ModelCatalog {
    /// Builds a [`ModelCatalog`] from a typed `conn_contract::ServerConfig`.
    #[must_use]
    pub fn from_server_config(config: &ServerConfig) -> Self {
        Self::from_providers(&config.providers)
    }

    /// Builds a [`ModelCatalog`] from `ServerConfig::providers`.
    #[must_use]
    pub fn from_providers(providers: &[Option<ServerProvidersItemItem>]) -> Self {
        let instances = instance_infos(providers);
        let mut groups = Vec::new();
        let mut unlisted_groups = Vec::new();
        for item in providers.iter().flatten() {
            // A disabled provider without models stays off the picker; the Providers page lists it.
            let unlisted = !item.enabled && item.models.is_empty();
            let display_name = resolve_instance_display_name(
                &item.instance_id,
                &item.driver,
                item.display_name.as_deref(),
            );
            let available = !matches!(
                item.availability,
                Some(ServerProvidersItemItemAvailability::Unavailable)
            );
            let models: Vec<ModelOption> = item
                .models
                .iter()
                .map(|m| model_option_from_contract(item, &display_name, m))
                .collect();
            let usable_sub_providers: Vec<&str> = item
                .sub_providers
                .iter()
                .flatten()
                .filter(|sub| sub.unavailable_reason.is_none())
                .map(|sub| sub.name.as_str())
                .collect();
            let ready = picker_ready(
                item.enabled,
                available,
                item.status,
                &models,
                &usable_sub_providers,
            );
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
            let group = ProviderGroup {
                instance_id: item.instance_id.clone(),
                driver: item.driver.clone(),
                display_name,
                enabled: item.enabled,
                ready,
                available,
                installed: item.installed,
                status: item.status,
                message: item
                    .message
                    .as_deref()
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .map(str::to_owned),
                unauthenticated: matches!(
                    item.auth.status,
                    ServerProviderAuthStatus::Unauthenticated
                ),
                auth_status: item.auth.status,
                accent_color: normalize_accent_color(item.accent_color.as_deref()),
                show_badge: instances
                    .iter()
                    .find(|info| info.instance_id == item.instance_id)
                    .is_some_and(|info| info.show_badge),
                can_authenticate: item.setup.as_ref().map(|s| s.can_authenticate),
                documentation_url: item
                    .setup
                    .as_ref()
                    .and_then(|s| s.documentation_url.clone()),
                provider_label: item
                    .display_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map_or_else(|| humanize_slug(&item.driver), str::to_owned),
                compatibility_note: item
                    .compatibility_advisory
                    .as_ref()
                    .and_then(compatibility_note),
                auth_email: item
                    .auth
                    .email
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
                auth_type: item.auth.r#type.clone(),
                can_logout: item.auth.can_logout,
                update_required: item
                    .update_required_models
                    .iter()
                    .flatten()
                    .map(|model| UpdateRequiredModel {
                        slug: model.slug.clone(),
                        name: model.name.clone(),
                        min_version: model.min_version.clone(),
                    })
                    .collect(),
                auth_label: item.auth.label.clone(),
                version: item.version.clone(),
                has_setup: item.driver == "antigravity"
                    || item.setup.as_ref().is_some_and(|s| s.can_authenticate),
                models,
                skills,
                supported_runtime_modes,
                supports_compact,
            };
            if unlisted {
                unlisted_groups.push(group);
            } else {
                groups.push(group);
            }
        }
        Self {
            providers: order_provider_groups(groups),
            unlisted: unlisted_groups,
            instances,
            preferences: ModelPreferences::default(),
        }
    }

    /// The catalog with the environment's model preferences: each instance's models in its
    /// saved order (`applyInstanceModelPreferences`), with hidden models and favorites kept
    /// for the picker.
    #[must_use]
    pub fn with_preferences(mut self, preferences: ModelPreferences) -> Self {
        let none = std::collections::HashSet::new();
        for group in self.providers.iter_mut().chain(self.unlisted.iter_mut()) {
            let order = preferences.instance(&group.instance_id).model_order;
            if order.is_empty() {
                continue;
            }
            let models = std::mem::take(&mut group.models);
            group.models =
                sort_models_for_instance(models, |m| m.slug.as_str(), &order, &none, false);
        }
        self.preferences = preferences;
        self
    }

    /// Whether the picker leaves `model` out: hidden in Settings, and not a custom model.
    #[must_use]
    pub fn is_hidden(&self, model: &ModelOption) -> bool {
        !model.is_custom && self.preferences.is_hidden(&model.instance_id, &model.slug)
    }

    /// Whether `model` is a favorite.
    #[must_use]
    pub fn is_favorite(&self, model: &ModelOption) -> bool {
        self.preferences
            .is_favorite(&model.instance_id, &model.slug)
    }

    /// The tab the picker opens on (`selectedInstanceId`'s initial value): Favorites when a
    /// favorite can be picked and the active provider is ready, else the active provider.
    #[must_use]
    pub fn initial_picker_tab(&self, active_instance_id: Option<&str>) -> Option<String> {
        let active_ready = active_instance_id.is_none_or(|id| {
            self.providers
                .iter()
                .find(|p| p.instance_id == id)
                .is_none_or(|p| p.ready)
        });
        let has_pickable_favorite = self.pickable_models().any(|m| self.is_favorite(m));
        if active_ready && has_pickable_favorite {
            Some(FAVORITES_TAB.to_owned())
        } else {
            active_instance_id.map(str::to_owned)
        }
    }

    /// The rail's providers (`isProviderInstancePickerVisible`): every enabled instance.
    pub fn picker_providers(&self) -> impl Iterator<Item = &ProviderGroup> {
        self.providers.iter().filter(|p| p.enabled)
    }

    /// Returns the preferred default model across available providers, hidden models aside:
    /// first ready provider's `is_default` model, else first model of a ready provider,
    /// else any `is_default` model, else the very first model in the catalog.
    #[must_use]
    pub fn default_model(&self) -> Option<&ModelOption> {
        self.providers
            .iter()
            .filter(|p| p.ready)
            .flat_map(|p| p.models.iter())
            .filter(|m| !self.is_hidden(m))
            .find(|m| m.is_default)
            .or_else(|| {
                self.providers
                    .iter()
                    .filter(|p| p.ready)
                    .flat_map(|p| p.models.iter())
                    .find(|m| !self.is_hidden(m))
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
    pub fn find_model(&self, instance_id: Option<&str>, model_slug: &str) -> Option<&ModelOption> {
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

    /// Every model the picker lists (`flatModels`): those of ready providers, minus Conn's
    /// synthetic Antigravity default.
    fn pickable_models(&self) -> impl Iterator<Item = &ModelOption> {
        self.providers
            .iter()
            .filter(|p| p.ready)
            .flat_map(|p| p.models.iter())
            .filter(|m| !is_synthetic_default(m) && !self.is_hidden(m))
    }

    /// Returns the models visible for the active provider tab and search query.
    ///
    /// When `query` is non-empty, searches across all providers (matching `ModelPickerContent.tsx`).
    /// When `query` is empty, filters to `selected_provider` (or all providers if `None`).
    /// A provider that is not ready lists no model, as in Conn.
    #[must_use]
    pub fn filtered_models(
        &self,
        selected_provider: Option<&str>,
        query: &str,
    ) -> Vec<&ModelOption> {
        let mut models = self.unsorted_filtered_models(selected_provider, query);
        // `sortProviderModelItems`: favorites first, except in Favorites, which keeps the
        // providers' order. The sort is stable.
        if selected_provider != Some(FAVORITES_TAB) || !query.trim().is_empty() {
            models.sort_by_key(|m| !self.is_favorite(m));
        }
        models
    }

    fn unsorted_filtered_models(
        &self,
        selected_provider: Option<&str>,
        query: &str,
    ) -> Vec<&ModelOption> {
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            let needle = trimmed.to_ascii_lowercase();
            return self
                .pickable_models()
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

        if selected_provider == Some(FAVORITES_TAB) {
            return self
                .pickable_models()
                .filter(|m| self.is_favorite(m))
                .collect();
        }

        if let Some(id) = selected_provider
            && let Some(group) = self.providers.iter().find(|p| p.instance_id == id)
        {
            return self
                .pickable_models()
                .filter(|m| m.instance_id == group.instance_id)
                .collect();
        }

        self.pickable_models().collect()
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
        is_custom: model.is_custom,
        has_capabilities: model.capabilities.is_some(),
        descriptors,
    }
}

/// A driver's label when the server sends no display name: the provider package's `label`, else
/// `formatProviderDriverKindLabel` (`fooBar` -> `Foo Bar`).
fn format_driver_name(driver: &str) -> String {
    match driver {
        "claudeAgent" => "Claude".to_owned(),
        "codex" => "Codex".to_owned(),
        "antigravity" => "Antigravity".to_owned(),
        "opencode" => "OpenCode".to_owned(),
        "grok" => "Grok".to_owned(),
        "cursor" => "Cursor".to_owned(),
        "kiro" => "Kiro".to_owned(),
        "pi" => "Pi".to_owned(),
        "muse" => "Muse Code".to_owned(),
        "fx" => "fx".to_owned(),
        "acpRegistry" => "ACP Registry".to_owned(),
        other => humanize_slug(other),
    }
}

/// `humanizeSlug` (`fooBar` and `foo_bar` become `Foo Bar`).
fn humanize_slug(driver: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut previous_lower = false;
    for c in driver.chars() {
        if c == '_' || c == '-' || c.is_whitespace() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            previous_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && previous_lower && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        word.push(c);
        previous_lower = c.is_ascii_lowercase();
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
        .iter()
        .map(|w| {
            let mut chars = w.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A model that needs a newer provider CLI (`updateRequiredModels`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateRequiredModel {
    pub slug: String,
    pub name: String,
    pub min_version: String,
}

/// `parseSemver`: `major.minor.patch` with an optional `-prerelease`, `v` and build metadata
/// ignored. A short version is padded with zeros.
fn parse_semver(value: &str) -> Option<(u64, u64, u64, Vec<String>)> {
    let trimmed = value.trim();
    let without_build = trimmed.split('+').next().unwrap_or("");
    let (main, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, ""), |(main, pre)| (main, pre));
    let mut segments: Vec<&str> = main
        .split('.')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    while !segments.is_empty() && segments.len() < 3 {
        segments.push("0");
    }
    let [major, minor, patch] = segments.as_slice() else {
        return None;
    };
    let number = |s: &str| {
        let s = s.strip_prefix('v').unwrap_or(s);
        (!s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
            .then(|| s.parse::<u64>().ok())
            .flatten()
    };
    Some((
        number(major)?,
        number(minor)?,
        number(patch)?,
        prerelease
            .split('.')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
    ))
}

/// `compareSemverVersions`: negative, zero or positive. A version that does not parse sorts
/// as text after one that does.
#[must_use]
pub fn compare_semver(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (Some(l), Some(r)) = (parse_semver(left), parse_semver(right)) else {
        return left.cmp(right);
    };
    let by_number = (l.0, l.1, l.2).cmp(&(r.0, r.1, r.2));
    if by_number != Ordering::Equal {
        return by_number;
    }
    match (l.3.is_empty(), r.3.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (false, false) => {}
    }
    for (a, b) in l.3.iter().zip(&r.3) {
        let numeric = |s: &str| {
            s.chars()
                .all(|c| c.is_ascii_digit())
                .then(|| s.parse::<u64>().ok())
                .flatten()
        };
        let order = match (numeric(a), numeric(b)) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => a.cmp(b),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    l.3.len().cmp(&r.3.len())
}

/// `formatConjunctionList` in English: `A`, `A and B`, `A, B, and C`.
fn conjunction_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [first, second] => format!("{first} and {second}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

impl ProviderGroup {
    /// `formatProviderUpdateRequiredNotice`: the models this provider's CLI is too old for,
    /// narrowed by the picker's search `query`, and the version that runs them.
    #[must_use]
    pub fn update_required_notice(&self, query: &str) -> Option<String> {
        let query = query.trim().to_lowercase();
        let models: Vec<&UpdateRequiredModel> = self
            .update_required
            .iter()
            .filter(|model| {
                query.is_empty()
                    || model.name.to_lowercase().contains(&query)
                    || model.slug.to_lowercase().contains(&query)
            })
            .collect();
        let first = models.first()?;
        let min_version = models
            .iter()
            .fold(first.min_version.as_str(), |highest, model| {
                if compare_semver(&model.min_version, highest).is_gt() {
                    model.min_version.as_str()
                } else {
                    highest
                }
            });
        let version = if min_version.starts_with('v') {
            min_version.to_owned()
        } else {
            format!("v{min_version}")
        };
        let names: Vec<&str> = models.iter().map(|model| model.name.as_str()).collect();
        let names = conjunction_list(&names);
        Some(if self.driver == "codex" {
            format!("Update the Codex CLI to {version} or newer to use {names}.")
        } else {
            let provider = if self.driver == "claudeAgent" {
                "Claude Code".to_owned()
            } else {
                format_driver_name(&self.driver)
            };
            format!("Update {provider} to {version} or newer to use {names}.")
        })
    }
}

/// Which provider a composer sends with, and where `Open provider settings` leads when none
/// is usable (`resolveComposerProviderSelection`, `ChatComposer.tsx:934-945`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProviderSelection {
    /// The usable instance, if any.
    pub selected: Option<String>,
    /// No instance is usable: the footer offers `Open provider settings`.
    pub none_available: bool,
    /// The instance the footer's setup button opens: the one asked for, else the first
    /// instance that has a setup path. `None` disables the button.
    pub setup_instance: Option<String>,
}

impl ModelCatalog {
    /// `resolveComposerProviderSelection`: `candidates` are the instances the thread, its draft
    /// and its project ask for, in order. The first enabled, available candidate wins; else a
    /// ready instance of the requested driver, then any ready one, then any enabled and
    /// available one that has not failed.
    #[must_use]
    pub fn resolve_selection(&self, candidates: &[Option<&str>]) -> ProviderSelection {
        let entries = self.all_groups();
        let selectable = |group: &&ProviderGroup| group.enabled && group.available;
        let requested = candidates.iter().flatten().next().copied();
        let requested_driver = requested
            .and_then(|id| entries.iter().find(|g| g.instance_id == id))
            .or_else(|| entries.first())
            .map(|group| group.driver.as_str());
        let pick = |pool: &[&ProviderGroup]| -> Option<String> {
            pool.iter()
                .find(|group| group.ready)
                .or_else(|| {
                    pool.iter()
                        .find(|g| selectable(g) && g.status != ServerProviderState::Error)
                })
                .map(|group| group.instance_id.clone())
        };
        let selected = candidates
            .iter()
            .flatten()
            .find_map(|id| {
                entries
                    .iter()
                    .find(|g| g.instance_id == *id && selectable(g))
                    .map(|g| g.instance_id.clone())
            })
            .or_else(|| {
                let same_driver: Vec<&ProviderGroup> = entries
                    .iter()
                    .copied()
                    .filter(|g| Some(g.driver.as_str()) == requested_driver)
                    .collect();
                pick(&same_driver)
            })
            .or_else(|| pick(&entries));
        let none_available = selected.is_none();
        let setup_instance = none_available
            .then(|| {
                requested.map(str::to_owned).or_else(|| {
                    entries
                        .iter()
                        .find(|g| g.has_setup)
                        .map(|g| g.instance_id.clone())
                })
            })
            .flatten();
        ProviderSelection {
            selected,
            none_available,
            setup_instance,
        }
    }
}

/// One provider instance as the server lists it, for clients that only need to name it (the
/// iOS thread rows, the sidebar). Custom instance ids are `${driver}_${slug}`, so the driver
/// cannot be guessed from the id: look it up with [`ModelCatalog::driver_for_instance`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderInstanceInfo {
    pub instance_id: String,
    pub driver: String,
    /// `resolveProviderInstanceDisplayName`.
    pub display_name: String,
    /// `#rrggbb` accent colour (`normalizeProviderAccentColor`).
    pub accent_color: Option<String>,
    /// `shouldShowInstanceBadge`: show the instance's initials or accent beside its icon.
    pub show_badge: bool,
    pub enabled: bool,
}

impl ModelCatalog {
    /// Every provider with its group, picker or not, in server order (the Providers page).
    #[must_use]
    pub fn all_groups(&self) -> Vec<&ProviderGroup> {
        self.instances
            .iter()
            .filter_map(|info| {
                self.providers
                    .iter()
                    .chain(&self.unlisted)
                    .find(|group| group.instance_id == info.instance_id)
            })
            .collect()
    }

    /// The instance with `instance_id`, enabled or not.
    #[must_use]
    pub fn instance(&self, instance_id: &str) -> Option<&ProviderInstanceInfo> {
        self.instances
            .iter()
            .find(|info| info.instance_id == instance_id)
    }

    /// The driver of `instance_id` (`codex` for `codex_work`), or `None` for an id the server
    /// does not list.
    #[must_use]
    pub fn driver_for_instance(&self, instance_id: &str) -> Option<&str> {
        self.instance(instance_id).map(|info| info.driver.as_str())
    }
}

/// `resolveProviderInstanceDisplayName`: the server's name unless it only repeats the driver's,
/// then the humanised id of a custom instance, then the driver's name.
#[must_use]
pub fn resolve_instance_display_name(
    instance_id: &str,
    driver: &str,
    display_name: Option<&str>,
) -> String {
    let trimmed = display_name.map(str::trim).filter(|s| !s.is_empty());
    let kind_label = format_driver_name(driver);
    if let Some(name) = trimmed
        && name != kind_label
    {
        return name.to_owned();
    }
    if instance_id != driver {
        let humanized = humanize_slug(instance_id);
        if !humanized.is_empty() {
            return humanized;
        }
    }
    trimmed.map_or(kind_label, str::to_owned)
}

/// `normalizeProviderAccentColor`: only `#rrggbb` counts.
#[must_use]
pub fn normalize_accent_color(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    let hex = trimmed.strip_prefix('#')?;
    (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| trimmed.to_owned())
}

fn instance_infos(providers: &[Option<ServerProvidersItemItem>]) -> Vec<ProviderInstanceInfo> {
    let mut infos: Vec<ProviderInstanceInfo> = providers
        .iter()
        .flatten()
        .map(|item| ProviderInstanceInfo {
            instance_id: item.instance_id.clone(),
            driver: item.driver.clone(),
            display_name: resolve_instance_display_name(
                &item.instance_id,
                &item.driver,
                item.display_name.as_deref(),
            ),
            accent_color: normalize_accent_color(item.accent_color.as_deref()),
            show_badge: false,
            enabled: item.enabled,
        })
        .collect();
    let badges: Vec<bool> = infos
        .iter()
        .map(|entry| show_instance_badge(entry, &infos))
        .collect();
    for (info, badge) in infos.iter_mut().zip(badges) {
        info.show_badge = badge;
    }
    infos
}

/// `shouldShowInstanceBadge`. A disabled sibling does not count for an enabled instance, but
/// historical threads still tell apart accounts that are all disabled.
fn show_instance_badge(entry: &ProviderInstanceInfo, entries: &[ProviderInstanceInfo]) -> bool {
    if entry.accent_color.is_some() {
        return true;
    }
    entries
        .iter()
        .filter(|candidate| candidate.driver == entry.driver)
        .filter(|candidate| !(entry.enabled && !candidate.enabled))
        .count()
        > 1
}

/// `getProviderVersionLabel`.
fn provider_version_label(version: Option<&str>) -> Option<String> {
    let version = version?;
    if version.is_empty() {
        return None;
    }
    if let Some(rest) = version.strip_prefix("agy_acp_server_") {
        let mut parts = rest.split('_');
        let date = parts.next().unwrap_or("");
        let build = parts.next().unwrap_or("");
        let candidate: Vec<&str> = parts.collect();
        let candidate = candidate.join("_");
        let is_word = |s: &str| s.chars().all(|c| c.is_alphanumeric() || c == '_');
        if date.len() == 8
            && date.chars().all(|c| c.is_ascii_digit())
            && !build.is_empty()
            && build.chars().all(|c| c.is_ascii_digit())
            && is_word(&candidate)
        {
            let (year, month, day) = (&date[..4], &date[4..6], &date[6..]);
            return Some(if candidate.is_empty() {
                format!("{year}-{month}-{day}")
            } else {
                format!("{year}-{month}-{day} {candidate}")
            });
        }
    }
    Some(if version.starts_with(|c: char| c.is_ascii_digit()) {
        format!("v{version}")
    } else {
        version.to_owned()
    })
}

/// `getProviderCompatibilityNote`.
fn compatibility_note(
    advisory: &conn_contract::ServerProvidersItemItemCompatibilityAdvisory,
) -> Option<String> {
    let title = match advisory.status {
        ServerProviderCompatibilityStatus::Graceful => "Limited support",
        ServerProviderCompatibilityStatus::Unsupported => "Unsupported version",
        ServerProviderCompatibilityStatus::Broken => "Known broken version",
        ServerProviderCompatibilityStatus::Unknown
        | ServerProviderCompatibilityStatus::Supported => {
            return None;
        }
    };
    let recommendation = provider_version_label(advisory.recommended_version.as_deref())
        .or_else(|| advisory.recommended_range.clone());
    let detail = advisory
        .message
        .clone()
        .or_else(|| recommendation.map(|version| format!("Use {version} for full support.")));
    Some(match detail {
        Some(detail) => format!("{title} \u{b7} {detail}"),
        None => title.to_owned(),
    })
}

/// What a `subscribeServerConfig` event changed, so a view repaints only for news
/// (`reuseUnchanged`: pushes and reconnects resend unchanged data).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ServerConfigChange {
    /// The provider list differs from the one held.
    pub providers_changed: bool,
    /// The scratch root or a capability the client reads differs.
    pub config_changed: bool,
    /// `settingsUpdated` (or a snapshot) brought different settings.
    pub settings_changed: bool,
}

impl ServerConfigChange {
    /// True when anything a view reads changed.
    #[must_use]
    pub fn any(self) -> bool {
        self.providers_changed || self.config_changed || self.settings_changed
    }
}

/// The live projection of `subscribeServerConfig` (`applyServerConfigProjection`) for what
/// native clients read: the provider list, and the few `ServerConfig` fields next to it.
///
/// `keybindingsUpdated`, `settingsUpdated`, `environmentThemesUpdated` and
/// `usageLimitSourcesUpdated` change nothing a native client reads yet, so they are accepted and
/// ignored. A new `snapshot` replaces everything, as in Conn.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ServerConfigState {
    providers: Vec<ServerProvidersItemItem>,
    settings: Option<conn_contract::ServerSettings>,
    catalog: ModelCatalog,
    scratch_workspace_root: Option<String>,
    model_catalog_refresh: bool,
    managed_policy: Option<conn_contract::ManagedPolicySummary>,
    loaded: bool,
}

impl ServerConfigState {
    /// An empty state: no snapshot seen.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Forgets everything, for a new connection.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// True once a `snapshot` arrived. Until then an empty catalog means "loading", not "none".
    #[must_use]
    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    /// The parsed provider catalog, as enabled on the machine (no project in scope).
    #[must_use]
    pub fn catalog(&self) -> &ModelCatalog {
        &self.catalog
    }

    /// The server's settings: provider instances, project overrides and the rest. `None` until
    /// a snapshot arrived.
    #[must_use]
    pub fn settings(&self) -> Option<&conn_contract::ServerSettings> {
        self.settings.as_ref()
    }

    /// The catalog with each instance enabled as `project_id` sees it
    /// (`providerInstanceEntriesFor` -> `applyProviderInstanceSettings`): a project's override,
    /// else the machine setting. A server that sends no `providerInstances` keeps the flags
    /// of its snapshot. The environment's model preferences apply.
    #[must_use]
    pub fn catalog_for_project(&self, project_id: Option<&str>) -> ModelCatalog {
        let items: Vec<Option<ServerProvidersItemItem>> = self
            .providers
            .iter()
            .map(|provider| {
                let mut provider = provider.clone();
                if let Some(settings) = self
                    .settings
                    .as_ref()
                    .filter(|settings| settings.provider_instances.is_some())
                {
                    provider.enabled = crate::provider_settings::resolve_project_instance_enabled(
                        settings,
                        project_id,
                        &provider.instance_id,
                    );
                }
                Some(provider)
            })
            .collect();
        let preferences = self
            .settings
            .as_ref()
            .map(ModelPreferences::from_settings)
            .unwrap_or_default();
        ModelCatalog::from_providers(&items).with_preferences(preferences)
    }

    /// Every provider as the server sent it, in server order.
    #[must_use]
    pub fn providers(&self) -> &[ServerProvidersItemItem] {
        &self.providers
    }

    /// One provider as the server sent it.
    #[must_use]
    pub fn provider(&self, instance_id: &str) -> Option<&ServerProvidersItemItem> {
        self.providers
            .iter()
            .find(|provider| provider.instance_id == instance_id)
    }

    /// `ServerConfig.managedPolicy`: what an administrator's policy locks, or `None` when the
    /// environment is unmanaged.
    #[must_use]
    pub fn managed_policy(&self) -> Option<&conn_contract::ManagedPolicySummary> {
        self.managed_policy.as_ref()
    }

    /// `ServerConfig.scratchWorkspaceRoot`.
    #[must_use]
    pub fn scratch_workspace_root(&self) -> Option<&str> {
        self.scratch_workspace_root.as_deref()
    }

    /// `environment.capabilities.modelCatalogRefresh`: the server honours `modelCatalogOnly`.
    /// An older one drops the field and would probe every provider.
    #[must_use]
    pub fn supports_model_catalog_refresh(&self) -> bool {
        self.model_catalog_refresh
    }

    /// Applies one stream event.
    pub fn apply(&mut self, event: ServerConfigStreamEvent) -> ServerConfigChange {
        match event {
            ServerConfigStreamEvent::Snapshot(snapshot) => self.load_config(&snapshot.config),
            ServerConfigStreamEvent::ProviderStatuses(statuses) => {
                let next = statuses.payload.providers.into_iter().flatten().collect();
                self.set_providers(next)
            }
            ServerConfigStreamEvent::ProviderStatusDeltas(deltas) => {
                let next = apply_provider_deltas(&self.providers, &deltas.payload.providers);
                self.set_providers(next)
            }
            ServerConfigStreamEvent::SettingsUpdated(updated) => {
                self.set_settings(updated.payload.settings)
            }
            ServerConfigStreamEvent::KeybindingsUpdated(_)
            | ServerConfigStreamEvent::EnvironmentThemesUpdated(_)
            | ServerConfigStreamEvent::UsageLimitSourcesUpdated(_) => ServerConfigChange::default(),
        }
    }

    /// Replaces the state with a whole `ServerConfig` (a `snapshot`, or `server.getConfig`).
    pub fn load_config(&mut self, config: &ServerConfig) -> ServerConfigChange {
        let was_loaded = std::mem::replace(&mut self.loaded, true);
        let scratch = config.scratch_workspace_root.clone();
        let refresh = config.environment.capabilities.model_catalog_refresh == Some(true);
        let config_changed = !was_loaded
            || scratch != self.scratch_workspace_root
            || refresh != self.model_catalog_refresh
            || config.managed_policy != self.managed_policy;
        self.scratch_workspace_root = scratch;
        self.model_catalog_refresh = refresh;
        self.managed_policy.clone_from(&config.managed_policy);
        let settings_changed = self.settings.as_ref() != Some(&config.settings);
        self.settings = Some(config.settings.clone());
        let mut change = self.set_providers(config.providers.iter().flatten().cloned().collect());
        if settings_changed && !change.providers_changed {
            self.catalog = self.catalog_for_project(None);
        }
        change.settings_changed = settings_changed;
        change.config_changed = config_changed;
        if !was_loaded {
            change.providers_changed = true;
        }
        change
    }

    fn set_providers(&mut self, mut next: Vec<ServerProvidersItemItem>) -> ServerConfigChange {
        with_held_provider_catalogs(&self.providers, &mut next);
        if next == self.providers {
            return ServerConfigChange::default();
        }
        self.providers = next;
        self.catalog = self.catalog_for_project(None);
        ServerConfigChange {
            providers_changed: true,
            ..ServerConfigChange::default()
        }
    }

    /// `settingsUpdated`: new settings can switch instances on or off.
    fn set_settings(&mut self, settings: conn_contract::ServerSettings) -> ServerConfigChange {
        if self.settings.as_ref() == Some(&settings) {
            return ServerConfigChange::default();
        }
        self.settings = Some(settings);
        self.catalog = self.catalog_for_project(None);
        ServerConfigChange {
            settings_changed: true,
            ..ServerConfigChange::default()
        }
    }
}

/// `withHeldProviderCatalogs`: a provider sent with a catalog digest comes without its slash
/// commands and skills. Keep the lists this client holds until it loads the ones the digest
/// stands for.
fn with_held_provider_catalogs(
    previous: &[ServerProvidersItemItem],
    next: &mut [ServerProvidersItemItem],
) {
    for provider in next {
        if provider.catalog_digest.is_none() || provider.loaded_catalog_digest.is_some() {
            continue;
        }
        let Some(held) = previous
            .iter()
            .find(|candidate| candidate.instance_id == provider.instance_id)
        else {
            continue;
        };
        provider.slash_commands.clone_from(&held.slash_commands);
        provider.skills.clone_from(&held.skills);
        provider
            .loaded_catalog_digest
            .clone_from(&held.loaded_catalog_digest);
    }
}

/// `applyServerProviderDeltas`: each delta leaves out the models, slash commands and skills
/// the reader already holds. The result lists the deltas' providers, in their order. A provider
/// whose models this reader never held cannot be rebuilt, so it is dropped like an unreadable one.
fn apply_provider_deltas(
    previous: &[ServerProvidersItemItem],
    deltas: &[Option<conn_contract::ServerConfigProviderStatusDeltasPayloadProvidersItem>],
) -> Vec<ServerProvidersItemItem> {
    deltas
        .iter()
        .flatten()
        .filter_map(|delta| {
            let base = previous
                .iter()
                .find(|candidate| candidate.instance_id == delta.instance_id);
            let mut value = serde_json::to_value(delta).ok()?;
            let object = value.as_object_mut()?;
            if delta.models.is_none() {
                let held = base?;
                object.insert(
                    "models".to_owned(),
                    serde_json::to_value(&held.models).ok()?,
                );
            }
            if delta.slash_commands.is_none()
                && let Some(held) = base.and_then(|b| b.slash_commands.as_ref())
            {
                object.insert("slashCommands".to_owned(), serde_json::to_value(held).ok()?);
            }
            if delta.skills.is_none()
                && let Some(held) = base.and_then(|b| b.skills.as_ref())
            {
                object.insert("skills".to_owned(), serde_json::to_value(held).ok()?);
            }
            serde_json::from_value(value).ok()
        })
        .collect()
}

#[cfg(test)]
mod live_tests {
    use serde_json::{Value, json};

    use super::*;

    /// A real `subscribeServerConfig` snapshot (recorded from a Conn server, trimmed to Codex,
    /// Claude and a disabled Antigravity).
    fn snapshot_json() -> Value {
        serde_json::from_str(include_str!(
            "../tests/fixtures/server-config-snapshot.json"
        ))
        .expect("fixture is JSON")
    }

    fn event(value: Value) -> ServerConfigStreamEvent {
        serde_json::from_value(value).expect("event decodes")
    }

    fn loaded() -> ServerConfigState {
        let mut state = ServerConfigState::new();
        state.apply(event(snapshot_json()));
        state
    }

    fn provider_json(id: &str) -> Value {
        snapshot_json()["config"]["providers"]
            .as_array()
            .and_then(|all| all.iter().find(|p| p["instanceId"] == id))
            .cloned()
            .expect("provider in fixture")
    }

    #[test]
    fn snapshot_fills_the_catalog_and_lists_every_instance() {
        let state = loaded();
        assert!(state.is_loaded());
        let ids: Vec<_> = state
            .catalog()
            .providers
            .iter()
            .map(|g| g.instance_id.as_str())
            .collect();
        assert_eq!(
            ids,
            ["codex", "claudeAgent"],
            "a disabled, model-less one is skipped"
        );
        assert_eq!(
            state.catalog().driver_for_instance("antigravity"),
            Some("antigravity"),
            "but the lookup still knows it"
        );
        assert!(state.scratch_workspace_root().is_some());
    }

    #[test]
    fn provider_statuses_bring_antigravity_models_after_its_first_session() {
        let mut state = loaded();
        assert!(
            !state
                .catalog()
                .providers
                .iter()
                .any(|group| group.driver == "antigravity"),
            "disabled and model-less: not in the picker yet"
        );
        let mut antigravity = provider_json("antigravity");
        antigravity["enabled"] = json!(true);
        antigravity["installed"] = json!(true);
        antigravity["status"] = json!("ready");
        antigravity["models"] = json!([{
            "slug": "gemini-4-neon", "name": "Gemini 4 Neon", "isCustom": false, "capabilities": null
        }]);
        // Settings turn it on; its provider entry follows once a session started.
        let mut settings = snapshot_json()["config"]["settings"].clone();
        settings["providerInstances"]["antigravity"] =
            json!({ "driver": "antigravity", "enabled": true });
        let change = state.apply(event(json!({
            "version": 1,
            "type": "settingsUpdated",
            "payload": { "settings": settings }
        })));
        assert!(change.settings_changed && !change.providers_changed);
        let change = state.apply(event(json!({
            "version": 1,
            "type": "providerStatuses",
            "payload": { "providers": [provider_json("codex"), antigravity] }
        })));
        assert!(change.providers_changed);
        let models = state.catalog().filtered_models(Some("antigravity"), "");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].slug, "gemini-4-neon");
    }

    #[test]
    fn deltas_keep_the_held_lists_and_drop_unreadable_providers() {
        let mut state = loaded();
        let mut codex = provider_json("codex");
        for key in ["models", "slashCommands", "skills"] {
            codex.as_object_mut().expect("object").remove(key);
        }
        codex["status"] = json!("warning");
        codex["message"] = json!("Codex is rate limited.");
        let mut unknown = provider_json("claudeAgent");
        unknown["instanceId"] = json!("claudeAgent_new");
        unknown.as_object_mut().expect("object").remove("models");
        let change = state.apply(event(json!({
            "version": 1,
            "type": "providerStatusDeltas",
            "payload": { "providers": [codex, unknown] }
        })));
        assert!(change.providers_changed);
        let group = &state.catalog().providers[0];
        assert_eq!(group.models.len(), 2, "models came from the held provider");
        assert_eq!(group.message.as_deref(), Some("Codex is rate limited."));
        assert_eq!(
            state.catalog().providers.len(),
            1,
            "claude is not in the deltas, and the new one had no models to start from"
        );
    }

    #[test]
    fn a_resent_snapshot_changes_nothing() {
        let mut state = loaded();
        let change = state.apply(event(snapshot_json()));
        assert_eq!(change, ServerConfigChange::default());
    }

    #[test]
    fn other_events_are_accepted_and_ignored() {
        let mut state = loaded();
        let change = state.apply(event(json!({
            "version": 1,
            "type": "environmentThemesUpdated",
            "payload": { "themes": [] }
        })));
        assert_eq!(change, ServerConfigChange::default());
        assert_eq!(state.catalog().providers.len(), 2);
    }

    #[test]
    fn custom_instances_resolve_their_driver_name_and_badge() {
        let mut work = provider_json("codex");
        work["instanceId"] = json!("codex_work");
        work["displayName"] = json!("Codex");
        let mut state = ServerConfigState::new();
        let mut snapshot = snapshot_json();
        let providers = snapshot["config"]["providers"]
            .as_array_mut()
            .expect("array");
        providers.push(work);
        snapshot["config"]["settings"]["providerInstances"]["codex_work"] =
            json!({ "driver": "codex" });
        state.apply(event(snapshot));
        let catalog = state.catalog();
        assert_eq!(catalog.driver_for_instance("codex_work"), Some("codex"));
        let info = catalog.instance("codex_work").expect("listed");
        assert_eq!(
            info.display_name, "Codex Work",
            "the id names it, not the driver's name"
        );
        assert!(info.show_badge, "two Codex instances need a badge");
        assert!(catalog.instance("codex").is_some_and(|i| i.show_badge));
        assert!(
            !catalog
                .instance("claudeAgent")
                .is_some_and(|i| i.show_badge)
        );
    }

    #[test]
    fn accent_colours_only_count_as_six_digit_hex() {
        assert_eq!(
            normalize_accent_color(Some(" #12aBef ")).as_deref(),
            Some("#12aBef")
        );
        assert_eq!(normalize_accent_color(Some("red")), None);
        assert_eq!(normalize_accent_color(Some("#fff")), None);
        assert_eq!(normalize_accent_color(None), None);
    }

    fn banner_for(mut provider: Value) -> Option<ProviderBanner> {
        let item: ServerProvidersItemItem = serde_json::from_value({
            provider["enabled"] = json!(true);
            provider
        })
        .expect("provider decodes");
        ModelCatalog::from_providers(&[Some(item)])
            .providers
            .first()
            .and_then(ProviderGroup::banner)
    }

    #[test]
    fn banner_follows_conns_rules() {
        assert_eq!(banner_for(provider_json("codex")), None, "ready needs none");

        let mut error = provider_json("codex");
        error["status"] = json!("error");
        error["message"] = json!("codex is not logged in");
        error["auth"]["status"] = json!("unauthenticated");
        let banner = banner_for(error).expect("an error raises it");
        assert!(
            banner.title.ends_with(" is unauthenticated"),
            "{}",
            banner.title
        );
        assert_eq!(banner.message, "codex is not logged in");
        assert!(!banner.warning);
        assert!(
            banner
                .key
                .starts_with("codex\u{0}error\u{0}unauthenticated")
        );

        let mut unchecked = provider_json("antigravity");
        unchecked["installed"] = json!(true);
        unchecked["status"] = json!("warning");
        unchecked["auth"]["status"] = json!("unknown");
        assert_eq!(
            banner_for(unchecked),
            None,
            "Antigravity checks credentials at session start"
        );
    }

    #[test]
    fn status_message_points_at_setup_only_when_there_is_one() {
        let mut antigravity = provider_json("antigravity");
        antigravity["installed"] = json!(true);
        antigravity["status"] = json!("error");
        antigravity["auth"]["status"] = json!("unauthenticated");
        antigravity
            .as_object_mut()
            .expect("object")
            .remove("message");
        let banner = banner_for(antigravity).expect("raised");
        assert_eq!(
            banner.message,
            "Open provider setup to sign in with Google."
        );
        assert!(banner.offers_setup);

        let mut codex = provider_json("codex");
        codex["status"] = json!("error");
        codex["auth"]["status"] = json!("unauthenticated");
        codex["message"] = Value::Null;
        codex.as_object_mut().expect("object").remove("message");
        let banner = banner_for(codex).expect("raised");
        assert_eq!(banner.message, "Sign in via the CLI to authenticate again.");
        assert!(!banner.offers_setup);
    }

    #[test]
    fn update_required_models_name_the_version_that_runs_them() {
        let with_models = |id: &str, models: Value| {
            let mut provider = provider_json(id);
            provider["updateRequiredModels"] = models;
            let item: ServerProvidersItemItem =
                serde_json::from_value(provider).expect("provider decodes");
            ModelCatalog::from_providers(&[Some(item)])
                .providers
                .remove(0)
        };
        let codex = with_models(
            "codex",
            json!([
                { "slug": "gpt-7", "name": "GPT-7", "minVersion": "0.170.0" },
                { "slug": "gpt-7-pro", "name": "GPT-7 Pro", "minVersion": "v0.171.2" },
            ]),
        );
        assert_eq!(
            codex.update_required_notice("").as_deref(),
            Some("Update the Codex CLI to v0.171.2 or newer to use GPT-7 and GPT-7 Pro.")
        );
        assert_eq!(
            codex.update_required_notice(" pro ").as_deref(),
            Some("Update the Codex CLI to v0.171.2 or newer to use GPT-7 Pro.")
        );
        assert_eq!(codex.update_required_notice("sonnet"), None);
        let claude = with_models(
            "claudeAgent",
            json!([
                { "slug": "a", "name": "A", "minVersion": "2.1.0" },
                { "slug": "b", "name": "B", "minVersion": "2.0.0" },
                { "slug": "c", "name": "C", "minVersion": "2.0.5" },
            ]),
        );
        assert_eq!(
            claude.update_required_notice("").as_deref(),
            Some("Update Claude Code to v2.1.0 or newer to use A, B, and C.")
        );
    }

    #[test]
    fn semver_compares_numbers_then_prereleases() {
        use std::cmp::Ordering::{Equal, Greater, Less};
        assert_eq!(compare_semver("0.171.2", "0.170.9"), Greater);
        assert_eq!(compare_semver("v1.2", "1.2.0"), Equal);
        assert_eq!(compare_semver("1.0.0-rc.1", "1.0.0"), Less);
        assert_eq!(compare_semver("1.0.0-rc.2", "1.0.0-rc.10"), Less);
        assert_eq!(compare_semver("1.0.0+build", "1.0.0"), Equal);
    }

    fn settings_event(codex: bool, claude: bool) -> ServerConfigStreamEvent {
        let mut settings = snapshot_json()["config"]["settings"].clone();
        settings["providerInstances"]["codex"] = json!({ "driver": "codex", "enabled": codex });
        settings["providerInstances"]["claudeAgent"] =
            json!({ "driver": "claudeAgent", "enabled": claude });
        event(
            json!({ "version": 1, "type": "settingsUpdated", "payload": { "settings": settings } }),
        )
    }

    #[test]
    fn the_composer_provider_falls_back_and_then_offers_setup() {
        let mut state = loaded();
        let pick = |state: &ServerConfigState, candidates: &[Option<&str>]| {
            state.catalog().resolve_selection(candidates)
        };
        assert_eq!(
            pick(&state, &[Some("claudeAgent")]).selected.as_deref(),
            Some("claudeAgent")
        );
        assert_eq!(
            pick(&state, &[None, Some("antigravity")])
                .selected
                .as_deref(),
            Some("codex"),
            "a disabled instance gives way to the first ready one"
        );
        state.apply(settings_event(false, false));
        let none = pick(&state, &[Some("codex")]);
        assert!(none.none_available && none.selected.is_none());
        assert_eq!(
            none.setup_instance.as_deref(),
            Some("codex"),
            "the one asked for"
        );
        let anything = pick(&state, &[]);
        assert!(anything.none_available);
        assert_eq!(
            anything.setup_instance.as_deref(),
            Some("antigravity"),
            "else the first instance with a setup path"
        );
    }

    #[test]
    fn a_project_override_switches_an_instance_off_for_that_project() {
        let mut state = loaded();
        let mut settings = snapshot_json()["config"]["settings"].clone();
        settings["projectSettingsOverrides"] = json!({
            "p1": { "providerInstances": { "codex": { "enabled": false } } }
        });
        state.apply(event(json!({
            "version": 1, "type": "settingsUpdated", "payload": { "settings": settings }
        })));
        let ready = |catalog: &ModelCatalog| -> Vec<String> {
            catalog
                .providers
                .iter()
                .filter(|g| g.ready)
                .map(|g| g.instance_id.clone())
                .collect()
        };
        assert_eq!(ready(state.catalog()), ["codex", "claudeAgent"]);
        assert_eq!(
            ready(&state.catalog_for_project(Some("p1"))),
            ["claudeAgent"]
        );
        assert_eq!(
            ready(&state.catalog_for_project(Some("p2"))),
            ["codex", "claudeAgent"]
        );
    }

    #[test]
    fn model_preferences_hide_order_and_favor_models_in_the_picker() {
        let mut state = loaded();
        let (first, second) = ("gpt-6.1-sol", "gpt-6-astra");
        let mut settings = snapshot_json()["config"]["settings"].clone();
        settings["providerModelPreferences"] = json!({
            "codex": { "hiddenModels": [first], "modelOrder": [second] },
            "claudeAgent": { "modelOrder": ["claude-sonnet-5-5"] },
        });
        settings["favorites"] = json!([{ "provider": "codex", "model": second }]);
        state.apply(event(json!({
            "version": 1, "type": "settingsUpdated", "payload": { "settings": settings }
        })));
        let catalog = state.catalog();
        assert_eq!(
            catalog.providers[0].models[0].slug, second,
            "the saved order leads"
        );
        assert_eq!(catalog.providers[1].models[0].slug, "claude-sonnet-5-5");
        let listed: Vec<&str> = catalog
            .filtered_models(Some("codex"), "")
            .iter()
            .map(|m| m.slug.as_str())
            .collect();
        assert_eq!(listed, [second], "hidden models leave the picker");
        let searched: Vec<&str> = catalog
            .filtered_models(None, "s")
            .iter()
            .map(|m| m.slug.as_str())
            .collect();
        assert_eq!(searched.first(), Some(&second), "favorites lead a search");
        assert!(
            catalog.find_model(Some("codex"), first).is_some(),
            "a hidden model stays findable for threads that use it"
        );
        assert_ne!(
            catalog.default_model().map(|m| m.slug.as_str()),
            Some(first)
        );
        let favorites: Vec<&str> = catalog
            .filtered_models(Some(FAVORITES_TAB), "")
            .iter()
            .map(|m| m.slug.as_str())
            .collect();
        assert_eq!(favorites, [second]);
        assert_eq!(
            catalog.initial_picker_tab(Some("codex")).as_deref(),
            Some(FAVORITES_TAB)
        );
        assert_eq!(
            loaded()
                .catalog()
                .initial_picker_tab(Some("codex"))
                .as_deref(),
            Some("codex"),
            "without favorites the active provider opens"
        );
    }

    #[test]
    fn a_server_without_provider_instances_keeps_its_own_enabled_flags() {
        let mut snapshot = snapshot_json();
        snapshot["config"]["settings"]
            .as_object_mut()
            .expect("settings")
            .remove("providerInstances");
        let mut state = ServerConfigState::new();
        state.apply(event(snapshot));
        assert_eq!(state.catalog().providers.len(), 2);
    }

    #[test]
    fn version_labels_and_compatibility_notes() {
        assert_eq!(
            provider_version_label(Some("agy_acp_server_20261104_17_rc1")).as_deref(),
            Some("2026-11-04 rc1")
        );
        assert_eq!(
            provider_version_label(Some("1.2.3")).as_deref(),
            Some("v1.2.3")
        );
        assert_eq!(
            provider_version_label(Some("nightly")).as_deref(),
            Some("nightly")
        );
        let advisory = conn_contract::ServerProvidersItemItemCompatibilityAdvisory {
            status: ServerProviderCompatibilityStatus::Broken,
            latest_version_status: None,
            message: None,
            recommended_version: Some("2.0.1".to_owned()),
            recommended_range: None,
        };
        assert_eq!(
            compatibility_note(&advisory).as_deref(),
            Some("Known broken version \u{b7} Use v2.0.1 for full support.")
        );
    }
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

    /// What the live server sends for Antigravity before any session started: installed, signed
    /// in unchecked, a warning with the account message, and no models.
    fn unchecked_antigravity() -> Option<ServerProvidersItemItem> {
        let mut provider = sample_provider("antigravity", "antigravity", "Antigravity", vec![]);
        if let Some(p) = provider.as_mut() {
            p.status = ServerProviderState::Warning;
            p.auth.status = ServerProviderAuthStatus::Unknown;
            p.message =
                Some("Antigravity is installed. Google account access is not checked yet.".into());
        }
        provider
    }

    #[test]
    fn rail_lists_antigravity_and_grok_in_server_order_like_conn() {
        let providers = vec![
            sample_provider(
                "claudeAgent",
                "claudeAgent",
                "Claude",
                vec![("opus", "Opus")],
            ),
            sample_provider("codex", "codex", "Codex", vec![("gpt-6", "GPT-6")]),
            unchecked_antigravity(),
            sample_provider("grok", "grok", "Grok", vec![("grok-4.7", "Grok 4.7")]),
        ];
        let catalog = ModelCatalog::from_providers(&providers);
        let rail: Vec<_> = catalog
            .picker_providers()
            .map(|p| p.driver.as_str())
            .collect();
        assert_eq!(rail, ["claudeAgent", "codex", "antigravity", "grok"]);

        let grok = catalog.filtered_models(Some("grok"), "");
        assert_eq!(grok.len(), 1, "Grok lists its models");
        assert_eq!(grok[0].driver, "grok", "kept as its own driver");
    }

    #[test]
    fn unchecked_antigravity_says_why_instead_of_no_models() {
        let catalog = ModelCatalog::from_providers(&[unchecked_antigravity()]);
        let group = &catalog.providers[0];
        assert!(!group.ready, "a warning without sub-providers is not ready");
        assert!(group.offers_setup(), "Antigravity always has a setup path");
        assert!(!group.rail_disabled(), "so its rail icon stays selectable");
        assert!(catalog.filtered_models(Some("antigravity"), "").is_empty());
        let notice = "Antigravity is installed. Google account access is not checked yet.";
        assert_eq!(group.setup_notice().as_deref(), Some(notice));
        assert_eq!(
            group.rail_label(),
            format!("Antigravity: Limited. {notice}"),
            "the tooltip carries the reason, as Conn's describeUnavailableInstance"
        );
    }

    #[test]
    fn unready_provider_without_setup_is_dimmed_and_lists_no_models() {
        let mut codex = sample_provider("codex", "codex", "Codex", vec![("gpt-6", "GPT-6")]);
        if let Some(p) = codex.as_mut() {
            p.status = ServerProviderState::Error;
            p.message = Some("codex is not logged in".into());
        }
        let catalog = ModelCatalog::from_providers(&[codex]);
        let group = &catalog.providers[0];
        assert!(
            group.rail_disabled(),
            "nothing to set up: blocked like Conn"
        );
        assert_eq!(
            group.rail_label(),
            "Codex: Unavailable. codex is not logged in"
        );
        assert_eq!(group.setup_notice(), None);
        assert!(catalog.filtered_models(None, "gpt").is_empty());
    }

    #[test]
    fn disabled_providers_stay_off_the_rail_and_defaults_lead_their_driver() {
        let mut off = sample_provider("grok", "grok", "Grok", vec![("grok-4.7", "Grok 4.7")]);
        if let Some(p) = off.as_mut() {
            p.enabled = false;
        }
        let providers = vec![
            sample_provider(
                "codex-work",
                "codex",
                "Codex Work",
                vec![("gpt-6", "GPT-6")],
            ),
            sample_provider(
                "claudeAgent",
                "claudeAgent",
                "Claude",
                vec![("opus", "Opus")],
            ),
            sample_provider("codex", "codex", "Codex", vec![("gpt-6", "GPT-6")]),
            off,
        ];
        let catalog = ModelCatalog::from_providers(&providers);
        let rail: Vec<_> = catalog
            .picker_providers()
            .map(|p| p.instance_id.as_str())
            .collect();
        assert_eq!(rail, ["codex", "codex-work", "claudeAgent"]);
    }

    #[test]
    fn driver_labels_fall_back_like_conn() {
        assert_eq!(format_driver_name("grok"), "Grok");
        assert_eq!(format_driver_name("someNewAgent"), "Some New Agent");
        assert_eq!(format_driver_name("open_router"), "Open Router");
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
            is_custom: false,
            has_capabilities: true,
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
