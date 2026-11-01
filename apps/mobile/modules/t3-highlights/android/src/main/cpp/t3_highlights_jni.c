#include <jni.h>
#include <string.h>

#include "t3_highlights.h"

// HighlightsNative serializes both calls, so the copy reads the records the
// tokenize call just produced.
static const uint32_t* last_records = NULL;
static int64_t last_count = 0;

JNIEXPORT jint JNICALL Java_expo_modules_t3highlights_HighlightsNative_nativeTokenize(
    JNIEnv* env, jclass clazz, jbyteArray source, jint language) {
  (void)clazz;
  last_records = NULL;
  last_count = 0;
  if (language < 0 || language > UINT8_MAX) return -1;

  jsize length = (*env)->GetArrayLength(env, source);
  jbyte* bytes = (*env)->GetByteArrayElements(env, source, NULL);
  if (bytes == NULL) return -1;
  int64_t count = t3_highlights_tokenize((const uint8_t*)bytes, (size_t)length,
                                         (uint8_t)language, &last_records);
  (*env)->ReleaseByteArrayElements(env, source, bytes, JNI_ABORT);

  if (count < 0 || count > INT32_MAX / 4) {
    last_records = NULL;
    return -1;
  }
  last_count = count;
  return (jint)count;
}

JNIEXPORT void JNICALL Java_expo_modules_t3highlights_HighlightsNative_nativeCopyRecords(
    JNIEnv* env, jclass clazz, jobject destination) {
  (void)clazz;
  void* address = (*env)->GetDirectBufferAddress(env, destination);
  jlong capacity = (*env)->GetDirectBufferCapacity(env, destination);
  size_t byte_count = (size_t)last_count * sizeof(uint32_t);
  if (address == NULL || last_records == NULL || capacity < (jlong)byte_count) return;
  memcpy(address, last_records, byte_count);
}
