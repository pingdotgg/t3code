#include "ShellBridge.h"

#include <QDesktopServices>
#include <QFile>
#include <QFileInfo>
#include <QMimeDatabase>
#include <QtLogging>

namespace {

// Everything the web app publishes (see apps/web/src/shell/*Bridge.tsx) plus
// the shell's own `backendError`.
constexpr const char* kStateKeys[] = {
    "backendError", "composer", "contextMenu", "git",      "layout", "notifications",
    "rightPanel",   "settings", "sidebar",     "theme",    "workspace",
};

// Qt 6.11 deprecates the public constructor in favour of create(); the
// minimum supported Qt (6.9) only has the constructor.
QQmlPropertyMap* createStateMap(QObject* parent) {
#if QT_VERSION >= QT_VERSION_CHECK(6, 11, 0)
  return QQmlPropertyMap::create(parent);
#else
  return new QQmlPropertyMap(parent);
#endif
}

}  // namespace

ShellBridge::ShellBridge(QObject* parent)
    : QObject(parent), m_state(createStateMap(this)), m_channel(new ShellChannel(this)) {
  for (const char* key : kStateKeys) {
    m_state->insert(QString::fromLatin1(key), QVariant());
  }
}

QObject* ShellBridge::channel() const {
  return m_channel;
}

QVariantMap ShellBridge::snapshot() const {
  QVariantMap result;
  for (const QString& key : m_state->keys()) {
    const QVariant value = m_state->value(key);
    if (value.isValid()) {
      result.insert(key, value);
    }
  }
  return result;
}

void ShellBridge::setPageUrl(const QUrl& url) {
  if (m_pageUrl == url) {
    return;
  }
  m_pageUrl = url;
  emit pageUrlChanged();
}

QUrl ShellBridge::webChannelScriptUrl() const {
  return QUrl(QStringLiteral(T3_WEBCHANNEL_SCRIPT_URL));
}

void ShellBridge::publish(const QString& key, const QVariant& value) {
  // An unchanged republish would re-evaluate every binding on the key for
  // nothing, and echo it to every page following the state.
  if (m_state->contains(key) && m_state->value(key) == value) {
    return;
  }
  m_state->insert(key, value);
  emit stateEntryChanged(key, value);
}

void ShellBridge::openExternal(const QUrl& url) {
  const auto scheme = url.scheme();
  if (scheme != QStringLiteral("http") && scheme != QStringLiteral("https") &&
      scheme != QStringLiteral("mailto")) {
    return;
  }
  QDesktopServices::openUrl(url);
}

void ShellBridge::setColorScheme(const QString& scheme) {
  if (m_colorScheme == scheme) {
    return;
  }
  m_colorScheme = scheme;
  emit colorSchemeChanged();
}

void ShellBridge::windowCommand(const QString& command) {
  emit windowCommandRequested(command);
}

void ShellBridge::dispatch(const QString& action, const QVariant& payload) {
  emit actionRequested(action, payload);
}

void ShellBridge::notifyPageLoaded(bool ok, const QUrl& url) {
  emit pageLoaded(ok, url);
}

QVariantList ShellBridge::readImageFiles(const QList<QUrl>& urls) const {
  constexpr qint64 kMaxBytes = 10 * 1024 * 1024;
  QMimeDatabase mimeDatabase;
  QVariantList result;
  for (const QUrl& url : urls) {
    if (!url.isLocalFile()) {
      continue;
    }
    const QString path = url.toLocalFile();
    const QMimeType mime = mimeDatabase.mimeTypeForFile(path);
    if (!mime.name().startsWith(QStringLiteral("image/"))) {
      qInfo().noquote() << "[shell] skipping non-image attachment" << path;
      continue;
    }
    QFile file(path);
    if (file.size() > kMaxBytes || !file.open(QIODevice::ReadOnly)) {
      qInfo().noquote() << "[shell] skipping attachment (too large or unreadable)" << path;
      continue;
    }
    result.append(QVariantMap{
        {QStringLiteral("name"), QFileInfo(path).fileName()},
        {QStringLiteral("mimeType"), mime.name()},
        {QStringLiteral("base64"), QString::fromLatin1(file.readAll().toBase64())},
    });
  }
  return result;
}

ShellChannel::ShellChannel(ShellBridge* bridge) : QObject(bridge), m_bridge(bridge) {
  connect(bridge, &ShellBridge::actionRequested, this, &ShellChannel::actionRequested);
  connect(bridge, &ShellBridge::stateEntryChanged, this, &ShellChannel::stateEntryChanged);
}

void ShellChannel::publish(const QString& key, const QVariant& value) {
  m_bridge->publish(key, value);
}

void ShellChannel::dispatch(const QString& action, const QVariant& payload) {
  m_bridge->dispatch(action, payload);
}

QVariantMap ShellChannel::snapshot() const {
  return m_bridge->snapshot();
}
