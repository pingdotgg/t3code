//! The custom model editor of Settings → Providers → Models: rename a custom model and set
//! the options the composer shows for it (`CustomModelEditor.tsx`, `customModelEditor.logic.ts`,
//! `customModelSaves.logic.ts`, `@t3tools/shared/model` `toCustomModelSetting`).
//!
//! Pure and GPUI-free. A [`Draft`] holds the text of every field, so a view keeps one input per
//! field, writes each change here, and renders from it. [`Draft::entry`] is the value the
//! instance's `config.customModels` stores.

use serde_json::{Map, Value, json};

use crate::providers::{ModelOptionDescriptor, SelectChoice};

/// How an option is picked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionKind {
    /// One of several choices.
    Select,
    /// On or off.
    Boolean,
}

/// A choice of a select option.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    /// Identifies the row while it is edited; never stored.
    pub key: u64,
    pub id: String,
    pub label: String,
    pub is_default: bool,
    pub description: Option<String>,
}

/// An option of the model, as the form holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Descriptor {
    /// Identifies the row while it is edited; never stored.
    pub key: u64,
    pub kind: OptionKind,
    pub id: String,
    pub label: String,
    pub choices: Vec<Choice>,
    pub current_boolean: Option<bool>,
    pub description: Option<String>,
}

/// One choice of a preset option.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PresetChoice {
    pub id: &'static str,
    pub label: &'static str,
    pub is_default: bool,
}

/// An option a driver is known to read (`DESCRIPTOR_PRESETS_BY_KIND`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: OptionKind,
    pub choices: &'static [PresetChoice],
}

const fn choice(id: &'static str, label: &'static str, is_default: bool) -> PresetChoice {
    PresetChoice {
        id,
        label,
        is_default,
    }
}

const EFFORT: &[PresetChoice] = &[
    choice("low", "Low", false),
    choice("medium", "Medium", true),
    choice("high", "High", false),
    choice("xhigh", "Extra High", false),
];

const CODEX: &[Preset] = &[
    Preset {
        id: "reasoningEffort",
        label: "Reasoning",
        kind: OptionKind::Select,
        choices: EFFORT,
    },
    Preset {
        id: "serviceTier",
        label: "Speed",
        kind: OptionKind::Select,
        choices: &[
            choice("default", "Standard", true),
            choice("fast", "Fast", false),
        ],
    },
];
const CLAUDE: &[Preset] = &[
    Preset {
        id: "effort",
        label: "Reasoning",
        kind: OptionKind::Select,
        choices: &[
            choice("low", "Low", false),
            choice("medium", "Medium", false),
            choice("high", "High", true),
            choice("xhigh", "Extra High", false),
            choice("max", "Max", false),
        ],
    },
    Preset {
        id: "fastMode",
        label: "Fast Mode",
        kind: OptionKind::Boolean,
        choices: &[],
    },
    Preset {
        id: "thinking",
        label: "Thinking",
        kind: OptionKind::Boolean,
        choices: &[],
    },
];
const CURSOR: &[Preset] = &[
    Preset {
        id: "reasoning",
        label: "Reasoning",
        kind: OptionKind::Select,
        choices: EFFORT,
    },
    Preset {
        id: "fastMode",
        label: "Fast Mode",
        kind: OptionKind::Boolean,
        choices: &[],
    },
    Preset {
        id: "thinking",
        label: "Thinking",
        kind: OptionKind::Boolean,
        choices: &[],
    },
];
const GROK: &[Preset] = &[Preset {
    id: "reasoningEffort",
    label: "Reasoning",
    kind: OptionKind::Select,
    choices: EFFORT,
}];
const PI: &[Preset] = &[Preset {
    id: "thinking",
    label: "Thinking",
    kind: OptionKind::Select,
    choices: &[
        choice("off", "Off", false),
        choice("minimal", "Minimal", false),
        choice("low", "Low", false),
        choice("medium", "Medium", true),
        choice("high", "High", false),
        choice("xhigh", "Extra High", false),
        choice("max", "Max", false),
    ],
}];
const OPENCODE: &[Preset] = &[
    Preset {
        id: "variant",
        label: "Reasoning",
        kind: OptionKind::Select,
        choices: EFFORT,
    },
    Preset {
        id: "agent",
        label: "Agent",
        kind: OptionKind::Select,
        choices: &[
            choice("build", "Build", true),
            choice("plan", "Plan", false),
        ],
    },
];

