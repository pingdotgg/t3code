#pragma once

#include <QLockFile>
#include <QString>

class QQuickWebEngineProfile;

// Configures Qt WebEngine's default profile as the one browser profile every
// web surface shares. The primary page and the embed panels get the same
// cookies, storage and HTTP cache, and all of it comes back from disk on the
// next start. The profile is registered as the `WebProfile` singleton in
// T3.Shell; a view that sets no profile lands on it too.
class WebProfile {
public:
  // `dataDir` is the profile's on-disk home (storage, cache, lock).
  explicit WebProfile(const QString& dataDir);

  QQuickWebEngineProfile* profile() const { return m_profile; }

private:
  QLockFile m_lock;
  QQuickWebEngineProfile* m_profile;
};
