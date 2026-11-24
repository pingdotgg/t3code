//! Settings → Terminal: the terminal's font, spacing and cursor.
//!
//! Web Conn keeps `fontFamilyTerminal`, `fontSizeTerminal` and `lineHeightTerminal` as client
//! settings (`packages/contracts/src/settings.ts`, `TypographySettings.tsx`); this model has the
//! same three, with the same ranges, plus the font weight, letter spacing and cursor that a
//! terminal needs. Pure and GPUI-free; the desktop app keeps it in a small JSON file.

use serde::{Deserialize, Serialize};

/// `MIN_TERMINAL_FONT_SIZE` / `MAX_TERMINAL_FONT_SIZE`.
pub const MIN_FONT_SIZE: f32 = 8.0;
pub const MAX_FONT_SIZE: f32 = 20.0;
/// `MIN_TERMINAL_LINE_HEIGHT` / `MAX_TERMINAL_LINE_HEIGHT` (a multiple of the font size).
pub const MIN_LINE_HEIGHT: f32 = 1.0;
pub const MAX_LINE_HEIGHT: f32 = 2.0;
/// Extra space after each glyph, in pixels.
pub const MIN_LETTER_SPACING: f32 = -2.0;
pub const MAX_LETTER_SPACING: f32 = 4.0;

/// The font weight is a number from `MIN_FONT_WEIGHT` to `MAX_FONT_WEIGHT` in steps of
/// `FONT_WEIGHT_STEP`: the slider's range for a variable font. A static family offers only the
/// weights it has, from [`FONT_WEIGHTS`].
pub const MIN_FONT_WEIGHT: u16 = 0;
pub const MAX_FONT_WEIGHT: u16 = 900;
pub const FONT_WEIGHT_STEP: u16 = 25;

/// The named weights (CSS numbers). A static family's segmented choice lists those it has.
pub const FONT_WEIGHTS: [(u16, &str); 9] = [
    (100, "Thin"),
    (200, "Extra Light"),
    (300, "Light"),
    (400, "Regular"),
    (500, "Medium"),
    (600, "Semibold"),
    (700, "Bold"),
    (800, "Extra Bold"),
    (900, "Black"),
];

/// The name of a named weight, or `None` for a value between names.
#[must_use]
pub fn weight_name(weight: u16) -> Option<&'static str> {
    FONT_WEIGHTS
        .iter()
        .find(|(value, _)| *value == weight)
        .map(|(_, name)| *name)
}

/// `weight` rounded to the nearest step and kept in `MIN_FONT_WEIGHT..=MAX_FONT_WEIGHT`.
#[must_use]
pub fn snap_weight(weight: f32) -> u16 {
    let step = f32::from(FONT_WEIGHT_STEP);
    let snapped = if weight.is_finite() {
        (weight / step).round() * step
    } else {
        400.0
    };
    snapped.clamp(f32::from(MIN_FONT_WEIGHT), f32::from(MAX_FONT_WEIGHT)) as u16
}

/// `weight` kept inside a variable font's weight axis (`min..=max`, in CSS units), on the step.
/// The axis ends are kept exactly even when they are not on a step.
#[must_use]
pub fn clamp_weight_to_axis(weight: u16, min: f32, max: f32) -> u16 {
    let wanted = f32::from(weight);
    if wanted <= min {
        return min.ceil() as u16;
    }
    if wanted >= max {
        return max.floor() as u16;
    }
    weight
}

/// The weight in `available` nearest to `weight` (ties go lighter), for a static family; `weight`
/// itself when the family lists none.
#[must_use]
pub fn nearest_weight(weight: u16, available: &[u16]) -> u16 {
    available
        .iter()
        .copied()
        .min_by_key(|have| (have.abs_diff(weight), *have))
        .unwrap_or(weight)
}

/// Reads the weight from a settings file, which has held a number (`400`), a decimal, or a name
/// (`"semibold"`, `"Bold"`) or a digit string. Anything else is the regular weight.
fn weight_from_json<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u16, D::Error> {
    use serde_json::Value;
    let value = Value::deserialize(deserializer)?;
    let weight = match &value {
        Value::Number(number) => number.as_f64().map(|n| n as f32),
        Value::String(text) => {
            let text = text.trim();
            text.parse::<f32>().ok().or_else(|| {
                let key: String = text
                    .chars()
                    .filter(|c| c.is_alphanumeric())
                    .collect::<String>()
                    .to_ascii_lowercase();
                FONT_WEIGHTS
                    .iter()
                    .find(|(_, name)| {
                        name.chars()
                            .filter(|c| c.is_alphanumeric())
                            .collect::<String>()
                            .to_ascii_lowercase()
                            == key
                    })
                    .map(|(value, _)| f32::from(*value))
                    .or(match key.as_str() {
                        "normal" => Some(400.0),
                        "semibold" | "demibold" => Some(600.0),
                        "ultralight" => Some(200.0),
                        "heavy" => Some(800.0),
                        _ => None,
                    })
            })
        }
        _ => None,
    };
    Ok(snap_weight(weight.unwrap_or(400.0)))
}

