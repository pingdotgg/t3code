#include "WebProfile.h"

#include <QDir>
#include <QQuickWebEngineDownloadRequest>
#include <QQuickWebEngineProfile>
#include <QtLogging>

namespace {

// The app bundle, fonts and icons add up to a few megabytes; this keeps the
// cache from growing with every dev rebuild while still holding a few of them.
constexpr int kHttpCacheBytes = 64 * 1024 * 1024;

}  // namespace

WebProfile::WebProfile(const QString& dataDir)
    : m_lock(QDir(dataDir).filePath(QStringLiteral("lock"))),
      m_profile(QQuickWebEngineProfile::defaultProfile()) {
  QDir().mkpath(dataDir);
  // Chromium cannot share a profile directory between processes. A second
  // shell on the same T3 home keeps Qt's off-the-record default instead of
  // corrupting the first one's session; cookies and cache then live in memory
  // for its run.
  if (!m_lock.tryLock(0)) {
    qWarning().noquote() << "[web] profile" << dataDir
                         << "is in use by another shell; this instance keeps no browser state";
  } else {
    m_profile->setStorageName(QStringLiteral("t3code"));
    m_profile->setOffTheRecord(false);
    m_profile->setPersistentStoragePath(dataDir);
    m_profile->setCachePath(QDir(dataDir).filePath(QStringLiteral("cache")));
    m_profile->setHttpCacheType(QQuickWebEngineProfile::DiskHttpCache);
    m_profile->setHttpCacheMaximumSize(kHttpCacheBytes);
    m_profile->setPersistentCookiesPolicy(QQuickWebEngineProfile::ForcePersistentCookies);
    m_profile->setPersistentPermissionsPolicy(
        QQuickWebEngineProfile::PersistentPermissionsPolicy::StoreOnDisk);
  }

  // Without a handler every download is dropped on the floor. Saving into
  // the user's download folder (Chromium's default target, deduplicated by
  // name) matches what the app expects from a browser.
  QObject::connect(m_profile, &QQuickWebEngineProfile::downloadRequested, m_profile,
                   [](QQuickWebEngineDownloadRequest* download) {
                     qInfo().noquote() << "[web] download" << download->url().toString() << "->"
                                       << QDir(download->downloadDirectory())
                                              .filePath(download->downloadFileName());
                     download->accept();
                   });
}
