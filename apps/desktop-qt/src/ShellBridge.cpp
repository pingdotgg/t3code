#include "ShellBridge.h"

#include <QDesktopServices>

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
