cmake_minimum_required(VERSION 3.22.1)

project(t3terminal LANGUAGES CXX)

add_library(ghostty-vt SHARED IMPORTED)
set_target_properties(
  ghostty-vt
  PROPERTIES IMPORTED_LOCATION
             "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libghostty-vt.so"
)

add_library(t3terminal SHARED t3_terminal_jni.cpp)

target_include_directories(
  t3terminal
  PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../../../Vendor/libghostty-vt/include"
)

target_link_libraries(t3terminal PRIVATE ghostty-vt log)
