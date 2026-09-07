#include <QFile>
#include <QPointer>
#include <QQuickWebEngineProfile>
#include <QTemporaryDir>
#include <QTest>
#include <QtWebEngineQuick>

#include "ShellBridge.h"
#include "ShellRuntime.h"
#include "ThemeStore.h"
#include "WebProfile.h"

class ShellRuntimeTest : public QObject {
  Q_OBJECT

private slots:
  void reloadKeepsSingletonsAndRecoversFromInvalidSource() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    const QString config = directory.filePath("config");
    const QString sources = directory.filePath("qml");
    QVERIFY(QDir().mkpath(config));
    QVERIFY(QDir().mkpath(sources + "/T3/Bricks"));
    const QString shellPath = config + "/shell.qml";
    const QString defaultPath = sources + "/T3/Bricks/DefaultShell.qml";
    const auto writeSource = [](const QString& path, const QByteArray& contents) {
      QFile file(path);
      return file.open(QIODevice::WriteOnly) && file.write(contents) == contents.size();
    };
    const auto source = [](int revision) {
      return QByteArray(R"(
import QtQuick
import T3.Shell
Window {
  objectName: "reload-probe"
  property int revision: )") + QByteArray::number(revision) + QByteArray(revision, ' ') + R"(
  property int protocol: Shell.protocolVersion
  property string prompt: Shell.state.composer.text
  property real radiusValue: Theme.radius
  property string configValue: Runtime.configDir
  property string profileName: WebProfile.storageName
}
)";
    };
    QVERIFY(writeSource(shellPath, source(1)));
    QVERIFY(writeSource(defaultPath, source(0)));
    ShellBridge bridge;
    bridge.publish("composer", QVariantMap{{"text", "Retained draft"}});
    ThemeStore theme(config);
    WebProfile webProfile(directory.filePath("web"));
    qmlRegisterSingletonInstance("T3.Shell", 1, 0, "WebProfile", webProfile.profile());
    ShellRuntime runtime({config, sources}, &bridge, &theme);
    const auto window = []() -> QQuickWindow* {
      QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
      for (auto* candidate : QGuiApplication::allWindows()) {
        if (candidate->objectName() == "reload-probe") return qobject_cast<QQuickWindow*>(candidate);
      }
      return nullptr;
    };
    const auto verifySingletons = [&](QQuickWindow* root) {
      QVERIFY(root);
      QCOMPARE(root->property("protocol").toInt(), bridge.protocolVersion());
      QCOMPARE(root->property("prompt").toString(), QString("Retained draft"));
      QCOMPARE(root->property("radiusValue").toReal(), theme.radius());
      QCOMPARE(root->property("configValue").toString(), config);
      QCOMPARE(root->property("profileName").toString(), webProfile.profile()->storageName());
    };
    runtime.start();
    verifySingletons(window());
    for (int revision = 2; revision <= 3; ++revision) {
      QPointer<QQuickWindow> previous = window();
      QVERIFY(writeSource(shellPath, source(revision)));
      runtime.reload();
      verifySingletons(window());
      QVERIFY(previous.isNull());
      QCOMPARE(window()->property("revision").toInt(), revision);
      QCOMPARE(runtime.generation(), revision);
    }
    QPointer<QQuickWindow> working = window();
    QVERIFY(writeSource(shellPath, "invalid QML"));
    QVERIFY(writeSource(defaultPath, "invalid QML"));
    runtime.reload();
    QCOMPARE(window(), working.data());
    QCOMPARE(runtime.generation(), 3);
    QVERIFY(!runtime.lastError().isEmpty());
    verifySingletons(window());

    QVERIFY(writeSource(defaultPath, source(4)));
    runtime.reload();
    verifySingletons(window());
    QCOMPARE(window()->property("revision").toInt(), 4);
    QVERIFY(!runtime.usingUserShell());
    QVERIFY(writeSource(shellPath, source(5)));
    runtime.reload();
    verifySingletons(window());
    QCOMPARE(window()->property("revision").toInt(), 5);
    QVERIFY(runtime.usingUserShell());
    QVERIFY(runtime.lastError().isEmpty());

    QVERIFY(writeSource(shellPath, source(6)));
    QTRY_COMPARE(runtime.generation(), 6);
    verifySingletons(window());
    QCOMPARE(window()->property("revision").toInt(), 6);
  }
};

int main(int argc, char** argv) {
  QtWebEngineQuick::initialize();
  QGuiApplication app(argc, argv);
  ShellRuntimeTest test;
  return QTest::qExec(&test, argc, argv);
}

#include "tst_ShellRuntime.moc"
