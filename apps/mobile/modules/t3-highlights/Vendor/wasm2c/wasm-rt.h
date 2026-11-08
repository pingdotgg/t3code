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

#ifndef WASM_RT_H_
#define WASM_RT_H_

#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef __has_builtin
#define __has_builtin(x) 0 /** Compatibility with non-clang compilers. */
#endif

#if __has_builtin(__builtin_expect)
#define UNLIKELY(x) __builtin_expect(!!(x), 0)
#define LIKELY(x) __builtin_expect(!!(x), 1)
#else
#define UNLIKELY(x) (x)
#define LIKELY(x) (x)
#endif

#if __has_builtin(__builtin_memcpy)
#define wasm_rt_memcpy __builtin_memcpy
#else
#define wasm_rt_memcpy memcpy
#endif

#if __has_builtin(__builtin_unreachable)
#define wasm_rt_unreachable __builtin_unreachable
#else
#define wasm_rt_unreachable abort
#endif

#ifdef __STDC_VERSION__
#if __STDC_VERSION__ >= 201112L
#define WASM_RT_C11_AVAILABLE
#endif
#endif

/**
 * Many devices don't implement the C11 threads.h. We use CriticalSection APIs
 * for Windows and pthreads on other platforms where threads are not available.
 */
#ifdef WASM_RT_C11_AVAILABLE

#if defined(_WIN32)
#include <windows.h>
#define WASM_RT_MUTEX CRITICAL_SECTION
#define WASM_RT_USE_CRITICALSECTION 1
#else
#include <pthread.h>
#define WASM_RT_MUTEX pthread_mutex_t
#define WASM_RT_USE_PTHREADS 1
#endif

#endif

#ifdef WASM_RT_C11_AVAILABLE
#define WASM_RT_THREAD_LOCAL _Thread_local
#elif defined(_MSC_VER)
#define WASM_RT_THREAD_LOCAL __declspec(thread)
#elif (defined(__GNUC__) || defined(__clang__)) && !defined(__APPLE__)
// Disabled on Apple systems due to sporadic test failures.
#define WASM_RT_THREAD_LOCAL __thread
#else
#define WASM_RT_THREAD_LOCAL
#endif

/**
 * If enabled, perform additional sanity checks in the generated wasm2c code and
 * wasm2c runtime. This is useful to enable on debug builds.
 */
#ifndef WASM_RT_SANITY_CHECKS
#define WASM_RT_SANITY_CHECKS 0
#endif

/**
 * Backward compatibility: Convert the previously exposed
 * WASM_RT_MEMCHECK_SIGNAL_HANDLER macro to the ALLOCATION and CHECK macros that
 * are now used.
 */
#if defined(WASM_RT_MEMCHECK_SIGNAL_HANDLER)

#if WASM_RT_MEMCHECK_SIGNAL_HANDLER
#define WASM_RT_USE_MMAP 1
#define WASM_RT_MEMCHECK_GUARD_PAGES 1
#else
#define WASM_RT_USE_MMAP 0
#define WASM_RT_MEMCHECK_BOUNDS_CHECK 1
#endif

#warning \
    "WASM_RT_MEMCHECK_SIGNAL_HANDLER has been deprecated in favor of WASM_RT_USE_MMAP and WASM_RT_MEMORY_CHECK_* macros"
#endif

/**
 * Specify if we use OR mmap/mprotect (+ Windows equivalents) OR malloc/realloc
 * for the Wasm memory allocation and growth. mmap/mprotect guarantees memory
 * will grow without being moved, while malloc ensures the virtual memory is
 * consumed only as needed, but may relocate the memory to handle memory
 * fragmentation.
 *
 * This defaults to malloc on 32-bit platforms or if memory64 support is needed.
 * It defaults to mmap on 64-bit platforms assuming memory64 support is not
 * needed (so we can use the guard based range checks below).
 */
#ifndef WASM_RT_USE_MMAP
#if UINTPTR_MAX > 0xffffffff
#define WASM_RT_USE_MMAP 1
#else
#define WASM_RT_USE_MMAP 0
#endif
#endif

/**
 * This macro, if defined, allows the embedder to permit elimination of unused
 * memory loads. Note, this a non conformant configuration, i.e., this does not
 * respect Wasm's specification, as Wasm requires all loads (even the eliminated
 * loads to trap), whereas this configuration could eliminate an out-of-bound
 * load, and thus allow the Wasm module to not trap. Use with caution.
 */
