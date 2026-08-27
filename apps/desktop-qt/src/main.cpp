#include <QCommandLineParser>
#include <QDir>
#include <QJsonDocument>
#include <QGuiApplication>
#include <QProcessEnvironment>
#include <QStandardPaths>
#include <QTimer>
#include <QtLogging>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>

#include "BackendProcess.h"
#include "ShellBridge.h"
#include "ShellRuntime.h"
#include "ThemeStore.h"

namespace {

// The rice lives inside T3 home next to the rest of the app's state, so a
// sandboxed T3CODE_HOME brings its own shell config too.
QString resolveConfigDir(const QString& override) {
  if (!override.isEmpty()) {
    return QDir(override).absolutePath();
  }
  const QString home = QProcessEnvironment::systemEnvironment().value(QStringLiteral("T3CODE_HOME"));
  const QString base = home.isEmpty() ? QDir::home().filePath(QStringLiteral(".t3")) : home;
  return QDir(base).absoluteFilePath(QStringLiteral("shell"));
}

QString resolveQmlSourceDir(const QString& override) {
  if (!override.isNull()) {
    return override;
  }
  const QString fromEnv =
      QProcessEnvironment::systemEnvironment().value(QStringLiteral("T3CODE_QML_DIR"));
  if (!fromEnv.isEmpty()) {
    return fromEnv;
  }
  return QStringLiteral(T3_QML_SOURCE_DIR);
}

}  // namespace

