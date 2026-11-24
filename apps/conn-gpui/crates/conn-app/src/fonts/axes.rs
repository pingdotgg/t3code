//! The weights a font family offers, read from CoreText (Settings → Terminal).
//!
//! A variable font has a `wght` variation axis with a minimum and a maximum, and the weight is
//! any value between. A static family has a face per weight, and only those weights exist. Both
//! are read from the font itself: the embedded JetBrains Mono from its bytes, any other family
//! from the installed faces. Nothing is guessed from the family name.

use std::cell::RefCell;
use std::collections::HashMap;

/// What a family offers for the font weight.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum FamilyWeights {
    /// A variable font with a weight axis: any weight from `min` to `max` (CSS units).
    Variable { min: f32, max: f32 },
    /// A static family: only these weights, ascending.
    Static(Vec<u16>),
    /// No such family is installed: nothing to limit the choice to.
    Unknown,
}

thread_local! {
    static CACHE: RefCell<HashMap<String, FamilyWeights>> = RefCell::new(HashMap::new());
}

/// The weights `family` offers, remembered after the first lookup.
#[must_use]
pub(crate) fn family_weights(family: &str) -> FamilyWeights {
    let key = family.trim().to_owned();
    if let Some(found) = CACHE.with(|cache| cache.borrow().get(&key).cloned()) {
        return found;
    }
    let found = lookup(&key);
    CACHE.with(|cache| cache.borrow_mut().insert(key, found.clone()));
    found
}

/// What one face reports: its weight axis, if any, and its weight.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Face {
    axis: Option<(f32, f32)>,
    weight: u16,
}

/// Folds the faces of a family into what it offers: a variable one makes the family variable.
fn combine(faces: &[Face]) -> FamilyWeights {
    if let Some((min, max)) = faces.iter().find_map(|face| face.axis) {
        return FamilyWeights::Variable { min, max };
    }
    let mut weights: Vec<u16> = faces.iter().map(|face| face.weight).collect();
    weights.sort_unstable();
    weights.dedup();
    if weights.is_empty() {
        FamilyWeights::Unknown
    } else {
        FamilyWeights::Static(weights)
    }
}

/// The CSS weight nearest to CoreText's normalised weight trait (-1 to 1), by the same table
/// font-kit uses to read a face's weight.
fn css_weight_from_trait(normalised: f64) -> u16 {
    const TRAIT: [f64; 9] = [-0.7, -0.5, -0.23, 0.0, 0.2, 0.3, 0.4, 0.6, 0.8];
    let index = TRAIT
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            (normalised - **a)
                .abs()
                .total_cmp(&(normalised - **b).abs())
        })
        .map_or(3, |(index, _)| index);
    (index as u16 + 1) * 100
}

#[cfg(target_os = "macos")]
mod coretext {
    use std::sync::Arc;

    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::data_provider::CGDataProvider;
    use core_graphics::font::CGFont;
    use core_text::font::CTFont;
    use core_text::font_descriptor::TraitAccessors as _;

    use super::{Face, css_weight_from_trait};

    /// The `wght` variation axis tag (`'wght'`).
    const WEIGHT_AXIS_TAG: i64 = 0x7767_6874;

    /// `kCTFontVariationAxisIdentifierKey` and friends, which CoreText spells without `Font`.
    const IDENTIFIER: &str = "NSCTVariationAxisIdentifier";
    const MINIMUM: &str = "NSCTVariationAxisMinimumValue";
    const MAXIMUM: &str = "NSCTVariationAxisMaximumValue";

