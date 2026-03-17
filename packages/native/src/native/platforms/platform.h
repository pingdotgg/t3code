#pragma once

#ifndef PLATFORMS_PLATFORM_H
#define PLATFORMS_PLATFORM_H

#if defined(_WIN32)
  #define T3TOOLS_OS_WINDOWS 1

#elif defined(__APPLE__)
  #define T3TOOLS_OS_MACOS 1

#elif defined(__linux__)
  #define T3TOOLS_OS_LINUX 1

#else
  #error Unsupported platform
#endif

#endif