//! The workspace editor (`WorkspaceDialog.tsx`): creates a workspace or edits one. A workspace is
//! a saved scope: the sidebar shows only the threads of its projects.
//!
//! The form is web's: a name, one of 12 colours, a letter, an uploaded image or one of 19 icons,
//! and the projects, listed under the machine each lives on with a checkbox. Beside the machines'
//! projects it lists the Orbit projects: a workspace keeps one by its slug, which matches
//! whichever machine's project carries that folder or repository name.

use std::sync::Arc;

use conn_desktop::orbit::OrbitWorkspace;
use conn_desktop::orbit::workspace_editor::{
    EditorProject, EditorSection, WORKSPACE_COLORS, WORKSPACE_ICON_NAMES, WorkspaceDraft,
    group_projects_by_connection, unavailable_projects, workspace_color_style, workspace_letter,
};
use conn_theme::{Appearance, ShellGeometry, Tokens};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter, FocusHandle,
    Focusable, FontWeight, Image, ImageSource, InteractiveElement as _, IntoElement, KeyDownEvent,
    MouseButton, ObjectFit, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription,
    TestSupportExt as _, Window, anchored, deferred, div, img, point, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::theme::{hsla, hsla_alpha};

/// Width of the dialog (`max-w-md`).
const EDITOR_WIDTH_PX: f32 = 448.0;
/// The picker grids have 12 columns over the dialog's `400px` of content, `4px` apart.
const GRID_GAP_PX: f32 = 4.0;
const GRID_CELL_PX: f32 = (400.0 - 11.0 * GRID_GAP_PX) / 12.0;

/// What the editor asks of the app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceEditorEvent {
    /// The draft to create or save; the app answers a refused one with [`WorkspaceEditor::set_error`].
    Save(WorkspaceDraft),
    Delete,
    Cancel,
}

/// Where the Orbit project list stands.
#[derive(Clone, Debug, PartialEq, Eq)]
enum OrbitProjects {
    Loading,
    Loaded(Vec<EditorProject>),
    Failed,
}

/// Everything the app gives the editor to start from.
pub(crate) struct WorkspaceEditorInit {
    /// The workspace being edited; none creates one.
    pub(crate) editing: Option<OrbitWorkspace>,
    /// The colour a new workspace starts with (`nextWorkspaceColor`).
    pub(crate) default_color: String,
    /// The projects of every connected environment, under their machines.
    pub(crate) projects: Vec<EditorProject>,
    /// Keys the workspace already covers by name, checked from the start.
    pub(crate) preselected: Vec<String>,
    pub(crate) tokens: Tokens,
    pub(crate) geometry: ShellGeometry,
}

pub(crate) struct WorkspaceEditor {
    tokens: Tokens,
    geometry: ShellGeometry,
    editing: Option<OrbitWorkspace>,
    name_input: Entity<InputState>,
    _name_sub: Subscription,
    color: String,
    icon: Option<String>,
    image: Option<String>,
    image_paint: Option<Arc<Image>>,
    selected: Vec<String>,
    projects: Vec<EditorProject>,
    orbit: OrbitProjects,
    error: Option<String>,
    focus_handle: FocusHandle,
}

impl EventEmitter<WorkspaceEditorEvent> for WorkspaceEditor {}