    /// The face a `CTFont` is: its weight axis (`CTFontCopyVariationAxes`) and its weight trait.
    pub(super) fn face_of(font: &CTFont) -> Face {
        let identifier = CFString::from_static_string(IDENTIFIER);
        let minimum = CFString::from_static_string(MINIMUM);
        let maximum = CFString::from_static_string(MAXIMUM);
        let axis = font.get_variation_axes().and_then(|axes| {
            axes.iter().find_map(|axis| {
                let number = |key: &CFString| {
                    axis.find(key)
                        .and_then(|value| value.downcast::<CFNumber>())
                        .and_then(|value| value.to_f64())
                };
                if number(&identifier)? as i64 != WEIGHT_AXIS_TAG {
                    return None;
                }
                Some((number(&minimum)? as f32, number(&maximum)? as f32))
            })
        });
        Face {
            axis,
            weight: css_weight_from_trait(font.all_traits().normalized_weight()),
        }
    }

    /// The face in a font file's bytes.
    pub(super) fn face_of_bytes(bytes: &[u8]) -> Option<Face> {
        let provider = CGDataProvider::from_buffer(Arc::new(bytes.to_vec()));
        let font = CGFont::from_data_provider(provider).ok()?;
        Some(face_of(&core_text::font::new_from_CGFont(&font, 16.0)))
    }

    /// The installed faces of `family`; none when no such family is installed.
    pub(super) fn installed_faces(family: &str) -> Vec<Face> {
        let Some(collection) = core_text::font_collection::create_for_family(family) else {
            return Vec::new();
        };
        let Some(descriptors) = collection.get_descriptors() else {
            return Vec::new();
        };
        descriptors
            .iter()
            .map(|descriptor| face_of(&core_text::font::new_from_descriptor(&descriptor, 16.0)))
            .collect()
    }
}

#[cfg(target_os = "macos")]
fn lookup(family: &str) -> FamilyWeights {
    let bundled = crate::fonts::bundled_faces(family);
    let faces: Vec<Face> = if bundled.is_empty() {
        coretext::installed_faces(family)
    } else {
        bundled
            .iter()
            .filter_map(|bytes| coretext::face_of_bytes(bytes))
            .collect()
    };
    combine(&faces)
}

#[cfg(not(target_os = "macos"))]
fn lookup(_family: &str) -> FamilyWeights {
    FamilyWeights::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_variable_face_makes_the_family_variable_else_the_weights_are_the_faces() {
        let variable = Face {
            axis: Some((100.0, 800.0)),
            weight: 400,
        };
        let regular = Face {
            axis: None,
            weight: 400,
        };
        let bold = Face {
            axis: None,
            weight: 700,
        };
        assert_eq!(
            combine(&[variable, regular]),
            FamilyWeights::Variable {
                min: 100.0,
                max: 800.0
            }
        );
        assert_eq!(
            combine(&[bold, regular, regular]),
            FamilyWeights::Static(vec![400, 700])
        );
        assert_eq!(combine(&[]), FamilyWeights::Unknown);
    }

    #[test]
    fn coretext_weight_traits_map_to_css_weights() {
        for (normalised, css) in [
            (-0.7, 100),
            (-0.23, 300),
            (0.0, 400),
            (0.23, 500),
            (0.4, 700),
        ] {
            assert_eq!(css_weight_from_trait(normalised), css, "{normalised}");
        }
    }

    /// The embedded JetBrains Mono is the v2.304 variable font: a `wght` axis from 100 to 800,
    /// read from CoreText, not assumed.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_bundled_jetbrains_mono_has_a_100_to_800_weight_axis() {
        assert_eq!(
            family_weights(crate::theme::MONO_FONT),
            FamilyWeights::Variable {
                min: 100.0,
                max: 800.0
            }
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_installed_static_family_lists_its_own_weights_and_a_missing_one_is_unknown() {
        // Menlo ships with macOS as static faces (regular, bold, italics).
        match family_weights("Menlo") {
            FamilyWeights::Static(weights) => {
                assert!(
                    weights.contains(&400) && weights.contains(&700),
                    "{weights:?}"
                );
            }
            other => panic!("Menlo is a static family, got {other:?}"),
        }
        assert_eq!(
            family_weights("Definitely Not An Installed Font"),
            FamilyWeights::Unknown
        );
    }
}
