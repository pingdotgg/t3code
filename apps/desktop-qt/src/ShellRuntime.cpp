#include "ShellRuntime.h"

#include <QCryptographicHash>
#include <QDir>
#include <QDirIterator>
#include <QFileInfo>
#include <QImage>
#include <QQmlContext>
#include <QQuickWindow>
#include <QQmlError>
#include <QtLogging>
#include <QtQml/qqml.h>

#include "PlatformWindow.h"
#include "ShellBridge.h"
#include "ThemeStore.h"

namespace {

const QStringList kWatchedSuffixes{QStringLiteral("qml"), QStringLiteral("js"),
                                   QStringLiteral("qmldir")};

bool isWatchedSource(const QFileInfo& info) {
  return kWatchedSuffixes.contains(info.suffix()) || info.fileName() == QStringLiteral("qmldir");
}

}  // namespace

ShellRuntime::ShellRuntime(Options options, ShellBridge* bridge, ThemeStore* theme, QObject* parent)
    : QObject(parent), m_options(std::move(options)), m_bridge(bridge), m_theme(theme) {
  // Registered once: singleton instances are shared by every engine generation,
  // which is what keeps published web state alive across a hot reload.
  qmlRegisterSingletonInstance("T3.Shell", 1, 0, "Shell", m_bridge);
  qmlRegisterSingletonInstance("T3.Shell", 1, 0, "Theme", m_theme);
  qmlRegisterSingletonInstance("T3.Shell", 1, 0, "Runtime", this);

  m_debounce.setSingleShot(true);
  m_debounce.setInterval(120);
  connect(&m_debounce, &QTimer::timeout, this, [this] {
    rebuildWatchList();
    const QString next = sourceFingerprint();
    if (next == m_fingerprint) {
      return;
    }
    reload();
  });
  connect(&m_watcher, &QFileSystemWatcher::directoryChanged, &m_debounce,
          qOverload<>(&QTimer::start));
  connect(&m_watcher, &QFileSystemWatcher::fileChanged, &m_debounce, qOverload<>(&QTimer::start));
}

ShellRuntime::~ShellRuntime() {
  delete m_engine;
}

QString ShellRuntime::userShellPath() const {
  return QDir(m_options.configDir).filePath(QStringLiteral("shell.qml"));
}

QString ShellRuntime::appVersion() const {
  return QStringLiteral(T3_APP_VERSION);
}

QUrl ShellRuntime::defaultShellUrl() const {
  if (!m_options.qmlSourceDir.isEmpty()) {
    const QString onDisk =
        QDir(m_options.qmlSourceDir).filePath(QStringLiteral("T3/Bricks/DefaultShell.qml"));
    if (QFileInfo::exists(onDisk)) {
      return QUrl::fromLocalFile(onDisk);
    }
  }
  return QUrl(QStringLiteral("qrc:/qt/qml/T3/Bricks/DefaultShell.qml"));
}

void ShellRuntime::start() {
  rebuildWatchList();
  reload();
}

void ShellRuntime::reload() {
  QQmlApplicationEngine* previous = m_engine;
  const bool previousUsingUserShell = m_usingUserShell;
  m_engine = nullptr;
  m_lastError.clear();
  m_usingUserShell = false;

  QString error;
  const QString userShell = userShellPath();
  bool loaded = false;
  if (QFileInfo::exists(userShell)) {
    loaded = loadGeneration(QUrl::fromLocalFile(userShell), &error);
    m_usingUserShell = loaded;
    if (!loaded) {
      m_lastError = error;
      qWarning().noquote() << "[shell] user shell failed, falling back to default:\n" << error;
    }
  }
  if (!loaded) {
    QString defaultError;
    loaded = loadGeneration(defaultShellUrl(), &defaultError);
    if (!loaded) {
      m_lastError = m_lastError.isEmpty() ? defaultError : m_lastError + QLatin1Char('\n') + defaultError;
      qCritical().noquote() << "[shell] default shell failed:\n" << defaultError;
    }
  }

  if (!loaded) {
    // Neither shell loaded: keep the previous generation on screen so the
    // app never loses its window; the overlay shows lastError until the next
    // source change retries.
    m_engine = previous;
    m_usingUserShell = previousUsingUserShell;
    m_fingerprint = sourceFingerprint();
    emit generationChanged();
    return;
  }
  // The new window exists before the old one goes, so the app never hits
  // "last window closed" mid-reload.
  if (previous != nullptr) {
    previous->deleteLater();
  }
  for (QObject* root : m_engine->rootObjects()) {
    if (auto* window = qobject_cast<QQuickWindow*>(root)) {
      applyWindowBlur(window, m_theme->windowTransparent() && m_theme->windowBlur(),
                      m_theme->appearance() != QStringLiteral("light"));
    }
  }
  m_fingerprint = sourceFingerprint();
  ++m_generation;
  qInfo().noquote() << "[shell] generation" << m_generation << "loaded from"
                    << (m_usingUserShell ? userShellPath() : defaultShellUrl().toString());
  emit generationChanged();
}