#ifndef WASM_RT_NONCONFORMING_ALLOW_OOB_READ_ELIMINATION
#define WASM_RT_NONCONFORMING_ALLOW_OOB_READ_ELIMINATION 0
#endif

/**
 * Set the range checking strategy for Wasm memories.
 *
 * GUARD_PAGES:  memory accesses rely on unmapped pages/guard pages to trap
 * out-of-bound accesses.
 *
 * BOUNDS_CHECK: memory accesses are checked with explicit bounds checks.
 *
 * This defaults to GUARD_PAGES as this is the fastest option, iff the
 * requirements of GUARD_PAGES --- 64-bit platforms, MMAP allocation strategy,
 * no 64-bit memories, and platforms with a supported FORCE_READ_STRATEGY
 * described below --- are met. This falls back to BOUNDS otherwise.
 *
 * FORCE_READ_STRATEGY --- either the compiler should be a gcc/clang-like
 * compiler or the embedder must permit a non-conforming setting (allow dead
 * read elimination from linear memory)
 */
#if UINTPTR_MAX > 0xffffffff && WASM_RT_USE_MMAP && \
    (WASM_RT_NONCONFORMING_ALLOW_OOB_READ_ELIMINATION || defined(__GNUC__))
#define WASM_RT_GUARD_PAGES_SUPPORTED 1
#else
#define WASM_RT_GUARD_PAGES_SUPPORTED 0
#endif

/** Specify defaults for memory checks if unspecified */
#if !defined(WASM_RT_MEMCHECK_GUARD_PAGES) && \
    !defined(WASM_RT_MEMCHECK_BOUNDS_CHECK)
#if WASM_RT_GUARD_PAGES_SUPPORTED
#define WASM_RT_MEMCHECK_GUARD_PAGES 1
#else
#define WASM_RT_MEMCHECK_BOUNDS_CHECK 1
#endif
#endif

/** Ensure the macros are defined */
#ifndef WASM_RT_MEMCHECK_GUARD_PAGES
#define WASM_RT_MEMCHECK_GUARD_PAGES 0
#endif
#ifndef WASM_RT_MEMCHECK_BOUNDS_CHECK
#define WASM_RT_MEMCHECK_BOUNDS_CHECK 0
#endif

/** Sanity check the use of guard pages */
#if WASM_RT_MEMCHECK_GUARD_PAGES && !WASM_RT_GUARD_PAGES_SUPPORTED
#error \
    "WASM_RT_MEMCHECK_GUARD_PAGES not supported on this platform/configuration"
#endif

#if WASM_RT_MEMCHECK_GUARD_PAGES && WASM_RT_MEMCHECK_BOUNDS_CHECK
#error \
    "Cannot use both WASM_RT_MEMCHECK_GUARD_PAGES and WASM_RT_MEMCHECK_BOUNDS_CHECK"

#elif !WASM_RT_MEMCHECK_GUARD_PAGES && !WASM_RT_MEMCHECK_BOUNDS_CHECK
#error \
    "Must choose at least one from WASM_RT_MEMCHECK_GUARD_PAGES and WASM_RT_MEMCHECK_BOUNDS_CHECK"
#endif

/**
 * Some configurations above require the Wasm runtime to install a signal
 * handler. However, this can be explicitly disallowed by the host using
 * WASM_RT_SKIP_SIGNAL_RECOVERY. In this case, when the wasm code encounters an
 * OOB access, it may either trap or abort.
 */
#ifndef WASM_RT_SKIP_SIGNAL_RECOVERY
#define WASM_RT_SKIP_SIGNAL_RECOVERY 0
#endif

#if WASM_RT_MEMCHECK_GUARD_PAGES && !WASM_RT_SKIP_SIGNAL_RECOVERY
#define WASM_RT_INSTALL_SIGNAL_HANDLER 1
#else
#define WASM_RT_INSTALL_SIGNAL_HANDLER 0
#endif

/**
 * This macro, if defined to 1 (i.e., allows the "segue" optimization), allows
 * Wasm2c to use segment registers to speedup access to the linear heap. Note
 * that even if allowed in this way, the segment registers would only be used if
 * Wasm2c output is compiled for a suitable architecture and OS and the produces
 * C file is compiled by supported compilers. The extact restrictions are listed
 * in detail in src/template/wasm2c.declarations.c
 */
