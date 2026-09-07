#include "ShellRuntime.h"

#include <QCryptographicHash>
#include <QDir>
#include <QDirIterator>
#include <QFileInfo>
#include <QImage>
#include <QKeySequence>
#include <QQmlContext>
#include <QQuickWindow>
#include <QQmlError>
#include <QtLogging>
#include <QtQml/qqml.h>
#include <qpa/qwindowsysteminterface.h>

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
  // These instances, including WebProfile registered by main, belong to one
  // engine for its entire lifetime. Reload replaces only the root objects.
  qmlRegisterSingletonInstance("T3.Shell", 1, 0, "Shell", m_bridge);
  qmlRegisterSingletonInstance("T3.Shell", 1, 0, "Theme", m_theme);
  qmlRegisterSingletonInstance("T3.Shell", 1, 0, "Runtime", this);

  m_engine = new QQmlApplicationEngine(this);
  connect(m_engine, &QQmlEngine::warnings, this, [](const QList<QQmlError>& warnings) {
    for (const auto& warning : warnings) {
      qWarning().noquote() << "[qml]" << warning.toString();
    }
  });

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
  connect(m_theme, &ThemeStore::themeChanged, this, &ShellRuntime::applyWindowTheme);
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
  const auto previous = m_engine->rootObjects();
  const bool previousUsingUserShell = m_usingUserShell;
  // Old roots keep their own QML types until the replacement loads. Only
  // C++ singleton state crosses generations; QML-created objects never do.
  m_engine->clearComponentCache();
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
    m_usingUserShell = previousUsingUserShell;
    m_fingerprint = sourceFingerprint();
    emit generationChanged();
    return;
  }
  // The new window exists before the old one goes, so the app never hits
  // "last window closed" mid-reload.
  for (QObject* root : previous) {
    root->deleteLater();
  }
  applyWindowTheme();
  m_fingerprint = sourceFingerprint();
  ++m_generation;
  qInfo().noquote() << "[shell] generation" << m_generation << "loaded from"
                    << (m_usingUserShell ? userShellPath() : defaultShellUrl().toString());
  emit generationChanged();
}

bool ShellRuntime::loadGeneration(const QUrl& rootUrl, QString* errorOut) {
  auto* engine = m_engine;
  const auto previousRootCount = engine->rootObjects().size();
  if (!m_options.qmlSourceDir.isEmpty()) {
    engine->addImportPath(m_options.qmlSourceDir);
  }
  const QString userImports = QDir(m_options.configDir).filePath(QStringLiteral("qml"));
  if (QDir(userImports).exists()) {
    engine->addImportPath(userImports);
  }

  // Temporary diagnostic connections must not outlive the captured locals.
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
  const auto roots = engine->rootObjects();
  bool hasWindow = false;
  for (auto index = previousRootCount; index < roots.size(); ++index) {
    hasWindow |= qobject_cast<QQuickWindow*>(roots.at(index)) != nullptr;
  }
  if (failed || !hasWindow) {
    for (auto index = previousRootCount; index < roots.size(); ++index) {
      delete roots.at(index);
    }
    if (!failed && roots.size() > previousRootCount) {
      messages << QStringLiteral("Shell root must be a QQuickWindow: %1").arg(rootUrl.toString());
    }
    if (errorOut != nullptr) {
      *errorOut = messages.isEmpty()
                      ? QStringLiteral("Failed to load %1").arg(rootUrl.toString())
                      : messages.join(QLatin1Char('\n'));
    }
    return false;
  }
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

QQuickWindow* ShellRuntime::rootWindow() const {
  if (m_engine == nullptr) {
    return nullptr;
  }
  const auto roots = m_engine->rootObjects();
  for (auto root = roots.crbegin(); root != roots.crend(); ++root) {
    if (auto* window = qobject_cast<QQuickWindow*>(*root)) {
      return window;
    }
  }
  return nullptr;
}

void ShellRuntime::applyWindowTheme() {
  if (auto* window = rootWindow()) {
    applyWindowBlur(window, m_theme->windowTransparent() && m_theme->windowBlur(),
                    m_theme->appearance() != QStringLiteral("light"));
  }
}

bool ShellRuntime::captureWindow(const QString& path) {
  QQuickWindow* window = rootWindow();
  if (window == nullptr) {
    return false;
  }
  const QImage image = window->grabWindow();
  if (image.isNull() || !image.save(path)) {
    qWarning().noquote() << "[shell] screenshot failed:" << path;
    return false;
  }
  qInfo().noquote() << "[shell] screenshot written:" << path;
  return true;
}

bool ShellRuntime::pressKey(const QString& chord) {
  const QKeySequence sequence(chord, QKeySequence::PortableText);
  if (sequence.count() != 1) {
    qWarning().noquote() << "[shell] not a single key chord:" << chord;
    return false;
  }
  QQuickWindow* window = rootWindow();
  if (window == nullptr) {
    return false;
  }
  const QKeyCombination combination = sequence[0];
  const Qt::KeyboardModifiers modifiers = combination.keyboardModifiers();
  const int key = combination.key();
  // Printable keys carry their text like a real press would; chords with
  // Ctrl/Alt/Meta produce none.
  QString text;
  if ((modifiers & ~Qt::ShiftModifier) == Qt::NoModifier && key >= Qt::Key_Space &&
      key <= Qt::Key_ydiaeresis) {
    const QChar character(key);
    text = modifiers.testFlag(Qt::ShiftModifier) ? character.toUpper() : character.toLower();
  }
  using Delivery = QWindowSystemInterface::SynchronousDelivery;
  QWindowSystemInterface::handleKeyEvent<Delivery>(window, QEvent::KeyPress, key, modifiers, text);
  QWindowSystemInterface::handleKeyEvent<Delivery>(window, QEvent::KeyRelease, key, modifiers,
                                                   text);
  return true;
}
