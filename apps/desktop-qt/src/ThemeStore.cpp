#include "ThemeStore.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QRegularExpression>

namespace {

// Role names are camelCase in the file and become `--app-theme-<kebab>` on
// the page, mirroring APP_THEME_VARIABLES in apps/web/src/themePalette.ts.
bool isRoleName(const QString& name) {
  static const QRegularExpression pattern(QStringLiteral("^[a-z][a-zA-Z0-9]*$"));
  return pattern.match(name).hasMatch();
}

QString cssVariableForRole(const QString& role) {
  if (role == QStringLiteral("terminalSelection")) {
    return QStringLiteral("--app-theme-terminal-selection-background");
  }
  QString kebab;
  for (const QChar ch : role) {
    if (ch.isUpper()) {
      kebab += QLatin1Char('-');
      kebab += ch.toLower();
    } else {
      kebab += ch;
    }
  }
  return QStringLiteral("--app-theme-") + kebab;
}

// Values land in inline styles; keep them to what a colour token can be.
bool isSafeColorValue(const QString& value) {
  static const QRegularExpression pattern(QStringLiteral("^[a-zA-Z0-9#(),.%/ -]+$"));
  return !value.isEmpty() && value.size() < 128 && pattern.match(value).hasMatch();
}

QString jsLiteral(const QJsonValue& value) {
  return QString::fromUtf8(QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact))
      .mid(1)
      .chopped(1);
}

void mergeColors(QVariantMap& into, const QJsonObject& colors) {
  for (auto it = colors.begin(); it != colors.end(); ++it) {
    if (isRoleName(it.key()) && it.value().isString() && isSafeColorValue(it.value().toString())) {
      into.insert(it.key(), it.value().toString());
    }
  }
}

}  // namespace

ThemeStore::ThemeStore(const QString& configDir, QObject* parent)
    : QObject(parent),
      m_configDir(configDir),
      m_path(QDir(configDir).filePath(QStringLiteral("theme.json"))) {
  m_debounce.setSingleShot(true);
  m_debounce.setInterval(80);
  connect(&m_debounce, &QTimer::timeout, this, &ThemeStore::reload);
  connect(&m_watcher, &QFileSystemWatcher::fileChanged, this, [this] {
    watch();
    scheduleReload();
  });
  connect(&m_watcher, &QFileSystemWatcher::directoryChanged, this, [this] {
    watch();
    scheduleReload();
  });
  applyDefaults();
  watch();
  reload();
}

void ThemeStore::watch() {
  if (QDir(m_configDir).exists() && !m_watcher.directories().contains(m_configDir)) {
    m_watcher.addPath(m_configDir);
  }
  if (QFileInfo::exists(m_path) && !m_watcher.files().contains(m_path)) {
    m_watcher.addPath(m_path);
  }
}

void ThemeStore::scheduleReload() {
  m_debounce.start();
}

void ThemeStore::applyDefaults() {
  m_loaded = false;
  m_id.clear();
  m_name.clear();
  m_appearance.clear();
  m_colors.clear();
  m_windowOpacity = 1.0;
  m_windowTransparent = false;
  m_windowBlur = false;
  m_frameless = true;
  m_lastError.clear();
}

void ThemeStore::reload() {
  QFile file(m_path);
  if (!file.exists()) {
    if (m_loaded || !m_lastContent.isEmpty()) {
      m_lastContent.clear();
      applyDefaults();
      emit themeChanged();
    }
    return;
  }
  if (!file.open(QIODevice::ReadOnly)) {
    m_lastError = QStringLiteral("Cannot read %1").arg(m_path);
    emit themeChanged();
    return;
  }
  const QByteArray content = file.readAll();
  if (content == m_lastContent) {
    return;
  }
  m_lastContent = content;

  QJsonParseError parseError;
  const QJsonDocument doc = QJsonDocument::fromJson(content, &parseError);
  if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
    // Keep the previous good theme; a half-written file must not flash defaults.
    m_lastError = QStringLiteral("theme.json: %1").arg(parseError.errorString());
    emit themeChanged();
    return;
  }

  applyDefaults();
  const QJsonObject root = doc.object();
  m_loaded = true;
  m_id = root.value(QStringLiteral("id")).toString(QStringLiteral("shell"));
  m_name = root.value(QStringLiteral("name")).toString(m_id);
  m_appearance = root.value(QStringLiteral("appearance")).toString() == QStringLiteral("light")
                     ? QStringLiteral("light")
                     : QStringLiteral("dark");

  mergeColors(m_colors, root.value(QStringLiteral("colors")).toObject());
  mergeColors(m_colors, root.value(QStringLiteral("variants")).toObject().value(m_appearance).toObject());

  const QJsonObject window = root.value(QStringLiteral("window")).toObject();
  m_windowOpacity = qBound(0.1, window.value(QStringLiteral("opacity")).toDouble(1.0), 1.0);
  m_windowTransparent = window.value(QStringLiteral("transparent")).toBool(false);
  m_windowBlur = window.value(QStringLiteral("blur")).toBool(false);
  m_frameless = window.value(QStringLiteral("frameless")).toBool(true);

  emit themeChanged();
}

QString ThemeStore::injectionScript() const {
  // Applies the theme the same way the web app applies its own
  // (applyThemeColorPreview in themePalette.ts): `data-theme-id` on <html>
  // plus inline `--app-theme-*` variables. The web app re-applies its stored
  // preference on boot and on changes, so an observer re-asserts ours until
  // the SPA takes shell themes over itself. An empty theme removes the hook.
  QJsonObject vars;
  for (auto it = m_colors.cbegin(); it != m_colors.cend(); ++it) {
    vars.insert(cssVariableForRole(it.key()), it.value().toString());
  }
  const QJsonObject theme{
      {QStringLiteral("id"), m_loaded ? m_id : QString()},
      {QStringLiteral("dark"), m_appearance != QStringLiteral("light")},
      {QStringLiteral("vars"), vars},
  };
  return QStringLiteral(
             "(() => {"
             "  const theme = %1;"
             "  const root = document.documentElement;"
             "  const state = (window.__t3ShellTheme ||= {});"
             "  if (state.observer) { state.observer.disconnect(); state.observer = null; }"
             "  if (!theme.id) {"
             "    for (const name of state.applied || []) root.style.removeProperty(name);"
             "    state.applied = [];"
             "    return;"
             "  }"
             "  const apply = () => {"
             "    root.dataset.themeId = theme.id;"
             "    root.classList.toggle('dark', theme.dark);"
             "    for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);"
             "  };"
             "  for (const name of state.applied || []) if (!(name in theme.vars)) root.style.removeProperty(name);"
             "  state.applied = Object.keys(theme.vars);"
             "  apply();"
             "  state.observer = new MutationObserver(() => {"
             "    if (root.dataset.themeId !== theme.id) apply();"
             "  });"
             "  state.observer.observe(root, { attributes: true, attributeFilter: ['data-theme-id'] });"
             "})();")
      .arg(jsLiteral(theme));
}

QColor ThemeStore::color(const QString& role, const QColor& fallback) const {
  const auto value = m_colors.value(role).toString();
  if (value.isEmpty()) {
    return fallback;
  }
  const QColor parsed(value);
  return parsed.isValid() ? parsed : fallback;
}