#ifndef WASM_RT_ALLOW_SEGUE
#define WASM_RT_ALLOW_SEGUE 0
#endif

/**
 * The segue optimization restores x86 segments to their old values when exiting
 * wasm2c code. If WASM_RT_SEGUE_FREE_SEGMENT is defined, wasm2c assumes it has
 * exclusive use of the segment and optimizes performance in two ways. First, it
 * does not restore the "old" value of the segment during exits. Second, wasm2c
 * only sets the segment register if the value has changed since the last time
 * it was set.
 */
#ifndef WASM_RT_SEGUE_FREE_SEGMENT
#define WASM_RT_SEGUE_FREE_SEGMENT 0
#endif

#ifndef WASM_RT_USE_SEGUE
// Memory functions can use the segue optimization if allowed. The segue
// optimization uses x86 segments to point to a linear memory. We use this
// optimization when:
//
// (1) Segue is allowed using WASM_RT_ALLOW_SEGUE
// (2) on x86_64 without WABT_BIG_ENDIAN enabled
// (3) the compiler supports: intrinsics for (rd|wr)gsbase, "address namespaces"
//     for accessing pointers, and supports memcpy on pointers with custom
//     "address namespaces". GCC does not support the memcpy requirement, so
//     this leaves only clang (version 9 or later) for now.
// (4) The OS provides a way to query if (rd|wr)gsbase is allowed by the kernel
// or the implementation has to use a syscall for this.
// (5) The OS doesn't replace the segment register on context switch which
//     eliminates windows for now
//
// While more OS can be supported in the future, we only support linux for now
#if WASM_RT_ALLOW_SEGUE && !WABT_BIG_ENDIAN &&                            \
    (defined(__x86_64__) || defined(_M_X64)) && __clang__ &&              \
    (__clang_major__ >= 9) && __has_builtin(__builtin_ia32_wrgsbase64) && \
    !defined(_WIN32) && !defined(__ANDROID__) &&                          \
    (defined(__linux__) || defined(__FreeBSD__))
#define WASM_RT_USE_SEGUE 1
#else
#define WASM_RT_USE_SEGUE 0
#endif
#endif

/**
 * This macro, if defined, allows the embedder to disable all stack exhaustion
 * checks. This a non conformant configuration, i.e., this does not respect
 * Wasm's specification, and may compromise security. Use with caution.
 */
#ifndef WASM_RT_NONCONFORMING_UNCHECKED_STACK_EXHAUSTION
#define WASM_RT_NONCONFORMING_UNCHECKED_STACK_EXHAUSTION 0
#endif

/**
 * We need to detect and trap stack overflows. If we use a signal handler on
 * POSIX systems, this can detect call stack overflows. On windows, or platforms
 * without a signal handler, we use stack depth counting. The s390x big endian
 * platform additionally seems to have issues with stack guard pages, so we play
 * it safe and use stack counting on big endian platforms.
 */
#if !defined(WASM_RT_STACK_DEPTH_COUNT) &&        \
    !defined(WASM_RT_STACK_EXHAUSTION_HANDLER) && \
    !WASM_RT_NONCONFORMING_UNCHECKED_STACK_EXHAUSTION

#if WASM_RT_INSTALL_SIGNAL_HANDLER && !defined(_WIN32) && !WABT_BIG_ENDIAN
#define WASM_RT_STACK_EXHAUSTION_HANDLER 1
#else
#define WASM_RT_STACK_DEPTH_COUNT 1
#endif

#endif

/** Ensure the stack macros are defined */
#ifndef WASM_RT_STACK_DEPTH_COUNT
#define WASM_RT_STACK_DEPTH_COUNT 0
#endif
#ifndef WASM_RT_STACK_EXHAUSTION_HANDLER
#define WASM_RT_STACK_EXHAUSTION_HANDLER 0
#endif

#if WASM_RT_NONCONFORMING_UNCHECKED_STACK_EXHAUSTION

#if (WASM_RT_STACK_EXHAUSTION_HANDLER + WASM_RT_STACK_DEPTH_COUNT) != 0
#error \
    "Cannot specify WASM_RT_NONCONFORMING_UNCHECKED_STACK_EXHAUSTION along with WASM_RT_STACK_EXHAUSTION_HANDLER or WASM_RT_STACK_DEPTH_COUNT"
