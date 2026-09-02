#pragma once

#include <QObject>
#include <QQmlPropertyMap>
#include <QUrl>
#include <QVariant>
#include <QVariantMap>

class ShellChannel;

// The `Shell` singleton QML bricks read from. State flows web -> QML through
// `publish`; actions flow QML -> web through `dispatch`/`actionRequested`. Qt
// holds no domain logic: it stores whatever the web app publishes and relays
// it. Pages reach it through `channel`, never through this object directly.
class ShellBridge : public QObject {
  Q_OBJECT
  Q_PROPERTY(int protocolVersion READ protocolVersion CONSTANT)
  // One QML property per published key (Shell.state.composer, ...), so a
  // publish only re-evaluates the bindings that read that key. Keys the page
  // may publish are declared up front; a binding made before its key exists
  // would never see the value.
  Q_PROPERTY(QQmlPropertyMap* state READ state CONSTANT)
  Q_PROPERTY(QObject* channel READ channel CONSTANT)
  Q_PROPERTY(QUrl pageUrl READ pageUrl WRITE setPageUrl NOTIFY pageUrlChanged)
  Q_PROPERTY(QUrl webChannelScriptUrl READ webChannelScriptUrl CONSTANT)
  Q_PROPERTY(QString colorScheme READ colorScheme NOTIFY colorSchemeChanged)

public:
  explicit ShellBridge(QObject* parent = nullptr);

  int protocolVersion() const { return 1; }
  QQmlPropertyMap* state() const { return m_state; }
  QObject* channel() const;
  QVariantMap snapshot() const;
  QUrl pageUrl() const { return m_pageUrl; }
  void setPageUrl(const QUrl& url);
  QUrl webChannelScriptUrl() const;
  QString colorScheme() const { return m_colorScheme; }

  // Called by the web app (via the channel) with its view models.
  Q_INVOKABLE void publish(const QString& key, const QVariant& value);
  Q_INVOKABLE void openExternal(const QUrl& url);
  Q_INVOKABLE void setColorScheme(const QString& scheme);
  Q_INVOKABLE void windowCommand(const QString& command);

  // Called by QML bricks; delivered to the web app as `actionRequested`.
  Q_INVOKABLE void dispatch(const QString& action, const QVariant& payload = QVariant());
  // Reads image files for the composer: [{name, mimeType, base64}], skipping
  // anything that is not an image or is over the page's size limit.
  Q_INVOKABLE QVariantList readImageFiles(const QList<QUrl>& urls) const;
  // Called by WebSurface when a top-level navigation finishes.
  Q_INVOKABLE void notifyPageLoaded(bool ok, const QUrl& url);

signals:
  void stateEntryChanged(const QString& key, const QVariant& value);
  void pageUrlChanged();
  void colorSchemeChanged();
  void actionRequested(const QString& action, const QVariant& payload);
  void windowCommandRequested(const QString& command);
  void pageLoaded(bool ok, const QUrl& url);

private:
  QQmlPropertyMap* m_state;
  ShellChannel* m_channel;
  QUrl m_pageUrl;
  QString m_colorScheme = QStringLiteral("system");
};

// The one object registered on every surface's WebChannel. It has no
// properties on purpose: QWebChannel re-serializes a changed property to
// every connected page, which for the state map meant every publish (each
// composer keystroke) echoed the whole map back to both surfaces. Pages that
// need the map pull `snapshot` once and follow `stateEntryChanged`.
class ShellChannel : public QObject {
  Q_OBJECT

public:
  explicit ShellChannel(ShellBridge* bridge);

  Q_INVOKABLE void publish(const QString& key, const QVariant& value);
  Q_INVOKABLE void dispatch(const QString& action, const QVariant& payload);
  Q_INVOKABLE QVariantMap snapshot() const;

signals:
  void actionRequested(const QString& action, const QVariant& payload);
  void stateEntryChanged(const QString& key, const QVariant& value);

private:
  ShellBridge* m_bridge;
};