/// The cursor's shape.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    #[default]
    Block,
    Bar,
    Underline,
}

impl CursorStyle {
    pub const ALL: [Self; 3] = [Self::Block, Self::Bar, Self::Underline];

    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Block => "Block",
            Self::Bar => "Bar",
            Self::Underline => "Underline",
        }
    }
}

/// The terminal's look. Every field has a default, so an older or partial file still loads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalSettings {
    /// A font family name; empty uses the theme's monospace font.
    pub font_family: String,
    pub font_size: f32,
    /// A CSS weight, 0 to 900 in steps of 25. Older files hold 300 to 700 or a name; both load.
    #[serde(deserialize_with = "weight_from_json")]
    pub font_weight: u16,
    /// A multiple of the font size.
    pub line_height: f32,
    /// Extra space after each glyph, in pixels.
    pub letter_spacing: f32,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_family: "JetBrains Mono".to_owned(),
            font_size: 13.0,
            font_weight: 400,
            line_height: 1.35,
            letter_spacing: 0.0,
            cursor_style: CursorStyle::Block,
            cursor_blink: false,
        }
    }
}

impl TerminalSettings {
    /// The settings with every value kept in its range (a hand-edited file may not be).
    #[must_use]
    pub fn clamped(mut self) -> Self {
        let finite = |value: f32, fallback: f32| if value.is_finite() { value } else { fallback };
        let defaults = Self::default();
        self.font_family = self.font_family.trim().to_owned();
        self.font_size =
            finite(self.font_size, defaults.font_size).clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
        self.font_weight = snap_weight(f32::from(self.font_weight));
        self.line_height =
            finite(self.line_height, defaults.line_height).clamp(MIN_LINE_HEIGHT, MAX_LINE_HEIGHT);
        self.letter_spacing = finite(self.letter_spacing, defaults.letter_spacing)
            .clamp(MIN_LETTER_SPACING, MAX_LETTER_SPACING);
        self
    }

    /// Parses a settings file. A broken one gives the defaults; missing fields take theirs.
    #[must_use]
    pub fn from_json(json: &str) -> Self {
        serde_json::from_str::<Self>(json)
            .map(Self::clamped)
            .unwrap_or_default()
    }

    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }

    /// The height of one terminal row in pixels: the font size times the line height.
    #[must_use]
    pub fn cell_height(&self) -> f32 {
        (self.font_size * self.line_height).max(1.0)
    }

    /// The next step of the font size, `delta` steps from now, in range.
    #[must_use]
    pub fn stepped_font_size(&self, delta: f32) -> f32 {
        (self.font_size + delta).clamp(MIN_FONT_SIZE, MAX_FONT_SIZE)
    }

    /// The next line height, one `0.05` step per `delta`, in range and rounded to the step.
    #[must_use]
    pub fn stepped_line_height(&self, delta: f32) -> f32 {
        round_to(
            (self.line_height + delta * 0.05).clamp(MIN_LINE_HEIGHT, MAX_LINE_HEIGHT),
            0.05,
        )
    }

    /// The next letter spacing, one `0.25px` step per `delta`, in range.
    #[must_use]
    pub fn stepped_letter_spacing(&self, delta: f32) -> f32 {
        round_to(
            (self.letter_spacing + delta * 0.25).clamp(MIN_LETTER_SPACING, MAX_LETTER_SPACING),
            0.25,
        )
    }
}

