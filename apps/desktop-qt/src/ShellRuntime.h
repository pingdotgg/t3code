#pragma once

#include <QFileSystemWatcher>
#include <QObject>
#include <QQmlApplicationEngine>
#include <QString>
#include <QStringList>
#include <QTimer>
#include <QUrl>

class ShellBridge;
class ThemeStore;

// Owns the QML engine "generation": resolves which shell.qml to load (user
// config dir first, built-in default otherwise), watches the QML sources it
// loaded from disk, and rebuilds the whole engine when they change. A broken
// user shell falls back to the default with `lastError` set so a bad rice can
// never lock the app.
class ShellRuntime : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString configDir READ configDir CONSTANT)
  Q_PROPERTY(QString userShellPath READ userShellPath CONSTANT)
  Q_PROPERTY(bool usingUserShell READ usingUserShell NOTIFY generationChanged)
  Q_PROPERTY(QString lastError READ lastError NOTIFY generationChanged)
  Q_PROPERTY(int generation READ generation NOTIFY generationChanged)
  Q_PROPERTY(bool hotReloadEnabled READ hotReloadEnabled CONSTANT)
  Q_PROPERTY(QString appVersion READ appVersion CONSTANT)

public:
  struct Options {
    QString configDir;
    QString qmlSourceDir;  // empty = compiled-in bricks only
  };

  ShellRuntime(Options options, ShellBridge* bridge, ThemeStore* theme, QObject* parent = nullptr);
  ~ShellRuntime() override;

  QString configDir() const { return m_options.configDir; }
  QString userShellPath() const;
  bool usingUserShell() const { return m_usingUserShell; }
  QString lastError() const { return m_lastError; }
  int generation() const { return m_generation; }
  bool hotReloadEnabled() const { return true; }
  QString appVersion() const;

  void start();
  Q_INVOKABLE void reload();
  // Grabs the current root window into a PNG; used by --screenshot and
  // available to bricks for the same purpose.
  Q_INVOKABLE bool captureWindow(const QString& path);

signals:
  void generationChanged();

private:
  bool loadGeneration(const QUrl& rootUrl, QString* errorOut);
  void rebuildWatchList();
  QString sourceFingerprint() const;
  QUrl defaultShellUrl() const;

  Options m_options;
  ShellBridge* m_bridge;
  ThemeStore* m_theme;
  QQmlApplicationEngine* m_engine = nullptr;
  QFileSystemWatcher m_watcher;
  QTimer m_debounce;
  QString m_fingerprint;
  QString m_lastError;
  bool m_usingUserShell = false;
  int m_generation = 0;
};
