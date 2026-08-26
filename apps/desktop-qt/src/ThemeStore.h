#pragma once

#include <QColor>
#include <QFileSystemWatcher>
#include <QObject>
#include <QString>
#include <QTimer>
#include <QVariantMap>

// Loads `<configDir>/theme.json`, watches it, and exposes it to QML (the
// `Theme` singleton) and to the web view. The file is the web app's own
// ThemeFile format (`{version, id, name, appearance, colors, variants}`, role
// names such as `canvas`, `chrome`, `text`, `sidebar`) plus a shell-only
// `window` section, so one file themes both halves and the web's Theme Editor
// can author it.
class ThemeStore : public QObject {
  Q_OBJECT
  Q_PROPERTY(bool loaded READ loaded NOTIFY themeChanged)
  Q_PROPERTY(QString path READ path CONSTANT)
  Q_PROPERTY(QString id READ id NOTIFY themeChanged)
  Q_PROPERTY(QString name READ name NOTIFY themeChanged)
  Q_PROPERTY(QString appearance READ appearance NOTIFY themeChanged)
  Q_PROPERTY(QVariantMap colors READ colors NOTIFY themeChanged)
  Q_PROPERTY(qreal windowOpacity READ windowOpacity NOTIFY themeChanged)
  Q_PROPERTY(bool windowTransparent READ windowTransparent NOTIFY themeChanged)
  Q_PROPERTY(bool windowBlur READ windowBlur NOTIFY themeChanged)
  Q_PROPERTY(bool frameless READ frameless NOTIFY themeChanged)
  Q_PROPERTY(QString injectionScript READ injectionScript NOTIFY themeChanged)
  Q_PROPERTY(QString lastError READ lastError NOTIFY themeChanged)

public:
  explicit ThemeStore(const QString& configDir, QObject* parent = nullptr);

  bool loaded() const { return m_loaded; }
  QString path() const { return m_path; }
  QString id() const { return m_id; }
  QString name() const { return m_name; }
  QString appearance() const { return m_appearance; }
  QVariantMap colors() const { return m_colors; }
  qreal windowOpacity() const { return m_windowOpacity; }
  bool windowTransparent() const { return m_windowTransparent; }
  bool windowBlur() const { return m_windowBlur; }
  bool frameless() const { return m_frameless; }
  QString injectionScript() const;
  QString lastError() const { return m_lastError; }

  // Resolved colour for a role (`canvas`, `text`, ...), or `fallback`.
  Q_INVOKABLE QColor color(const QString& role, const QColor& fallback) const;
  Q_INVOKABLE void reload();

signals:
  void themeChanged();

private:
  void watch();
  void scheduleReload();
  void applyDefaults();

  QString m_configDir;
  QString m_path;
  QFileSystemWatcher m_watcher;
  QTimer m_debounce;
  QByteArray m_lastContent;

  bool m_loaded = false;
  QString m_id;
  QString m_name;
  QString m_appearance;
  QVariantMap m_colors;
  qreal m_windowOpacity = 1.0;
  bool m_windowTransparent = false;
  bool m_windowBlur = false;
  bool m_frameless = true;
  QString m_lastError;
};
