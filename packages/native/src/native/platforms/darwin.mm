#include "darwin.h"
#include "platform.h"
#include <napi.h>

#ifdef T3TOOLS_OS_MACOS

namespace t3tools::native::platforms::darwin {
  void Init(Napi::Env env, Napi::Object exports) {
    // TODO: Implement Darwin platform-specific functionality here
  }
}

#else

namespace t3tools::native::platforms::darwin {
  void Init(Napi::Env env, Napi::Object exports) {
    // Not supported on this platform
  }
}

#endif