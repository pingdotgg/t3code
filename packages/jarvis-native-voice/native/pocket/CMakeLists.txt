# Production Pocket TTS daemon. Fetches pinned dependencies only; the
# pocket_tts.cpp in this directory already carries the production edits.
cmake_minimum_required(VERSION 3.28)
project(jarvis_pocket_tts VERSION 1.0.0 LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})
set(CMAKE_BUILD_RPATH_USE_ORIGIN ON)
if(APPLE)
    set(CMAKE_INSTALL_RPATH "@loader_path;@loader_path/../lib")
elseif(UNIX)
    set(CMAKE_INSTALL_RPATH "$ORIGIN;$ORIGIN/../lib")
endif()
set(CMAKE_BUILD_WITH_INSTALL_RPATH ON)

set(ORT_VERSION "1.23.2" CACHE STRING "Pinned ONNX Runtime version")
include(FetchContent)
set(FETCHCONTENT_QUIET OFF)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|amd64|AMD64")
        set(ONNXRUNTIME_ARCH "x64")
    elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64|ARM64")
        set(ONNXRUNTIME_ARCH "aarch64")
    endif()
    set(ONNXRUNTIME_URL "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-${ONNXRUNTIME_ARCH}-${ORT_VERSION}.tgz")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
    set(ONNXRUNTIME_URL "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-osx-universal2-${ORT_VERSION}.tgz")
elseif(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    set(ONNXRUNTIME_URL "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-win-x64-${ORT_VERSION}.zip")
endif()

FetchContent_Declare(onnxruntime URL ${ONNXRUNTIME_URL} DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(onnxruntime)
set(ONNXRUNTIME_ROOT ${onnxruntime_SOURCE_DIR})
set(ONNXRUNTIME_INCLUDE_DIR ${ONNXRUNTIME_ROOT}/include)
if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    set(ONNXRUNTIME_LIB ${ONNXRUNTIME_ROOT}/lib/onnxruntime.lib)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
    set(ONNXRUNTIME_LIB ${ONNXRUNTIME_ROOT}/lib/libonnxruntime.dylib)
else()
    set(ONNXRUNTIME_LIB ${ONNXRUNTIME_ROOT}/lib/libonnxruntime.so)
endif()

set(SPM_ENABLE_SHARED OFF CACHE BOOL "" FORCE)
set(SPM_ENABLE_TCMALLOC OFF CACHE BOOL "" FORCE)
set(SPM_PROTOBUF_PROVIDER "internal" CACHE STRING "" FORCE)
set(SPM_ABSL_PROVIDER "internal" CACHE STRING "" FORCE)
set(SPM_ENABLE_NFKC_COMPILE OFF CACHE BOOL "" FORCE)
file(WRITE ${CMAKE_BINARY_DIR}/patch_sentencepiece.cmake "
file(READ \"\${SOURCE_DIR}/src/sentencepiece_processor.h\" CONTENT)
if(NOT CONTENT MATCHES \"#include <cstdint>\")
    string(REPLACE \"#include <string>\" \"#include <string>\\n#include <cstdint>\" CONTENT \"\${CONTENT}\")
    file(WRITE \"\${SOURCE_DIR}/src/sentencepiece_processor.h\" \"\${CONTENT}\")
endif()
")
FetchContent_Declare(sentencepiece
    GIT_REPOSITORY https://github.com/google/sentencepiece.git
    GIT_TAG v0.2.1
    GIT_SHALLOW TRUE
    PATCH_COMMAND ${CMAKE_COMMAND} -DSOURCE_DIR=<SOURCE_DIR> -P ${CMAKE_BINARY_DIR}/patch_sentencepiece.cmake
    EXCLUDE_FROM_ALL
)
FetchContent_MakeAvailable(sentencepiece)
target_compile_options(sentencepiece-static PRIVATE -w)
set(SENTENCEPIECE_INCLUDE_DIRS "${sentencepiece_SOURCE_DIR}/src")

FetchContent_Declare(dr_libs GIT_REPOSITORY https://github.com/mackron/dr_libs.git GIT_TAG master GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(dr_libs)

add_executable(jarvis-pocket-tts pocket_tts.cpp daemon_main.cpp)
target_compile_definitions(jarvis-pocket-tts PRIVATE PTT_SHARED_LIB)
target_include_directories(jarvis-pocket-tts PRIVATE
    ${ONNXRUNTIME_INCLUDE_DIR}
    ${SENTENCEPIECE_INCLUDE_DIRS}
    ${dr_libs_SOURCE_DIR}
)
target_link_libraries(jarvis-pocket-tts PRIVATE ${ONNXRUNTIME_LIB} sentencepiece-static)
if(WIN32)
    target_link_libraries(jarvis-pocket-tts PRIVATE psapi)
endif()
if(UNIX)
    target_link_libraries(jarvis-pocket-tts PRIVATE pthread dl)
endif()
