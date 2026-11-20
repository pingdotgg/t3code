//! `t3_theme_read` and `t3_theme_set` (`mcp/toolkits/theme`, `EnvironmentThemeService`).

use conn_files::themes::{self, Refused, Themes};
use serde_json::{Map, Value, json};

use super::{Args, Cx, ToolError, ToolResult, fail, str_arg};

fn unavailable() -> ToolError {
    fail(
        "orchestration_error",
        "The operation could not be completed.",
    )
}

fn refused(error: &Refused) -> ToolError {
    fail("invalid_request", error.message())
}

fn service(cx: &Cx<'_>) -> Result<Themes, ToolError> {
    cx.config()
        .files
        .as_ref()
        .map(|files| files.themes.clone())
        .ok_or_else(unavailable)
}

async fn refresh(themes: &Themes) -> Result<themes::Snapshot, ToolError> {
    let themes = themes.clone();
    tokio::task::spawn_blocking(move || themes.refresh())
        .await
        .map_err(|_| unavailable())
}

/// `t3_theme_read` (`reads`): the default theme, the built-in and published themes, one
/// published theme's file when asked, and the guide.
pub(super) async fn read(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let themes = service(cx)?;
    let snapshot = refresh(&themes).await?;
    let settings = cx.config().settings.as_ref().ok_or_else(unavailable)?;
    let current = (settings.read)()
        .get("defaultTheme")
        .cloned()
        .unwrap_or_else(|| Value::from(""));
    let mut theme = None;
    if let Some(theme_id) = str_arg(args, "themeId") {
        let Some(found) = snapshot.themes.iter().find(|t| t["id"] == theme_id) else {
            let mut error = Refused::new(theme_id, "is not a published theme.");
            error.known = Some(snapshot.ids());
            return Err(refused(&error));
        };
        let mut file = found.as_object().cloned().unwrap_or_default();
        file.remove("id");
        file.remove("background");
        theme = Some(Value::Object(file));
    }
    let published: Vec<Value> = snapshot
        .themes
        .iter()
        .map(|t| {
            json!({
                "id": t["id"],
                "name": t["name"],
                "hasCss": t["css"].as_str().is_some_and(|css| !css.is_empty()),
                "hasBackground": t.get("background").is_some(),
            })
        })
        .collect();
    let upstream = themes::upstream();
    let mut result = json!({
        "current": current,
        "builtIn": upstream.built_in,
        "published": published,
        "themesDir": themes.dir().display().to_string(),
        "guide": upstream.guide,
    });
    if let Some(theme) = theme {
        result["theme"] = theme;
    }
    Ok(result)
}

/// `t3_theme_set` (`writesEnvironment`): publishes `theme` under `themeId` when given, then
/// makes the theme and `appearance` the environment's defaults. A failed select puts back the
/// file the publish replaced.
pub(super) async fn set(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.environment_writer().await?;
    let theme_id = str_arg(args, "themeId");
    let appearance = str_arg(args, "appearance");
    let theme = args.get("theme");
    if theme_id.is_none() && (theme.is_some() || appearance.is_none()) {
        return Err(fail(
            "invalid_request",
            "Give `themeId`, `appearance`, or both. `theme` needs a `themeId`.",
        ));
    }
    let file: Option<Map<String, Value>> = match theme {
        // The input rules decoded it already; this keeps only the file's own fields.
        Some(theme) => Some(
            themes::decode_theme_file(theme)
                .ok_or_else(|| fail("invalid_request", "`theme` is not a valid theme file."))?,
        ),
        None => None,
    };
    let service = service(cx)?;
    let settings = cx.config().settings.as_ref().ok_or_else(unavailable)?;
    // The stock theme is an empty default with a set time, which clients adopt as stock.
    let default_theme = theme_id.map(|id| {
        if id == themes::upstream().default_id {
            ""
        } else {
            id
        }
    });
    let select = || async {
        let set_at = conn_support::time::iso_from_ms(conn_support::time::now_ms());
        let mut patch = Map::new();
        if let Some(default_theme) = default_theme {
            patch.insert("defaultTheme".into(), Value::from(default_theme));
            patch.insert("defaultThemeSetAt".into(), Value::from(set_at.clone()));
        }
        if let Some(appearance) = appearance {
            patch.insert("defaultAppearance".into(), Value::from(appearance));
            patch.insert("defaultAppearanceSetAt".into(), Value::from(set_at));
        }
        (settings.update)(Value::Object(patch))
            .await
            .map(|_| ())
            .map_err(|_| unavailable())
    };
    {
        let _publishing = service.lock_publish().await;
        // The turn may have ended, or the thread's modes changed, while this waited.
        cx.environment_writer().await?;
        if let Some(id) = theme_id
            && !themes::is_theme_id(id)
        {
            return Err(refused(&Refused::invalid_id(id)));
        }
        match (theme_id, file) {
            (None, _) => select().await?,
            (Some(id), None) => {
                let snapshot = refresh(&service).await?;
                let mut known = themes::upstream().built_in.clone();
                known.extend(snapshot.ids());
                if !known.iter().any(|k| k == id) {
                    let mut error = Refused::new(id, "is not a built-in or published theme.");
                    error.known = Some(known);
                    return Err(refused(&error));
                }
                select().await?;
            }
            (Some(id), Some(file)) => {
                let publisher = service.clone();
                let owned = id.to_owned();
                let revert = tokio::task::spawn_blocking(move || publisher.publish(&owned, &file))
                    .await
                    .map_err(|_| unavailable())?
                    .map_err(|e| refused(&e))?;
                if let Err(error) = select().await {
                    let _ = tokio::task::spawn_blocking(move || revert.run()).await;
                    return Err(error);
                }
            }
        }
    }
    let mut result = json!({ "published": theme.is_some() });
    if let Some(id) = theme_id {
        result["themeId"] = Value::from(id);
    }
    if let Some(appearance) = appearance {
        result["appearance"] = Value::from(appearance);
    }
    Ok(result)
}