#endif

#else

#if (WASM_RT_STACK_EXHAUSTION_HANDLER + WASM_RT_STACK_DEPTH_COUNT) > 1
#error \
    "Cannot specify multiple options from WASM_RT_STACK_EXHAUSTION_HANDLER , WASM_RT_STACK_DEPTH_COUNT"
#elif (WASM_RT_STACK_EXHAUSTION_HANDLER + WASM_RT_STACK_DEPTH_COUNT) == 0
#error \
    "Must specify one of WASM_RT_STACK_EXHAUSTION_HANDLER , WASM_RT_STACK_DEPTH_COUNT"
#endif

#endif

#if WASM_RT_STACK_EXHAUSTION_HANDLER && !WASM_RT_INSTALL_SIGNAL_HANDLER
#error \
    "WASM_RT_STACK_EXHAUSTION_HANDLER  can only be used if WASM_RT_INSTALL_SIGNAL_HANDLER is enabled"
#endif

#if WASM_RT_STACK_DEPTH_COUNT
/**
 * When the signal handler cannot be used to detect stack overflows, stack depth
 * is limited explicitly. The maximum stack depth before trapping can be
 * configured by defining this symbol before including wasm-rt when building the
 * generated c files, for example:
 *
 * ```
 *   cc -c -DWASM_RT_MAX_CALL_STACK_DEPTH=100 my_module.c -o my_module.o
 * ```
 */
#ifndef WASM_RT_MAX_CALL_STACK_DEPTH
#define WASM_RT_MAX_CALL_STACK_DEPTH 500
#endif

/** Current call stack depth. */
extern WASM_RT_THREAD_LOCAL uint32_t wasm_rt_call_stack_depth;

#endif

#if WASM_RT_USE_SEGUE
/**
 * The segue optimization uses x86 segments to point to a linear memory. If
 * used, the runtime must query whether it can use the fast userspace wrgsbase
 * instructions or whether it must invoke syscalls to set the segment base,
 * depending on the supported CPU features. The result of this query is saved in
 * this variable.
 */
extern bool wasm_rt_fsgsbase_inst_supported;
/**
 * If fast userspace wrgsbase instructions don't exist, the runtime most provide
 * a function that invokes the OS' underlying syscall to set the segment base.
 */
void wasm_rt_syscall_set_segue_base(void* base);
/**
 * If fast userspace rdgsbase instructions don't exist, the runtime most provide
 * a function that invokes the OS' underlying syscall to get the segment base.
 */
void* wasm_rt_syscall_get_segue_base();
/**
 * If WASM_RT_SEGUE_FREE_SEGMENT is defined, we must only set the segment
 * register if it was changed since the last time it was set. The last value set
 * on the segment register is stored in this variable.
 */
#if WASM_RT_SEGUE_FREE_SEGMENT
extern WASM_RT_THREAD_LOCAL void* wasm_rt_last_segment_val;
#endif
#endif

#if defined(_MSC_VER)
#define WASM_RT_NO_RETURN __declspec(noreturn)
#else
#define WASM_RT_NO_RETURN __attribute__((noreturn))
#endif

#if defined(__APPLE__) && WASM_RT_STACK_EXHAUSTION_HANDLER
#define WASM_RT_MERGED_OOB_AND_EXHAUSTION_TRAPS 1
#else
#define WASM_RT_MERGED_OOB_AND_EXHAUSTION_TRAPS 0
#endif

/** Reason a trap occurred. Provide this to `wasm_rt_trap`. */
typedef enum {
  WASM_RT_TRAP_NONE, /** No error. */
  WASM_RT_TRAP_OOB,  /** Out-of-bounds access in linear memory or a table. */
  WASM_RT_TRAP_INT_OVERFLOW, /** Integer overflow on divide or truncation. */
  WASM_RT_TRAP_DIV_BY_ZERO,  /** Integer divide by zero. */
  WASM_RT_TRAP_INVALID_CONVERSION, /** Conversion from NaN to integer. */
  WASM_RT_TRAP_UNREACHABLE,        /** Unreachable instruction executed. */
  WASM_RT_TRAP_CALL_INDIRECT,      /** Invalid call_indirect, for any reason. */
  WASM_RT_TRAP_NULL_REF,           /** Null reference. */
  WASM_RT_TRAP_UNCAUGHT_EXCEPTION, /** Exception thrown and not caught. */
  WASM_RT_TRAP_UNALIGNED,          /** Unaligned atomic instruction executed. */
#if WASM_RT_MERGED_OOB_AND_EXHAUSTION_TRAPS
  WASM_RT_TRAP_EXHAUSTION = WASM_RT_TRAP_OOB,
#else
  WASM_RT_TRAP_EXHAUSTION, /** Call stack exhausted. */
#endif
} wasm_rt_trap_t;

