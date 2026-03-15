#include "linux.h"
#include "platform.h"
#include <napi.h>

#ifdef T3TOOLS_OS_LINUX

namespace t3tools::native::platforms::gnu_linux {
  void Init(Napi::Env env, Napi::Object exports) {
    // TODO: Implement Linux platform-specific functionality here
  }
}

#else

namespace t3tools::native::platforms::gnu_linux {
  void Init(Napi::Env env, Napi::Object exports) {
    // Not supported on this platform
  }
}

#endif