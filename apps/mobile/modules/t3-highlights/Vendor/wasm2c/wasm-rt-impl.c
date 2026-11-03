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
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if WASM_RT_INSTALL_SIGNAL_HANDLER && !defined(_WIN32)
#include <signal.h>
#include <unistd.h>
#endif

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#endif

#ifndef NDEBUG
#define DEBUG_PRINTF(...) fprintf(stderr, __VA_ARGS__);
#else
#define DEBUG_PRINTF(...)
#endif

#if WASM_RT_INSTALL_SIGNAL_HANDLER
static bool g_signal_handler_installed = false;
#ifdef _WIN32
static void* g_sig_handler_handle = 0;
#endif
#endif

#if WASM_RT_USE_SEGUE
bool wasm_rt_fsgsbase_inst_supported = false;
#ifdef __linux__
#include <sys/auxv.h>
#ifdef __GLIBC__
#include <gnu/libc-version.h>
#endif
#include <asm/prctl.h>    // For ARCH_SET_GS
#include <sys/syscall.h>  // For SYS_arch_prctl
#include <unistd.h>       // For syscall
#ifndef HWCAP2_FSGSBASE
#define HWCAP2_FSGSBASE (1 << 1)
#endif
#elif defined(__FreeBSD__)
#include <machine/sysarch.h>  // For amd64_set_gsbase etc.
#endif
#endif

#if WASM_RT_SEGUE_FREE_SEGMENT
WASM_RT_THREAD_LOCAL void* wasm_rt_last_segment_val = NULL;
#endif

#if WASM_RT_STACK_DEPTH_COUNT
WASM_RT_THREAD_LOCAL uint32_t wasm_rt_call_stack_depth;
WASM_RT_THREAD_LOCAL uint32_t wasm_rt_saved_call_stack_depth;
#elif WASM_RT_STACK_EXHAUSTION_HANDLER
static WASM_RT_THREAD_LOCAL void* g_alt_stack = NULL;
#endif

#ifndef WASM_RT_TRAP_HANDLER
WASM_RT_THREAD_LOCAL wasm_rt_jmp_buf g_wasm_rt_jmp_buf;
#endif

#ifdef WASM_RT_TRAP_HANDLER
extern void WASM_RT_TRAP_HANDLER(wasm_rt_trap_t code);
#endif

void wasm_rt_trap(wasm_rt_trap_t code) {
  assert(code != WASM_RT_TRAP_NONE);
#if WASM_RT_STACK_DEPTH_COUNT
  wasm_rt_call_stack_depth = wasm_rt_saved_call_stack_depth;
#endif

#ifdef WASM_RT_TRAP_HANDLER
  WASM_RT_TRAP_HANDLER(code);
  wasm_rt_unreachable();
#else
  WASM_RT_LONGJMP(g_wasm_rt_jmp_buf, code);
#endif
}

#ifdef _WIN32

#if WASM_RT_INSTALL_SIGNAL_HANDLER

static LONG os_signal_handler(PEXCEPTION_POINTERS info) {
  if (info->ExceptionRecord->ExceptionCode == EXCEPTION_ACCESS_VIOLATION) {
    wasm_rt_trap(WASM_RT_TRAP_OOB);
  } else if (info->ExceptionRecord->ExceptionCode == EXCEPTION_STACK_OVERFLOW) {
    wasm_rt_trap(WASM_RT_TRAP_EXHAUSTION);
  }
  return EXCEPTION_CONTINUE_SEARCH;
}

static void os_install_signal_handler(void) {
  g_sig_handler_handle =
      AddVectoredExceptionHandler(1 /* CALL_FIRST */, os_signal_handler);
}

static void os_cleanup_signal_handler(void) {
  RemoveVectoredExceptionHandler(g_sig_handler_handle);
}

#endif

#else

#if WASM_RT_INSTALL_SIGNAL_HANDLER
static void os_signal_handler(int sig, siginfo_t* si, void* unused) {
  if (si->si_code == SEGV_ACCERR) {
    wasm_rt_trap(WASM_RT_TRAP_OOB);
  } else {
    wasm_rt_trap(WASM_RT_TRAP_EXHAUSTION);
  }
}

