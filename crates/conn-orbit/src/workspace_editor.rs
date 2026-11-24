//! The workspace editor's rules, as web Conn has them (`workspaces.logic.ts`,
//! `workspaceStore.ts`, `WorkspaceDialog.tsx`): the palette and icon set, what a valid draft is,
//! unique names, and how the project picker lists projects under the machine they live on.
//!
//! A workspace is a saved scope over projects (`OrbitWorkspace`): the sidebar shows only the
//! threads of its projects. Plain data in and out, so the iPhone app can share it.

use std::collections::BTreeMap;

use crate::profile::OrbitWorkspace;

/// `WORKSPACE_COLORS`, in the order of the editor's palette.
pub const WORKSPACE_COLORS: [&str; 12] = [
    "slate", "red", "orange", "amber", "lime", "green", "teal", "cyan", "sky", "blue", "violet",
    "pink",
];

/// `WORKSPACE_ICONS`: the icons a workspace can show in place of its letter, in the editor's
/// order. The client maps each name to its own glyph.
pub const WORKSPACE_ICON_NAMES: [&str; 19] = [
    "briefcase",
    "code",
    "terminal",
    "rocket",
    "server",
    "database",
    "smartphone",
    "globe",
    "folder",
    "book",
    "flask",
    "palette",
    "users",
    "building",
    "house",
    "star",
    "heart",
    "zap",
    "coffee",
];

/// `WORKSPACE_IMAGE_MAX_CHARS`: the longest image data URL a workspace keeps.
pub const WORKSPACE_IMAGE_MAX_CHARS: usize = 200_000;

/// The longest name (`validateWorkspaceDraft`).
pub const WORKSPACE_NAME_MAX_CHARS: usize = 40;

/// A palette colour as web paints it (`WORKSPACE_COLOR_CLASSES`): the Tailwind fill and whether
/// its letter is black (`text-black`) or white.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceColorStyle {
    pub fill_rgb: u32,
    pub dark_text: bool,
}

/// The fill and letter colour of a palette colour, or `None` for a name outside the palette.
#[must_use]
pub fn workspace_color_style(name: &str) -> Option<WorkspaceColorStyle> {
    let (fill_rgb, dark_text) = match name {
        "slate" => (0x64748b, false),
        "red" => (0xef4444, false),
        "orange" => (0xf97316, false),
        "amber" => (0xf59e0b, true),
        "lime" => (0x84cc16, true),
        "green" => (0x16a34a, false),
        "teal" => (0x0d9488, false),
        "cyan" => (0x06b6d4, true),
        "sky" => (0x0ea5e9, false),
        "blue" => (0x2563eb, false),
        "violet" => (0x7c3aed, false),
        "pink" => (0xec4899, false),
        _ => return None,
    };
    Some(WorkspaceColorStyle {
        fill_rgb,
        dark_text,
    })
}

/// A workspace being created or edited, before it is validated.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceDraft {
    pub name: String,
    pub color: String,
    /// A name from [`WORKSPACE_ICON_NAMES`], or none to show the name's first letter.
    pub icon: Option<String>,
    /// An uploaded picture (a small `data:image/...;base64,` URL) shown instead of the icon or letter.
    pub image: Option<String>,
    /// Environment-scoped project refs, `<environmentId>:<projectId>` (`projectRefs`).
    pub project_refs: Vec<String>,
    /// Logical project keys: a repository or folder name that matches whichever environment's
    /// project carries it (`projectKeys`).
    pub project_keys: Vec<String>,
}

/// `workspaceNameKey`: folds case and accents and keeps letters and digits.
#[must_use]
pub fn workspace_name_key(name: &str) -> String {
    name.chars()
        .flat_map(fold_accent)
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Folds the Latin letters with accents that the workspace names use; other scripts stay as typed
/// (Conn folds with Unicode NFKD).
fn fold_accent(c: char) -> impl Iterator<Item = char> {
    let folded = match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => 'A',
        'ç' => 'c',
        'Ç' => 'C',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'È' | 'É' | 'Ê' | 'Ë' => 'E',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'Ì' | 'Í' | 'Î' | 'Ï' => 'I',
        'ñ' => 'n',
        'Ñ' => 'N',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => 'o',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => 'O',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        'Ù' | 'Ú' | 'Û' | 'Ü' => 'U',
        'ý' | 'ÿ' => 'y',
        other => other,
    };
    std::iter::once(folded)
}

