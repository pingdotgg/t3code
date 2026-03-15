#include "win32.h"
#include "platform.h"
#include <napi.h>

#ifdef T3TOOLS_OS_WINDOWS

namespace t3tools::native::platforms::win32 {
  void Init(Napi::Env env, Napi::Object exports) {
    // TODO: Implement Win32 platform-specific functionality here
  }
}

#else

namespace t3tools::native::platforms::win32 {
  void Init(Napi::Env env, Napi::Object exports) {
    // Not supported on this platform
  }
}

#endif