static void os_install_signal_handler(void) {
  struct sigaction sa;
  memset(&sa, '\0', sizeof(sa));
  sa.sa_flags = SA_SIGINFO;
#if WASM_RT_STACK_EXHAUSTION_HANDLER
  sa.sa_flags |= SA_ONSTACK;
#endif
  sigemptyset(&sa.sa_mask);
  sa.sa_sigaction = os_signal_handler;

  /* Install SIGSEGV and SIGBUS handlers, since macOS seems to use SIGBUS. */
  if (sigaction(SIGSEGV, &sa, NULL) != 0 || sigaction(SIGBUS, &sa, NULL) != 0) {
    perror("sigaction failed");
    abort();
  }
}

static void os_cleanup_signal_handler(void) {
  /* Undo what was done in os_install_signal_handler */
  struct sigaction sa;
  memset(&sa, '\0', sizeof(sa));
  sa.sa_handler = SIG_DFL;
  if (sigaction(SIGSEGV, &sa, NULL) != 0 || sigaction(SIGBUS, &sa, NULL)) {
    perror("sigaction failed");
    abort();
  }
}
#endif

#if WASM_RT_STACK_EXHAUSTION_HANDLER
static bool os_has_altstack_installed() {
  /* check for altstack already in place */
  stack_t ss;
  if (sigaltstack(NULL, &ss) != 0) {
    perror("os_has_altstack_installed: sigaltstack failed");
    abort();
  }

  return !(ss.ss_flags & SS_DISABLE);
}

/* These routines set up an altstack to handle SIGSEGV from stack overflow. */
static void os_allocate_and_install_altstack(void) {
  /* verify altstack not already allocated */
  assert(!g_alt_stack &&
         "wasm-rt error: tried to re-allocate thread-local alternate stack");

  /* We could check and warn if an altstack is already installed, but some
   * sanitizers install their own altstack, so this warning would fire
   * spuriously and break the test outputs. */

  /* allocate altstack */
  g_alt_stack = malloc(SIGSTKSZ);
  if (g_alt_stack == NULL) {
    perror("malloc failed");
    abort();
  }

  /* install altstack */
  stack_t ss;
  ss.ss_sp = g_alt_stack;
  ss.ss_flags = 0;
  ss.ss_size = SIGSTKSZ;
  if (sigaltstack(&ss, NULL) != 0) {
    perror("os_allocate_and_install_altstack: sigaltstack failed");
    abort();
  }
}

static void os_disable_and_deallocate_altstack(void) {
  /* in debug build, verify altstack allocated */
  assert(g_alt_stack &&
         "wasm-rt error: thread-local alternate stack not allocated");

  /* verify altstack was still in place */
  stack_t ss;
  if (sigaltstack(NULL, &ss) != 0) {
    perror("os_disable_and_deallocate_altstack: sigaltstack failed");
    abort();
  }

  if ((!g_alt_stack) || (ss.ss_flags & SS_DISABLE) ||
      (ss.ss_sp != g_alt_stack) || (ss.ss_size != SIGSTKSZ)) {
    DEBUG_PRINTF(
        "wasm-rt warning: alternate stack was modified unexpectedly\n");
    return;
  }

  assert(!(ss.ss_flags & SS_ONSTACK) &&
         "attempt to deallocate altstack while in use");

  /* disable and free */
  ss.ss_flags = SS_DISABLE;
  if (sigaltstack(&ss, NULL) != 0) {
    perror("sigaltstack disable failed");
    abort();
  }
  assert(!os_has_altstack_installed());
  free(g_alt_stack);
  g_alt_stack = NULL;
}
#endif

#endif

#if WASM_RT_USE_SEGUE && defined(__FreeBSD__)
static void call_cpuid(uint64_t* rax,
                       uint64_t* rbx,
                       uint64_t* rcx,
                       uint64_t* rdx) {
  __asm__ volatile(
      "cpuid"
      : "=a"(*rax), "=b"(*rbx), "=c"(*rcx), "=d"(*rdx)  // output operands
      : "a"(*rax), "c"(*rcx)                            // input operands
  );
}
#endif

