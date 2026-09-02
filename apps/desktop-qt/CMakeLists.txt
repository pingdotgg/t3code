cmake_minimum_required(VERSION 3.21)

project(t3code-qt VERSION 0.0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 6.9 REQUIRED COMPONENTS Core Gui GuiPrivate Quick WebEngineQuick WebChannel)
qt_standard_project_setup(REQUIRES 6.9)
qt_policy(SET QTP0001 NEW)

# Where the QML bricks live on disk. Non-release builds load them from here so
# edits hot-reload without a rebuild; release builds only use the compiled-in
# copies. T3_QML_SOURCE_DIR="" disables disk loading for any build type.
if(NOT DEFINED T3_QML_SOURCE_DIR)
  if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set(T3_QML_SOURCE_DIR "")
  else()
    set(T3_QML_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/qml")
  endif()
endif()

# The Node desktop host entry. In-repo builds point at the TypeScript source.
# Release builds resolve an installed path relative to the executable.
if(NOT DEFINED T3_HOST_ENTRY)
  if(CMAKE_BUILD_TYPE STREQUAL "Release")
    if(APPLE)
      set(T3_HOST_ENTRY "../Resources/t3code/host/main.ts")
    else()
      set(T3_HOST_ENTRY "../share/t3code/host/main.ts")
    endif()
  else()
    set(T3_HOST_ENTRY "${CMAKE_CURRENT_SOURCE_DIR}/host/main.ts")
  endif()
endif()

# Release packages carry the same Node executable that installed their native
# dependencies. Development builds keep using the command from PATH.
if(NOT DEFINED T3_NODE_ENTRY)
  if(CMAKE_BUILD_TYPE STREQUAL "Release")
    if(APPLE)
      set(T3_NODE_ENTRY "../Resources/t3code/bin/node")
    elseif(WIN32)
      set(T3_NODE_ENTRY "../share/t3code/bin/node.exe")
    else()
      set(T3_NODE_ENTRY "../share/t3code/bin/node")
    endif()
  else()
    set(T3_NODE_ENTRY "node")
  endif()
endif()

# qwebchannel.js is the browser half of Qt WebChannel. Qt installs it as data
# (share/qt6/webchannel); bundling it makes the injected script independent of
# whether the runtime Qt exposes it as a qrc resource.
get_filename_component(_qt_prefix "${QT6_INSTALL_PREFIX}" ABSOLUTE)
find_file(T3_QWEBCHANNEL_JS qwebchannel.js
  HINTS
    "${_qt_prefix}/${QT6_INSTALL_DATA}/webchannel"
    "${_qt_prefix}/share/qt6/webchannel"
    "${_qt_prefix}/share/qt/webchannel"
    "${_qt_prefix}/../qtwebchannel/share/qt6/webchannel"
)

qt_add_executable(t3code-qt
  src/main.cpp
  src/BackendProcess.cpp
  src/BackendProcess.h
  src/ShellBridge.cpp
  src/ShellBridge.h
  src/ShellRuntime.cpp
  src/ShellRuntime.h
  src/ThemeStore.cpp
  src/ThemeStore.h
  src/WebProfile.cpp
  src/WebProfile.h
  src/PlatformWindow.h
)

if(T3_QWEBCHANNEL_JS)
  set_source_files_properties("${T3_QWEBCHANNEL_JS}" PROPERTIES QT_RESOURCE_ALIAS "qwebchannel.js")
  qt_add_resources(t3code-qt "t3_webchannel" PREFIX "/t3" FILES "${T3_QWEBCHANNEL_JS}")
  target_compile_definitions(t3code-qt PRIVATE T3_WEBCHANNEL_SCRIPT_URL="qrc:/t3/qwebchannel.js")
else()
  message(STATUS "qwebchannel.js not found next to Qt; relying on qrc:///qtwebchannel/qwebchannel.js at runtime")
  target_compile_definitions(t3code-qt PRIVATE T3_WEBCHANNEL_SCRIPT_URL="qrc:///qtwebchannel/qwebchannel.js")
endif()

target_compile_definitions(t3code-qt PRIVATE
  T3_QML_SOURCE_DIR="${T3_QML_SOURCE_DIR}"
  T3_HOST_ENTRY="${T3_HOST_ENTRY}"
  T3_NODE_ENTRY="${T3_NODE_ENTRY}"
  T3_APP_VERSION="${PROJECT_VERSION}"
)

if(APPLE)
  target_sources(t3code-qt PRIVATE src/PlatformWindow.mm)
  target_link_libraries(t3code-qt PRIVATE "-framework AppKit")
else()
  target_sources(t3code-qt PRIVATE src/PlatformWindow.cpp)
endif()

add_subdirectory(qml/T3/Bricks)

target_link_libraries(t3code-qt PRIVATE
  Qt6::Core
  Qt6::Gui
  Qt6::GuiPrivate
  Qt6::Quick
  Qt6::WebEngineQuick
  Qt6::WebChannel
  t3bricksplugin
)

set_target_properties(t3code-qt PROPERTIES
  MACOSX_BUNDLE TRUE
  MACOSX_BUNDLE_GUI_IDENTIFIER "codes.t3.desktop-qt"
  MACOSX_BUNDLE_BUNDLE_NAME "T3 Code"
  WIN32_EXECUTABLE TRUE
)

install(TARGETS t3code-qt
  BUNDLE DESTINATION .
  RUNTIME DESTINATION bin
)
