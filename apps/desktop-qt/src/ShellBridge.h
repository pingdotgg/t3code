#pragma once

#include <QObject>
#include <QUrl>
#include <QVariant>
#include <QVariantMap>

// The single WebChannel object the web view talks to, and the `Shell`
// singleton QML bricks read from. State flows web -> QML through `publish`;
// actions flow QML -> web through `dispatch`/`actionRequested`. Qt holds no
// domain logic: it stores whatever the web app publishes and relays it.
class ShellBridge : public QObject {
  Q_OBJECT
  Q_PROPERTY(int protocolVersion READ protocolVersion CONSTANT)
  Q_PROPERTY(QVariantMap state READ state NOTIFY stateChanged)
  Q_PROPERTY(QUrl pageUrl READ pageUrl WRITE setPageUrl NOTIFY pageUrlChanged)
  Q_PROPERTY(QUrl webChannelScriptUrl READ webChannelScriptUrl CONSTANT)
  Q_PROPERTY(QString colorScheme READ colorScheme NOTIFY colorSchemeChanged)

public:
  explicit ShellBridge(QObject* parent = nullptr);

  int protocolVersion() const { return 1; }
  QVariantMap state() const { return m_state; }
  QUrl pageUrl() const { return m_pageUrl; }
  void setPageUrl(const QUrl& url);
  QUrl webChannelScriptUrl() const;
  QString colorScheme() const { return m_colorScheme; }

  // Called by the web app over WebChannel.
  Q_INVOKABLE void publish(const QString& key, const QVariant& value);
  Q_INVOKABLE void openExternal(const QUrl& url);
  Q_INVOKABLE void setColorScheme(const QString& scheme);
  Q_INVOKABLE void windowCommand(const QString& command);

  // Called by QML bricks; delivered to the web app as `actionRequested`.
  Q_INVOKABLE void dispatch(const QString& action, const QVariant& payload = QVariant());
  // Called by WebSurface when a top-level navigation finishes.
  Q_INVOKABLE void notifyPageLoaded(bool ok, const QUrl& url);

signals:
  void stateChanged();
  void stateEntryChanged(const QString& key, const QVariant& value);
  void pageUrlChanged();
  void colorSchemeChanged();
  void actionRequested(const QString& action, const QVariant& payload);
  void windowCommandRequested(const QString& command);
  void pageLoaded(bool ok, const QUrl& url);

private:
  QVariantMap m_state;
  QUrl m_pageUrl;
  QString m_colorScheme = QStringLiteral("system");
};