/// `meansAllProjects`: words that mean "no workspace".
#[must_use]
pub fn means_all_projects(name: &str) -> bool {
    matches!(
        workspace_name_key(name).as_str(),
        "" | "all" | "allprojects" | "none"
    )
}

/// `workspaceLetter`: the letter a workspace shows without an icon.
#[must_use]
pub fn workspace_letter(name: &str) -> String {
    name.chars()
        .find(|c| c.is_alphanumeric())
        .map_or_else(|| "?".to_owned(), |c| c.to_uppercase().collect())
}

/// `isWorkspaceImage`: a PNG, JPEG or WebP data URL of base64 text, short enough to keep.
#[must_use]
pub fn is_workspace_image(value: &str) -> bool {
    if value.len() > WORKSPACE_IMAGE_MAX_CHARS {
        return false;
    }
    let Some(rest) = ["png", "jpeg", "webp"]
        .iter()
        .find_map(|kind| value.strip_prefix(&format!("data:image/{kind};base64,")))
    else {
        return false;
    };
    let body = rest.trim_end_matches('=');
    !body.is_empty()
        && rest.len() - body.len() <= 2
        && body
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
}

/// `nextWorkspaceColor`: the first palette colour no workspace uses, else the palette cycles.
#[must_use]
pub fn next_workspace_color(workspaces: &[OrbitWorkspace]) -> &'static str {
    WORKSPACE_COLORS
        .iter()
        .find(|color| !workspaces.iter().any(|w| w.color == **color))
        .copied()
        .unwrap_or(WORKSPACE_COLORS[workspaces.len() % WORKSPACE_COLORS.len()])
}

/// `validateWorkspaceDraft`: trims the draft, or says in words what is wrong with it.
///
/// # Errors
/// Returns the sentence the editor shows.
pub fn validate_workspace_draft(draft: &WorkspaceDraft) -> Result<WorkspaceDraft, String> {
    let name = draft.name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("Give the workspace a name.".to_owned());
    }
    if name.chars().count() > WORKSPACE_NAME_MAX_CHARS {
        return Err("Keep the name to 40 characters.".to_owned());
    }
    if means_all_projects(&name) {
        return Err(format!("\"{name}\" is reserved for all projects."));
    }
    if workspace_color_style(&draft.color).is_none() {
        return Err("Pick a color.".to_owned());
    }
    if let Some(image) = &draft.image
        && !is_workspace_image(image)
    {
        return Err("That image can't be used.".to_owned());
    }
    let unique = |values: &[String]| {
        let mut seen: Vec<String> = Vec::with_capacity(values.len());
        for value in values {
            if !seen.contains(value) {
                seen.push(value.clone());
            }
        }
        seen
    };
    Ok(WorkspaceDraft {
        name,
        color: draft.color.clone(),
        icon: draft.icon.clone(),
        image: draft.image.clone(),
        project_refs: unique(&draft.project_refs),
        project_keys: unique(&draft.project_keys),
    })
}

/// `assertUniqueName`.
///
/// # Errors
/// Returns the sentence the editor shows when another workspace has the name.
pub fn assert_unique_workspace_name(
    workspaces: &[OrbitWorkspace],
    name: &str,
    except_id: Option<&str>,
) -> Result<(), String> {
    let key = workspace_name_key(name);
    if workspaces
        .iter()
        .any(|w| Some(w.id.as_str()) != except_id && workspace_name_key(&w.name) == key)
    {
        return Err(format!("A workspace named \"{name}\" already exists."));
    }
    Ok(())
}

fn to_workspace(id: &str, draft: WorkspaceDraft) -> OrbitWorkspace {
    OrbitWorkspace {
        id: id.to_owned(),
        name: draft.name,
        color: draft.color,
        icon: draft.icon,
        image: draft.image,
        project_refs: draft.project_refs,
        project_keys: draft.project_keys,
    }
}

/// `createWorkspace`: the list with a new workspace at its end.
///
/// # Errors
/// Returns the sentence the editor shows when the draft is not valid or the name is taken.
pub fn create_workspace(
    workspaces: &[OrbitWorkspace],
    draft: &WorkspaceDraft,
    id: &str,
) -> Result<Vec<OrbitWorkspace>, String> {
    let valid = validate_workspace_draft(draft)?;
    assert_unique_workspace_name(workspaces, &valid.name, None)?;
    let mut next = workspaces.to_vec();
    next.push(to_workspace(id, valid));
    Ok(next)
}

