cmake_minimum_required(VERSION 3.22.1)

project(t3highlights LANGUAGES C)

set(T3_HIGHLIGHTS_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../..")

add_library(
  t3highlights SHARED
  t3_highlights_jni.c
  "${T3_HIGHLIGHTS_ROOT}/cpp/t3_highlights.c"
  "${T3_HIGHLIGHTS_ROOT}/Vendor/highlights/highlights.c"
  "${T3_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-impl.c"
  "${T3_HIGHLIGHTS_ROOT}/Vendor/wasm2c/wasm-rt-mem-impl.c"
)

target_include_directories(
  t3highlights
  PRIVATE "${T3_HIGHLIGHTS_ROOT}/cpp" "${T3_HIGHLIGHTS_ROOT}/Vendor"
          "${T3_HIGHLIGHTS_ROOT}/Vendor/highlights" "${T3_HIGHLIGHTS_ROOT}/Vendor/wasm2c"
)

# Plain malloc memory with explicit bounds checks: no guard-page signal
# handlers competing with ART's.
target_compile_definitions(
  t3highlights PRIVATE WASM_RT_USE_MMAP=0 WASM_RT_MEMCHECK_BOUNDS_CHECK=1
                       WASM_RT_SKIP_SIGNAL_RECOVERY=1
)

# The lexers are generated code; keep them fast in debug builds too.
target_compile_options(t3highlights PRIVATE -O2)

target_link_options(
  t3highlights PRIVATE "-Wl,-z,common-page-size=16384" "-Wl,-z,max-page-size=16384"
)
