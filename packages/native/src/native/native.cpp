#include "platforms/darwin.h"
#include "platforms/linux.h"
#include "platforms/win32.h"
#include <napi.h>

namespace t3tools::native {

Napi::Value Ping(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  return Napi::String::New(env, "pong");
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  platforms::darwin::Init(env, exports);
  platforms::linux::Init(env, exports);
  platforms::win32::Init(env, exports);
  exports.Set("ping", Napi::Function::New(env, Ping));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
} // namespace t3tools::native