/// The options `driver` is known to read; none for a driver without presets.
#[must_use]
pub fn presets(driver: &str) -> &'static [Preset] {
    match driver {
        "codex" => CODEX,
        "claudeAgent" => CLAUDE,
        "cursor" => CURSOR,
        "grok" => GROK,
        "pi" => PI,
        "opencode" => OPENCODE,
        _ => &[],
    }
}

/// The model being edited: its name and options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    pub slug: String,
    /// Empty shows the slug.
    pub name: String,
    pub descriptors: Vec<Descriptor>,
    driver: String,
    next_key: u64,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

impl Draft {
    /// The form of the stored custom model `raw` (a slug or `{ slug, name, capabilities }`).
    #[must_use]
    pub fn from_raw(raw: &Value, driver: &str) -> Self {
        let slug = match raw {
            Value::String(slug) => slug.trim().to_owned(),
            other => text(other, "slug").unwrap_or_default().trim().to_owned(),
        };
        let name = text(raw, "name")
            .map(|name| name.trim().to_owned())
            .filter(|name| *name != slug)
            .unwrap_or_default();
        let mut draft = Self {
            slug,
            name,
            descriptors: Vec::new(),
            driver: driver.to_owned(),
            next_key: 0,
        };
        let stored = raw
            .get("capabilities")
            .and_then(|c| c.get("optionDescriptors"))
            .and_then(Value::as_array);
        for descriptor in stored.into_iter().flatten() {
            if let Some(descriptor) = draft.descriptor_from_json(descriptor) {
                draft.descriptors.push(descriptor);
            }
        }
        draft
    }

    /// The driver whose presets the form offers.
    #[must_use]
    pub fn driver(&self) -> &str {
        &self.driver
    }

    fn key(&mut self) -> u64 {
        self.next_key += 1;
        self.next_key
    }

    fn new_choice(&mut self, id: &str, label: &str, is_default: bool) -> Choice {
        Choice {
            key: self.key(),
            id: id.to_owned(),
            label: label.to_owned(),
            is_default,
            description: None,
        }
    }