int main(int argc, char* argv[]) {
  QCoreApplication::setOrganizationName(QStringLiteral("T3 Tools"));
  QCoreApplication::setOrganizationDomain(QStringLiteral("t3.codes"));
  QCoreApplication::setApplicationName(QStringLiteral("t3code"));
  QCoreApplication::setApplicationVersion(QStringLiteral(T3_APP_VERSION));
  // Stable app id so compositor rules (blur, opacity, workspace) can target it.
  QGuiApplication::setDesktopFileName(QStringLiteral("t3code"));

  // Chromium's classic scrollbars paint a thumb in the page's scrollbar
  // gutters; overlay scrollbars match what the app expects from browsers.
  if (!qEnvironmentVariableIsSet("QTWEBENGINE_CHROMIUM_FLAGS")) {
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS", "--enable-features=OverlayScrollbar");
  }
  QtWebEngineQuick::initialize();
  QGuiApplication app(argc, argv);

  QCommandLineParser parser;
  parser.setApplicationDescription(QStringLiteral("T3 Code Qt shell"));
  parser.addHelpOption();
  parser.addVersionOption();
  const QCommandLineOption urlOption(
      QStringLiteral("url"),
      QStringLiteral("Load this URL instead of spawning the desktop host (dev attach mode)."),
      QStringLiteral("url"));
  const QCommandLineOption configDirOption(
      QStringLiteral("config-dir"),
      QStringLiteral("Directory holding shell.qml, theme.json and qml/ (default $T3CODE_HOME/shell, i.e. ~/.t3/shell)."),
      QStringLiteral("dir"));
  const QCommandLineOption qmlDirOption(
      QStringLiteral("qml-dir"),
      QStringLiteral("Load the built-in bricks from this directory instead of the binary."),
      QStringLiteral("dir"));
  const QCommandLineOption hostEntryOption(
      QStringLiteral("host-entry"), QStringLiteral("Path to the Node desktop host entry."),
      QStringLiteral("file"), QStringLiteral(T3_HOST_ENTRY));
  const QCommandLineOption nodeOption(
      QStringLiteral("node"), QStringLiteral("Node executable used to run the desktop host."),
      QStringLiteral("path"));
  const QCommandLineOption screenshotOption(
      QStringLiteral("screenshot"),
      QStringLiteral("Write a PNG of the window once the page has loaded, then quit."),
      QStringLiteral("file"));
  const QCommandLineOption actionOption(
      QStringLiteral("action"),
      QStringLiteral("Dispatch a shell action after the page loads, e.g. rightPanel.toggle or "
                     "composer.text.set={\"text\":\"hi\"}. Repeatable; runs in order."),
      QStringLiteral("name[=json]"));
  parser.addOptions({urlOption, configDirOption, qmlDirOption, hostEntryOption, nodeOption,
                     screenshotOption, actionOption});
  parser.process(app);

  const QString configDir = resolveConfigDir(parser.value(configDirOption));
  const QString qmlSourceDir =
      resolveQmlSourceDir(parser.isSet(qmlDirOption) ? parser.value(qmlDirOption) : QString());
  qInfo().noquote() << "[shell] config dir:" << configDir;
  if (!qmlSourceDir.isEmpty()) {
    qInfo().noquote() << "[shell] bricks from disk:" << qmlSourceDir;
  }

  ShellBridge bridge;
  ThemeStore theme(configDir);
  ShellRuntime runtime({configDir, qmlSourceDir}, &bridge, &theme);
  // The page publishes its resolved theme; without a theme.json it is the
  // shell's palette.
  QObject::connect(&bridge, &ShellBridge::stateEntryChanged, &theme,
                   [&theme](const QString& key, const QVariant& value) {
                     if (key == QStringLiteral("theme")) {
                       theme.applyPageTheme(value);
                     }
                   });

  BackendProcess::Options backendOptions;
  const auto env = QProcessEnvironment::systemEnvironment();
  backendOptions.nodeExecutable = parser.isSet(nodeOption)
                                      ? parser.value(nodeOption)
                                      : env.value(QStringLiteral("T3CODE_NODE"), QStringLiteral("node"));
  backendOptions.hostEntry = parser.value(hostEntryOption);
  backendOptions.hostArguments = parser.positionalArguments();
  BackendProcess backend(backendOptions);
  QObject::connect(&backend, &BackendProcess::ready, &bridge, &ShellBridge::setPageUrl);
  QObject::connect(&backend, &BackendProcess::failed, &bridge, [&bridge](const QString& message) {
    qCritical().noquote() << "[shell]" << message;
    bridge.publish(QStringLiteral("backendError"), message);
  });
  QObject::connect(&app, &QCoreApplication::aboutToQuit, &backend, &BackendProcess::stop);

  if (parser.isSet(urlOption)) {
    bridge.setPageUrl(QUrl::fromUserInput(parser.value(urlOption)));
  } else {
    backend.start();
  }

  // Scripted runs: dispatch queued actions once the page is up, then
  // optionally grab the window and quit. Only the first load triggers this.
  const QStringList scriptedActions = parser.values(actionOption);
  const bool screenshotRequested = parser.isSet(screenshotOption);
  if (!scriptedActions.isEmpty() || screenshotRequested) {
    const QString target = parser.value(screenshotOption);
    auto* armed = new bool(false);
    QObject::connect(&bridge, &ShellBridge::pageLoaded, &runtime,
                     [&runtime, &bridge, &app, target, scriptedActions, screenshotRequested,
                      armed](bool ok) {
                       if (*armed) {
                         return;
                       }
                       *armed = true;
                       if (!ok) {
                         qWarning().noquote() << "[shell] page failed to load; scripted run aborted";
                         if (screenshotRequested) {
                           app.exit(2);
                         }
                         return;
                       }
                       int delay = 1500;
                       for (const QString& spec : scriptedActions) {
                         QTimer::singleShot(delay, &bridge, [&bridge, spec] {
                           const int eq = spec.indexOf(QLatin1Char('='));
                           const QString name = eq < 0 ? spec : spec.left(eq);
                           QVariant payload;
                           if (eq >= 0) {
                             payload = QJsonDocument::fromJson(spec.mid(eq + 1).toUtf8())
                                           .toVariant();
                           }
                           qInfo().noquote() << "[shell] scripted action" << name;
                           bridge.dispatch(name, payload);
                         });
                         delay += 1500;
                       }
                       if (screenshotRequested) {
                         QTimer::singleShot(delay + 1500, &runtime, [&runtime, &app, target] {
                           const bool ok = runtime.captureWindow(target);
                           app.exit(ok ? 0 : 2);
                         });
                       }
                     });
  }

  runtime.start();
  return app.exec();
}
