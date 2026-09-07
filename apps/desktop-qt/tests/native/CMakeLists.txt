cmake_minimum_required(VERSION 3.21)
project(t3code-qt-runtime-tests LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 6.9 REQUIRED COMPONENTS Core Gui GuiPrivate Quick Test WebEngineQuick WebChannel)
enable_testing()
add_executable(tst_ShellRuntime
  tst_ShellRuntime.cpp
  ../../src/ShellRuntime.cpp
  ../../src/ShellBridge.cpp
  ../../src/ThemeStore.cpp
  ../../src/WebProfile.cpp
)
target_include_directories(tst_ShellRuntime PRIVATE ../../src)
target_compile_definitions(tst_ShellRuntime PRIVATE
  T3_APP_VERSION="test"
  T3_WEBCHANNEL_SCRIPT_URL="qrc:///qtwebchannel/qwebchannel.js"
)
target_link_libraries(tst_ShellRuntime PRIVATE
  Qt6::Core Qt6::Gui Qt6::GuiPrivate Qt6::Quick Qt6::Test Qt6::WebEngineQuick Qt6::WebChannel
)
if(APPLE)
  enable_language(OBJCXX)
  target_sources(tst_ShellRuntime PRIVATE ../../src/PlatformWindow.mm)
  target_link_libraries(tst_ShellRuntime PRIVATE "-framework AppKit")
else()
  target_sources(tst_ShellRuntime PRIVATE ../../src/PlatformWindow.cpp)
endif()
add_test(NAME ShellRuntime COMMAND tst_ShellRuntime)
set_tests_properties(ShellRuntime PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_QPA_PLATFORMTHEME=")
