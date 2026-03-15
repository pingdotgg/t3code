#pragma once

#ifndef PLATFORMS_LINUX_H
#define PLATFORMS_LINUX_H

#include <napi.h>

namespace t3tools::native::platforms::gnu_linux {
  void Init(Napi::Env env, Napi::Object exports);
}

#endif