impl Focusable for WorkspaceEditor {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// A workspace's badge (`WorkspaceBadge`): its image, or its icon or first letter on its colour.
#[must_use]
pub(crate) fn workspace_badge(
    name: &str,
    color: &str,
    icon: Option<&str>,
    image: Option<Arc<Image>>,
    size_px: f32,
    radius_px: f32,
    fallback: conn_theme::Rgba,
) -> gpui_kit::Div {
    let frame = div()
        .flex()
        .items_center()
        .justify_center()
        .flex_shrink_0()
        .size(px(size_px))
        .rounded(px(radius_px))
        .overflow_hidden();
    if let Some(image) = image {
        // `rounded-tile object-cover`: GPUI's `overflow_hidden` clips to the rectangle, not to
        // rounded corners, so the picture takes the radius itself and paints clipped to it.
        return frame.child(
            img(ImageSource::Image(image))
                .size_full()
                .rounded(px(radius_px))
                .object_fit(ObjectFit::Cover),
        );
    }
    let (fill, dark_text) = match workspace_color_style(color) {
        Some(style) => (conn_theme::Rgba::hex(style.fill_rgb), style.dark_text),
        None => {
            let fill = crate::orbit_sync::workspace_tile_color(color, fallback);
            let luma = 0.2126 * fill.r + 0.7152 * fill.g + 0.0722 * fill.b;
            (fill, luma > 0.58)
        }
    };
    let text = if dark_text {
        conn_theme::Rgba::hex(0x00_00_00)
    } else {
        conn_theme::Rgba::hex(0xff_ff_ff)
    };
    let frame = frame.bg(hsla(fill)).text_color(hsla(text));
    match icon {
        Some(icon) => frame.child(icons::concept(
            icons::project_lucide_concept(icon),
            size_px * 0.57,
            hsla(text),
        )),
        None => frame
            .text_size(px(size_px * 0.4))
            .font_weight(FontWeight::SEMIBOLD)
            .child(workspace_letter(name)),
    }
}

impl WorkspaceEditor {
    pub(crate) fn new(
        init: WorkspaceEditorInit,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let WorkspaceEditorInit {
            editing,
            default_color,
            projects,
            preselected,
            tokens,
            geometry,
        } = init;
        let name_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Orbit")
                .default_value(editing.as_ref().map(|w| w.name.clone()).unwrap_or_default())
        });
        let name_sub = cx.subscribe_in(
            &name_input,
            window,
            |this, _input, event: &InputEvent, _window, cx| match event {
                InputEvent::PressEnter { .. } => this.save(cx),
                InputEvent::Change => {
                    // The badge letter follows the name.
                    cx.notify();
                }
                _ => {}
            },
        );
        let focus_handle = cx.focus_handle();
        window.focus(&name_input.focus_handle(cx), cx);
        let color = editing.as_ref().map_or(default_color, |w| w.color.clone());
        let mut selected: Vec<String> = editing
            .iter()
            .flat_map(|w| w.project_refs.iter().chain(&w.project_keys).cloned())
            .collect();
        for key in preselected {
            if !selected.contains(&key) {
                selected.push(key);
            }
        }
        let image = editing.as_ref().and_then(|w| w.image.clone());
        let image_paint = image
            .as_deref()
            .and_then(crate::workspace_image::image_of_data_url);
        Self {
            tokens,
            geometry,
            icon: editing.as_ref().and_then(|w| w.icon.clone()),
            editing,
            name_input,
            _name_sub: name_sub,
            color,
            image,
            image_paint,
            selected,
            projects,
            orbit: OrbitProjects::Loading,
            error: None,
            focus_handle,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The Orbit projects arrived (or could not be read).
    pub(crate) fn set_orbit_projects(
        &mut self,
        projects: Option<Vec<EditorProject>>,
        cx: &mut Context<'_, Self>,
    ) {
        self.orbit = match projects {
            Some(projects) => OrbitProjects::Loaded(projects),
            None => OrbitProjects::Failed,
        };
        cx.notify();
    }

    /// The app refused the draft: say why, as web does under the form.
    pub(crate) fn set_error(&mut self, error: String, cx: &mut Context<'_, Self>) {
        self.error = Some(error);
        cx.notify();
    }

    fn name(&self, cx: &App) -> String {
        self.name_input.read(cx).value().to_string()
    }

    fn save(&mut self, cx: &mut Context<'_, Self>) {
        let (project_refs, project_keys) =
            conn_desktop::orbit::workspace_editor::split_selected_keys(
                &self.selected,
                &self.all_projects(),
                self.editing.as_ref(),
            );
        let draft = WorkspaceDraft {
            name: self.name(cx),
            color: self.color.clone(),
            icon: self.icon.clone(),
            image: self.image.clone(),
            project_refs,
            project_keys,
        };
        cx.emit(WorkspaceEditorEvent::Save(draft));
    }

    fn all_projects(&self) -> Vec<EditorProject> {
        let mut all = self.projects.clone();
        if let OrbitProjects::Loaded(orbit) = &self.orbit {
            all.extend(orbit.iter().cloned());
        }
        all
    }

    fn toggle(&mut self, key: &str, checked: bool, cx: &mut Context<'_, Self>) {
        if checked {
            if !self.selected.iter().any(|k| k == key) {
                self.selected.push(key.to_owned());
            }
        } else {
            self.selected.retain(|k| k != key);
        }
        cx.notify();
    }

    fn choose_icon(&mut self, icon: Option<String>, cx: &mut Context<'_, Self>) {
        self.icon = icon;
        self.image = None;
        self.image_paint = None;
        cx.notify();
    }

    fn pick_image(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let paths = cx.prompt_for_paths(gpui_kit::PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Choose image".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(mut chosen))) = paths.await else {
                return;
            };
            let Some(path) = chosen.pop() else {
                return;
            };
            let result = crate::live::RT
                .spawn_blocking(move || crate::workspace_image::data_url_from_file(&path))
                .await
                .unwrap_or_else(|_| Err("That image can't be read.".to_owned()));
            let _ = this.update(cx, |editor, cx| {
                match result {
                    Ok(url) => {
                        editor.image_paint = crate::workspace_image::image_of_data_url(&url);
                        editor.image = Some(url);
                        editor.error = None;
                    }
                    Err(message) => editor.error = Some(message),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn label(&self, text: &str) -> gpui_kit::Div {
        div()
            .text_size(px(12.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(hsla(self.tokens.foreground))
            .child(text.to_owned())
    }

    fn picker_surface(&self, selected: bool) -> gpui_kit::Div {
        div()
            .flex()
            .items_center()
            .justify_center()
            .h(px(28.0))
            .rounded(px(6.0))
            .border_1()
            .border_color(if selected {
                hsla(self.tokens.foreground)
            } else {
                hsla(self.tokens.input)
            })
            .bg(hsla(self.tokens.shell_control_raised))
            .cursor_pointer()
    }

    fn render_colors(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let mut grid = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(GRID_GAP_PX))
            .w(px(400.0));
        for option in WORKSPACE_COLORS {
            let selected = self.color == option;
            let Some(style) = workspace_color_style(option) else {
                continue;
            };
            let name = option.to_owned();
            let mut cell = div()
                .id(SharedString::from(format!("workspace-color-{option}")))
                .a11y_button(format!("workspace.editor.color.{option}"), option)
                .size(px(GRID_CELL_PX))
                .rounded(px(6.0))
                .bg(hsla(conn_theme::Rgba::hex(style.fill_rgb)))
                .cursor_pointer()
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    this.color.clone_from(&name);
                    cx.notify();
                }));
            if selected {
                cell = cell.border_2().border_color(hsla(self.tokens.foreground));
            }
            grid = grid.child(cell);
        }
        grid.into_any_element()
    }

    fn render_icons(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let letter_selected = self.icon.is_none() && self.image.is_none();
        let image_selected = self.image.is_some();
        let letter = self
            .picker_surface(letter_selected)
            .id("workspace-icon-letter")
            .a11y_button("workspace.editor.icon.letter", "Letter")
            .w(px(GRID_CELL_PX * 2.0 + GRID_GAP_PX))
            .text_size(px(12.0))
            .text_color(fg)
            .child("Letter")
            .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                this.choose_icon(None, cx);
            }));
        let image = self
            .picker_surface(image_selected)
            .id("workspace-icon-image")
            .a11y_button(
                "workspace.editor.icon.image",
                if image_selected {
                    "Replace image"
                } else {
                    "Upload image"
                },
            )
            .w(px(GRID_CELL_PX * 3.0 + GRID_GAP_PX * 2.0))
            .gap(px(6.0))
            .text_size(px(12.0))
            .text_color(fg)
            .child(match &self.image_paint {
                Some(paint) => img(ImageSource::Image(Arc::clone(paint)))
                    .size(px(16.0))
                    .rounded(px(2.0))
                    .object_fit(ObjectFit::Cover)
                    .into_any_element(),
                None => icons::concept("superhero/image.svg", 16.0, fg).into_any_element(),
            })
            .child("Image")
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                this.pick_image(window, cx);
            }));
        let mut grid = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(GRID_GAP_PX))
            .w(px(400.0))
            .child(letter)
            .child(image);
        for name in WORKSPACE_ICON_NAMES {
            let selected = self.icon.as_deref() == Some(name) && self.image.is_none();
            let pick = name.to_owned();
            grid = grid.child(
                self.picker_surface(selected)
                    .id(SharedString::from(format!("workspace-icon-{name}")))
                    .a11y_button(format!("workspace.editor.icon.{name}"), name)
                    .w(px(GRID_CELL_PX))
                    .child(icons::concept(
                        icons::project_lucide_concept(name),
                        16.0,
                        fg,
                    ))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                        this.choose_icon(Some(pick.clone()), cx);
                    })),
            );
        }
        grid.into_any_element()
    }

    fn checkbox(&self, checked: bool) -> gpui_kit::Div {
        let mut boxed = div()
            .flex()
            .items_center()
            .justify_center()
            .size(px(16.0))
            .flex_shrink_0()
            .rounded(px(4.0))
            .border_1()
            .border_color(hsla(self.tokens.input))
            .bg(hsla(self.tokens.shell_control_raised));
        if checked {
            boxed = boxed
                .bg(hsla(self.tokens.primary))
                .border_color(hsla(self.tokens.primary))
                .child(icons::concept(
                    "superhero/check.svg",
                    12.0,
                    hsla(self.tokens.primary_foreground),
                ));
        }
        boxed
    }

    fn render_project_row(
        &self,
        section_id: &str,
        project: &EditorProject,
        elsewhere: &[String],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let checked = self.selected.iter().any(|k| k == &project.key);
        let key = project.key.clone();
        let mut label = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .min_w_0()
            .flex_1()
            .text_size(px(13.0))
            .text_color(hsla(self.tokens.foreground))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .child(project.display_name.clone()),
            );
        if !elsewhere.is_empty() {
            label = label.child(
                div()
                    .flex_shrink_0()
                    .text_size(px(12.0))
                    .text_color(hsla(self.tokens.muted_foreground))
                    .child(format!("also on {}", elsewhere.join(", "))),
            );
        }
        div()
            .id(SharedString::from(format!(
                "workspace-project-{section_id}-{}",
                project.key
            )))
            .a11y_button(
                format!("workspace.editor.project.{}", project.key),
                format!(
                    "{}{}",
                    project.display_name,
                    if checked { ", selected" } else { "" }
                ),
            )
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .min_w_0()
            .pl(px(20.0))
            .py(px(2.0))
            .cursor_pointer()
            .child(self.checkbox(checked))
            .child(label)
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                let now = this.selected.iter().any(|k| k == &key);
                this.toggle(&key, !now, cx);
            }))
            .into_any_element()
    }

    fn render_section(
        &self,
        section: &EditorSection,
        title: &str,
        icon: &'static str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let fg = hsla(self.tokens.foreground);
        let section_id = section
            .connection
            .as_ref()
            .map_or_else(|| "unknown".to_owned(), |c| c.environment_id.clone());
        let keys: Vec<String> = section.projects.iter().map(|p| p.key.clone()).collect();
        let all_selected = keys.iter().all(|k| self.selected.contains(k));
        let toggle_keys = keys;
        let mut header = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .text_size(px(12.0))
            .text_color(muted)
            .child(icons::concept(icon, 14.0, muted))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(title.to_owned()),
            );
        if section.connection.as_ref().is_some_and(|c| c.primary) {
            header = header.child("· this machine");
        }
        header = header.child(div().flex_1()).child(
            div()
                .id(SharedString::from(format!(
                    "workspace-section-all-{section_id}"
                )))
                .a11y_button(
                    format!("workspace.editor.section.{section_id}.all"),
                    if all_selected {
                        format!("Clear {title}")
                    } else {
                        format!("Select all {title}")
                    },
                )
                .flex_shrink_0()
                .px(px(4.0))
                .rounded(px(4.0))
                .cursor_pointer()
                .hover(move |s| s.text_color(fg))
                .child(if all_selected { "Clear" } else { "Select all" })
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    if all_selected {
                        this.selected.retain(|k| !toggle_keys.contains(k));
                    } else {
                        for key in &toggle_keys {
                            if !this.selected.contains(key) {
                                this.selected.push(key.clone());
                            }
                        }
                    }
                    cx.notify();
                })),
        );
        let mut column = div().flex().flex_col().gap(px(4.0)).min_w_0().child(header);
        for project in &section.projects {
            let elsewhere: Vec<String> = self
                .projects
                .iter()
                .filter(|other| {
                    other.display_name == project.display_name
                        && other.connection.as_ref().map(|c| &c.environment_id)
                            != project.connection.as_ref().map(|c| &c.environment_id)
                })
                .filter_map(|other| other.connection.as_ref().map(|c| c.label.clone()))
                .collect();
            column = column.child(self.render_project_row(&section_id, project, &elsewhere, cx));
        }
        column
            .id(SharedString::from(format!(
                "workspace-section-{section_id}"
            )))
            .a11y_group(
                format!("workspace.editor.section.{section_id}"),
                title.to_owned(),
            )
            .into_any_element()
    }

    fn render_projects(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let mut listed = self.projects.clone();
        let orbit = match &self.orbit {
            OrbitProjects::Loaded(projects) => projects.clone(),
            OrbitProjects::Loading | OrbitProjects::Failed => Vec::new(),
        };
        listed.extend(orbit.iter().cloned());
        let missing = unavailable_projects(self.editing.as_ref(), &listed);
        let mut sections: Vec<AnyElement> = Vec::new();
        if !orbit.is_empty() {
            sections.push(self.render_section(
                &EditorSection {
                    connection: None,
                    projects: orbit,
                },
                "Orbit projects",
                "superhero/route.svg",
                cx,
            ));
        }
        let mut machine_projects = self.projects.clone();
        machine_projects.extend(missing);
        for section in group_projects_by_connection(&machine_projects) {
            let title = section
                .connection
                .as_ref()
                .map_or_else(|| "Not connected".to_owned(), |c| c.label.clone());
            let icon = section
                .connection
                .as_ref()
                .map_or("superhero/offline.svg", |c| machine_icon(&c.kind));
            sections.push(self.render_section(&section, &title, icon, cx));
        }
        let status = match &self.orbit {
            OrbitProjects::Loading => Some("Loading Orbit projects…"),
            OrbitProjects::Failed => Some("Orbit projects could not be loaded."),
            OrbitProjects::Loaded(_) => None,
        };
        if sections.is_empty() && status.is_none() {
            return div()
                .text_size(px(13.0))
                .text_color(muted)
                .child("No projects yet.")
                .into_any_element();
        }
        let mut list = div()
            .id("workspace-project-list")
            .flex()
            .flex_col()
            .gap(px(12.0))
            .max_h(px(288.0))
            .overflow_y_scroll()
            .rounded(px(6.0))
            .border_1()
            .border_color(hsla(self.tokens.border))
            .p(px(8.0));
        for section in sections {
            list = list.child(section);
        }
        if let Some(status) = status {
            list = list.child(div().text_size(px(12.0)).text_color(muted).child(status));
        }
        list.into_any_element()
    }

    fn button(
        &self,
        id: &'static str,
        label: &'static str,
        primary: bool,
        destructive: bool,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let (bg, fg, border) = if primary {
            (
                hsla(self.tokens.primary),
                hsla(self.tokens.primary_foreground),
                hsla(self.tokens.primary),
            )
        } else if destructive {
            (
                hsla_alpha(self.tokens.background, 0.0),
                hsla(self.tokens.destructive),
                hsla_alpha(self.tokens.destructive, 0.5),
            )
        } else {
            (
                hsla(self.tokens.shell_control_raised),
                hsla(self.tokens.foreground),
                hsla(self.tokens.input),
            )
        };
        div()
            .id(id)
            .a11y_button(format!("workspace.editor.{id}"), label)
            .flex()
            .items_center()
            .justify_center()
            .h(px(32.0))
            .px(px(14.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(border)
            .bg(bg)
            .text_size(px(13.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .cursor_pointer()
            .child(label)
    }
}

/// The glyph of a machine kind in a picker section header.
fn machine_icon(kind: &str) -> &'static str {
    match kind {
        "cloud" => "superhero/cloud.svg",
        "desktop" => "superhero/desktop.svg",
        "laptop" => "superhero/laptop.svg",
        "mac-mini" => "superhero/computer-mini.svg",
        "mac-studio" => "superhero/computer-studio.svg",
        _ => "superhero/server.svg",
    }
}

impl Render for WorkspaceEditor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let scrim_alpha = match self.tokens.appearance {
            Appearance::Dark => 0.50,
            Appearance::Light => 0.25,
        };
        let name = self.name(cx);
        let editing_title = self.editing.as_ref().map(|w| w.name.clone());
        let title = editing_title
            .as_ref()
            .map_or_else(|| "New workspace".to_owned(), |name| format!("Edit {name}"));
        let badge = workspace_badge(
            if name.is_empty() { "?" } else { &name },
            &self.color,
            self.icon.as_deref(),
            self.image_paint.clone(),
            36.0,
            6.0,
            self.tokens.primary,
        );
        let form = div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_end()
                    .gap(px(12.0))
                    .child(badge)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .gap(px(6.0))
                            .child(self.label("Name"))
                            .child(
                                div()
                                    .id("workspace-name")
                                    .a11y_group("workspace.editor.name", "Workspace name")
                                    .child(Input::new(&self.name_input)),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(self.label("Color"))
                    .child(self.render_colors(cx)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(self.label("Icon"))
                    .child(self.render_icons(cx)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(self.label("Projects"))
                    .child(self.render_projects(cx)),
            )
            .children(self.error.clone().map(|error| {
                div()
                    .id("workspace-error")
                    .a11y_group("workspace.editor.error", error.clone())
                    .text_size(px(13.0))
                    .text_color(hsla(self.tokens.destructive))
                    .child(error)
            }));

        let mut footer = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(8.0))
            .px(px(24.0))
            .py(px(16.0));
        if self.editing.is_some() {
            footer = footer
                .child(
                    self.button("delete", "Delete", false, true)
                        .on_click(cx.listener(|_this, _: &ClickEvent, _window, cx| {
                            cx.emit(WorkspaceEditorEvent::Delete);
                        })),
                )
                .child(div().flex_1());
        }
        footer = footer
            .child(
                self.button("cancel", "Cancel", false, false)
                    .on_click(cx.listener(|_this, _: &ClickEvent, _window, cx| {
                        cx.emit(WorkspaceEditorEvent::Cancel);
                    })),
            )
            .child(
                self.button(
                    "save",
                    if self.editing.is_some() {
                        "Save"
                    } else {
                        "Create"
                    },
                    true,
                    false,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                    this.save(cx);
                })),
            );

        let modal = div()
            .id("conn-workspace-editor")
            .test_support()
            .a11y(gpui_kit::Role::Dialog, "workspace.editor", title.clone())
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|_this, event: &KeyDownEvent, _window, cx| {
                if event.keystroke.key == "escape" {
                    cx.emit(WorkspaceEditorEvent::Cancel);
                    cx.stop_propagation();
                }
            }))
            .flex()
            .flex_col()
            .w(px(EDITOR_WIDTH_PX))
            .max_h(px((f32::from(viewport.height) - 48.0).max(380.0)))
            .rounded(px(self.geometry.window_radius_px.min(14.0)))
            .overflow_hidden()
            .bg(hsla(self.tokens.popover))
            .border_1()
            .border_color(hsla(self.tokens.shell_inner_border))
            .shadow_lg()
            .font_family(".SystemUIFont")
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(hsla(self.tokens.foreground))
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .px(px(24.0))
                    .pt(px(20.0))
                    .pb(px(12.0))
                    .child(
                        div()
                            .text_size(px(16.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(hsla(self.tokens.muted_foreground))
                            .child(
                                "A workspace shows only the threads of its projects. \
                                 Workspaces sync through your Orbit profile.",
                            ),
                    ),
            )
            .child(
                div()
                    .id("workspace-editor-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(px(24.0))
                    .pb(px(8.0))
                    .child(form),
            )
            .child(footer);

        deferred(
            anchored().position(point(px(0.0), px(0.0))).child(
                div()
                    .id("conn-workspace-editor-backdrop")
                    .flex()
                    .items_center()
                    .justify_center()
                    .w(viewport.width)
                    .h(viewport.height)
                    .bg(hsla_alpha(self.tokens.background, scrim_alpha))
                    .occlude()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|_this, _, _window, cx| {
                            cx.emit(WorkspaceEditorEvent::Cancel);
                        }),
                    )
                    .child(modal),
            ),
        )
        .with_priority(crate::panels::chrome::MODAL_LAYER_PRIORITY)
    }
}