fn round_to(value: f32, step: f32) -> f32 {
    (value / step).round() * step
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_jetbrains_mono_at_web_line_height() {
        let d = TerminalSettings::default();
        assert_eq!(d.font_family, "JetBrains Mono");
        assert_eq!(d.line_height, 1.35);
        assert_eq!(d.font_weight, 400);
        assert_eq!(d.cursor_style, CursorStyle::Block);
        assert!(!d.cursor_blink);
    }

    #[test]
    fn a_partial_file_keeps_defaults_for_the_rest() {
        let s = TerminalSettings::from_json(r#"{"fontSize": 15, "cursorStyle": "bar"}"#);
        assert_eq!(s.font_size, 15.0);
        assert_eq!(s.cursor_style, CursorStyle::Bar);
        assert_eq!(s.font_family, "JetBrains Mono");
    }

    #[test]
    fn a_broken_file_gives_the_defaults() {
        assert_eq!(
            TerminalSettings::from_json("{nope"),
            TerminalSettings::default()
        );
        assert_eq!(TerminalSettings::from_json(""), TerminalSettings::default());
    }

    #[test]
    fn values_are_kept_in_range() {
        let s = TerminalSettings::from_json(
            r#"{"fontSize": 99, "lineHeight": 0.2, "letterSpacing": 50, "fontWeight": 5}"#,
        );
        assert_eq!(s.font_size, MAX_FONT_SIZE);
        assert_eq!(s.line_height, MIN_LINE_HEIGHT);
        assert_eq!(s.letter_spacing, MAX_LETTER_SPACING);
        assert_eq!(s.font_weight, 0, "5 snaps to the lowest step");
    }

    /// Files from before the slider hold the five old weights, or names: they load unchanged.
    #[test]
    fn an_old_saved_weight_migrates_unchanged() {
        for (json, expected) in [
            (r#"{"fontWeight": 300}"#, 300),
            (r#"{"fontWeight": 400}"#, 400),
            (r#"{"fontWeight": 700}"#, 700),
            (r#"{"fontWeight": "semibold"}"#, 600),
            (r#"{"fontWeight": "Light"}"#, 300),
            (r#"{"fontWeight": "650"}"#, 650),
            (r#"{"fontWeight": null}"#, 400),
            (r#"{}"#, 400),
        ] {
            assert_eq!(
                TerminalSettings::from_json(json).font_weight,
                expected,
                "{json}"
            );
        }
        // A new file keeps the exact step, and a hand-edited one is put on the step.
        assert_eq!(
            TerminalSettings::from_json(r#"{"fontWeight": 425}"#).font_weight,
            425
        );
        assert_eq!(
            TerminalSettings::from_json(r#"{"fontWeight": 438}"#).font_weight,
            450
        );
        assert_eq!(
            TerminalSettings::from_json(r#"{"fontWeight": 1200}"#).font_weight,
            900
        );
    }

    #[test]
    fn weights_clamp_to_the_axis_and_pick_the_nearest_static() {
        // JetBrains Mono's `wght` axis is 100 to 800.
        assert_eq!(clamp_weight_to_axis(0, 100.0, 800.0), 100);
        assert_eq!(clamp_weight_to_axis(900, 100.0, 800.0), 800);
        assert_eq!(clamp_weight_to_axis(425, 100.0, 800.0), 425);
        assert_eq!(
            nearest_weight(450, &[400, 500, 600, 700]),
            400,
            "a tie goes lighter"
        );
        assert_eq!(nearest_weight(560, &[400, 500, 600, 700]), 600);
        assert_eq!(nearest_weight(300, &[400, 700]), 400);
        assert_eq!(nearest_weight(300, &[]), 300);
        assert_eq!(weight_name(600), Some("Semibold"));
        assert_eq!(weight_name(425), None);
    }

    #[test]
    fn settings_round_trip_through_json() {
        let s = TerminalSettings {
            font_family: "Menlo".to_owned(),
            font_size: 14.0,
            font_weight: 500,
            line_height: 1.5,
            letter_spacing: 0.5,
            cursor_style: CursorStyle::Underline,
            cursor_blink: true,
        };
        assert_eq!(TerminalSettings::from_json(&s.to_json()), s);
    }

    #[test]
    fn steps_stay_in_range_and_on_the_step() {
        let s = TerminalSettings::default();
        assert_eq!(s.stepped_font_size(1.0), 14.0);
        assert_eq!(
            TerminalSettings {
                font_size: 20.0,
                ..s.clone()
            }
            .stepped_font_size(1.0),
            20.0
        );
        assert!((s.stepped_line_height(1.0) - 1.40).abs() < 1e-4);
        assert!(
            (TerminalSettings {
                line_height: 2.0,
                ..s.clone()
            }
            .stepped_line_height(1.0)
                - 2.0)
                .abs()
                < 1e-4
        );
        assert_eq!(s.stepped_letter_spacing(-1.0), -0.25);
        assert_eq!(
            TerminalSettings {
                letter_spacing: -2.0,
                ..s
            }
            .stepped_letter_spacing(-1.0),
            -2.0
        );
    }

    #[test]
    fn cell_height_is_size_times_line_height() {
        let s = TerminalSettings {
            font_size: 10.0,
            line_height: 1.5,
            ..TerminalSettings::default()
        };
        assert_eq!(s.cell_height(), 15.0);
    }
}