bool ShellRuntime::loadGeneration(const QUrl& rootUrl, QString* errorOut) {
  auto* engine = new QQmlApplicationEngine(this);
  if (!m_options.qmlSourceDir.isEmpty()) {
    engine->addImportPath(m_options.qmlSourceDir);
  }
  const QString userImports = QDir(m_options.configDir).filePath(QStringLiteral("qml"));
  if (QDir(userImports).exists()) {
    engine->addImportPath(userImports);
  }

  // Collect load-time diagnostics into locals, then hand the connection over
  // to a logger: these lambdas must not outlive the locals they capture.
  QStringList messages;
  const auto warningsDuringLoad =
      connect(engine, &QQmlEngine::warnings, this, [&messages](const QList<QQmlError>& warnings) {
        for (const auto& warning : warnings) {
          messages << warning.toString();
        }
      });
  bool failed = false;
  const auto creationFailed = connect(engine, &QQmlApplicationEngine::objectCreationFailed, this,
                                      [&failed](const QUrl&) { failed = true; });

  engine->load(rootUrl);
  disconnect(warningsDuringLoad);
  disconnect(creationFailed);
  connect(engine, &QQmlEngine::warnings, this, [](const QList<QQmlError>& warnings) {
    for (const auto& warning : warnings) {
      qWarning().noquote() << "[qml]" << warning.toString();
    }
  });
  for (const auto& message : messages) {
    qWarning().noquote() << "[qml]" << message;
  }
  if (failed || engine->rootObjects().isEmpty()) {
    if (errorOut != nullptr) {
      *errorOut = messages.isEmpty()
                      ? QStringLiteral("Failed to load %1").arg(rootUrl.toString())
                      : messages.join(QLatin1Char('\n'));
    }
    delete engine;
    return false;
  }
  m_engine = engine;
  return true;
}

void ShellRuntime::rebuildWatchList() {
  QStringList directories;
  const auto collect = [&directories](const QString& root) {
    if (root.isEmpty() || !QDir(root).exists()) {
      return;
    }
    directories << root;
    QDirIterator it(root, QDir::Dirs | QDir::NoDotAndDotDot, QDirIterator::Subdirectories);
    while (it.hasNext()) {
      directories << it.next();
    }
  };
  collect(m_options.configDir);
  collect(m_options.qmlSourceDir);

  const QStringList watched = m_watcher.directories();
  QStringList added;
  for (const auto& dir : directories) {
    if (!watched.contains(dir)) {
      added << dir;
    }
  }
  if (!added.isEmpty()) {
    m_watcher.addPaths(added);
  }
  const QString userShell = userShellPath();
  if (QFileInfo::exists(userShell) && !m_watcher.files().contains(userShell)) {
    m_watcher.addPath(userShell);
  }
}

QString ShellRuntime::sourceFingerprint() const {
  QCryptographicHash hash(QCryptographicHash::Sha1);
  for (const auto& dir : m_watcher.directories()) {
    QDirIterator it(dir, QDir::Files);
    while (it.hasNext()) {
      const QFileInfo info(it.next());
      if (!isWatchedSource(info)) {
        continue;
      }
      hash.addData(info.absoluteFilePath().toUtf8());
      hash.addData(QByteArray::number(info.lastModified().toMSecsSinceEpoch()));
      hash.addData(QByteArray::number(info.size()));
    }
  }
  return QString::fromLatin1(hash.result().toHex());
}

bool ShellRuntime::captureWindow(const QString& path) {
  if (m_engine == nullptr) {
    return false;
  }
  for (QObject* root : m_engine->rootObjects()) {
    auto* window = qobject_cast<QQuickWindow*>(root);
    if (window == nullptr) {
      continue;
    }
    const QImage image = window->grabWindow();
    if (image.isNull() || !image.save(path)) {
      qWarning().noquote() << "[shell] screenshot failed:" << path;
      return false;
    }
    qInfo().noquote() << "[shell] screenshot written:" << path;
    return true;
  }
  return false;
}
