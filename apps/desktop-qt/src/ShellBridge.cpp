#include "ShellBridge.h"

#include <QDesktopServices>
#include <QFile>
#include <QFileInfo>
#include <QMimeDatabase>
#include <QtLogging>

ShellBridge::ShellBridge(QObject* parent) : QObject(parent) {}

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
  // Every brick binds to `state`, so an unchanged republish would re-evaluate
  // all of them for nothing.
  const auto existing = m_state.constFind(key);
  if (existing != m_state.constEnd() && existing.value() == value) {
    return;
  }
  m_state.insert(key, value);
  emit stateEntryChanged(key, value);
  emit stateChanged();
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