/// `updateWorkspace`: the list with workspace `id` replaced by the draft.
///
/// # Errors
/// Returns the sentence the editor shows when the draft is not valid or the name is taken.
pub fn update_workspace(
    workspaces: &[OrbitWorkspace],
    id: &str,
    draft: &WorkspaceDraft,
) -> Result<Vec<OrbitWorkspace>, String> {
    let valid = validate_workspace_draft(draft)?;
    assert_unique_workspace_name(workspaces, &valid.name, Some(id))?;
    Ok(workspaces
        .iter()
        .map(|w| {
            if w.id == id {
                to_workspace(id, valid.clone())
            } else {
                w.clone()
            }
        })
        .collect())
}

/// The machine a project lives on, as the editor's sections name it (`WorkspaceConnection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorConnection {
    pub environment_id: String,
    pub label: String,
    /// The machine kind icon name (`server`, `mac-mini`, ...), as the environment says it is.
    pub kind: String,
    /// The environment this app talks to first.
    pub primary: bool,
}

/// One project a workspace can include.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorProject {
    /// What the workspace stores: `<environmentId>:<projectId>`, or a logical key for an Orbit
    /// project.
    pub key: String,
    pub display_name: String,
    pub connection: Option<EditorConnection>,
    /// The key is a logical one (an Orbit project's slug, a repository name) that matches
    /// whichever environment's project carries it, not an environment-scoped ref.
    pub logical: bool,
}

/// A section of the picker (`WorkspaceConnectionSection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorSection {
    /// None holds projects with no known connection (an environment that is offline now).
    pub connection: Option<EditorConnection>,
    pub projects: Vec<EditorProject>,
}

/// `groupProjectsByConnection`: this machine first, then the others by label, then projects with
/// no known connection.
#[must_use]
pub fn group_projects_by_connection(projects: &[EditorProject]) -> Vec<EditorSection> {
    let mut sections: BTreeMap<String, EditorSection> = BTreeMap::new();
    let mut unknown: Vec<EditorProject> = Vec::new();
    for project in projects {
        match &project.connection {
            Some(connection) => sections
                .entry(connection.environment_id.clone())
                .or_insert_with(|| EditorSection {
                    connection: Some(connection.clone()),
                    projects: Vec::new(),
                })
                .projects
                .push(project.clone()),
            None => unknown.push(project.clone()),
        }
    }
    let mut ordered: Vec<EditorSection> = sections.into_values().collect();
    ordered.sort_by(|a, b| {
        let (ca, cb) = (a.connection.as_ref(), b.connection.as_ref());
        cb.is_some_and(|c| c.primary)
            .cmp(&ca.is_some_and(|c| c.primary))
            .then_with(|| {
                ca.map(|c| c.label.to_lowercase())
                    .cmp(&cb.map(|c| c.label.to_lowercase()))
            })
    });
    if !unknown.is_empty() {
        ordered.push(EditorSection {
            connection: None,
            projects: unknown,
        });
    }
    ordered
}

/// The projects a saved workspace has that the picker does not list now (an environment is
/// offline), shown as "(not available now)" so saving never drops them silently.
#[must_use]
pub fn unavailable_projects(
    workspace: Option<&OrbitWorkspace>,
    listed: &[EditorProject],
) -> Vec<EditorProject> {
    let Some(workspace) = workspace else {
        return Vec::new();
    };
    workspace
        .project_refs
        .iter()
        .chain(&workspace.project_keys)
        .filter(|key| !listed.iter().any(|p| &p.key == *key))
        .map(|key| EditorProject {
            key: key.clone(),
            display_name: format!("{key} (not available now)"),
            connection: None,
            logical: workspace.project_keys.contains(key),
        })
        .collect()
}

