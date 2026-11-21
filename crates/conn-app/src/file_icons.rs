//! Conn's file-type icons for the Files tree, file tabs, and context chips.
//!
//! Ports `@pierre/trees@1.0.0-beta.6` (`complete` icon set) plus Conn's
//! `T3_PIERRE_ICONS` overrides (`apps/web/src/pierre-icons.ts` and
//! `apps/web/src/components/chat/PierreEntryIcon.tsx`).
//!
//! This module is GPUI-free: it returns embedded asset paths (`files/<id>.svg`)
//! and light/dark [`conn_theme::Rgba`] tint colors. Directories do not receive
//! a file icon (Conn renders only the disclosure chevron).

use conn_theme::{Appearance, Rgba};

/// Light and dark tint colors for a file-type icon.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct IconColor {
    pub(crate) light: Rgba,
    pub(crate) dark: Rgba,
}

impl IconColor {
    /// Creates an icon color pair from opaque `0xRRGGBB` hex literals.
    #[must_use]
    pub(crate) const fn hex(light: u32, dark: u32) -> Self {
        Self {
            light: rgb(light),
            dark: rgb(dark),
        }
    }

    /// Selects the color matching the active theme appearance.
    #[must_use]
    pub(crate) const fn for_appearance(self, appearance: Appearance) -> Rgba {
        match appearance {
            Appearance::Light => self.light,
            Appearance::Dark => self.dark,
        }
    }
}

/// Resolved file-type icon: embedded SVG asset path and optional light/dark tint.
///
/// When `color` is `None`, the icon has no dedicated token color in Conn and
/// inherits the caller's muted/default icon foreground.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FileIcon {
    pub(crate) asset: &'static str,
    pub(crate) color: Option<IconColor>,
}

const fn rgb(hex: u32) -> Rgba {
    Rgba::new(
        ((hex >> 16) & 0xff) as f32 / 255.0,
        ((hex >> 8) & 0xff) as f32 / 255.0,
        (hex & 0xff) as f32 / 255.0,
        1.0,
    )
}

// Shared 13-color palette from `@pierre/trees/dist/style.js` (`--trees-icon-*`)
// and Conn (`PierreEntryIcon.tsx`, `DOCUMENT_ICON_COLORS`, `T3_FILE_ICON_SPRITE`).
const GRAY: IconColor = IconColor::hex(0x84848a, 0xadadb1);
const RED: IconColor = IconColor::hex(0xd52c36, 0xff6762);
const VERMILION: IconColor = IconColor::hex(0xff8c5b, 0xd5512f);
const ORANGE: IconColor = IconColor::hex(0xd47628, 0xffa359);
const YELLOW: IconColor = IconColor::hex(0xd5a910, 0xffd452);
const GREEN: IconColor = IconColor::hex(0x199f43, 0x5ecc71);
const TEAL: IconColor = IconColor::hex(0x17a5af, 0x64d1db);
const CYAN: IconColor = IconColor::hex(0x1ca1c7, 0x68cdf2);
const BLUE: IconColor = IconColor::hex(0x1a85d4, 0x69b1ff);
const INDIGO: IconColor = IconColor::hex(0x693acf, 0x9d6afb);
const PURPLE: IconColor = IconColor::hex(0xa631be, 0xd568ea);
const PINK: IconColor = IconColor::hex(0xd32a61, 0xff678d);
const MAUVE: IconColor = IconColor::hex(0x594c5b, 0x79697b);

// `t3-file-icon-video` hard-codes `stroke="#a631be"` in both light and dark modes.
const VIDEO_FIXED_PURPLE: IconColor = IconColor::hex(0xa631be, 0xa631be);

/// Resolves the Conn file-type icon for a file path or basename.
///
/// Follows the exact precedence of `@pierre/trees`'s `createFileTreeIconResolver`
/// configured with Conn's `T3_PIERRE_ICONS` (`set: "complete"`):
/// 1. Conn custom `byFileName` (exact lowercased basename)
/// 2. Conn custom `byFileExtension` (lowercased suffixes after `.`, longest first)
/// 3. `@pierre/trees` built-in `BUILT_IN_FILE_NAME_TOKENS` (exact lowercased basename)
/// 4. `@pierre/trees` built-in `COMPLETE_EXTENSION_OVERRIDES` and
///    `BUILT_IN_FILE_EXTENSION_TOKENS` (longest suffix first)
/// 5. Built-in `default` file icon
///
/// Only pass file paths; directories get no icon in Conn (only the chevron).
#[must_use]
pub(crate) fn file_icon(path: &str) -> FileIcon {
    let base_name = path.rsplit('/').next().unwrap_or(path);
    let lower_name = base_name.to_lowercase();

    // 1. Conn `T3_PIERRE_ICONS.byFileName`
    if let Some(icon) = conn_by_file_name(&lower_name) {
        return icon;
    }

    // 2. Conn `T3_PIERRE_ICONS.byFileExtension` (checked before built-in filenames,
    // matching `createFileTreeIconResolver` in `@pierre/trees/dist/render/iconResolver.js`)
    for ext in extension_candidates(&lower_name) {
        if let Some(icon) = conn_by_extension(ext) {
            return icon;
        }
    }

    // 3. `@pierre/trees` `BUILT_IN_FILE_NAME_TOKENS`
    if let Some(token) = builtin_file_name_token(&lower_name) {
        return builtin_icon(token);
    }

    // 4. `@pierre/trees` `COMPLETE_EXTENSION_OVERRIDES` + `BUILT_IN_FILE_EXTENSION_TOKENS`
    for ext in extension_candidates(&lower_name) {
        if let Some(token) = builtin_extension_token(ext) {
            return builtin_icon(token);
        }
    }

    // 5. Fallback default file icon
    builtin_icon(BuiltinToken::Default)
}