    /// `descriptorToEditor` for a stored descriptor: choices the runtime injects into the
    /// prompt are left out, since a custom entry has no runtime profile for them.
    fn descriptor_from_json(&mut self, value: &Value) -> Option<Descriptor> {
        let kind = match value.get("type").and_then(Value::as_str)? {
            "select" => OptionKind::Select,
            "boolean" => OptionKind::Boolean,
            _ => return None,
        };
        let injected: Vec<&str> = value
            .get("promptInjectedValues")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let current = text(value, "currentValue");
        let options: Vec<&Value> = if kind == OptionKind::Select {
            value
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|o| !injected.contains(&o.get("id").and_then(Value::as_str).unwrap_or("")))
                .collect()
        } else {
            Vec::new()
        };
        let default_index = options
            .iter()
            .position(|o| text(o, "id") == current && current.is_some())
            .or_else(|| {
                options
                    .iter()
                    .position(|o| o.get("isDefault").and_then(Value::as_bool) == Some(true))
            });
        let choices = options
            .iter()
            .enumerate()
            .map(|(index, option)| Choice {
                key: self.key(),
                id: text(option, "id").unwrap_or_default(),
                label: text(option, "label").unwrap_or_default(),
                is_default: Some(index) == default_index,
                description: text(option, "description"),
            })
            .collect();
        Some(Descriptor {
            key: self.key(),
            kind,
            id: text(value, "id")?,
            label: text(value, "label").unwrap_or_default(),
            choices,
            current_boolean: (kind == OptionKind::Boolean)
                .then(|| value.get("currentValue").and_then(Value::as_bool))
                .flatten(),
            description: text(value, "description"),
        })
    }

    /// The options of a built-in model, for `Copy from...` (`descriptorsFromCapabilities`).
    /// Claude's context window needs suffix mappings a custom entry does not carry.
    pub fn copy_options_from(&mut self, options: &[ModelOptionDescriptor]) {
        let mut copied = Vec::new();
        for option in options {
            if self.driver == "claudeAgent" && option.id() == "contextWindow" {
                continue;
            }
            let descriptor = match option {
                ModelOptionDescriptor::Select {
                    id,
                    label,
                    choices,
                    current_value,
                    prompt_injected,
                    ..
                } => {
                    let kept: Vec<&SelectChoice> = choices
                        .iter()
                        .filter(|c| !prompt_injected.contains(&c.id))
                        .collect();
                    let default_index = kept
                        .iter()
                        .position(|c| Some(&c.id) == current_value.as_ref())
                        .or_else(|| kept.iter().position(|c| c.is_default));
                    Descriptor {
                        key: self.key(),
                        kind: OptionKind::Select,
                        id: id.clone(),
                        label: label.clone(),
                        choices: kept
                            .iter()
                            .enumerate()
                            .map(|(index, c)| Choice {
                                key: self.key(),
                                id: c.id.clone(),
                                label: c.label.clone(),
                                is_default: Some(index) == default_index,
                                description: c.description.clone(),
                            })
                            .collect(),
                        current_boolean: None,
                        description: None,
                    }
                }
                ModelOptionDescriptor::Boolean {
                    id,
                    label,
                    current_value,
                } => Descriptor {
                    key: self.key(),
                    kind: OptionKind::Boolean,
                    id: id.clone(),
                    label: label.clone(),
                    choices: Vec::new(),
                    current_boolean: *current_value,
                    description: None,
                },
            };
            copied.push(descriptor);
        }
        self.descriptors = copied;
    }

    fn descriptor_mut(&mut self, key: u64) -> Option<&mut Descriptor> {
        self.descriptors.iter_mut().find(|d| d.key == key)
    }

    /// `descriptorFromPreset`: adds a known option of the driver.
    pub fn add_preset(&mut self, preset_id: &str) {
        let Some(preset) = presets(&self.driver).iter().find(|p| p.id == preset_id) else {
            return;
        };
        let descriptor = self.descriptor_of(preset);
        self.descriptors.push(descriptor);
    }

    fn descriptor_of(&mut self, preset: &Preset) -> Descriptor {
        Descriptor {
            key: self.key(),
            kind: preset.kind,
            id: preset.id.to_owned(),
            label: preset.label.to_owned(),
            choices: preset
                .choices
                .iter()
                .map(|c| self.new_choice(c.id, c.label, c.is_default))
                .collect(),
            current_boolean: None,
            description: None,
        }
    }

    /// `emptyEditorDescriptor`: a blank option.
    pub fn add_custom_option(&mut self) {
        let key = self.key();
        self.descriptors.push(Descriptor {
            key,
            kind: OptionKind::Select,
            id: String::new(),
            label: String::new(),
            choices: Vec::new(),
            current_boolean: None,
            description: None,
        });
    }

    pub fn remove_option(&mut self, key: u64) {
        self.descriptors.retain(|d| d.key != key);
    }

    /// `applyPresetId`: the option takes a preset's id, label, type and choices, or with `None`
    /// (`Custom...`) clears its id.
    pub fn apply_preset_id(&mut self, key: u64, preset_id: Option<&str>) {
        let Some(preset_id) = preset_id else {
            if let Some(descriptor) = self.descriptor_mut(key) {
                descriptor.id.clear();
            }
            return;
        };
        let Some(preset) = presets(&self.driver).iter().find(|p| p.id == preset_id) else {
            return;
        };
        let choices: Vec<Choice> = preset
            .choices
            .iter()
            .map(|c| self.new_choice(c.id, c.label, c.is_default))
            .collect();
        if let Some(descriptor) = self.descriptor_mut(key) {
            descriptor.id = preset.id.to_owned();
            descriptor.label = preset.label.to_owned();
            descriptor.kind = preset.kind;
            descriptor.choices = choices;
            descriptor.current_boolean = None;
            descriptor.description = None;
        }
    }

    pub fn set_option_id(&mut self, key: u64, id: &str) {
        if let Some(descriptor) = self.descriptor_mut(key) {
            id.clone_into(&mut descriptor.id);
        }
    }

    pub fn set_option_label(&mut self, key: u64, label: &str) {
        if let Some(descriptor) = self.descriptor_mut(key) {
            label.clone_into(&mut descriptor.label);
        }
    }

    pub fn set_option_kind(&mut self, key: u64, kind: OptionKind) {
        if let Some(descriptor) = self.descriptor_mut(key) {
            descriptor.kind = kind;
        }
    }

    pub fn add_choice(&mut self, key: u64) {
        let choice = self.new_choice("", "", false);
        if let Some(descriptor) = self.descriptor_mut(key) {
            descriptor.choices.push(choice);
        }
    }

    pub fn remove_choice(&mut self, key: u64, choice_key: u64) {
        if let Some(descriptor) = self.descriptor_mut(key) {
            descriptor.choices.retain(|c| c.key != choice_key);
        }
    }

    pub fn set_choice_id(&mut self, key: u64, choice_key: u64, id: &str) {
        if let Some(c) = self.choice_mut(key, choice_key) {
            id.clone_into(&mut c.id);
        }
    }

    pub fn set_choice_label(&mut self, key: u64, choice_key: u64, label: &str) {
        if let Some(c) = self.choice_mut(key, choice_key) {
            label.clone_into(&mut c.label);
        }
    }

    /// Making a choice the default clears the others (`updateChoice`).
    pub fn set_choice_default(&mut self, key: u64, choice_key: u64, is_default: bool) {
        if let Some(descriptor) = self.descriptor_mut(key) {
            for c in &mut descriptor.choices {
                if c.key == choice_key {
                    c.is_default = is_default;
                } else if is_default {
                    c.is_default = false;
                }
            }
        }
    }

    fn choice_mut(&mut self, key: u64, choice_key: u64) -> Option<&mut Choice> {
        self.descriptor_mut(key)?
            .choices
            .iter_mut()
            .find(|c| c.key == choice_key)
    }

    /// The preset the option's id names, if any (`idSelectValue`).
    #[must_use]
    pub fn preset_of(&self, descriptor: &Descriptor) -> Option<&'static Preset> {
        presets(&self.driver).iter().find(|p| p.id == descriptor.id)
    }

    /// The presets not yet added.
    #[must_use]
    pub fn unused_presets(&self) -> Vec<&'static Preset> {
        presets(&self.driver)
            .iter()
            .filter(|p| !self.descriptors.iter().any(|d| d.id == p.id))
            .collect()
    }

    /// `validateDraft`: the first problem, as the message under the form.
    #[must_use]
    pub fn problem(&self) -> Option<String> {
        let mut seen_ids: Vec<&str> = Vec::new();
        for (index, descriptor) in self.descriptors.iter().enumerate() {
            let position = index + 1;
            let id = descriptor.id.trim();
            if id.is_empty() {
                return Some(format!("Option {position} needs an id."));
            }
            if seen_ids.contains(&id) {
                return Some(format!("Option {position}: id \"{id}\" is used twice."));
            }
            seen_ids.push(id);
            if descriptor.label.trim().is_empty() {
                return Some(format!("Option {position} needs a label."));
            }
            if descriptor.kind != OptionKind::Select {
                continue;
            }
            if descriptor.choices.is_empty() {
                return Some(format!("Option {position} needs at least one choice."));
            }
            let mut seen_choices: Vec<&str> = Vec::new();
            for choice in &descriptor.choices {
                let choice_id = choice.id.trim();
                if choice_id.is_empty() {
                    return Some(format!("Option {position} has a choice without a value."));
                }
                if seen_choices.contains(&choice_id) {
                    return Some(format!(
                        "Option {position}: choice \"{choice_id}\" is used twice."
                    ));
                }
                seen_choices.push(choice_id);
            }
        }
        None
    }

    fn name_or_slug(&self) -> &str {
        let name = self.name.trim();
        if name.is_empty() { &self.slug } else { name }
    }

    /// `definitionFromDraft` + `toCustomModelSetting`: what `config.customModels` stores for
    /// the model. A model with no new name and no options is its bare slug.
    #[must_use]
    pub fn entry(&self) -> Value {
        let descriptors: Vec<Value> = self
            .descriptors
            .iter()
            .map(|descriptor| {
                let mut out = Map::new();
                out.insert("id".to_owned(), json!(descriptor.id.trim()));
                out.insert("label".to_owned(), json!(descriptor.label.trim()));
                match descriptor.kind {
                    OptionKind::Boolean => {
                        out.insert("type".to_owned(), json!("boolean"));
                        if let Some(description) = &descriptor.description {
                            out.insert("description".to_owned(), json!(description));
                        }
                        if let Some(current) = descriptor.current_boolean {
                            out.insert("currentValue".to_owned(), json!(current));
                        }
                    }
                    OptionKind::Select => {
                        out.insert("type".to_owned(), json!("select"));
                        if let Some(description) = &descriptor.description {
                            out.insert("description".to_owned(), json!(description));
                        }
                        let options: Vec<Value> = descriptor
                            .choices
                            .iter()
                            .map(|choice| {
                                let id = choice.id.trim();
                                let label = choice.label.trim();
                                let mut option = Map::new();
                                option.insert("id".to_owned(), json!(id));
                                option.insert(
                                    "label".to_owned(),
                                    json!(if label.is_empty() { id } else { label }),
                                );
                                if let Some(description) = &choice.description {
                                    option.insert("description".to_owned(), json!(description));
                                }
                                if choice.is_default {
                                    option.insert("isDefault".to_owned(), json!(true));
                                }
                                Value::Object(option)
                            })
                            .collect();
                        let current = descriptor
                            .choices
                            .iter()
                            .find(|c| c.is_default)
                            .map(|c| c.id.trim().to_owned());
                        out.insert("options".to_owned(), Value::Array(options));
                        if let Some(current) = current.filter(|c| !c.is_empty()) {
                            out.insert("currentValue".to_owned(), json!(current));
                        }
                    }
                }
                Value::Object(out)
            })
            .collect();
        let name = self.name_or_slug();
        if name == self.slug && descriptors.is_empty() {
            return json!(self.slug);
        }
        let mut entry = Map::new();
        entry.insert("slug".to_owned(), json!(self.slug));
        if name != self.slug {
            entry.insert("name".to_owned(), json!(name));
        }
        if !descriptors.is_empty() {
            entry.insert(
                "capabilities".to_owned(),
                json!({ "optionDescriptors": descriptors }),
            );
        }
        Value::Object(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored() -> Value {
        json!({
            "slug": "my-model",
            "name": "My model",
            "capabilities": { "optionDescriptors": [
                { "id": "effort", "label": "Reasoning", "type": "select",
                  "options": [
                    { "id": "low", "label": "Low" },
                    { "id": "high", "label": "High", "isDefault": true },
                    { "id": "ultra", "label": "Ultra" } ],
                  "currentValue": "low", "promptInjectedValues": ["ultra"] },
                { "id": "fastMode", "label": "Fast Mode", "type": "boolean", "currentValue": true },
            ] },
        })
    }

    #[test]
    fn a_stored_model_opens_as_a_draft_and_saves_back_as_it_was() {
        let draft = Draft::from_raw(&stored(), "claudeAgent");
        assert_eq!(draft.name, "My model");
        assert_eq!(draft.descriptors.len(), 2);
        let effort = &draft.descriptors[0];
        assert_eq!(
            effort
                .choices
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "high"],
            "a choice the runtime injects into the prompt is not stored as an ordinary option"
        );
        assert_eq!(
            effort
                .choices
                .iter()
                .filter(|c| c.is_default)
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["low"],
            "currentValue picks the default, as in Conn"
        );
        assert_eq!(draft.problem(), None);
        let entry = draft.entry();
        assert_eq!(entry["slug"], "my-model");
        assert_eq!(entry["name"], "My model");
        assert_eq!(
            entry["capabilities"]["optionDescriptors"][0]["currentValue"],
            "low"
        );
        assert_eq!(
            entry["capabilities"]["optionDescriptors"][1]["currentValue"],
            true
        );
    }

    #[test]
    fn a_model_without_a_new_name_or_options_is_its_bare_slug() {
        let mut draft = Draft::from_raw(&json!("plain"), "codex");
        assert_eq!(draft.entry(), json!("plain"));
        draft.name = "plain".to_owned();
        assert_eq!(
            draft.entry(),
            json!("plain"),
            "the slug as a name is no name"
        );
        draft.name = "  Plain!  ".to_owned();
        assert_eq!(draft.entry(), json!({ "slug": "plain", "name": "Plain!" }));
        draft.name.clear();
        draft.add_preset("serviceTier");
        assert_eq!(
            draft.entry()["capabilities"]["optionDescriptors"][0]["options"][0],
            json!({ "id": "default", "label": "Standard", "isDefault": true })
        );
    }

    #[test]
    fn options_come_from_presets_or_by_hand_and_a_choice_default_is_one_at_a_time() {
        let mut draft = Draft::from_raw(&json!("m"), "claudeAgent");
        assert_eq!(draft.unused_presets().len(), 3);
        draft.add_preset("effort");
        draft.add_preset("fastMode");
        assert_eq!(
            draft
                .unused_presets()
                .iter()
                .map(|p| p.id)
                .collect::<Vec<_>>(),
            ["thinking"]
        );
        draft.add_custom_option();
        let (effort, custom) = (draft.descriptors[0].key, draft.descriptors[2].key);
        assert_eq!(draft.descriptors[0].choices.len(), 5);
        assert!(draft.preset_of(&draft.descriptors[0]).is_some());
        assert!(draft.preset_of(&draft.descriptors[2]).is_none());

        let low = draft.descriptors[0].choices[0].key;
        draft.set_choice_default(effort, low, true);
        assert_eq!(
            draft.descriptors[0]
                .choices
                .iter()
                .filter(|c| c.is_default)
                .count(),
            1
        );
        assert!(
            draft.descriptors[0].choices[0].is_default,
            "high lost the default"
        );

        draft.apply_preset_id(custom, Some("thinking"));
        assert_eq!(draft.descriptors[2].kind, OptionKind::Boolean);
        draft.apply_preset_id(custom, None);
        assert_eq!(draft.descriptors[2].id, "");
        draft.remove_option(custom);
        assert_eq!(draft.descriptors.len(), 2);
    }

    #[test]
    fn problems_name_the_option_and_the_choice() {
        let mut draft = Draft::from_raw(&json!("m"), "codex");
        draft.add_custom_option();
        let key = draft.descriptors[0].key;
        assert_eq!(draft.problem().as_deref(), Some("Option 1 needs an id."));
        draft.set_option_id(key, "tier");
        assert_eq!(draft.problem().as_deref(), Some("Option 1 needs a label."));
        draft.set_option_label(key, "Tier");
        assert_eq!(
            draft.problem().as_deref(),
            Some("Option 1 needs at least one choice.")
        );
        draft.add_choice(key);
        assert_eq!(
            draft.problem().as_deref(),
            Some("Option 1 has a choice without a value.")
        );
        let first = draft.descriptors[0].choices[0].key;
        draft.set_choice_id(key, first, "a");
        draft.add_choice(key);
        let second = draft.descriptors[0].choices[1].key;
        draft.set_choice_id(key, second, "a");
        assert_eq!(
            draft.problem().as_deref(),
            Some("Option 1: choice \"a\" is used twice.")
        );
        draft.set_choice_id(key, second, "b");
        assert_eq!(draft.problem(), None);
        draft.add_custom_option();
        let again = draft.descriptors[1].key;
        draft.set_option_id(again, "tier");
        assert_eq!(
            draft.problem().as_deref(),
            Some("Option 2: id \"tier\" is used twice.")
        );
        draft.set_option_kind(key, OptionKind::Boolean);
        draft.remove_option(again);
        assert_eq!(draft.problem(), None, "a toggle needs no choices");
        // A choice with no label stores its value as the label.
        draft.set_option_kind(key, OptionKind::Select);
        assert_eq!(
            draft.entry()["capabilities"]["optionDescriptors"][0]["options"][0]["label"],
            "a"
        );
        draft.remove_choice(key, first);
        assert_eq!(draft.descriptors[0].choices.len(), 1);
    }

    #[test]
    fn copying_from_a_built_in_model_keeps_its_options_but_not_claudes_context_window() {
        let options = vec![
            ModelOptionDescriptor::Select {
                id: "effort".to_owned(),
                label: "Reasoning".to_owned(),
                choices: vec![
                    SelectChoice {
                        id: "low".to_owned(),
                        label: "Low".to_owned(),
                        description: None,
                        is_default: false,
                    },
                    SelectChoice {
                        id: "high".to_owned(),
                        label: "High".to_owned(),
                        description: None,
                        is_default: true,
                    },
                    SelectChoice {
                        id: "ultra".to_owned(),
                        label: "Ultra".to_owned(),
                        description: None,
                        is_default: false,
                    },
                ],
                current_value: None,
                prompt_injected: vec!["ultra".to_owned()],
                reasoning_role: true,
            },
            ModelOptionDescriptor::Select {
                id: "contextWindow".to_owned(),
                label: "Context".to_owned(),
                choices: Vec::new(),
                current_value: None,
                prompt_injected: Vec::new(),
                reasoning_role: false,
            },
            ModelOptionDescriptor::Boolean {
                id: "fastMode".to_owned(),
                label: "Fast Mode".to_owned(),
                current_value: Some(false),
            },
        ];
        let mut claude = Draft::from_raw(&json!("m"), "claudeAgent");
        claude.copy_options_from(&options);
        assert_eq!(
            claude
                .descriptors
                .iter()
                .map(|d| d.id.as_str())
                .collect::<Vec<_>>(),
            ["effort", "fastMode"]
        );
        assert_eq!(claude.descriptors[0].choices.len(), 2);
        let mut codex = Draft::from_raw(&json!("m"), "codex");
        codex.copy_options_from(&options);
        assert_eq!(codex.descriptors.len(), 3, "other drivers keep it");
    }
}