void wasm_rt_init(void) {
  wasm_rt_init_thread();
#if WASM_RT_INSTALL_SIGNAL_HANDLER
  if (!g_signal_handler_installed) {
    g_signal_handler_installed = true;
    os_install_signal_handler();
  }
#endif

#if WASM_RT_USE_SEGUE
#if defined(__linux__) && defined(__GLIBC__) && __GLIBC__ >= 2 && \
    __GLIBC_MINOR__ >= 18
  // Check for support for userspace wrgsbase instructions
  unsigned long val = getauxval(AT_HWCAP2);
  wasm_rt_fsgsbase_inst_supported = val & HWCAP2_FSGSBASE;
#elif defined(__FreeBSD__)
  // FreeBSD enables fsgsbase on the newer kernels if the hardware supports it.
  // We just need to check if the hardware supports it by querying the correct
  // cpuid leaf.
  uint64_t rax, rbx, rcx, rdx;
  rax = 0;
  call_cpuid(&rax, &rbx, &rcx, &rdx);

  if (rax > 7) {
    rax = 7;
    rcx = 0;
    call_cpuid(&rax, &rbx, &rcx, &rdx);
    if (rbx & 0x1) {
      wasm_rt_fsgsbase_inst_supported = true;
    }
  }
#endif
#endif

  assert(wasm_rt_is_initialized());
}

bool wasm_rt_is_initialized(void) {
#if WASM_RT_STACK_EXHAUSTION_HANDLER
  if (!os_has_altstack_installed()) {
    return false;
  }
#endif
#if WASM_RT_INSTALL_SIGNAL_HANDLER
  return g_signal_handler_installed;
#else
  return true;
#endif
}

void wasm_rt_free(void) {
  assert(wasm_rt_is_initialized());
#if WASM_RT_INSTALL_SIGNAL_HANDLER
  os_cleanup_signal_handler();
  g_signal_handler_installed = false;
#endif
  wasm_rt_free_thread();
}

void wasm_rt_init_thread(void) {
#if WASM_RT_STACK_EXHAUSTION_HANDLER
  os_allocate_and_install_altstack();
#endif
}

void wasm_rt_free_thread(void) {
#if WASM_RT_STACK_EXHAUSTION_HANDLER
  os_disable_and_deallocate_altstack();
#endif
}

#if WASM_RT_USE_SEGUE
void wasm_rt_syscall_set_segue_base(void* base) {
  int error_code = 0;
#ifdef __linux__
  error_code = syscall(SYS_arch_prctl, ARCH_SET_GS, base);
#elif defined(__FreeBSD__)
  error_code = amd64_set_gsbase(base);
#else
#error "Unknown platform"
#endif
  if (error_code != 0) {
    perror("wasm_rt_syscall_set_segue_base error");
    abort();
  }
}
void* wasm_rt_syscall_get_segue_base() {
  void* base;
  int error_code = 0;
#ifdef __linux__
  error_code = syscall(SYS_arch_prctl, ARCH_GET_GS, &base);
#elif defined(__FreeBSD__)
  error_code = amd64_get_gsbase(&base);
#else
#error "Unknown platform"
#endif
  if (error_code != 0) {
    perror("wasm_rt_syscall_get_segue_base error");
    abort();
  }
  return base;
}
#endif

// Include table operations for funcref
#define WASM_RT_TABLE_OPS_FUNCREF
#include "wasm-rt-impl-tableops.inc"
#undef WASM_RT_TABLE_OPS_FUNCREF

// Include table operations for externref
#define WASM_RT_TABLE_OPS_EXTERNREF
#include "wasm-rt-impl-tableops.inc"
#undef WASM_RT_TABLE_OPS_EXTERNREF

const char* wasm_rt_strerror(wasm_rt_trap_t trap) {
  switch (trap) {
    case WASM_RT_TRAP_NONE:
      return "No error";
    case WASM_RT_TRAP_OOB:
#if WASM_RT_MERGED_OOB_AND_EXHAUSTION_TRAPS
      return "Out-of-bounds access in linear memory or a table, or call stack "
             "exhausted";
#else
      return "Out-of-bounds access in linear memory or a table";
    case WASM_RT_TRAP_EXHAUSTION:
      return "Call stack exhausted";
#endif
    case WASM_RT_TRAP_INT_OVERFLOW:
      return "Integer overflow on divide or truncation";
    case WASM_RT_TRAP_DIV_BY_ZERO:
      return "Integer divide by zero";
    case WASM_RT_TRAP_INVALID_CONVERSION:
      return "Conversion from NaN to integer";
    case WASM_RT_TRAP_UNREACHABLE:
      return "Unreachable instruction executed";
    case WASM_RT_TRAP_CALL_INDIRECT:
      return "Invalid call_indirect or return_call_indirect";
    case WASM_RT_TRAP_UNCAUGHT_EXCEPTION:
      return "Uncaught exception";
    case WASM_RT_TRAP_UNALIGNED:
      return "Unaligned atomic memory access";
    case WASM_RT_TRAP_NULL_REF:
      return "Null reference";
  }
  return "invalid trap code";
}
