#include <QFile>
#include <QJsonDocument>
#include <QImage>
#include <QQmlApplicationEngine>
#include <QQuickItem>
#include <QSignalSpy>
#include <QQuickWebEngineProfile>
#include <QTemporaryDir>
#include <QTest>
#include <QtWebEngineQuick>
#include <memory>

#include "ShellBridge.h"
#include "ShellRuntime.h"
#include "ThemeStore.h"
#include "WebProfile.h"

// List delegates belong to the visual tree, not necessarily the QObject tree.
static QQuickItem* findVisualItem(QQuickItem* parent, const QString& name) {
  if (parent->objectName() == name) return parent;
  for (auto* child : parent->childItems()) {
    if (auto* found = findVisualItem(child, name)) return found;
  }
  return nullptr;
}

class ShellExamplesTest : public QObject {
  Q_OBJECT

  QTemporaryDir directory;
  ShellBridge bridge;
  std::unique_ptr<ThemeStore> theme;
  std::unique_ptr<WebProfile> profile;
  std::unique_ptr<ShellRuntime> runtime;

private slots:
  void initTestCase() {
    QVERIFY(directory.isValid());
    theme = std::make_unique<ThemeStore>(directory.path());
    profile = std::make_unique<WebProfile>(directory.filePath("web"));
    qmlRegisterSingletonInstance("T3.Shell", 1, 0, "WebProfile", profile->profile());
    runtime = std::make_unique<ShellRuntime>(
        ShellRuntime::Options{directory.path(), QStringLiteral(T3_TEST_SOURCE_DIR "/qml")},
        &bridge, theme.get());
    bridge.setPageUrl(QUrl("about:blank"));
    const auto state = QJsonDocument::fromJson(R"({
      "workspace": {
        "projectTitle": "Example project", "threadTitle": "Fix TUI Readability Issue",
        "isDraft": false, "renameRequestId": 0, "scripts": [], "editors": [],
        "terminalAvailable": false, "branch": "feature/a-descriptive-branch-name-that-needs-to-fit",
        "environments": [], "environmentChangeable": false, "activeEnvironmentId": null,
        "envMode": "local", "envModeLabel": "Local checkout", "envModeChangeable": false,
        "canOpenPullRequest": false, "branchChangeable": false, "branchSwitchPending": false,
        "branches": [], "branchesLoading": false, "branchesTotal": 0,
        "git": {"hasUpstream": false, "hasWorkingTreeChanges": false, "pullRequest": null}
      },
      "sidebar": {
        "projects": [], "scopeProjectKey": null, "activeThreadKey": null,
        "activeDraftId": null, "drafts": [], "pinned": [], "active": [],
        "snoozed": [], "settled": [], "settledTotal": 0
      },
      "layout": {"sidebarCollapsed": false},
      "notifications": {"items": []}
    })").toVariant().toMap();
    for (auto it = state.cbegin(); it != state.cend(); ++it) bridge.publish(it.key(), it.value());
  }

  void layoutsFit_data() {
    QTest::addColumn<QString>("example");
    QTest::addColumn<int>("width");
    for (const auto& example : {"minimal", "glass", "terminal", "dashboard"}) {
      for (const int width : {1400, 1000, 640}) {
        QTest::newRow(qPrintable(QString("%1-%2").arg(example).arg(width))) << QString(example) << width;
      }
    }
  }

  void layoutsFit() {
    QFETCH(QString, example);
    QFETCH(int, width);
    const QDir source(QStringLiteral(T3_TEST_SOURCE_DIR "/examples/") + example);
    for (const auto& file : source.entryList(QDir::Files)) {
      const QString target = directory.filePath(file);
      if (QFile::exists(target)) QVERIFY(QFile::remove(target));
      QVERIFY(QFile::copy(source.filePath(file), target));
    }
    theme->reload();
    runtime->reload();
    QVERIFY2(runtime->usingUserShell(), qPrintable(runtime->lastError()));
    QVERIFY2(runtime->lastError().isEmpty(), qPrintable(runtime->lastError()));
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
    auto* engine = runtime->findChild<QQmlApplicationEngine*>();
    QVERIFY(engine);
    auto* window = qobject_cast<QQuickWindow*>(engine->rootObjects().last());
    QVERIFY(window);
    window->resize(width, 880);
    QVERIFY(QTest::qWaitForWindowExposed(window));
    auto* title = window->findChild<QQuickItem*>("threadLabel");
    QVERIFY(title);
    if (width == 1400) QTRY_VERIFY(!title->property("truncated").toBool());
    QTRY_VERIFY(title->mapToScene(QPointF(title->width(), 0)).x() <= window->width());

    if (example != "dashboard") return;
    QVERIFY(window->setProperty("drawerOpen", true));
    auto* drawer = window->findChild<QQuickItem*>("drawer");
    QVERIFY(drawer);
    QTRY_VERIFY(drawer->opacity() > 0.99);
    for (const auto& name : {"workspaceCard", "calendarCard", "metersCard", "agentCard"}) {
      auto* card = window->findChild<QQuickItem*>(name);
      QVERIFY2(card, name);
      QTRY_VERIFY2(card->mapToItem(drawer, QPointF(card->width(), 0)).x() <= drawer->width() - 10, name);
      QVERIFY(card->mapToItem(drawer, QPointF(0, 0)).x() >= 10);
    }
    auto* branch = window->findChild<QQuickItem*>("branchChip");
    QVERIFY(branch);
    QTRY_VERIFY(branch->width() <= branch->parentItem()->width());
    if (width == 1000) {
      drawer->setHeight(200);
      auto* actions = window->findChild<QQuickItem*>("agentActions");
      QVERIFY(actions);
      const auto area = actions->mapRectToScene(QRectF(0, 0, actions->width(), actions->height())).toAlignedRect();
      QVERIFY(area.top() > drawer->mapToScene(QPointF(0, drawer->height())).y());
      QVERIFY(area.bottom() < window->height());
      const auto clipped = window->grabWindow().copy(area);
      QVERIFY(!clipped.isNull());
      actions->setVisible(false);
      QTRY_COMPARE(window->grabWindow().copy(area), clipped);
      actions->setVisible(true);
    }
    auto* scroll = window->findChild<QObject*>("drawerScroll");
    QVERIFY(scroll);
    auto* content = scroll->property("contentItem").value<QQuickItem*>();
    QVERIFY(content);
    const qreal bottom = content->property("contentHeight").toReal() - content->height();
    if (bottom > 0) {
      QVERIFY(content->setProperty("contentY", bottom));
      auto* agent = window->findChild<QQuickItem*>("agentCard");
      QVERIFY(agent);
      QTRY_VERIFY(agent->mapToItem(drawer, QPointF(0, agent->height())).y() <= drawer->height() - 10);
    }
  }

  void panelTabsSupportKeyboardActivationAndClose() {
    QFile source(directory.filePath("shell.qml"));
    QVERIFY(source.open(QIODevice::WriteOnly | QIODevice::Truncate));
    source.write("import QtQuick\nimport T3.Bricks\nShellWindow { width: 600; height: 400; RightPanel { anchors.fill: parent } }");
    source.close();
    bridge.publish("rightPanel", QJsonDocument::fromJson(R"({
      "isOpen": true, "activeSurfaceId": "diff", "embedPath": "/test",
      "surfaces": [{"id": "diff", "title": "Diff"}, {"id": "files", "title": "Files"}],
      "canAdd": {"diff": true, "files": true, "terminal": true, "pullRequest": false, "agents": true}
    })").toVariant());
    runtime->reload();
    QVERIFY2(runtime->lastError().isEmpty(), qPrintable(runtime->lastError()));
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
    auto* engine = runtime->findChild<QQmlApplicationEngine*>();
    QVERIFY(engine);
    auto* window = qobject_cast<QQuickWindow*>(engine->rootObjects().last());
    QVERIFY(window);
    QVERIFY(QTest::qWaitForWindowExposed(window));
    QTRY_VERIFY(findVisualItem(window->contentItem(), "panelTab-files"));
    auto* tab = findVisualItem(window->contentItem(), "panelTab-files");
    auto* close = findVisualItem(window->contentItem(), "panelClose-files");
    QVERIFY(tab);
    QVERIFY(close);
    QSignalSpy actions(&bridge, &ShellBridge::actionRequested);
    tab->forceActiveFocus(Qt::TabFocusReason);
    QTest::keyClick(window, Qt::Key_Return);
    QCOMPARE(actions.size(), 1);
    QCOMPARE(actions.last().at(0).toString(), QString("rightPanel.activate"));
    QCOMPARE(actions.last().at(1).toMap().value("id").toString(), QString("files"));
    close->forceActiveFocus(Qt::TabFocusReason);
    QTest::keyClick(window, Qt::Key_Space);
    QCOMPARE(actions.size(), 2);
    QCOMPARE(actions.last().at(0).toString(), QString("rightPanel.close"));
    QCOMPARE(actions.last().at(1).toMap().value("id").toString(), QString("files"));
    bridge.publish("rightPanel", QVariant());
  }

  void cleanupTestCase() {
    runtime.reset();
    profile.reset();
    theme.reset();
  }
};

int main(int argc, char** argv) {
  QtWebEngineQuick::initialize();
  QGuiApplication app(argc, argv);
  ShellExamplesTest test;
  return QTest::qExec(&test, argc, argv);
}

#include "tst_ShellExamples.moc"
