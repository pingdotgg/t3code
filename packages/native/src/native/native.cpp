#include "platforms/platform.h"

#ifdef T3TOOLS_OS_MACOS
#include "platforms/darwin.h"
#elif T3TOOLS_OS_LINUX
#include "platforms/linux.h"
#elif T3TOOLS_OS_WINDOWS
#include "platforms/win32.h"
#endif
#include <napi.h>

namespace t3tools::native {

Napi::Value Ping(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  return Napi::String::New(env, "pong");
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  #ifdef T3TOOLS_OS_MACOS
  platforms::darwin::Init(env, exports);
  #elif T3TOOLS_OS_LINUX
  platforms::gnu_linux::Init(env, exports);
  #elif T3TOOLS_OS_WINDOWS
  platforms::win32::Init(env, exports);
  #endif
  exports.Set("ping", Napi::Function::New(env, Ping));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
} // namespace t3tools::native