/// Yields every suffix following a `.` in `lower_name`, from longest to shortest,
/// matching `getExtensionCandidates` in `@pierre/trees/dist/render/iconResolver.js`.
fn extension_candidates(lower_name: &str) -> impl Iterator<Item = &str> {
    lower_name
        .match_indices('.')
        .map(|(dot_idx, _)| &lower_name[dot_idx + 1..])
}

/// Conn's `T3_PIERRE_ICONS.byFileName` overrides (`pierre-icons.ts`).
///
/// None of these overrides assign a CSS `data-icon-token` in Conn, so they
/// inherit the caller's muted foreground (`color: None`). Note: `t3-file-icon-pnpm`
/// also embeds a fixed `#f9ad00` path alongside its `currentColor` path.
fn conn_by_file_name(lower_name: &str) -> Option<FileIcon> {
    match lower_name {
        "package.json" => Some(FileIcon {
            asset: "files/file-tree-builtin-npm.svg",
            color: None,
        }),
        "tsconfig.json" => Some(FileIcon {
            asset: "files/file-tree-builtin-typescript.svg",
            color: None,
        }),
        "agents.md" => Some(FileIcon {
            asset: "files/t3-file-icon-agents.svg",
            color: None,
        }),
        "pnpm-lock.yaml" | "pnpm-workspace.yaml" => Some(FileIcon {
            asset: "files/t3-file-icon-pnpm.svg",
            color: None,
        }),
        _ => None,
    }
}

