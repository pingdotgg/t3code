#pragma once

#ifndef PLATFORMS_WIN32_H
#define PLATFORMS_WIN32_H

#include <napi.h>

namespace t3tools::native::platforms::win32 {
  void Init(Napi::Env env, Napi::Object exports);
}

#endif