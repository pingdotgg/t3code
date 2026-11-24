//! Read-only PHP previews backed by Zed. Conn owns the workspace and selection.
use gpui_kit::{App, AppContext, BorrowAppContext, Context, Entity, Window};
use std::{ops::Range, sync::Arc};
use zed_editor::{Editor, MultiBufferOffset, RowHighlightOptions, ToOffset};
use zed_language::{Buffer, Language, LanguageConfig};
use zed_theme::ActiveTheme as _;

#[derive(Default, Clone)]
struct PhpGrammar(Arc<std::sync::OnceLock<Arc<Language>>>);
impl gpui_kit::Global for PhpGrammar {}

#[expect(
    clippy::expect_used,
    reason = "the grammar and highlight query ship in the same crate"
)]
fn php_grammar() -> Arc<Language> {
    let config = LanguageConfig {
        name: "PHP".into(),
        ..Default::default()
    };
    let php = Language::new(config, Some(tree_sitter_php::LANGUAGE_PHP.into()))
        .with_highlights_query(tree_sitter_php::HIGHLIGHTS_QUERY)
        .expect("PHP query must match its bundled grammar");
    Arc::new(php)
}

pub(crate) fn enabled() -> bool {
    std::env::var("CONN_FILES_EDITOR").as_deref() != Ok("kit")
}

pub(crate) fn init(cx: &mut App) {
    if enabled() {
        let grammar = PhpGrammar::default();
        cx.set_global(grammar.clone());
        cx.background_executor()
            .spawn(async move {
                grammar.0.get_or_init(php_grammar);
            })
            .detach();
        let defaults = zed_settings::default_settings();
        let settings = zed_settings::SettingsStore::new(cx, &defaults);
        cx.set_global(settings);
        zed_theme_settings::init(zed_theme::LoadThemes::JustBase, cx);
        let themes = zed_theme::ThemeRegistry::global(cx);
        for palette in crate::editor_settings::Palette::ALL {
            if let Err(error) = zed_theme_settings::load_user_theme(&themes, palette.bytes()) {
                eprintln!("Could not load {} editor theme: {error}", palette.label());
            }
        }
    }
}

pub(crate) fn apply(name: &str, tokens: &conn_theme::Tokens, cx: &mut App) {
    if !enabled() || cx.try_global::<zed_theme::GlobalTheme>().is_none() {
        return;
    }
    let Ok(palette) = zed_theme::ThemeRegistry::global(cx).get(name) else {
        return;
    };
    let mut theme = (*palette).clone();
    let bg = crate::theme::hsla(tokens.shell_card);
    theme.styles.colors.editor_background = bg;
    theme.styles.colors.editor_active_line_background = bg;
    theme.styles.colors.editor_gutter_background = bg;
    theme.styles.colors.editor_foreground = crate::theme::hsla(tokens.foreground);
    theme.styles.colors.editor_line_number = crate::theme::hsla(tokens.muted_foreground);
    let prefs = crate::editor_settings::current(cx);
    let font = crate::editor_settings::family(cx).to_string();
    cx.update_global::<zed_settings::SettingsStore, _>(|settings, cx| {
        settings.update_default_settings(cx, |settings| {
            settings.editor.scroll_beyond_last_line = Some(zed_settings::ScrollBeyondLastLine::Off);
            let gutter = settings.editor.gutter.get_or_insert_with(Default::default);
            gutter.min_line_number_digits = Some(1);
            gutter.runnables = Some(false);
            gutter.breakpoints = Some(false);
            gutter.bookmarks = Some(false);
            settings.theme.buffer_font_family = Some(font.into());
            settings.theme.buffer_font_size = Some(prefs.font_size.into());
            settings.theme.buffer_line_height =
                Some(zed_settings::BufferLineHeight::Custom(prefs.line_height));
        });
    });
    zed_theme::GlobalTheme::update_theme(cx, Arc::new(theme));
}

pub(super) fn open(source: &str, wrap: bool, window: &mut Window, cx: &mut App) -> Entity<Editor> {
    let language = cx.global::<PhpGrammar>().0.get_or_init(php_grammar).clone();
    language.set_theme(cx.theme().syntax());
    let buffer = cx.new(|cx| {
        let mut buffer = Buffer::local(source, cx);
        buffer.set_language(Some(language.clone()), cx);
        buffer.set_capability(zed_language::Capability::ReadOnly, cx);
        buffer
    });
    cx.new(|cx| {
        cx.observe_global::<zed_theme::GlobalTheme>(move |_, cx| {
            language.set_theme(cx.theme().syntax());
            cx.notify();
        })
        .detach();
        let mut editor = Editor::for_buffer(buffer, None, window, cx);
        editor.set_read_only(true);
        editor.set_show_git_diff_gutter(false, cx);
        set_wrap(&mut editor, wrap, cx);
        editor
    })
}

pub(super) fn set_wrap(editor: &mut Editor, wrap: bool, cx: &mut Context<'_, Editor>) {
    let mode = if wrap {
        zed_settings::SoftWrap::EditorWidth
    } else {
        zed_settings::SoftWrap::None
    };
    editor.set_soft_wrap_mode(mode, cx);
}

pub(super) fn selection(editor: &Editor, cx: &App) -> Range<usize> {
    let snapshot = editor.buffer().read(cx).snapshot(cx);
    let range = editor.selections.newest_anchor().range();
    range.start.to_offset(&snapshot).0..range.end.to_offset(&snapshot).0
}

struct AgentReveal;

pub(super) fn reveal(
    editor: &mut Editor,
    source: &str,
    lines: conn_contract::source::SourceLines,
    excerpt: Option<&str>,
    cx: &mut Context<'_, Editor>,
) -> Result<(), String> {
    let text = zed_text::LineEnding::normalize_cow(source.into());
    let bytes = lines
        .bytes(&text)
        .ok_or("The requested lines are missing.")?;
    if let Some(expected) = excerpt
        && &text[bytes.clone()] != zed_text::LineEnding::normalize_cow(expected.into()).as_ref()
    {
        return Err("The requested source has changed.".into());
    }
    // Zed treats an end anchor at column zero as exclusive, including on an empty row.
    let end = bytes.end + usize::from(text.as_bytes().get(bytes.end) == Some(&b'\n'));
    let buffer = editor.buffer().read(cx).snapshot(cx);
    let anchors = buffer.anchor_before(MultiBufferOffset(bytes.start))
        ..buffer.anchor_after(MultiBufferOffset(end));
    editor.clear_row_highlights::<AgentReveal>();
    editor.highlight_rows::<AgentReveal>(
        anchors,
        |_| gpui_kit::rgba(0x5983ff50).into(),
        RowHighlightOptions {
            autoscroll: true,
            include_gutter: true,
        },
        cx,
    );
    editor.request_autoscroll(zed_editor::scroll::Autoscroll::center(), cx);
    cx.notify();
    Ok(())
}