/// Conn's `T3_PIERRE_ICONS.byFileExtension` overrides (`pierre-icons.ts` + `video.ts`).
fn conn_by_extension(ext: &str) -> Option<FileIcon> {
    match ext {
        "avi" | "m4v" | "mkv" | "mov" | "mp4" | "ogv" | "webm" => Some(FileIcon {
            asset: "files/t3-file-icon-video.svg",
            color: Some(VIDEO_FIXED_PURPLE),
        }),
        "pdf" => Some(FileIcon {
            asset: "files/t3-file-icon-pdf.svg",
            color: Some(RED),
        }),
        "doc" | "docx" | "odt" | "rtf" => Some(FileIcon {
            asset: "files/t3-file-icon-word.svg",
            color: Some(BLUE),
        }),
        "xls" | "xlsx" | "ods" | "csv" | "tsv" => Some(FileIcon {
            asset: "files/t3-file-icon-spreadsheet.svg",
            color: Some(GREEN),
        }),
        "ppt" | "pptx" | "odp" => Some(FileIcon {
            asset: "files/t3-file-icon-slides.svg",
            color: Some(ORANGE),
        }),
        "epub" => Some(FileIcon {
            asset: "files/t3-file-icon-epub.svg",
            color: Some(INDIGO),
        }),
        "cs" | "csx" => Some(FileIcon {
            asset: "files/t3-file-icon-csharp.svg",
            color: Some(INDIGO),
        }),
        "dart" => Some(FileIcon {
            asset: "files/t3-file-icon-dart.svg",
            color: Some(CYAN),
        }),
        "diff" | "patch" => Some(FileIcon {
            asset: "files/t3-file-icon-diff.svg",
            color: Some(GREEN),
        }),
        "ex" | "exs" => Some(FileIcon {
            asset: "files/t3-file-icon-elixir.svg",
            color: Some(PURPLE),
        }),
        "hs" | "lhs" => Some(FileIcon {
            asset: "files/t3-file-icon-haskell.svg",
            color: Some(INDIGO),
        }),
        // `resolvePierreIconForEntry` explicitly restores `token: "image"` for heic/heif.
        "heic" | "heif" => Some(builtin_icon(BuiltinToken::Image)),
        "java" => Some(FileIcon {
            asset: "files/t3-file-icon-java.svg",
            color: Some(ORANGE),
        }),
        "kt" | "kts" => Some(FileIcon {
            asset: "files/t3-file-icon-kotlin.svg",
            color: Some(INDIGO),
        }),
        "lua" | "luau" => Some(FileIcon {
            asset: "files/t3-file-icon-lua.svg",
            color: Some(BLUE),
        }),
        "php" => Some(FileIcon {
            asset: "files/t3-file-icon-php.svg",
            color: Some(INDIGO),
        }),
        "ps1" | "psm1" | "psd1" => Some(FileIcon {
            asset: "files/t3-file-icon-powershell.svg",
            color: Some(BLUE),
        }),
        "r" => Some(FileIcon {
            asset: "files/t3-file-icon-r.svg",
            color: Some(BLUE),
        }),
        "scala" => Some(FileIcon {
            asset: "files/t3-file-icon-scala.svg",
            color: Some(RED),
        }),
        "toml" => Some(FileIcon {
            asset: "files/t3-file-icon-toml.svg",
            color: Some(GRAY),
        }),
        "xml" | "xsd" | "xsl" | "xslt" => Some(FileIcon {
            asset: "files/t3-file-icon-xml.svg",
            color: Some(ORANGE),
        }),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BuiltinToken {
    Astro,
    Babel,
    Bash,
    Biome,
    Bootstrap,
    Browserslist,
    Bun,
    C,
    Claude,
    Cpp,
    Css,
    Database,
    Default,
    Docker,
    Eslint,
    Font,
    Git,
    Go,
    Graphql,
    Html,
    Image,
    Javascript,
    Json,
    Markdown,
    Mcp,
    Nextjs,
    Oxc,
    Postcss,
    Prettier,
    Python,
    React,
    Ruby,
    Rust,
    Sass,
    Stylelint,
    Svelte,
    Svg,
    Svgo,
    Swift,
    Tailwind,
    Terraform,
    Text,
    Typescript,
    Vite,
    Vscode,
    Vue,
    Wasm,
    Webpack,
    Yml,
    Zig,
    Zip,
}

fn builtin_icon(token: BuiltinToken) -> FileIcon {
    match token {
        BuiltinToken::Astro => FileIcon {
            asset: "files/file-tree-builtin-astro.svg",
            color: Some(PURPLE),
        },
        BuiltinToken::Babel => FileIcon {
            asset: "files/file-tree-builtin-babel.svg",
            color: Some(YELLOW),
        },
        BuiltinToken::Bash => FileIcon {
            asset: "files/file-tree-builtin-bash.svg",
            color: Some(GREEN),
        },
        BuiltinToken::Biome => FileIcon {
            asset: "files/file-tree-builtin-biome.svg",
            color: Some(BLUE),
        },
        BuiltinToken::Bootstrap => FileIcon {
            asset: "files/file-tree-builtin-bootstrap.svg",
            color: Some(INDIGO),
        },
        BuiltinToken::Browserslist => FileIcon {
            asset: "files/file-tree-builtin-browserslist.svg",
            color: Some(YELLOW),
        },
        BuiltinToken::Bun => FileIcon {
            asset: "files/file-tree-builtin-bun.svg",
            color: Some(MAUVE),
        },
        BuiltinToken::C => FileIcon {
            asset: "files/file-tree-builtin-c.svg",
            color: Some(BLUE),
        },
        BuiltinToken::Claude => FileIcon {
            asset: "files/file-tree-builtin-claude.svg",
            color: Some(ORANGE),
        },
        BuiltinToken::Cpp => FileIcon {
            asset: "files/file-tree-builtin-cpp.svg",
            color: Some(BLUE),
        },
        BuiltinToken::Css => FileIcon {
            asset: "files/file-tree-builtin-css.svg",
            color: Some(INDIGO),
        },
        BuiltinToken::Database => FileIcon {
            asset: "files/file-tree-builtin-database.svg",
            color: Some(PURPLE),
        },
        BuiltinToken::Default => FileIcon {
            asset: "files/file-tree-builtin-default.svg",
            color: Some(GRAY),
        },
        BuiltinToken::Docker => FileIcon {
            asset: "files/file-tree-builtin-docker.svg",
            color: Some(BLUE),
        },
        BuiltinToken::Eslint => FileIcon {
            asset: "files/file-tree-builtin-eslint.svg",
            color: Some(INDIGO),
        },
        // `font`, `nextjs`, and `stylelint` have no `--trees-file-icon-color-*` rule in
        // `@pierre/trees/dist/style.js` and inherit `--trees-fg-muted` in the tree.
        BuiltinToken::Font => FileIcon {
            asset: "files/file-tree-builtin-font.svg",
            color: None,
        },
        BuiltinToken::Git => FileIcon {
            asset: "files/file-tree-builtin-git.svg",
            color: Some(VERMILION),
        },
        BuiltinToken::Go => FileIcon {
            asset: "files/file-tree-builtin-go.svg",
            color: Some(CYAN),
        },
        BuiltinToken::Graphql => FileIcon {
            asset: "files/file-tree-builtin-graphql.svg",
            color: Some(PINK),
        },
        BuiltinToken::Html => FileIcon {
            asset: "files/file-tree-builtin-html.svg",
            color: Some(ORANGE),
        },
        BuiltinToken::Image => FileIcon {
            asset: "files/file-tree-builtin-image.svg",
            color: Some(PINK),
        },
        BuiltinToken::Javascript => FileIcon {
            asset: "files/file-tree-builtin-javascript.svg",
            color: Some(YELLOW),
        },
        BuiltinToken::Json => FileIcon {
            asset: "files/file-tree-builtin-json.svg",
            color: Some(ORANGE),
        },
        BuiltinToken::Markdown => FileIcon {
            asset: "files/file-tree-builtin-markdown.svg",
            color: Some(GREEN),
        },
        BuiltinToken::Mcp => FileIcon {
            asset: "files/file-tree-builtin-mcp.svg",
            color: Some(TEAL),
        },
        BuiltinToken::Nextjs => FileIcon {
            asset: "files/file-tree-builtin-nextjs.svg",
            color: None,
        },
        BuiltinToken::Oxc => FileIcon {
            asset: "files/file-tree-builtin-oxc.svg",
            color: Some(CYAN),
        },
        BuiltinToken::Postcss => FileIcon {
            asset: "files/file-tree-builtin-postcss.svg",
            color: Some(RED),
        },
        BuiltinToken::Prettier => FileIcon {
            asset: "files/file-tree-builtin-prettier.svg",
            color: Some(TEAL),
        },
        BuiltinToken::Python => FileIcon {
            asset: "files/file-tree-builtin-python.svg",
            color: Some(BLUE),
        },
        BuiltinToken::React => FileIcon {
            asset: "files/file-tree-builtin-react.svg",
            color: Some(CYAN),
        },
        BuiltinToken::Ruby => FileIcon {
            asset: "files/file-tree-builtin-ruby.svg",
            color: Some(RED),
        },
        BuiltinToken::Rust => FileIcon {
            asset: "files/file-tree-builtin-rust.svg",
            color: Some(ORANGE),
        },
        BuiltinToken::Sass => FileIcon {
            asset: "files/file-tree-builtin-sass.svg",
            color: Some(PINK),
        },
        BuiltinToken::Stylelint => FileIcon {
            asset: "files/file-tree-builtin-stylelint.svg",
            color: None,
        },
        BuiltinToken::Svelte => FileIcon {
            asset: "files/file-tree-builtin-svelte.svg",
            color: Some(RED),
        },
        BuiltinToken::Svg => FileIcon {
            asset: "files/file-tree-builtin-svg.svg",
            color: Some(ORANGE),
        },
        BuiltinToken::Svgo => FileIcon {
            asset: "files/file-tree-builtin-svgo.svg",
            color: Some(GREEN),
        },
        BuiltinToken::Swift => FileIcon {
            asset: "files/file-tree-builtin-swift.svg",
            color: Some(ORANGE),
        },
        BuiltinToken::Tailwind => FileIcon {
            asset: "files/file-tree-builtin-tailwind.svg",
            color: Some(CYAN),
        },
        BuiltinToken::Terraform => FileIcon {
            asset: "files/file-tree-builtin-terraform.svg",
            color: Some(INDIGO),
        },
        BuiltinToken::Text => FileIcon {
            asset: "files/file-tree-builtin-text.svg",
            color: Some(GRAY),
        },
        BuiltinToken::Typescript => FileIcon {
            asset: "files/file-tree-builtin-typescript.svg",
            color: Some(BLUE),
        },
        BuiltinToken::Vite => FileIcon {
            asset: "files/file-tree-builtin-vite.svg",
            color: Some(PURPLE),
        },
        BuiltinToken::Vscode => FileIcon {
            asset: "files/file-tree-builtin-vscode.svg",
            color: Some(BLUE),
        },
        BuiltinToken::Vue => FileIcon {
            asset: "files/file-tree-builtin-vue.svg",
            color: Some(GREEN),
        },
        BuiltinToken::Wasm => FileIcon {
            asset: "files/file-tree-builtin-wasm.svg",
            color: Some(INDIGO),
        },
        BuiltinToken::Webpack => FileIcon {
            asset: "files/file-tree-builtin-webpack.svg",
            color: Some(BLUE),
        },
        BuiltinToken::Yml => FileIcon {
            asset: "files/file-tree-builtin-yml.svg",
            color: Some(RED),
        },
        BuiltinToken::Zig => FileIcon {
            asset: "files/file-tree-builtin-zig.svg",
            color: Some(ORANGE),
        },
        BuiltinToken::Zip => FileIcon {
            asset: "files/file-tree-builtin-zip.svg",
            color: Some(ORANGE),
        },
    }
}

/// `@pierre/trees` `BUILT_IN_FILE_NAME_TOKENS` (`builtInIcons.js`).
fn builtin_file_name_token(lower_name: &str) -> Option<BuiltinToken> {
    use BuiltinToken as T;
    match lower_name {
        ".babelrc" | ".babelrc.json" | "babel.config.cjs" | "babel.config.js"
        | "babel.config.json" | "babel.config.mjs" => Some(T::Babel),
        ".bash_profile" | ".bashrc" | ".zprofile" | ".zshenv" | ".zshrc" => Some(T::Bash),
        ".browserslistrc" => Some(T::Browserslist),
        ".dockerignore"
        | "compose.yaml"
        | "compose.yml"
        | "docker-compose.override.yml"
        | "docker-compose.yaml"
        | "docker-compose.yml"
        | "dockerfile" => Some(T::Docker),
        ".eslintignore" | ".eslintrc" | ".eslintrc.cjs" | ".eslintrc.js" | ".eslintrc.json"
        | ".eslintrc.yaml" | ".eslintrc.yml" | "eslint.config.cjs" | "eslint.config.js"
        | "eslint.config.mjs" | "eslint.config.mts" | "eslint.config.ts" => Some(T::Eslint),
        ".gitattributes" | ".gitignore" | ".gitkeep" | ".gitmodules" => Some(T::Git),
        ".oxlintrc.json" => Some(T::Oxc),
        ".postcssrc" | ".postcssrc.json" | ".postcssrc.yaml" | ".postcssrc.yml"
        | "postcss.config.cjs" | "postcss.config.js" | "postcss.config.mjs"
        | "postcss.config.ts" => Some(T::Postcss),
        ".prettierignore"
        | ".prettierrc"
        | ".prettierrc.cjs"
        | ".prettierrc.js"
        | ".prettierrc.json"
        | ".prettierrc.mjs"
        | ".prettierrc.toml"
        | ".prettierrc.yaml"
        | ".prettierrc.yml"
        | "prettier.config.cjs"
        | "prettier.config.js"
        | "prettier.config.mjs" => Some(T::Prettier),
        ".stylelintignore"
        | ".stylelintrc"
        | ".stylelintrc.cjs"
        | ".stylelintrc.js"
        | ".stylelintrc.json"
        | ".stylelintrc.mjs"
        | ".stylelintrc.yaml"
        | ".stylelintrc.yml"
        | "stylelint.config.cjs"
        | "stylelint.config.js"
        | "stylelint.config.mjs" => Some(T::Stylelint),
        ".terraform.lock.hcl" => Some(T::Terraform),
        "biome.json" | "biome.jsonc" => Some(T::Biome),
        "bootstrap.bundle.js"
        | "bootstrap.bundle.min.js"
        | "bootstrap.css"
        | "bootstrap.js"
        | "bootstrap.min.css"
        | "bootstrap.min.js" => Some(T::Bootstrap),
        "bun.lock" | "bun.lockb" | "bunfig.toml" => Some(T::Bun),
        "claude.md" => Some(T::Claude),
        "gemfile" | "rakefile" => Some(T::Ruby),
        "next.config.js" | "next.config.mjs" | "next.config.mts" | "next.config.ts" => {
            Some(T::Nextjs)
        }
        "readme.md" => Some(T::Markdown),
        "svgo.config.cjs" | "svgo.config.js" | "svgo.config.mjs" | "svgo.config.ts" => {
            Some(T::Svgo)
        }
        "tailwind.config.cjs"
        | "tailwind.config.js"
        | "tailwind.config.mjs"
        | "tailwind.config.ts" => Some(T::Tailwind),
        "vite.config.js" | "vite.config.mjs" | "vite.config.mts" | "vite.config.ts" => {
            Some(T::Vite)
        }
        "webpack.config.babel.js"
        | "webpack.config.cjs"
        | "webpack.config.js"
        | "webpack.config.mjs"
        | "webpack.config.ts" => Some(T::Webpack),
        _ => None,
    }
}

/// `@pierre/trees` `COMPLETE_EXTENSION_OVERRIDES` + `BUILT_IN_FILE_EXTENSION_TOKENS`.
///
/// Uppercase keys in upstream `BUILT_IN_FILE_EXTENSION_TOKENS` (`AUTHORS`,
/// `CHANGELOG`, `CONTRIBUTORS`, `LICENSE`) are unreachable because extension
/// candidates are lowercased before lookup; table extensions (`csv`, `ods`,
/// `tsv`, `xls`, `xlsx`) are shadowed by Conn's `byFileExtension`.
fn builtin_extension_token(ext: &str) -> Option<BuiltinToken> {
    use BuiltinToken as T;
    match ext {
        // `COMPLETE_EXTENSION_OVERRIDES`
        "jsx" | "tsx" => Some(T::React),
        "sass" | "scss" => Some(T::Sass),

        // `BUILT_IN_FILE_EXTENSION_TOKENS`
        "7z" | "bz2" | "gz" | "jar" | "rar" | "tar" | "tgz" | "war" | "xz" | "zip" => Some(T::Zip),
        "astro" => Some(T::Astro),
        "avif" | "bmp" | "gif" | "icns" | "ico" | "jpeg" | "jpg" | "png" | "tif" | "tiff"
        | "webp" => Some(T::Image),
        "bash" | "csh" | "fish" | "ksh" | "sh" | "zsh" => Some(T::Bash),
        "c" | "h" => Some(T::C),
        "cc" | "cpp" | "cxx" | "hh" | "hpp" | "hxx" | "inl" | "mm" => Some(T::Cpp),
        "cfg" | "conf" | "editorconfig" | "env" | "env.development" | "env.local"
        | "env.production" | "ini" | "log" | "rst" | "txt" => Some(T::Text),
        "cjs" | "js" | "mjs" => Some(T::Javascript),
        "code-workspace" => Some(T::Vscode),
        "css" | "less" | "postcss" | "styl" => Some(T::Css),
        "cts" | "mts" | "ts" => Some(T::Typescript),
        "db" | "sql" | "sqlite" | "sqlite3" => Some(T::Database),
        "eot" | "otf" | "ttf" | "woff" | "woff2" => Some(T::Font),
        "erb" | "gemspec" | "rake" | "rb" => Some(T::Ruby),
        "go" => Some(T::Go),
        "gql" | "graphql" => Some(T::Graphql),
        "htm" | "html" | "xhtml" => Some(T::Html),
        "json" | "json5" | "jsonc" | "jsonl" => Some(T::Json),
        "markdown" | "md" | "mdx" | "mdx.tsx" => Some(T::Markdown),
        "mcp" => Some(T::Mcp),
        "py" | "pyi" | "pyw" | "pyx" => Some(T::Python),
        "rs" => Some(T::Rust),
        "svelte" => Some(T::Svelte),
        "svg" => Some(T::Svg),
        "swift" => Some(T::Swift),
        "tf" | "tfstate" | "tfvars" => Some(T::Terraform),
        "vue" => Some(T::Vue),
        "wasm" | "wast" | "wat" => Some(T::Wasm),
        "yaml" | "yml" => Some(T::Yml),
        "zig" => Some(T::Zig),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use gpui_kit::AssetSource as _;

    use super::*;
    use crate::superhero::AppAssets;

    fn icon_name(icon: FileIcon) -> &'static str {
        icon.asset
            .strip_prefix("files/")
            .and_then(|s| s.strip_suffix(".svg"))
            .expect("asset path must have form files/<name>.svg")
    }

    #[test]
    fn matches_js_pierre_resolver_on_verified_filenames() {
        // Expected names generated by running `@pierre/trees@1.0.0-beta.6`'s
        // `createFileTreeIconResolver(T3_PIERRE_ICONS)` in Node on every input.
        const CASES: &[(&str, &str)] = &[
            ("Cargo.toml", "t3-file-icon-toml"),
            ("Cargo.lock", "file-tree-builtin-default"),
            (".gitignore", "file-tree-builtin-git"),
            ("AGENTS.md", "t3-file-icon-agents"),
            ("CLAUDE.md", "file-tree-builtin-claude"),
            ("README.md", "file-tree-builtin-markdown"),
            ("package.json", "file-tree-builtin-npm"),
            ("tsconfig.json", "file-tree-builtin-typescript"),
            ("foo.rs", "file-tree-builtin-rust"),
            ("foo.ts", "file-tree-builtin-typescript"),
            ("foo.tsx", "file-tree-builtin-react"),
            ("Dockerfile", "file-tree-builtin-docker"),
            (".env", "file-tree-builtin-text"),
            (".env.local", "file-tree-builtin-text"),
            (".env.production", "file-tree-builtin-text"),
            (".env.example", "file-tree-builtin-default"),
            ("image.png", "file-tree-builtin-image"),
            ("photo.heic", "file-tree-builtin-image"),
            ("PHOTO.HEIF", "file-tree-builtin-image"),
            ("doc.pdf", "t3-file-icon-pdf"),
            ("data.csv", "t3-file-icon-spreadsheet"),
            ("script.sh", "file-tree-builtin-bash"),
            ("rust-toolchain.toml", "t3-file-icon-toml"),
            ("foo.php", "t3-file-icon-php"),
            ("foo.py", "file-tree-builtin-python"),
            ("pnpm-lock.yaml", "t3-file-icon-pnpm"),
            ("pnpm-workspace.yaml", "t3-file-icon-pnpm"),
            ("clip.mp4", "t3-file-icon-video"),
            ("movie.webm", "t3-file-icon-video"),
            ("src/components/Button.jsx", "file-tree-builtin-react"),
            ("src/styles/main.scss", "file-tree-builtin-sass"),
            ("src/styles/app.css", "file-tree-builtin-css"),
            ("src/index.html", "file-tree-builtin-html"),
            ("src/App.vue", "file-tree-builtin-vue"),
            ("src/App.svelte", "file-tree-builtin-svelte"),
            ("cmd/server/main.go", "file-tree-builtin-go"),
            ("build.zig", "file-tree-builtin-zig"),
            ("schema.graphql", "file-tree-builtin-graphql"),
            ("db/app.sqlite3", "file-tree-builtin-database"),
            ("archive.tar.gz", "file-tree-builtin-zip"),
            ("bundle.zip", "file-tree-builtin-zip"),
            ("fonts/Inter.woff2", "file-tree-builtin-font"),
            ("notes.txt", "file-tree-builtin-text"),
            ("docs/post.mdx.tsx", "file-tree-builtin-markdown"),
            ("next.config.ts", "file-tree-builtin-nextjs"),
            ("vite.config.mts", "file-tree-builtin-vite"),
            ("tailwind.config.js", "file-tree-builtin-tailwind"),
            ("biome.jsonc", "file-tree-builtin-biome"),
            (".eslintrc.json", "file-tree-builtin-eslint"),
            (".prettierrc.toml", "t3-file-icon-toml"),
            ("bunfig.toml", "t3-file-icon-toml"),
            ("bun.lock", "file-tree-builtin-bun"),
            ("docker-compose.yml", "file-tree-builtin-docker"),
            ("webpack.config.babel.js", "file-tree-builtin-webpack"),
            ("Main.java", "t3-file-icon-java"),
            ("Program.cs", "t3-file-icon-csharp"),
            ("lib/main.dart", "t3-file-icon-dart"),
            ("mix.exs", "t3-file-icon-elixir"),
            ("src/Main.hs", "t3-file-icon-haskell"),
            ("App.kt", "t3-file-icon-kotlin"),
            ("init.luau", "t3-file-icon-lua"),
            ("deploy.ps1", "t3-file-icon-powershell"),
            ("stats.R", "t3-file-icon-r"),
            ("Server.scala", "t3-file-icon-scala"),
            ("config.xsd", "t3-file-icon-xml"),
            ("fix.patch", "t3-file-icon-diff"),
            ("report.docx", "t3-file-icon-word"),
            ("deck.pptx", "t3-file-icon-slides"),
            ("book.epub", "t3-file-icon-epub"),
            ("module.wasm", "file-tree-builtin-wasm"),
            ("infra/main.tf", "file-tree-builtin-terraform"),
            ("Package.swift", "file-tree-builtin-swift"),
            ("Gemfile", "file-tree-builtin-ruby"),
            ("page.astro", "file-tree-builtin-astro"),
            ("logo.svg", "file-tree-builtin-svg"),
            ("config.yaml", "file-tree-builtin-yml"),
            ("src/foo.c", "file-tree-builtin-c"),
            ("src/foo.hpp", "file-tree-builtin-cpp"),
            ("src/index.mjs", "file-tree-builtin-javascript"),
            ("LICENSE", "file-tree-builtin-default"),
            ("Makefile", "file-tree-builtin-default"),
            ("a/b/c/README.MD", "file-tree-builtin-markdown"),
            ("deep/nested/AGENTS.MD", "t3-file-icon-agents"),
            ("unknown.xyz", "file-tree-builtin-default"),
        ];

        for &(path, expected) in CASES {
            let resolved = file_icon(path);
            assert_eq!(
                icon_name(resolved),
                expected,
                "wrong icon for path {path:?}"
            );
        }
    }

    #[test]
    fn icon_colors_match_conn_palette_in_light_and_dark() {
        let rust = file_icon("src/main.rs");
        let rust_color = rust.color.expect("rust icon must have a tint color");
        assert_eq!(
            rust_color.for_appearance(Appearance::Light),
            rgb(0xd47628),
            "rust light color"
        );
        assert_eq!(
            rust_color.for_appearance(Appearance::Dark),
            rgb(0xffa359),
            "rust dark color"
        );

        let pdf = file_icon("spec.pdf");
        let pdf_color = pdf.color.expect("pdf icon must have a tint color");
        assert_eq!(
            pdf_color.for_appearance(Appearance::Light),
            rgb(0xd52c36),
            "pdf light color"
        );
        assert_eq!(
            pdf_color.for_appearance(Appearance::Dark),
            rgb(0xff6762),
            "pdf dark color"
        );

        let heic = file_icon("photo.heic");
        assert_eq!(heic.color, Some(PINK), "heic restores image token tint");

        let video = file_icon("demo.mp4");
        assert_eq!(
            video.color,
            Some(VIDEO_FIXED_PURPLE),
            "video uses fixed #a631be in light and dark"
        );

        assert_eq!(
            file_icon("AGENTS.md").color,
            None,
            "agents.md inherits muted foreground"
        );
        assert_eq!(
            file_icon("package.json").color,
            None,
            "package.json has no token in Conn"
        );
        assert_eq!(
            file_icon("tsconfig.json").color,
            None,
            "tsconfig.json has no token in Conn"
        );
        assert_eq!(
            file_icon("pnpm-lock.yaml").color,
            None,
            "pnpm-lock.yaml has no token in Conn"
        );
    }

    #[test]
    fn every_returnable_asset_exists_and_is_valid_svg() {
        // Sample inputs exercising every reachable icon variant (52 built-ins + 22 t3 icons).
        const COVERAGE_INPUTS: &[&str] = &[
            // Conn byFileName
            "package.json",
            "tsconfig.json",
            "AGENTS.md",
            "pnpm-lock.yaml",
            // Conn byFileExtension
            "a.mp4",
            "a.pdf",
            "a.docx",
            "a.csv",
            "a.pptx",
            "a.epub",
            "a.cs",
            "a.dart",
            "a.patch",
            "a.ex",
            "a.hs",
            "a.heic",
            "a.java",
            "a.kt",
            "a.lua",
            "a.php",
            "a.ps1",
            "a.r",
            "a.scala",
            "a.toml",
            "a.xml",
            // Built-in filenames & extensions (every BuiltinToken variant)
            "a.astro",
            ".babelrc",
            "a.sh",
            "biome.json",
            "bootstrap.css",
            ".browserslistrc",
            "bun.lock",
            "a.c",
            "CLAUDE.md",
            "a.cpp",
            "a.css",
            "a.sql",
            "unknown",
            "Dockerfile",
            ".eslintrc.json",
            "a.woff2",
            ".gitignore",
            "a.go",
            "a.graphql",
            "a.html",
            "a.png",
            "a.js",
            "a.json",
            "README.md",
            "a.mcp",
            "next.config.ts",
            ".oxlintrc.json",
            "postcss.config.js",
            ".prettierrc",
            "a.py",
            "a.tsx",
            "a.rb",
            "a.rs",
            "a.scss",
            ".stylelintrc",
            "a.svelte",
            "a.svg",
            "svgo.config.js",
            "a.swift",
            "tailwind.config.js",
            "a.tf",
            "a.txt",
            "a.ts",
            "vite.config.ts",
            "a.code-workspace",
            "a.vue",
            "a.wasm",
            "webpack.config.js",
            "a.yml",
            "a.zig",
            "a.zip",
        ];

        let mut seen = BTreeSet::new();
        for &input in COVERAGE_INPUTS {
            let icon = file_icon(input);
            seen.insert(icon.asset);
            let loaded = AppAssets
                .load(icon.asset)
                .expect("AppAssets::load must not error");
            let bytes = loaded
                .unwrap_or_else(|| panic!("embedded asset missing for {input:?}: {}", icon.asset));
            let text = std::str::from_utf8(&bytes)
                .unwrap_or_else(|err| panic!("{} is not valid UTF-8: {err}", icon.asset));
            assert!(
                text.starts_with("<svg ") && text.contains("viewBox="),
                "{} must be a standalone <svg> with viewBox",
                icon.asset
            );
            assert!(
                !text.contains("light-dark(") && !text.contains("var(--"),
                "{} must not contain CSS functions unsupported by usvg",
                icon.asset
            );
        }

        // Verify exact 1:1 parity between reachable icons and embedded `files/` assets.
        let embedded: BTreeSet<String> = AppAssets
            .list("files/")
            .expect("AppAssets::list must not error")
            .into_iter()
            .map(|s| s.to_string())
            .collect();
        let expected: BTreeSet<String> = seen.into_iter().map(str::to_owned).collect();
        assert_eq!(
            embedded, expected,
            "embedded files/*.svg assets must exactly match reachable icons"
        );
        assert_eq!(embedded.len(), 74, "expected 52 built-in + 22 t3 icons");
    }
}