/// A project's key is an environment-scoped ref when it holds `<environmentId>:<projectId>` for a
/// listed environment; anything else is a logical key (`projectKeys`).
#[must_use]
pub fn split_selected_keys(
    selected: &[String],
    listed: &[EditorProject],
    workspace: Option<&OrbitWorkspace>,
) -> (Vec<String>, Vec<String>) {
    let legacy: Vec<&String> = workspace.map_or_else(Vec::new, |w| w.project_keys.iter().collect());
    let mut refs = Vec::new();
    let mut keys = Vec::new();
    for key in selected {
        let is_logical = listed.iter().any(|p| &p.key == key && p.logical);
        if legacy.contains(&key) || is_logical {
            keys.push(key.clone());
        } else {
            refs.push(key.clone());
        }
    }
    (refs, keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str, name: &str, color: &str) -> OrbitWorkspace {
        OrbitWorkspace {
            id: id.to_owned(),
            name: name.to_owned(),
            color: color.to_owned(),
            icon: None,
            image: None,
            project_refs: vec![],
            project_keys: vec![],
        }
    }

    fn draft(name: &str) -> WorkspaceDraft {
        WorkspaceDraft {
            name: name.to_owned(),
            color: "blue".to_owned(),
            ..WorkspaceDraft::default()
        }
    }

    #[test]
    fn the_palette_has_the_twelve_colours_each_with_its_fill_and_letter_colour() {
        assert_eq!(WORKSPACE_COLORS.len(), 12);
        for color in WORKSPACE_COLORS {
            assert!(workspace_color_style(color).is_some(), "{color}");
        }
        // amber, lime and cyan carry black letters; the rest white.
        let dark: Vec<&str> = WORKSPACE_COLORS
            .into_iter()
            .filter(|c| workspace_color_style(c).is_some_and(|s| s.dark_text))
            .collect();
        assert_eq!(dark, ["amber", "lime", "cyan"]);
        assert_eq!(
            workspace_color_style("blue").map(|s| s.fill_rgb),
            Some(0x2563eb)
        );
        assert!(workspace_color_style("mauve").is_none());
        assert_eq!(WORKSPACE_ICON_NAMES.len(), 19);
    }

    #[test]
    fn a_name_is_trimmed_collapsed_and_checked() {
        let ok = validate_workspace_draft(&draft("  My   Orbit  ")).expect("valid");
        assert_eq!(ok.name, "My Orbit");
        assert_eq!(
            validate_workspace_draft(&draft("   ")),
            Err("Give the workspace a name.".to_owned())
        );
        assert_eq!(
            validate_workspace_draft(&draft(&"x".repeat(41))),
            Err("Keep the name to 40 characters.".to_owned())
        );
        assert_eq!(
            validate_workspace_draft(&draft("All projects")),
            Err("\"All projects\" is reserved for all projects.".to_owned())
        );
        assert_eq!(
            validate_workspace_draft(&WorkspaceDraft {
                color: "mauve".to_owned(),
                ..draft("x")
            }),
            Err("Pick a color.".to_owned())
        );
    }

    #[test]
    fn only_a_small_base64_png_jpeg_or_webp_is_an_image() {
        assert!(is_workspace_image("data:image/png;base64,iVBORw0KGgo="));
        assert!(is_workspace_image("data:image/webp;base64,AAAA"));
        assert!(!is_workspace_image("data:image/gif;base64,AAAA"));
        assert!(!is_workspace_image("data:image/png;base64,"));
        assert!(!is_workspace_image("data:image/png;base64,AA AA"));
        assert!(!is_workspace_image(&format!(
            "data:image/png;base64,{}",
            "A".repeat(WORKSPACE_IMAGE_MAX_CHARS)
        )));
        let bad = WorkspaceDraft {
            image: Some("https://example.com/x.png".to_owned()),
            ..draft("x")
        };
        assert_eq!(
            validate_workspace_draft(&bad),
            Err("That image can't be used.".to_owned())
        );
    }

    #[test]
    fn names_are_unique_ignoring_case_accents_and_punctuation() {
        let list = [workspace("a", "DLF - Leden", "red")];
        assert!(assert_unique_workspace_name(&list, "other", None).is_ok());
        assert_eq!(
            assert_unique_workspace_name(&list, "dlf leden", None),
            Err("A workspace named \"dlf leden\" already exists.".to_owned())
        );
        // Editing the workspace itself keeps its own name.
        assert!(assert_unique_workspace_name(&list, "DLF - Leden", Some("a")).is_ok());
        assert_eq!(workspace_name_key("Café Ünï"), "cafeuni");
    }

    #[test]
    fn a_new_workspace_gets_the_first_unused_colour_and_the_palette_cycles() {
        assert_eq!(next_workspace_color(&[]), "slate");
        let some = [workspace("a", "A", "slate"), workspace("b", "B", "red")];
        assert_eq!(next_workspace_color(&some), "orange");
        let all: Vec<OrbitWorkspace> = WORKSPACE_COLORS
            .iter()
            .enumerate()
            .map(|(i, c)| workspace(&format!("w{i}"), &format!("W{i}"), c))
            .collect();
        assert_eq!(next_workspace_color(&all), "slate");
    }

    #[test]
    fn creating_and_updating_keep_the_list_valid() {
        let list = vec![workspace("a", "Orbit", "red")];
        let mut with_projects = draft("Conn");
        with_projects.project_refs = vec!["nick:p1".to_owned(), "nick:p1".to_owned()];
        let created = create_workspace(&list, &with_projects, "ws-1").expect("created");
        assert_eq!(created.len(), 2);
        assert_eq!(created[1].id, "ws-1");
        assert_eq!(created[1].project_refs, ["nick:p1"], "a ref is kept once");
        assert!(create_workspace(&list, &draft("orbit"), "ws-2").is_err());

        let updated = update_workspace(&created, "ws-1", &draft("Conn Dev")).expect("updated");
        assert_eq!(updated[1].name, "Conn Dev");
        assert_eq!(updated[0].name, "Orbit");
        assert!(update_workspace(&created, "ws-1", &draft("Orbit")).is_err());
    }

    #[test]
    fn the_letter_is_the_first_letter_or_digit() {
        assert_eq!(workspace_letter("  dlf"), "D");
        assert_eq!(workspace_letter("-- 9 lives"), "9");
        assert_eq!(workspace_letter("---"), "?");
    }

    fn project(key: &str, name: &str, env: Option<(&str, &str, bool)>) -> EditorProject {
        EditorProject {
            key: key.to_owned(),
            display_name: name.to_owned(),
            connection: env.map(|(id, label, primary)| EditorConnection {
                environment_id: id.to_owned(),
                label: label.to_owned(),
                kind: "server".to_owned(),
                primary,
            }),
            logical: false,
        }
    }

    #[test]
    fn projects_are_listed_under_their_machine_this_one_first_and_unknown_last() {
        let projects = vec![
            project("vm:p2", "Site", Some(("vm", "nick-vm", false))),
            project("nick:p1", "Conn", Some(("nick", "nick", true))),
            project("mini:p3", "Orbit", Some(("mini", "mini", false))),
            project("gone:p4", "Old (not available now)", None),
            project("nick:p5", "Orbit", Some(("nick", "nick", true))),
        ];
        let sections = group_projects_by_connection(&projects);
        let labels: Vec<Option<&str>> = sections
            .iter()
            .map(|s| s.connection.as_ref().map(|c| c.label.as_str()))
            .collect();
        assert_eq!(labels, [Some("nick"), Some("mini"), Some("nick-vm"), None]);
        assert_eq!(sections[0].projects.len(), 2);
    }

    #[test]
    fn a_saved_project_the_picker_does_not_list_stays_visible_and_keeps_its_kind_of_key() {
        let saved = OrbitWorkspace {
            project_refs: vec!["offline:p9".to_owned(), "nick:p1".to_owned()],
            project_keys: vec!["github.com/nckrtl/conn".to_owned()],
            ..workspace("w", "W", "blue")
        };
        let listed = vec![project("nick:p1", "Conn", Some(("nick", "nick", true)))];
        let missing = unavailable_projects(Some(&saved), &listed);
        assert_eq!(
            missing.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(),
            ["offline:p9", "github.com/nckrtl/conn"]
        );
        assert!(missing[0].display_name.ends_with("(not available now)"));

        let selected = vec![
            "nick:p1".to_owned(),
            "offline:p9".to_owned(),
            "github.com/nckrtl/conn".to_owned(),
        ];
        let all: Vec<EditorProject> = listed.into_iter().chain(missing).collect();
        let (refs, keys) = split_selected_keys(&selected, &all, Some(&saved));
        assert_eq!(refs, ["nick:p1", "offline:p9"]);
        assert_eq!(keys, ["github.com/nckrtl/conn"]);
    }
}