#[cfg(test)]
impl WorkspaceEditor {
    /// Types a name into the form.
    pub(crate) fn set_name_for_test(
        &mut self,
        name: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.name_input
            .update(cx, |input, cx| input.set_value(name, window, cx));
    }

    /// Checks or unchecks a project by its key.
    pub(crate) fn toggle_for_test(&mut self, key: &str, checked: bool, cx: &mut Context<'_, Self>) {
        self.toggle(key, checked, cx);
    }

    /// Picks a colour and an icon (`None`: the letter).
    pub(crate) fn style_for_test(
        &mut self,
        color: &str,
        icon: Option<&str>,
        cx: &mut Context<'_, Self>,
    ) {
        self.color = color.to_owned();
        self.choose_icon(icon.map(str::to_owned), cx);
    }

    /// `Create` or `Save`.
    pub(crate) fn save_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.save(cx);
    }

    /// `Delete`.
    pub(crate) fn delete_for_test(&mut self, cx: &mut Context<'_, Self>) {
        cx.emit(WorkspaceEditorEvent::Delete);
    }

    /// The sentence under the form.
    pub(crate) fn error_for_test(&self) -> Option<String> {
        self.error.clone()
    }

    /// The projects the form lists, by key.
    pub(crate) fn listed_for_test(&self) -> Vec<String> {
        self.all_projects().into_iter().map(|p| p.key).collect()
    }
}
