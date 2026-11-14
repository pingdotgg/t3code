/*
 * Copyright 2018 WebAssembly Community Group participants
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "wasm-rt-impl.h"

#include <assert.h>
#include <stdio.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#endif

#ifdef WASM_RT_GROW_FAILED_HANDLER
extern void WASM_RT_GROW_FAILED_HANDLER();
#endif

#define PTHREAD_MEMORY_LOCK_VAR_INIT(name)      \
  if (pthread_mutex_init(&(name), NULL) != 0) { \
    fprintf(stderr, "Lock init failed\n");      \
    abort();                                    \
  }
#define PTHREAD_MEMORY_LOCK_AQUIRE(name)      \
  if (pthread_mutex_lock(&(name)) != 0) {     \
    fprintf(stderr, "Lock acquire failed\n"); \
    abort();                                  \
  }
#define PTHREAD_MEMORY_LOCK_RELEASE(name)     \
  if (pthread_mutex_unlock(&(name)) != 0) {   \
    fprintf(stderr, "Lock release failed\n"); \
    abort();                                  \
  }

#define WIN_MEMORY_LOCK_VAR_INIT(name) InitializeCriticalSection(&(name))
#define WIN_MEMORY_LOCK_AQUIRE(name) EnterCriticalSection(&(name))
#define WIN_MEMORY_LOCK_RELEASE(name) LeaveCriticalSection(&(name))

#if WASM_RT_USE_MMAP

#ifdef _WIN32
static void* os_mmap(size_t size) {
  void* ret = VirtualAlloc(NULL, size, MEM_RESERVE, PAGE_NOACCESS);
  return ret;
}

static int os_munmap(void* addr, size_t size) {
  // Windows can only unmap the whole mapping
  (void)size; /* unused */
  BOOL succeeded = VirtualFree(addr, 0, MEM_RELEASE);
  return succeeded ? 0 : -1;
}

static int os_mprotect(void* addr, size_t size) {
  if (size == 0) {
    return 0;
  }
  void* ret = VirtualAlloc(addr, size, MEM_COMMIT, PAGE_READWRITE);
  if (ret == addr) {
    return 0;
  }
  VirtualFree(addr, 0, MEM_RELEASE);
  return -1;
}

static void os_print_last_error(const char* msg) {
  DWORD errorMessageID = GetLastError();
  if (errorMessageID != 0) {
    LPSTR messageBuffer = 0;
    // The api creates the buffer that holds the message
    size_t size = FormatMessageA(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
            FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL, errorMessageID, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        (LPSTR)&messageBuffer, 0, NULL);
    (void)size;
    printf("%s. %s\n", msg, messageBuffer);
    LocalFree(messageBuffer);
  } else {
    printf("%s. No error code.\n", msg);
  }
}

#else /* !_WIN32 */
static void* os_mmap(size_t size) {
  int map_prot = PROT_NONE;
  int map_flags = MAP_ANONYMOUS | MAP_PRIVATE;
  uint8_t* addr = mmap(NULL, size, map_prot, map_flags, -1, 0);
  if (addr == MAP_FAILED)
    return NULL;
  return addr;
}

static int os_munmap(void* addr, size_t size) {
  return munmap(addr, size);
}

static int os_mprotect(void* addr, size_t size) {
  if (size == 0) {
    return 0;
  }
  return mprotect(addr, size, PROT_READ | PROT_WRITE);
}

static void os_print_last_error(const char* msg) {
  perror(msg);
}

#endif /* _WIN32 */

static uint64_t get_alloc_size_for_mmap_default32(uint64_t max_pages) {
#if WASM_RT_MEMCHECK_GUARD_PAGES
  /* Reserve 8GiB. */
  const uint64_t max_size = 0x200000000ul;
  return max_size;
#else
  if (max_pages != 0) {
    const uint64_t max_size = max_pages * WASM_DEFAULT_PAGE_SIZE;
    return max_size;
  }

  /* Reserve 4GiB. */
  const uint64_t max_size = 0x100000000ul;
  return max_size;
#endif
}

#endif /* WASM_RT_USE_MMAP */

static bool u64_mult_overflow(uint64_t a, uint64_t b, uint64_t* result) {
  uint64_t x = a * b;
  *result = x;
  if (a != 0 && x / a != b) {
    // overflow
    return true;
  }
  return false;
}

// Include operations for memory
#define WASM_RT_MEM_OPS
#include "wasm-rt-mem-impl-helper.inc"
#undef WASM_RT_MEM_OPS

// Include operations for shared memory
#define WASM_RT_MEM_OPS_SHARED
#include "wasm-rt-mem-impl-helper.inc"
#undef WASM_RT_MEM_OPS_SHARED

#undef C11_MEMORY_LOCK_VAR_INIT
#undef C11_MEMORY_LOCK_AQUIRE
#undef C11_MEMORY_LOCK_RELEASE
#undef PTHREAD_MEMORY_LOCK_VAR_INIT
#undef PTHREAD_MEMORY_LOCK_AQUIRE
#undef PTHREAD_MEMORY_LOCK_RELEASE
#undef WIN_MEMORY_LOCK_VAR_INIT
#undef WIN_MEMORY_LOCK_AQUIRE
#undef WIN_MEMORY_LOCK_RELEASE