/** Value types. Used to define function signatures. */
typedef enum {
  WASM_RT_I32,
  WASM_RT_I64,
  WASM_RT_F32,
  WASM_RT_F64,
  WASM_RT_V128,
  WASM_RT_FUNCREF,
  WASM_RT_EXTERNREF,
  WASM_RT_EXNREF,
} wasm_rt_type_t;

/**
 * A generic function pointer type, both for Wasm functions (`code`)
 * and host functions (`hostcode`). All function pointers are stored
 * in this canonical form, but must be cast to their proper signature
 * to call.
 */
typedef void (*wasm_rt_function_ptr_t)(void);

/**
 * A pointer to a "tail-callee" function, called by a tail-call
 * trampoline or by another tail-callee function. (The definition uses a
 * single-member struct to allow a recursive definition.)
 */
typedef struct wasm_rt_tailcallee_t {
  void (*fn)(void** instance_ptr,
             void* tail_call_stack,
             struct wasm_rt_tailcallee_t* next);
} wasm_rt_tailcallee_t;

/**
 * The type of a function (an arbitrary number of param and result types).
 * This is represented as an opaque 256-bit ID.
 */
typedef const char* wasm_rt_func_type_t;

/**
 * A function instance (the runtime representation of a function).
 * These can be stored in tables of type funcref, or used as values.
 */
typedef struct {
  /** The function's type. */
  wasm_rt_func_type_t func_type;
  /**
   * The function. The embedder must know the actual C signature of the function
   * and cast to it before calling.
   */
  wasm_rt_function_ptr_t func;
  /** An alternate version of the function to be used when tail-called. */
  wasm_rt_tailcallee_t func_tailcallee;
  /**
   * A function instance is a closure of the function over an instance
   * of the originating module. The module_instance element will be passed into
   * the function at runtime.
   */
  void* module_instance;
} wasm_rt_funcref_t;

/** Default (null) value of a funcref */
#define wasm_rt_funcref_null_value \
  ((wasm_rt_funcref_t){NULL, NULL, {NULL}, NULL})

/** The type of an external reference (opaque to WebAssembly). */
typedef void* wasm_rt_externref_t;

/** Default (null) value of an externref */
#define wasm_rt_externref_null_value ((wasm_rt_externref_t){NULL})

/** A Memory object. */
typedef struct {
  /** The linear memory data, with a byte length of `size`. */
  uint8_t* data;
  /** The location after the the reserved space for the linear memory data. */
  uint8_t* data_end;
  /** The page size for this Memory object
      (always 64 KiB without the custom-page-sizes feature) */
  uint32_t page_size;
  /** The current page count for this Memory object. */
  uint64_t pages;
  /** The maximum page count for this Memory object. */
  uint64_t max_pages;
  /** The current size of the linear memory, in bytes. */
  uint64_t size;
  /** Is this memory indexed by u64 (as opposed to default u32) */
  bool is64;
} wasm_rt_memory_t;

