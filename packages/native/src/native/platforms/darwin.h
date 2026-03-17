#pragma once

#ifndef PLATFORMS_DARWIN_H
#define PLATFORMS_DARWIN_H

#include <napi.h>

namespace t3tools::native::platforms::darwin {
  void Init(Napi::Env env, Napi::Object exports);
}

#endif