#include <fbjni/fbjni.h>
#include <jni.h>

#include "t3highlightsOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(vm, [] { margelo::nitro::t3highlights::registerAllNatives(); });
}