#ifdef WASM_RT_C11_AVAILABLE
/** A shared Memory object. */
typedef struct {
  /**
   * The linear memory data, with a byte length of `size`. The memory is marked
   * atomic as it is shared and may have to be accessed with different memory
   * orders --- sequential when being accessed atomically, relaxed otherwise.
   * Unfortunately, the C standard does not state what happens if there are
   * overlaps in two memory accesses which have a memory order, e.g., an
   * atomic32 being read from the same location an atomic64 is read. One way to
   * prevent optimizations from assuming non-overlapping behavior as typically
   * done in C is to mark the memory as volatile. Thus the memory is atomic and
   * volatile.
   */
  _Atomic volatile uint8_t* data;
  /** The location one byte after the reserved space for the linear memory data.
   * This includes any reserved pages that are not yet allocated. */
  _Atomic volatile uint8_t* data_end;
  /** The page size for this Memory object
      (always 64 KiB without the custom-page-sizes feature) */
  uint32_t page_size;
  /** The current page count for this Memory object. */
  uint64_t pages;
  /* The maximum page count for this Memory object. */
  uint64_t max_pages;
  /** The current size of the linear memory, in bytes. */
  uint64_t size;
  /** Is this memory indexed by u64 (as opposed to default u32) */
  bool is64;
  /** Lock used to ensure operations such as memory grow are threadsafe */
  WASM_RT_MUTEX mem_lock;
} wasm_rt_shared_memory_t;
#endif

/** A Table of type funcref. */
typedef struct {
  /** The table element data, with an element count of `size`. */
  wasm_rt_funcref_t* data;
  /**
   * The maximum element count of this Table object. If there is no maximum,
   * `max_size` is 0xffffffffu (i.e. UINT32_MAX).
   */
  uint32_t max_size;
  /** The current element count of the table. */
  uint32_t size;
} wasm_rt_funcref_table_t;

/** A Table of type externref. */
typedef struct {
  /** The table element data, with an element count of `size`. */
  wasm_rt_externref_t* data;
  /**
   * The maximum element count of this Table object. If there is no maximum,
   * `max_size` is 0xffffffffu (i.e. UINT32_MAX).
   */
  uint32_t max_size;
  /** The current element count of the table. */
  uint32_t size;
} wasm_rt_externref_table_t;

/** Initialize the runtime. */
void wasm_rt_init(void);

/** Is the runtime initialized? */
bool wasm_rt_is_initialized(void);

/** Free the runtime's state. */
void wasm_rt_free(void);

/*
 * Initialize the multithreaded runtime for a given thread. Must be
 * called by each thread (other than the one that called wasm_rt_init)
 * before initializing a Wasm module or calling an exported
 * function.
 */
void wasm_rt_init_thread(void);

/*
 * Free the individual thread's state.
 */
void wasm_rt_free_thread(void);

/** A hardened jmp_buf that allows checking for initialization before use */
typedef struct {
  /** Is the jmp buf intialized? */
  bool initialized;
  /** jmp_buf contents */
  jmp_buf buffer;
} wasm_rt_jmp_buf;

#ifndef _WIN32
#define WASM_RT_SETJMP_TRAP_SETBUF(buf) sigsetjmp(buf, 1)

/**
 * On macOS XNU, there is a bug where nested `sigsetjmp` and `siglongjmp` 
 * across threads that have an allocated alternate signal stack (`SS_ONSTACK`) 
 * will erroneously cause the kernel to preserve the `SS_ONSTACK` flag in the 
 * thread state
 *
 * See: https://github.com/WebAssembly/wabt/issues/2654
 * See: https://github.com/golang/go/issues/44501
 */
#define WASM_RT_SETJMP_EXN_SETBUF(buf) sigsetjmp(buf, 0)
#else
#define WASM_RT_SETJMP_TRAP_SETBUF(buf) setjmp(buf)
#define WASM_RT_SETJMP_EXN_SETBUF(buf) setjmp(buf)
#endif

#define WASM_RT_SETJMP(buf) \
  ((buf).initialized = true, WASM_RT_SETJMP_TRAP_SETBUF((buf).buffer))
#define WASM_RT_SETJMP_EXN(buf) \
  ((buf).initialized = true, WASM_RT_SETJMP_EXN_SETBUF((buf).buffer))

#ifndef _WIN32
#define WASM_RT_LONGJMP_UNCHECKED(buf, val) siglongjmp(buf, val)
#else
#define WASM_RT_LONGJMP_UNCHECKED(buf, val) longjmp(buf, val)
#endif

#define WASM_RT_LONGJMP(buf, val)                                   \
  /** Abort on failure as this may be called in the trap handler */ \
  if (!((buf).initialized))                                         \
    abort();                                                        \
  (buf).initialized = false;                                        \
  WASM_RT_LONGJMP_UNCHECKED((buf).buffer, val)

/**
 * Stop execution immediately and jump back to the call to `wasm_rt_impl_try`.
 * The result of `wasm_rt_impl_try` will be the provided trap reason.
 *
 * This is typically called by the generated code, and not the embedder.
 */
WASM_RT_NO_RETURN void wasm_rt_trap(wasm_rt_trap_t);

/** Return a human readable error string based on a trap type. */
const char* wasm_rt_strerror(wasm_rt_trap_t trap);

#define wasm_rt_try(target) WASM_RT_SETJMP_EXN(target)

/** WebAssembly's default page size (64 KiB) */
#define WASM_DEFAULT_PAGE_SIZE 65536

/**
 * Initialize a Memory object with an initial page size of `initial_pages` and
 * a maximum page size of `max_pages`, indexed with an i32 or i64.
 *
 *  ```
 *    wasm_rt_memory_t my_memory;
 *    // 1 initial page (65536 bytes), and a maximum of 2 pages,
 *    // indexed with an i32
 *    wasm_rt_allocate_memory(&my_memory, 1, 2, false, WASM_DEFAULT_PAGE_SIZE);
 *  ```
 */
void wasm_rt_allocate_memory(wasm_rt_memory_t*,
                             uint64_t initial_pages,
                             uint64_t max_pages,
                             bool is64,
                             uint32_t page_size);

/**
 * Grow a Memory object by `pages`, and return the previous page count. If
 * this new page count is greater than the maximum page count, the grow fails
 * and 0xffffffffu (UINT32_MAX) is returned instead.
 *
 *  ```
 *    wasm_rt_memory_t my_memory;
 *    ...
 *    // Grow memory by 10 pages.
 *    uint32_t old_page_size = wasm_rt_grow_memory(&my_memory, 10);
 *    if (old_page_size == UINT32_MAX) {
 *      // Failed to grow memory.
 *    }
 *  ```
 */
uint64_t wasm_rt_grow_memory(wasm_rt_memory_t*, uint64_t pages);

/** Free a Memory object. */
void wasm_rt_free_memory(wasm_rt_memory_t*);

#ifdef WASM_RT_C11_AVAILABLE
/** Shared memory version of wasm_rt_allocate_memory */
void wasm_rt_allocate_memory_shared(wasm_rt_shared_memory_t*,
                                    uint64_t initial_pages,
                                    uint64_t max_pages,
                                    bool is64,
                                    uint32_t page_size);

/** Shared memory version of wasm_rt_grow_memory */
uint64_t wasm_rt_grow_memory_shared(wasm_rt_shared_memory_t*, uint64_t pages);

/** Shared memory version of wasm_rt_free_memory */
void wasm_rt_free_memory_shared(wasm_rt_shared_memory_t*);
#endif

/**
 * Initialize a funcref Table object with an element count of `elements` and a
 * maximum size of `max_elements`.
 *
 *  ```
 *    wasm_rt_funcref_table_t my_table;
 *    // 5 elements and a maximum of 10 elements.
 *    wasm_rt_allocate_funcref_table(&my_table, 5, 10);
 *  ```
 */
void wasm_rt_allocate_funcref_table(wasm_rt_funcref_table_t*,
                                    uint32_t elements,
                                    uint32_t max_elements);

/** Free a funcref Table object. */
void wasm_rt_free_funcref_table(wasm_rt_funcref_table_t*);

/**
 * Initialize an externref Table object with an element count
 * of `elements` and a maximum size of `max_elements`.
 * Usage as per wasm_rt_allocate_funcref_table.
 */
void wasm_rt_allocate_externref_table(wasm_rt_externref_table_t*,
                                      uint32_t elements,
                                      uint32_t max_elements);

/** Free an externref Table object. */
void wasm_rt_free_externref_table(wasm_rt_externref_table_t*);

/**
 * Grow a Table object by `delta` elements (giving the new elements the value
 * `init`), and return the previous element count. If this new element count is
 * greater than the maximum element count, the grow fails and 0xffffffffu
 * (UINT32_MAX) is returned instead.
 */
uint32_t wasm_rt_grow_funcref_table(wasm_rt_funcref_table_t*,
                                    uint32_t delta,
                                    wasm_rt_funcref_t init);
uint32_t wasm_rt_grow_externref_table(wasm_rt_externref_table_t*,
                                      uint32_t delta,
                                      wasm_rt_externref_t init);

#ifdef __cplusplus
}
#endif

#endif /* WASM_RT_H_ */
