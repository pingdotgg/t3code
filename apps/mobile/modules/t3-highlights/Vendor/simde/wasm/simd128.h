/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/wasm/simd128.h :: */
/* SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Copyright:
 *   2021      Evan Nemerson <evan@nemerson.com>
 *   2023      Michael R. Crusoe <crusoe@debian.org>
 */

#if !defined(SIMDE_WASM_SIMD128_H)
#define SIMDE_WASM_SIMD128_H

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/simde-common.h :: */
/* SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Copyright:
 *   2017-2020 Evan Nemerson <evan@nemerson.com>
 *   2023      Yi-Yen Chung <eric681@andestech.com> (Copyright owned by Andes Technology)
 *   2023      Ju-Hung Li <jhlee@pllab.cs.nthu.edu.tw> (Copyright owned by NTHU pllab)
 */

#if !defined(SIMDE_COMMON_H)
#define SIMDE_COMMON_H

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/hedley.h :: */
/* Hedley - https://nemequ.github.io/hedley
 * Created by Evan Nemerson <evan@nemerson.com>
 *
 * To the extent possible under law, the author(s) have dedicated all
 * copyright and related and neighboring rights to this software to
 * the public domain worldwide. This software is distributed without
 * any warranty.
 *
 * For details, see <http://creativecommons.org/publicdomain/zero/1.0/>.
 * SPDX-License-Identifier: CC0-1.0
 */

#if !defined(HEDLEY_VERSION) || (HEDLEY_VERSION < 16)
#if defined(HEDLEY_VERSION)
#  undef HEDLEY_VERSION
#endif
#define HEDLEY_VERSION 16

#if defined(HEDLEY_STRINGIFY_EX)
#  undef HEDLEY_STRINGIFY_EX
#endif
#define HEDLEY_STRINGIFY_EX(x) #x

#if defined(HEDLEY_STRINGIFY)
#  undef HEDLEY_STRINGIFY
#endif
#define HEDLEY_STRINGIFY(x) HEDLEY_STRINGIFY_EX(x)

#if defined(HEDLEY_CONCAT_EX)
#  undef HEDLEY_CONCAT_EX
#endif
#define HEDLEY_CONCAT_EX(a,b) a##b

#if defined(HEDLEY_CONCAT)
#  undef HEDLEY_CONCAT
#endif
#define HEDLEY_CONCAT(a,b) HEDLEY_CONCAT_EX(a,b)

#if defined(HEDLEY_CONCAT3_EX)
#  undef HEDLEY_CONCAT3_EX
#endif
#define HEDLEY_CONCAT3_EX(a,b,c) a##b##c

#if defined(HEDLEY_CONCAT3)
#  undef HEDLEY_CONCAT3
#endif
#define HEDLEY_CONCAT3(a,b,c) HEDLEY_CONCAT3_EX(a,b,c)

#if defined(HEDLEY_VERSION_ENCODE)
#  undef HEDLEY_VERSION_ENCODE
#endif
#define HEDLEY_VERSION_ENCODE(major,minor,revision) (((major) * 1000000) + ((minor) * 1000) + (revision))

#if defined(HEDLEY_VERSION_DECODE_MAJOR)
#  undef HEDLEY_VERSION_DECODE_MAJOR
#endif
#define HEDLEY_VERSION_DECODE_MAJOR(version) ((version) / 1000000)

#if defined(HEDLEY_VERSION_DECODE_MINOR)
#  undef HEDLEY_VERSION_DECODE_MINOR
#endif
#define HEDLEY_VERSION_DECODE_MINOR(version) (((version) % 1000000) / 1000)

#if defined(HEDLEY_VERSION_DECODE_REVISION)
#  undef HEDLEY_VERSION_DECODE_REVISION
#endif
#define HEDLEY_VERSION_DECODE_REVISION(version) ((version) % 1000)

#if defined(HEDLEY_GNUC_VERSION)
#  undef HEDLEY_GNUC_VERSION
#endif
#if defined(__GNUC__) && defined(__GNUC_PATCHLEVEL__)
#  define HEDLEY_GNUC_VERSION HEDLEY_VERSION_ENCODE(__GNUC__, __GNUC_MINOR__, __GNUC_PATCHLEVEL__)
#elif defined(__GNUC__)
#  define HEDLEY_GNUC_VERSION HEDLEY_VERSION_ENCODE(__GNUC__, __GNUC_MINOR__, 0)
#endif

#if defined(HEDLEY_GNUC_VERSION_CHECK)
#  undef HEDLEY_GNUC_VERSION_CHECK
#endif
#if defined(HEDLEY_GNUC_VERSION)
#  define HEDLEY_GNUC_VERSION_CHECK(major,minor,patch) (HEDLEY_GNUC_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_GNUC_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_MSVC_VERSION)
#  undef HEDLEY_MSVC_VERSION
#endif
#if defined(_MSC_FULL_VER) && (_MSC_FULL_VER >= 140000000) && !defined(__ICL)
#  define HEDLEY_MSVC_VERSION HEDLEY_VERSION_ENCODE(_MSC_FULL_VER / 10000000, (_MSC_FULL_VER % 10000000) / 100000, (_MSC_FULL_VER % 100000) / 100)
#elif defined(_MSC_FULL_VER) && !defined(__ICL)
#  define HEDLEY_MSVC_VERSION HEDLEY_VERSION_ENCODE(_MSC_FULL_VER / 1000000, (_MSC_FULL_VER % 1000000) / 10000, (_MSC_FULL_VER % 10000) / 10)
#elif defined(_MSC_VER) && !defined(__ICL)
#  define HEDLEY_MSVC_VERSION HEDLEY_VERSION_ENCODE(_MSC_VER / 100, _MSC_VER % 100, 0)
#endif

#if defined(HEDLEY_MSVC_VERSION_CHECK)
#  undef HEDLEY_MSVC_VERSION_CHECK
#endif
#if !defined(HEDLEY_MSVC_VERSION)
#  define HEDLEY_MSVC_VERSION_CHECK(major,minor,patch) (0)
#elif defined(_MSC_VER) && (_MSC_VER >= 1400)
#  define HEDLEY_MSVC_VERSION_CHECK(major,minor,patch) (_MSC_FULL_VER >= ((major * 10000000) + (minor * 100000) + (patch)))
#elif defined(_MSC_VER) && (_MSC_VER >= 1200)
#  define HEDLEY_MSVC_VERSION_CHECK(major,minor,patch) (_MSC_FULL_VER >= ((major * 1000000) + (minor * 10000) + (patch)))
#else
#  define HEDLEY_MSVC_VERSION_CHECK(major,minor,patch) (_MSC_VER >= ((major * 100) + (minor)))
#endif

#if defined(HEDLEY_INTEL_VERSION)
#  undef HEDLEY_INTEL_VERSION
#endif
#if defined(__INTEL_COMPILER) && defined(__INTEL_COMPILER_UPDATE) && !defined(__ICL)
#  define HEDLEY_INTEL_VERSION HEDLEY_VERSION_ENCODE(__INTEL_COMPILER / 100, __INTEL_COMPILER % 100, __INTEL_COMPILER_UPDATE)
#elif defined(__INTEL_COMPILER) && !defined(__ICL)
#  define HEDLEY_INTEL_VERSION HEDLEY_VERSION_ENCODE(__INTEL_COMPILER / 100, __INTEL_COMPILER % 100, 0)
#endif

#if defined(HEDLEY_INTEL_VERSION_CHECK)
#  undef HEDLEY_INTEL_VERSION_CHECK
#endif
#if defined(HEDLEY_INTEL_VERSION)
#  define HEDLEY_INTEL_VERSION_CHECK(major,minor,patch) (HEDLEY_INTEL_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_INTEL_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_INTEL_CL_VERSION)
#  undef HEDLEY_INTEL_CL_VERSION
#endif
#if defined(__INTEL_COMPILER) && defined(__INTEL_COMPILER_UPDATE) && defined(__ICL)
#  define HEDLEY_INTEL_CL_VERSION HEDLEY_VERSION_ENCODE(__INTEL_COMPILER, __INTEL_COMPILER_UPDATE, 0)
#endif

#if defined(HEDLEY_INTEL_CL_VERSION_CHECK)
#  undef HEDLEY_INTEL_CL_VERSION_CHECK
#endif
#if defined(HEDLEY_INTEL_CL_VERSION)
#  define HEDLEY_INTEL_CL_VERSION_CHECK(major,minor,patch) (HEDLEY_INTEL_CL_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_INTEL_CL_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_PGI_VERSION)
#  undef HEDLEY_PGI_VERSION
#endif
#if defined(__PGI) && defined(__PGIC__) && defined(__PGIC_MINOR__) && defined(__PGIC_PATCHLEVEL__)
#  define HEDLEY_PGI_VERSION HEDLEY_VERSION_ENCODE(__PGIC__, __PGIC_MINOR__, __PGIC_PATCHLEVEL__)
#endif

#if defined(HEDLEY_PGI_VERSION_CHECK)
#  undef HEDLEY_PGI_VERSION_CHECK
#endif
#if defined(HEDLEY_PGI_VERSION)
#  define HEDLEY_PGI_VERSION_CHECK(major,minor,patch) (HEDLEY_PGI_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_PGI_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_SUNPRO_VERSION)
#  undef HEDLEY_SUNPRO_VERSION
#endif
#if defined(__SUNPRO_C) && (__SUNPRO_C > 0x1000)
#  define HEDLEY_SUNPRO_VERSION HEDLEY_VERSION_ENCODE((((__SUNPRO_C >> 16) & 0xf) * 10) + ((__SUNPRO_C >> 12) & 0xf), (((__SUNPRO_C >> 8) & 0xf) * 10) + ((__SUNPRO_C >> 4) & 0xf), (__SUNPRO_C & 0xf) * 10)
#elif defined(__SUNPRO_C)
#  define HEDLEY_SUNPRO_VERSION HEDLEY_VERSION_ENCODE((__SUNPRO_C >> 8) & 0xf, (__SUNPRO_C >> 4) & 0xf, (__SUNPRO_C) & 0xf)
#elif defined(__SUNPRO_CC) && (__SUNPRO_CC > 0x1000)
#  define HEDLEY_SUNPRO_VERSION HEDLEY_VERSION_ENCODE((((__SUNPRO_CC >> 16) & 0xf) * 10) + ((__SUNPRO_CC >> 12) & 0xf), (((__SUNPRO_CC >> 8) & 0xf) * 10) + ((__SUNPRO_CC >> 4) & 0xf), (__SUNPRO_CC & 0xf) * 10)
#elif defined(__SUNPRO_CC)
#  define HEDLEY_SUNPRO_VERSION HEDLEY_VERSION_ENCODE((__SUNPRO_CC >> 8) & 0xf, (__SUNPRO_CC >> 4) & 0xf, (__SUNPRO_CC) & 0xf)
#endif

#if defined(HEDLEY_SUNPRO_VERSION_CHECK)
#  undef HEDLEY_SUNPRO_VERSION_CHECK
#endif
#if defined(HEDLEY_SUNPRO_VERSION)
#  define HEDLEY_SUNPRO_VERSION_CHECK(major,minor,patch) (HEDLEY_SUNPRO_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_SUNPRO_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_EMSCRIPTEN_VERSION)
#  undef HEDLEY_EMSCRIPTEN_VERSION
#endif
#if defined(__EMSCRIPTEN__)
#  include <emscripten.h>
#  define HEDLEY_EMSCRIPTEN_VERSION HEDLEY_VERSION_ENCODE(__EMSCRIPTEN_major__, __EMSCRIPTEN_minor__, __EMSCRIPTEN_tiny__)
#endif

#if defined(HEDLEY_EMSCRIPTEN_VERSION_CHECK)
#  undef HEDLEY_EMSCRIPTEN_VERSION_CHECK
#endif
#if defined(HEDLEY_EMSCRIPTEN_VERSION)
#  define HEDLEY_EMSCRIPTEN_VERSION_CHECK(major,minor,patch) (HEDLEY_EMSCRIPTEN_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_EMSCRIPTEN_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_ARM_VERSION)
#  undef HEDLEY_ARM_VERSION
#endif
#if defined(__CC_ARM) && defined(__ARMCOMPILER_VERSION)
#  define HEDLEY_ARM_VERSION HEDLEY_VERSION_ENCODE(__ARMCOMPILER_VERSION / 1000000, (__ARMCOMPILER_VERSION % 1000000) / 10000, (__ARMCOMPILER_VERSION % 10000) / 100)
#elif defined(__CC_ARM) && defined(__ARMCC_VERSION)
#  define HEDLEY_ARM_VERSION HEDLEY_VERSION_ENCODE(__ARMCC_VERSION / 1000000, (__ARMCC_VERSION % 1000000) / 10000, (__ARMCC_VERSION % 10000) / 100)
#endif

#if defined(HEDLEY_ARM_VERSION_CHECK)
#  undef HEDLEY_ARM_VERSION_CHECK
#endif
#if defined(HEDLEY_ARM_VERSION)
#  define HEDLEY_ARM_VERSION_CHECK(major,minor,patch) (HEDLEY_ARM_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_ARM_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_IBM_VERSION)
#  undef HEDLEY_IBM_VERSION
#endif
#if defined(__ibmxl__)
#  define HEDLEY_IBM_VERSION HEDLEY_VERSION_ENCODE(__ibmxl_version__, __ibmxl_release__, __ibmxl_modification__)
#elif defined(__xlC__) && defined(__xlC_ver__)
#  define HEDLEY_IBM_VERSION HEDLEY_VERSION_ENCODE(__xlC__ >> 8, __xlC__ & 0xff, (__xlC_ver__ >> 8) & 0xff)
#elif defined(__xlC__)
#  define HEDLEY_IBM_VERSION HEDLEY_VERSION_ENCODE(__xlC__ >> 8, __xlC__ & 0xff, 0)
#endif

#if defined(HEDLEY_IBM_VERSION_CHECK)
#  undef HEDLEY_IBM_VERSION_CHECK
#endif
#if defined(HEDLEY_IBM_VERSION)
#  define HEDLEY_IBM_VERSION_CHECK(major,minor,patch) (HEDLEY_IBM_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_IBM_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_TI_VERSION)
#  undef HEDLEY_TI_VERSION
#endif
#if \
    defined(__TI_COMPILER_VERSION__) && \
    ( \
      defined(__TMS470__) || defined(__TI_ARM__) || \
      defined(__MSP430__) || \
      defined(__TMS320C2000__) \
    )
#  if (__TI_COMPILER_VERSION__ >= 16000000)
#    define HEDLEY_TI_VERSION HEDLEY_VERSION_ENCODE(__TI_COMPILER_VERSION__ / 1000000, (__TI_COMPILER_VERSION__ % 1000000) / 1000, (__TI_COMPILER_VERSION__ % 1000))
#  endif
#endif

#if defined(HEDLEY_TI_VERSION_CHECK)
#  undef HEDLEY_TI_VERSION_CHECK
#endif
#if defined(HEDLEY_TI_VERSION)
#  define HEDLEY_TI_VERSION_CHECK(major,minor,patch) (HEDLEY_TI_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_TI_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_TI_CL2000_VERSION)
#  undef HEDLEY_TI_CL2000_VERSION
#endif
#if defined(__TI_COMPILER_VERSION__) && defined(__TMS320C2000__)
#  define HEDLEY_TI_CL2000_VERSION HEDLEY_VERSION_ENCODE(__TI_COMPILER_VERSION__ / 1000000, (__TI_COMPILER_VERSION__ % 1000000) / 1000, (__TI_COMPILER_VERSION__ % 1000))
#endif

#if defined(HEDLEY_TI_CL2000_VERSION_CHECK)
#  undef HEDLEY_TI_CL2000_VERSION_CHECK
#endif
#if defined(HEDLEY_TI_CL2000_VERSION)
#  define HEDLEY_TI_CL2000_VERSION_CHECK(major,minor,patch) (HEDLEY_TI_CL2000_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_TI_CL2000_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_TI_CL430_VERSION)
#  undef HEDLEY_TI_CL430_VERSION
#endif
#if defined(__TI_COMPILER_VERSION__) && defined(__MSP430__)
#  define HEDLEY_TI_CL430_VERSION HEDLEY_VERSION_ENCODE(__TI_COMPILER_VERSION__ / 1000000, (__TI_COMPILER_VERSION__ % 1000000) / 1000, (__TI_COMPILER_VERSION__ % 1000))
#endif

#if defined(HEDLEY_TI_CL430_VERSION_CHECK)
#  undef HEDLEY_TI_CL430_VERSION_CHECK
#endif
#if defined(HEDLEY_TI_CL430_VERSION)
#  define HEDLEY_TI_CL430_VERSION_CHECK(major,minor,patch) (HEDLEY_TI_CL430_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_TI_CL430_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_TI_ARMCL_VERSION)
#  undef HEDLEY_TI_ARMCL_VERSION
#endif
#if defined(__TI_COMPILER_VERSION__) && (defined(__TMS470__) || defined(__TI_ARM__))
#  define HEDLEY_TI_ARMCL_VERSION HEDLEY_VERSION_ENCODE(__TI_COMPILER_VERSION__ / 1000000, (__TI_COMPILER_VERSION__ % 1000000) / 1000, (__TI_COMPILER_VERSION__ % 1000))
#endif

#if defined(HEDLEY_TI_ARMCL_VERSION_CHECK)
#  undef HEDLEY_TI_ARMCL_VERSION_CHECK
#endif
#if defined(HEDLEY_TI_ARMCL_VERSION)
#  define HEDLEY_TI_ARMCL_VERSION_CHECK(major,minor,patch) (HEDLEY_TI_ARMCL_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_TI_ARMCL_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_TI_CL6X_VERSION)
#  undef HEDLEY_TI_CL6X_VERSION
#endif
#if defined(__TI_COMPILER_VERSION__) && defined(__TMS320C6X__)
#  define HEDLEY_TI_CL6X_VERSION HEDLEY_VERSION_ENCODE(__TI_COMPILER_VERSION__ / 1000000, (__TI_COMPILER_VERSION__ % 1000000) / 1000, (__TI_COMPILER_VERSION__ % 1000))
#endif

#if defined(HEDLEY_TI_CL6X_VERSION_CHECK)
#  undef HEDLEY_TI_CL6X_VERSION_CHECK
#endif
#if defined(HEDLEY_TI_CL6X_VERSION)
#  define HEDLEY_TI_CL6X_VERSION_CHECK(major,minor,patch) (HEDLEY_TI_CL6X_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_TI_CL6X_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_TI_CL7X_VERSION)
#  undef HEDLEY_TI_CL7X_VERSION
#endif
#if defined(__TI_COMPILER_VERSION__) && defined(__C7000__)
#  define HEDLEY_TI_CL7X_VERSION HEDLEY_VERSION_ENCODE(__TI_COMPILER_VERSION__ / 1000000, (__TI_COMPILER_VERSION__ % 1000000) / 1000, (__TI_COMPILER_VERSION__ % 1000))
#endif

#if defined(HEDLEY_TI_CL7X_VERSION_CHECK)
#  undef HEDLEY_TI_CL7X_VERSION_CHECK
#endif
#if defined(HEDLEY_TI_CL7X_VERSION)
#  define HEDLEY_TI_CL7X_VERSION_CHECK(major,minor,patch) (HEDLEY_TI_CL7X_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_TI_CL7X_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_TI_CLPRU_VERSION)
#  undef HEDLEY_TI_CLPRU_VERSION
#endif
#if defined(__TI_COMPILER_VERSION__) && defined(__PRU__)
#  define HEDLEY_TI_CLPRU_VERSION HEDLEY_VERSION_ENCODE(__TI_COMPILER_VERSION__ / 1000000, (__TI_COMPILER_VERSION__ % 1000000) / 1000, (__TI_COMPILER_VERSION__ % 1000))
#endif

#if defined(HEDLEY_TI_CLPRU_VERSION_CHECK)
#  undef HEDLEY_TI_CLPRU_VERSION_CHECK
#endif
#if defined(HEDLEY_TI_CLPRU_VERSION)
#  define HEDLEY_TI_CLPRU_VERSION_CHECK(major,minor,patch) (HEDLEY_TI_CLPRU_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_TI_CLPRU_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_CRAY_VERSION)
#  undef HEDLEY_CRAY_VERSION
#endif
#if defined(_CRAYC)
#  if defined(_RELEASE_PATCHLEVEL)
#    define HEDLEY_CRAY_VERSION HEDLEY_VERSION_ENCODE(_RELEASE_MAJOR, _RELEASE_MINOR, _RELEASE_PATCHLEVEL)
#  else
#    define HEDLEY_CRAY_VERSION HEDLEY_VERSION_ENCODE(_RELEASE_MAJOR, _RELEASE_MINOR, 0)
#  endif
#endif

#if defined(HEDLEY_CRAY_VERSION_CHECK)
#  undef HEDLEY_CRAY_VERSION_CHECK
#endif
#if defined(HEDLEY_CRAY_VERSION)
#  define HEDLEY_CRAY_VERSION_CHECK(major,minor,patch) (HEDLEY_CRAY_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_CRAY_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_IAR_VERSION)
#  undef HEDLEY_IAR_VERSION
#endif
#if defined(__IAR_SYSTEMS_ICC__)
#  if __VER__ > 1000
#    define HEDLEY_IAR_VERSION HEDLEY_VERSION_ENCODE((__VER__ / 1000000), ((__VER__ / 1000) % 1000), (__VER__ % 1000))
#  else
#    define HEDLEY_IAR_VERSION HEDLEY_VERSION_ENCODE(__VER__ / 100, __VER__ % 100, 0)
#  endif
#endif

#if defined(HEDLEY_IAR_VERSION_CHECK)
#  undef HEDLEY_IAR_VERSION_CHECK
#endif
#if defined(HEDLEY_IAR_VERSION)
#  define HEDLEY_IAR_VERSION_CHECK(major,minor,patch) (HEDLEY_IAR_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_IAR_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_TINYC_VERSION)
#  undef HEDLEY_TINYC_VERSION
#endif
#if defined(__TINYC__)
#  define HEDLEY_TINYC_VERSION HEDLEY_VERSION_ENCODE(__TINYC__ / 1000, (__TINYC__ / 100) % 10, __TINYC__ % 100)
#endif

#if defined(HEDLEY_TINYC_VERSION_CHECK)
#  undef HEDLEY_TINYC_VERSION_CHECK
#endif
#if defined(HEDLEY_TINYC_VERSION)
#  define HEDLEY_TINYC_VERSION_CHECK(major,minor,patch) (HEDLEY_TINYC_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_TINYC_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_DMC_VERSION)
#  undef HEDLEY_DMC_VERSION
#endif
#if defined(__DMC__)
#  define HEDLEY_DMC_VERSION HEDLEY_VERSION_ENCODE(__DMC__ >> 8, (__DMC__ >> 4) & 0xf, __DMC__ & 0xf)
#endif

#if defined(HEDLEY_DMC_VERSION_CHECK)
#  undef HEDLEY_DMC_VERSION_CHECK
#endif
#if defined(HEDLEY_DMC_VERSION)
#  define HEDLEY_DMC_VERSION_CHECK(major,minor,patch) (HEDLEY_DMC_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_DMC_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_COMPCERT_VERSION)
#  undef HEDLEY_COMPCERT_VERSION
#endif
#if defined(__COMPCERT_VERSION__)
#  define HEDLEY_COMPCERT_VERSION HEDLEY_VERSION_ENCODE(__COMPCERT_VERSION__ / 10000, (__COMPCERT_VERSION__ / 100) % 100, __COMPCERT_VERSION__ % 100)
#endif

#if defined(HEDLEY_COMPCERT_VERSION_CHECK)
#  undef HEDLEY_COMPCERT_VERSION_CHECK
#endif
#if defined(HEDLEY_COMPCERT_VERSION)
#  define HEDLEY_COMPCERT_VERSION_CHECK(major,minor,patch) (HEDLEY_COMPCERT_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_COMPCERT_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_PELLES_VERSION)
#  undef HEDLEY_PELLES_VERSION
#endif
#if defined(__POCC__)
#  define HEDLEY_PELLES_VERSION HEDLEY_VERSION_ENCODE(__POCC__ / 100, __POCC__ % 100, 0)
#endif

#if defined(HEDLEY_PELLES_VERSION_CHECK)
#  undef HEDLEY_PELLES_VERSION_CHECK
#endif
#if defined(HEDLEY_PELLES_VERSION)
#  define HEDLEY_PELLES_VERSION_CHECK(major,minor,patch) (HEDLEY_PELLES_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_PELLES_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_MCST_LCC_VERSION)
#  undef HEDLEY_MCST_LCC_VERSION
#endif
#if defined(__LCC__) && defined(__LCC_MINOR__)
#  define HEDLEY_MCST_LCC_VERSION HEDLEY_VERSION_ENCODE(__LCC__ / 100, __LCC__ % 100, __LCC_MINOR__)
#endif

#if defined(HEDLEY_MCST_LCC_VERSION_CHECK)
#  undef HEDLEY_MCST_LCC_VERSION_CHECK
#endif
#if defined(HEDLEY_MCST_LCC_VERSION)
#  define HEDLEY_MCST_LCC_VERSION_CHECK(major,minor,patch) (HEDLEY_MCST_LCC_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_MCST_LCC_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_GCC_VERSION)
#  undef HEDLEY_GCC_VERSION
#endif
#if \
  defined(HEDLEY_GNUC_VERSION) && \
  !defined(__clang__) && \
  !defined(HEDLEY_INTEL_VERSION) && \
  !defined(HEDLEY_PGI_VERSION) && \
  !defined(HEDLEY_ARM_VERSION) && \
  !defined(HEDLEY_CRAY_VERSION) && \
  !defined(HEDLEY_TI_VERSION) && \
  !defined(HEDLEY_TI_ARMCL_VERSION) && \
  !defined(HEDLEY_TI_CL430_VERSION) && \
  !defined(HEDLEY_TI_CL2000_VERSION) && \
  !defined(HEDLEY_TI_CL6X_VERSION) && \
  !defined(HEDLEY_TI_CL7X_VERSION) && \
  !defined(HEDLEY_TI_CLPRU_VERSION) && \
  !defined(__COMPCERT__) && \
  !defined(HEDLEY_MCST_LCC_VERSION)
#  define HEDLEY_GCC_VERSION HEDLEY_GNUC_VERSION
#endif

#if defined(HEDLEY_GCC_VERSION_CHECK)
#  undef HEDLEY_GCC_VERSION_CHECK
#endif
#if defined(HEDLEY_GCC_VERSION)
#  define HEDLEY_GCC_VERSION_CHECK(major,minor,patch) (HEDLEY_GCC_VERSION >= HEDLEY_VERSION_ENCODE(major, minor, patch))
#else
#  define HEDLEY_GCC_VERSION_CHECK(major,minor,patch) (0)
#endif

#if defined(HEDLEY_HAS_ATTRIBUTE)
#  undef HEDLEY_HAS_ATTRIBUTE
#endif
#if \
  defined(__has_attribute) && \
  ( \
    (!defined(HEDLEY_IAR_VERSION) || HEDLEY_IAR_VERSION_CHECK(8,5,9)) \
  )
#  define HEDLEY_HAS_ATTRIBUTE(attribute) __has_attribute(attribute)
#else
#  define HEDLEY_HAS_ATTRIBUTE(attribute) (0)
#endif

#if defined(HEDLEY_GNUC_HAS_ATTRIBUTE)
#  undef HEDLEY_GNUC_HAS_ATTRIBUTE
#endif
#if defined(__has_attribute)
#  define HEDLEY_GNUC_HAS_ATTRIBUTE(attribute,major,minor,patch) HEDLEY_HAS_ATTRIBUTE(attribute)
#else
#  define HEDLEY_GNUC_HAS_ATTRIBUTE(attribute,major,minor,patch) HEDLEY_GNUC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_GCC_HAS_ATTRIBUTE)
#  undef HEDLEY_GCC_HAS_ATTRIBUTE
#endif
#if defined(__has_attribute)
#  define HEDLEY_GCC_HAS_ATTRIBUTE(attribute,major,minor,patch) HEDLEY_HAS_ATTRIBUTE(attribute)
#else
#  define HEDLEY_GCC_HAS_ATTRIBUTE(attribute,major,minor,patch) HEDLEY_GCC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_HAS_CPP_ATTRIBUTE)
#  undef HEDLEY_HAS_CPP_ATTRIBUTE
#endif
#if \
  defined(__has_cpp_attribute) && \
  defined(__cplusplus) && \
  (!defined(HEDLEY_SUNPRO_VERSION) || HEDLEY_SUNPRO_VERSION_CHECK(5,15,0))
#  define HEDLEY_HAS_CPP_ATTRIBUTE(attribute) __has_cpp_attribute(attribute)
#else
#  define HEDLEY_HAS_CPP_ATTRIBUTE(attribute) (0)
#endif

#if defined(HEDLEY_HAS_CPP_ATTRIBUTE_NS)
#  undef HEDLEY_HAS_CPP_ATTRIBUTE_NS
#endif
#if !defined(__cplusplus) || !defined(__has_cpp_attribute)
#  define HEDLEY_HAS_CPP_ATTRIBUTE_NS(ns,attribute) (0)
#elif \
  !defined(HEDLEY_PGI_VERSION) && \
  !defined(HEDLEY_IAR_VERSION) && \
  (!defined(HEDLEY_SUNPRO_VERSION) || HEDLEY_SUNPRO_VERSION_CHECK(5,15,0)) && \
  (!defined(HEDLEY_MSVC_VERSION) || HEDLEY_MSVC_VERSION_CHECK(19,20,0))
#  define HEDLEY_HAS_CPP_ATTRIBUTE_NS(ns,attribute) HEDLEY_HAS_CPP_ATTRIBUTE(ns::attribute)
#else
#  define HEDLEY_HAS_CPP_ATTRIBUTE_NS(ns,attribute) (0)
#endif

#if defined(HEDLEY_GNUC_HAS_CPP_ATTRIBUTE)
#  undef HEDLEY_GNUC_HAS_CPP_ATTRIBUTE
#endif
#if defined(__has_cpp_attribute) && defined(__cplusplus)
#  define HEDLEY_GNUC_HAS_CPP_ATTRIBUTE(attribute,major,minor,patch) __has_cpp_attribute(attribute)
#else
#  define HEDLEY_GNUC_HAS_CPP_ATTRIBUTE(attribute,major,minor,patch) HEDLEY_GNUC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_GCC_HAS_CPP_ATTRIBUTE)
#  undef HEDLEY_GCC_HAS_CPP_ATTRIBUTE
#endif
#if defined(__has_cpp_attribute) && defined(__cplusplus)
#  define HEDLEY_GCC_HAS_CPP_ATTRIBUTE(attribute,major,minor,patch) __has_cpp_attribute(attribute)
#else
#  define HEDLEY_GCC_HAS_CPP_ATTRIBUTE(attribute,major,minor,patch) HEDLEY_GCC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_HAS_BUILTIN)
#  undef HEDLEY_HAS_BUILTIN
#endif
#if defined(__has_builtin)
#  define HEDLEY_HAS_BUILTIN(builtin) __has_builtin(builtin)
#else
#  define HEDLEY_HAS_BUILTIN(builtin) (0)
#endif

#if defined(HEDLEY_GNUC_HAS_BUILTIN)
#  undef HEDLEY_GNUC_HAS_BUILTIN
#endif
#if defined(__has_builtin)
#  define HEDLEY_GNUC_HAS_BUILTIN(builtin,major,minor,patch) __has_builtin(builtin)
#else
#  define HEDLEY_GNUC_HAS_BUILTIN(builtin,major,minor,patch) HEDLEY_GNUC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_GCC_HAS_BUILTIN)
#  undef HEDLEY_GCC_HAS_BUILTIN
#endif
#if defined(__has_builtin)
#  define HEDLEY_GCC_HAS_BUILTIN(builtin,major,minor,patch) __has_builtin(builtin)
#else
#  define HEDLEY_GCC_HAS_BUILTIN(builtin,major,minor,patch) HEDLEY_GCC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_HAS_FEATURE)
#  undef HEDLEY_HAS_FEATURE
#endif
#if defined(__has_feature)
#  define HEDLEY_HAS_FEATURE(feature) __has_feature(feature)
#else
#  define HEDLEY_HAS_FEATURE(feature) (0)
#endif

#if defined(HEDLEY_GNUC_HAS_FEATURE)
#  undef HEDLEY_GNUC_HAS_FEATURE
#endif
#if defined(__has_feature)
#  define HEDLEY_GNUC_HAS_FEATURE(feature,major,minor,patch) __has_feature(feature)
#else
#  define HEDLEY_GNUC_HAS_FEATURE(feature,major,minor,patch) HEDLEY_GNUC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_GCC_HAS_FEATURE)
#  undef HEDLEY_GCC_HAS_FEATURE
#endif
#if defined(__has_feature)
#  define HEDLEY_GCC_HAS_FEATURE(feature,major,minor,patch) __has_feature(feature)
#else
#  define HEDLEY_GCC_HAS_FEATURE(feature,major,minor,patch) HEDLEY_GCC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_HAS_EXTENSION)
#  undef HEDLEY_HAS_EXTENSION
#endif
#if defined(__has_extension)
#  define HEDLEY_HAS_EXTENSION(extension) __has_extension(extension)
#else
#  define HEDLEY_HAS_EXTENSION(extension) (0)
#endif

#if defined(HEDLEY_GNUC_HAS_EXTENSION)
#  undef HEDLEY_GNUC_HAS_EXTENSION
#endif
#if defined(__has_extension)
#  define HEDLEY_GNUC_HAS_EXTENSION(extension,major,minor,patch) __has_extension(extension)
#else
#  define HEDLEY_GNUC_HAS_EXTENSION(extension,major,minor,patch) HEDLEY_GNUC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_GCC_HAS_EXTENSION)
#  undef HEDLEY_GCC_HAS_EXTENSION
#endif
#if defined(__has_extension)
#  define HEDLEY_GCC_HAS_EXTENSION(extension,major,minor,patch) __has_extension(extension)
#else
#  define HEDLEY_GCC_HAS_EXTENSION(extension,major,minor,patch) HEDLEY_GCC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_HAS_DECLSPEC_ATTRIBUTE)
#  undef HEDLEY_HAS_DECLSPEC_ATTRIBUTE
#endif
#if defined(__has_declspec_attribute)
#  define HEDLEY_HAS_DECLSPEC_ATTRIBUTE(attribute) __has_declspec_attribute(attribute)
#else
#  define HEDLEY_HAS_DECLSPEC_ATTRIBUTE(attribute) (0)
#endif

#if defined(HEDLEY_GNUC_HAS_DECLSPEC_ATTRIBUTE)
#  undef HEDLEY_GNUC_HAS_DECLSPEC_ATTRIBUTE
#endif
#if defined(__has_declspec_attribute)
#  define HEDLEY_GNUC_HAS_DECLSPEC_ATTRIBUTE(attribute,major,minor,patch) __has_declspec_attribute(attribute)
#else
#  define HEDLEY_GNUC_HAS_DECLSPEC_ATTRIBUTE(attribute,major,minor,patch) HEDLEY_GNUC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_GCC_HAS_DECLSPEC_ATTRIBUTE)
#  undef HEDLEY_GCC_HAS_DECLSPEC_ATTRIBUTE
#endif
#if defined(__has_declspec_attribute)
#  define HEDLEY_GCC_HAS_DECLSPEC_ATTRIBUTE(attribute,major,minor,patch) __has_declspec_attribute(attribute)
#else
#  define HEDLEY_GCC_HAS_DECLSPEC_ATTRIBUTE(attribute,major,minor,patch) HEDLEY_GCC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_HAS_WARNING)
#  undef HEDLEY_HAS_WARNING
#endif
#if defined(__has_warning)
#  define HEDLEY_HAS_WARNING(warning) __has_warning(warning)
#else
#  define HEDLEY_HAS_WARNING(warning) (0)
#endif

#if defined(HEDLEY_GNUC_HAS_WARNING)
#  undef HEDLEY_GNUC_HAS_WARNING
#endif
#if defined(__has_warning)
#  define HEDLEY_GNUC_HAS_WARNING(warning,major,minor,patch) __has_warning(warning)
#else
#  define HEDLEY_GNUC_HAS_WARNING(warning,major,minor,patch) HEDLEY_GNUC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_GCC_HAS_WARNING)
#  undef HEDLEY_GCC_HAS_WARNING
#endif
#if defined(__has_warning)
#  define HEDLEY_GCC_HAS_WARNING(warning,major,minor,patch) __has_warning(warning)
#else
#  define HEDLEY_GCC_HAS_WARNING(warning,major,minor,patch) HEDLEY_GCC_VERSION_CHECK(major,minor,patch)
#endif

#if \
  (defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L)) || \
  defined(__clang__) || \
  HEDLEY_GCC_VERSION_CHECK(3,0,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_IAR_VERSION_CHECK(8,0,0) || \
  HEDLEY_PGI_VERSION_CHECK(18,4,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(4,7,0) || \
  HEDLEY_TI_CL430_VERSION_CHECK(2,0,1) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,1,0) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,0,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_CRAY_VERSION_CHECK(5,0,0) || \
  HEDLEY_TINYC_VERSION_CHECK(0,9,17) || \
  HEDLEY_SUNPRO_VERSION_CHECK(8,0,0) || \
  (HEDLEY_IBM_VERSION_CHECK(10,1,0) && defined(__C99_PRAGMA_OPERATOR))
#  define HEDLEY_PRAGMA(value) _Pragma(#value)
#elif HEDLEY_MSVC_VERSION_CHECK(15,0,0)
#  define HEDLEY_PRAGMA(value) __pragma(value)
#else
#  define HEDLEY_PRAGMA(value)
#endif

#if defined(HEDLEY_DIAGNOSTIC_PUSH)
#  undef HEDLEY_DIAGNOSTIC_PUSH
#endif
#if defined(HEDLEY_DIAGNOSTIC_POP)
#  undef HEDLEY_DIAGNOSTIC_POP
#endif
#if defined(__clang__)
#  define HEDLEY_DIAGNOSTIC_PUSH _Pragma("clang diagnostic push")
#  define HEDLEY_DIAGNOSTIC_POP _Pragma("clang diagnostic pop")
#elif HEDLEY_INTEL_VERSION_CHECK(13,0,0)
#  define HEDLEY_DIAGNOSTIC_PUSH _Pragma("warning(push)")
#  define HEDLEY_DIAGNOSTIC_POP _Pragma("warning(pop)")
#elif HEDLEY_GCC_VERSION_CHECK(4,6,0)
#  define HEDLEY_DIAGNOSTIC_PUSH _Pragma("GCC diagnostic push")
#  define HEDLEY_DIAGNOSTIC_POP _Pragma("GCC diagnostic pop")
#elif \
  HEDLEY_MSVC_VERSION_CHECK(15,0,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_DIAGNOSTIC_PUSH __pragma(warning(push))
#  define HEDLEY_DIAGNOSTIC_POP __pragma(warning(pop))
#elif HEDLEY_ARM_VERSION_CHECK(5,6,0)
#  define HEDLEY_DIAGNOSTIC_PUSH _Pragma("push")
#  define HEDLEY_DIAGNOSTIC_POP _Pragma("pop")
#elif \
    HEDLEY_TI_VERSION_CHECK(15,12,0) || \
    HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
    HEDLEY_TI_CL430_VERSION_CHECK(4,4,0) || \
    HEDLEY_TI_CL6X_VERSION_CHECK(8,1,0) || \
    HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
    HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0)
#  define HEDLEY_DIAGNOSTIC_PUSH _Pragma("diag_push")
#  define HEDLEY_DIAGNOSTIC_POP _Pragma("diag_pop")
#elif HEDLEY_PELLES_VERSION_CHECK(2,90,0)
#  define HEDLEY_DIAGNOSTIC_PUSH _Pragma("warning(push)")
#  define HEDLEY_DIAGNOSTIC_POP _Pragma("warning(pop)")
#else
#  define HEDLEY_DIAGNOSTIC_PUSH
#  define HEDLEY_DIAGNOSTIC_POP
#endif

/* HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_ is for
   HEDLEY INTERNAL USE ONLY.  API subject to change without notice. */
#if defined(HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_)
#  undef HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_
#endif
#if defined(__cplusplus)
#  if HEDLEY_HAS_WARNING("-Wc++98-compat")
#    if HEDLEY_HAS_WARNING("-Wc++17-extensions")
#      if HEDLEY_HAS_WARNING("-Wc++1z-extensions")
#        define HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_(xpr) \
           HEDLEY_DIAGNOSTIC_PUSH \
           _Pragma("clang diagnostic ignored \"-Wc++98-compat\"") \
           _Pragma("clang diagnostic ignored \"-Wc++17-extensions\"") \
           _Pragma("clang diagnostic ignored \"-Wc++1z-extensions\"") \
           xpr \
           HEDLEY_DIAGNOSTIC_POP
#      else
#        define HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_(xpr) \
           HEDLEY_DIAGNOSTIC_PUSH \
           _Pragma("clang diagnostic ignored \"-Wc++98-compat\"") \
           _Pragma("clang diagnostic ignored \"-Wc++17-extensions\"") \
           xpr \
           HEDLEY_DIAGNOSTIC_POP
#      endif
#    else
#      define HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_(xpr) \
         HEDLEY_DIAGNOSTIC_PUSH \
         _Pragma("clang diagnostic ignored \"-Wc++98-compat\"") \
         xpr \
         HEDLEY_DIAGNOSTIC_POP
#    endif
#  endif
#endif
#if !defined(HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_)
#  define HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_(x) x
#endif

#if defined(HEDLEY_CONST_CAST)
#  undef HEDLEY_CONST_CAST
#endif
#if defined(__cplusplus)
#  define HEDLEY_CONST_CAST(T, expr) (const_cast<T>(expr))
#elif \
  HEDLEY_HAS_WARNING("-Wcast-qual") || \
  HEDLEY_GCC_VERSION_CHECK(4,6,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0)
#  define HEDLEY_CONST_CAST(T, expr) (__extension__ ({ \
      HEDLEY_DIAGNOSTIC_PUSH \
      HEDLEY_DIAGNOSTIC_DISABLE_CAST_QUAL \
      ((T) (expr)); \
      HEDLEY_DIAGNOSTIC_POP \
    }))
#else
#  define HEDLEY_CONST_CAST(T, expr) ((T) (expr))
#endif

#if defined(HEDLEY_REINTERPRET_CAST)
#  undef HEDLEY_REINTERPRET_CAST
#endif
#if defined(__cplusplus)
#  define HEDLEY_REINTERPRET_CAST(T, expr) (reinterpret_cast<T>(expr))
#else
#  define HEDLEY_REINTERPRET_CAST(T, expr) ((T) (expr))
#endif

#if defined(HEDLEY_STATIC_CAST)
#  undef HEDLEY_STATIC_CAST
#endif
#if defined(__cplusplus)
#  define HEDLEY_STATIC_CAST(T, expr) (static_cast<T>(expr))
#else
#  define HEDLEY_STATIC_CAST(T, expr) ((T) (expr))
#endif

#if defined(HEDLEY_CPP_CAST)
#  undef HEDLEY_CPP_CAST
#endif
#if defined(__cplusplus)
#  if HEDLEY_HAS_WARNING("-Wold-style-cast")
#    define HEDLEY_CPP_CAST(T, expr) \
       HEDLEY_DIAGNOSTIC_PUSH \
       _Pragma("clang diagnostic ignored \"-Wold-style-cast\"") \
       ((T) (expr)) \
       HEDLEY_DIAGNOSTIC_POP
#  elif HEDLEY_IAR_VERSION_CHECK(8,3,0)
#    define HEDLEY_CPP_CAST(T, expr) \
       HEDLEY_DIAGNOSTIC_PUSH \
       _Pragma("diag_suppress=Pe137") \
       HEDLEY_DIAGNOSTIC_POP
#  else
#    define HEDLEY_CPP_CAST(T, expr) ((T) (expr))
#  endif
#else
#  define HEDLEY_CPP_CAST(T, expr) (expr)
#endif

#if defined(HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED)
#  undef HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED
#endif
#if HEDLEY_HAS_WARNING("-Wdeprecated-declarations")
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("clang diagnostic ignored \"-Wdeprecated-declarations\"")
#elif HEDLEY_INTEL_VERSION_CHECK(13,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("warning(disable:1478 1786)")
#elif HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED __pragma(warning(disable:1478 1786))
#elif HEDLEY_PGI_VERSION_CHECK(20,7,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("diag_suppress 1215,1216,1444,1445")
#elif HEDLEY_PGI_VERSION_CHECK(17,10,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("diag_suppress 1215,1444")
#elif HEDLEY_GCC_VERSION_CHECK(4,3,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("GCC diagnostic ignored \"-Wdeprecated-declarations\"")
#elif HEDLEY_MSVC_VERSION_CHECK(15,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED __pragma(warning(disable:4996))
#elif HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("diag_suppress 1215,1444")
#elif \
    HEDLEY_TI_VERSION_CHECK(15,12,0) || \
    (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
    HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
    (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
    HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
    (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
    HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
    (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
    HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
    HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
    HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("diag_suppress 1291,1718")
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,13,0) && !defined(__cplusplus)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("error_messages(off,E_DEPRECATED_ATT,E_DEPRECATED_ATT_MESS)")
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,13,0) && defined(__cplusplus)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("error_messages(off,symdeprecated,symdeprecated2)")
#elif HEDLEY_IAR_VERSION_CHECK(8,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("diag_suppress=Pe1444,Pe1215")
#elif HEDLEY_PELLES_VERSION_CHECK(2,90,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED _Pragma("warn(disable:2241)")
#else
#  define HEDLEY_DIAGNOSTIC_DISABLE_DEPRECATED
#endif

#if defined(HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS)
#  undef HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS
#endif
#if HEDLEY_HAS_WARNING("-Wunknown-pragmas")
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS _Pragma("clang diagnostic ignored \"-Wunknown-pragmas\"")
#elif HEDLEY_INTEL_VERSION_CHECK(13,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS _Pragma("warning(disable:161)")
#elif HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS __pragma(warning(disable:161))
#elif HEDLEY_PGI_VERSION_CHECK(17,10,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS _Pragma("diag_suppress 1675")
#elif HEDLEY_GCC_VERSION_CHECK(4,3,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS _Pragma("GCC diagnostic ignored \"-Wunknown-pragmas\"")
#elif HEDLEY_MSVC_VERSION_CHECK(15,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS __pragma(warning(disable:4068))
#elif \
    HEDLEY_TI_VERSION_CHECK(16,9,0) || \
    HEDLEY_TI_CL6X_VERSION_CHECK(8,0,0) || \
    HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
    HEDLEY_TI_CLPRU_VERSION_CHECK(2,3,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS _Pragma("diag_suppress 163")
#elif HEDLEY_TI_CL6X_VERSION_CHECK(8,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS _Pragma("diag_suppress 163")
#elif HEDLEY_IAR_VERSION_CHECK(8,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS _Pragma("diag_suppress=Pe161")
#elif HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS _Pragma("diag_suppress 161")
#else
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS
#endif

#if defined(HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES)
#  undef HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES
#endif
#if HEDLEY_HAS_WARNING("-Wunknown-attributes")
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES _Pragma("clang diagnostic ignored \"-Wunknown-attributes\"")
#elif HEDLEY_GCC_VERSION_CHECK(4,6,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES _Pragma("GCC diagnostic ignored \"-Wdeprecated-declarations\"")
#elif HEDLEY_INTEL_VERSION_CHECK(17,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES _Pragma("warning(disable:1292)")
#elif HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES __pragma(warning(disable:1292))
#elif HEDLEY_MSVC_VERSION_CHECK(19,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES __pragma(warning(disable:5030))
#elif HEDLEY_PGI_VERSION_CHECK(20,7,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES _Pragma("diag_suppress 1097,1098")
#elif HEDLEY_PGI_VERSION_CHECK(17,10,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES _Pragma("diag_suppress 1097")
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,14,0) && defined(__cplusplus)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES _Pragma("error_messages(off,attrskipunsup)")
#elif \
    HEDLEY_TI_VERSION_CHECK(18,1,0) || \
    HEDLEY_TI_CL6X_VERSION_CHECK(8,3,0) || \
    HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES _Pragma("diag_suppress 1173")
#elif HEDLEY_IAR_VERSION_CHECK(8,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES _Pragma("diag_suppress=Pe1097")
#elif HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES _Pragma("diag_suppress 1097")
#else
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_CPP_ATTRIBUTES
#endif

#if defined(HEDLEY_DIAGNOSTIC_DISABLE_CAST_QUAL)
#  undef HEDLEY_DIAGNOSTIC_DISABLE_CAST_QUAL
#endif
#if HEDLEY_HAS_WARNING("-Wcast-qual")
#  define HEDLEY_DIAGNOSTIC_DISABLE_CAST_QUAL _Pragma("clang diagnostic ignored \"-Wcast-qual\"")
#elif HEDLEY_INTEL_VERSION_CHECK(13,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_CAST_QUAL _Pragma("warning(disable:2203 2331)")
#elif HEDLEY_GCC_VERSION_CHECK(3,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_CAST_QUAL _Pragma("GCC diagnostic ignored \"-Wcast-qual\"")
#else
#  define HEDLEY_DIAGNOSTIC_DISABLE_CAST_QUAL
#endif

#if defined(HEDLEY_DIAGNOSTIC_DISABLE_UNUSED_FUNCTION)
#  undef HEDLEY_DIAGNOSTIC_DISABLE_UNUSED_FUNCTION
#endif
#if HEDLEY_HAS_WARNING("-Wunused-function")
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNUSED_FUNCTION _Pragma("clang diagnostic ignored \"-Wunused-function\"")
#elif HEDLEY_GCC_VERSION_CHECK(3,4,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNUSED_FUNCTION _Pragma("GCC diagnostic ignored \"-Wunused-function\"")
#elif HEDLEY_MSVC_VERSION_CHECK(1,0,0)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNUSED_FUNCTION __pragma(warning(disable:4505))
#elif HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNUSED_FUNCTION _Pragma("diag_suppress 3142")
#else
#  define HEDLEY_DIAGNOSTIC_DISABLE_UNUSED_FUNCTION
#endif

#if defined(HEDLEY_DEPRECATED)
#  undef HEDLEY_DEPRECATED
#endif
#if defined(HEDLEY_DEPRECATED_FOR)
#  undef HEDLEY_DEPRECATED_FOR
#endif
#if \
  HEDLEY_MSVC_VERSION_CHECK(14,0,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_DEPRECATED(since) __declspec(deprecated("Since " # since))
#  define HEDLEY_DEPRECATED_FOR(since, replacement) __declspec(deprecated("Since " #since "; use " #replacement))
#elif \
  (HEDLEY_HAS_EXTENSION(attribute_deprecated_with_message) && !defined(HEDLEY_IAR_VERSION)) || \
  HEDLEY_GCC_VERSION_CHECK(4,5,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_ARM_VERSION_CHECK(5,6,0) || \
  HEDLEY_SUNPRO_VERSION_CHECK(5,13,0) || \
  HEDLEY_PGI_VERSION_CHECK(17,10,0) || \
  HEDLEY_TI_VERSION_CHECK(18,1,0) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(18,1,0) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(8,3,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,3,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_DEPRECATED(since) __attribute__((__deprecated__("Since " #since)))
#  define HEDLEY_DEPRECATED_FOR(since, replacement) __attribute__((__deprecated__("Since " #since "; use " #replacement)))
#elif defined(__cplusplus) && (__cplusplus >= 201402L)
#  define HEDLEY_DEPRECATED(since) HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_([[deprecated("Since " #since)]])
#  define HEDLEY_DEPRECATED_FOR(since, replacement) HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_([[deprecated("Since " #since "; use " #replacement)]])
#elif \
  HEDLEY_HAS_ATTRIBUTE(deprecated) || \
  HEDLEY_GCC_VERSION_CHECK(3,1,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
  (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
  (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10) || \
  HEDLEY_IAR_VERSION_CHECK(8,10,0)
#  define HEDLEY_DEPRECATED(since) __attribute__((__deprecated__))
#  define HEDLEY_DEPRECATED_FOR(since, replacement) __attribute__((__deprecated__))
#elif \
  HEDLEY_MSVC_VERSION_CHECK(13,10,0) || \
  HEDLEY_PELLES_VERSION_CHECK(6,50,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_DEPRECATED(since) __declspec(deprecated)
#  define HEDLEY_DEPRECATED_FOR(since, replacement) __declspec(deprecated)
#elif HEDLEY_IAR_VERSION_CHECK(8,0,0)
#  define HEDLEY_DEPRECATED(since) _Pragma("deprecated")
#  define HEDLEY_DEPRECATED_FOR(since, replacement) _Pragma("deprecated")
#else
#  define HEDLEY_DEPRECATED(since)
#  define HEDLEY_DEPRECATED_FOR(since, replacement)
#endif

#if defined(HEDLEY_UNAVAILABLE)
#  undef HEDLEY_UNAVAILABLE
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(warning) || \
  HEDLEY_GCC_VERSION_CHECK(4,3,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_UNAVAILABLE(available_since) __attribute__((__warning__("Not available until " #available_since)))
#else
#  define HEDLEY_UNAVAILABLE(available_since)
#endif

#if defined(HEDLEY_WARN_UNUSED_RESULT)
#  undef HEDLEY_WARN_UNUSED_RESULT
#endif
#if defined(HEDLEY_WARN_UNUSED_RESULT_MSG)
#  undef HEDLEY_WARN_UNUSED_RESULT_MSG
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(warn_unused_result) || \
  HEDLEY_GCC_VERSION_CHECK(3,4,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
  (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
  (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  (HEDLEY_SUNPRO_VERSION_CHECK(5,15,0) && defined(__cplusplus)) || \
  HEDLEY_PGI_VERSION_CHECK(17,10,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_WARN_UNUSED_RESULT __attribute__((__warn_unused_result__))
#  define HEDLEY_WARN_UNUSED_RESULT_MSG(msg) __attribute__((__warn_unused_result__))
#elif (HEDLEY_HAS_CPP_ATTRIBUTE(nodiscard) >= 201907L)
#  define HEDLEY_WARN_UNUSED_RESULT HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_([[nodiscard]])
#  define HEDLEY_WARN_UNUSED_RESULT_MSG(msg) HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_([[nodiscard(msg)]])
#elif HEDLEY_HAS_CPP_ATTRIBUTE(nodiscard)
#  define HEDLEY_WARN_UNUSED_RESULT HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_([[nodiscard]])
#  define HEDLEY_WARN_UNUSED_RESULT_MSG(msg) HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_([[nodiscard]])
#elif defined(_Check_return_) /* SAL */
#  define HEDLEY_WARN_UNUSED_RESULT _Check_return_
#  define HEDLEY_WARN_UNUSED_RESULT_MSG(msg) _Check_return_
#else
#  define HEDLEY_WARN_UNUSED_RESULT
#  define HEDLEY_WARN_UNUSED_RESULT_MSG(msg)
#endif

#if defined(HEDLEY_SENTINEL)
#  undef HEDLEY_SENTINEL
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(sentinel) || \
  HEDLEY_GCC_VERSION_CHECK(4,0,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_ARM_VERSION_CHECK(5,4,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_SENTINEL(position) __attribute__((__sentinel__(position)))
#else
#  define HEDLEY_SENTINEL(position)
#endif

#if defined(HEDLEY_NO_RETURN)
#  undef HEDLEY_NO_RETURN
#endif
#if HEDLEY_IAR_VERSION_CHECK(8,0,0)
#  define HEDLEY_NO_RETURN __noreturn
#elif \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_NO_RETURN __attribute__((__noreturn__))
#elif defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
#  define HEDLEY_NO_RETURN _Noreturn
#elif defined(__cplusplus) && (__cplusplus >= 201103L)
#  define HEDLEY_NO_RETURN HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_([[noreturn]])
#elif \
  HEDLEY_HAS_ATTRIBUTE(noreturn) || \
  HEDLEY_GCC_VERSION_CHECK(3,2,0) || \
  HEDLEY_SUNPRO_VERSION_CHECK(5,11,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_IBM_VERSION_CHECK(10,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
  (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
  (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_IAR_VERSION_CHECK(8,10,0)
#  define HEDLEY_NO_RETURN __attribute__((__noreturn__))
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,10,0)
#  define HEDLEY_NO_RETURN _Pragma("does_not_return")
#elif \
  HEDLEY_MSVC_VERSION_CHECK(13,10,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_NO_RETURN __declspec(noreturn)
#elif HEDLEY_TI_CL6X_VERSION_CHECK(6,0,0) && defined(__cplusplus)
#  define HEDLEY_NO_RETURN _Pragma("FUNC_NEVER_RETURNS;")
#elif HEDLEY_COMPCERT_VERSION_CHECK(3,2,0)
#  define HEDLEY_NO_RETURN __attribute((noreturn))
#elif HEDLEY_PELLES_VERSION_CHECK(9,0,0)
#  define HEDLEY_NO_RETURN __declspec(noreturn)
#else
#  define HEDLEY_NO_RETURN
#endif

#if defined(HEDLEY_NO_ESCAPE)
#  undef HEDLEY_NO_ESCAPE
#endif
#if HEDLEY_HAS_ATTRIBUTE(noescape)
#  define HEDLEY_NO_ESCAPE __attribute__((__noescape__))
#else
#  define HEDLEY_NO_ESCAPE
#endif

#if defined(HEDLEY_UNREACHABLE)
#  undef HEDLEY_UNREACHABLE
#endif
#if defined(HEDLEY_UNREACHABLE_RETURN)
#  undef HEDLEY_UNREACHABLE_RETURN
#endif
#if defined(HEDLEY_ASSUME)
#  undef HEDLEY_ASSUME
#endif
#if \
  HEDLEY_MSVC_VERSION_CHECK(13,10,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_ASSUME(expr) __assume(expr)
#elif HEDLEY_HAS_BUILTIN(__builtin_assume)
#  define HEDLEY_ASSUME(expr) __builtin_assume(expr)
#elif \
    HEDLEY_TI_CL2000_VERSION_CHECK(6,2,0) || \
    HEDLEY_TI_CL6X_VERSION_CHECK(4,0,0)
#  if defined(__cplusplus)
#    define HEDLEY_ASSUME(expr) std::_nassert(expr)
#  else
#    define HEDLEY_ASSUME(expr) _nassert(expr)
#  endif
#endif
#if \
  (HEDLEY_HAS_BUILTIN(__builtin_unreachable) && (!defined(HEDLEY_ARM_VERSION))) || \
  HEDLEY_GCC_VERSION_CHECK(4,5,0) || \
  HEDLEY_PGI_VERSION_CHECK(18,10,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_IBM_VERSION_CHECK(13,1,5) || \
  HEDLEY_CRAY_VERSION_CHECK(10,0,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_UNREACHABLE() __builtin_unreachable()
#elif defined(HEDLEY_ASSUME)
#  define HEDLEY_UNREACHABLE() HEDLEY_ASSUME(0)
#endif
#if !defined(HEDLEY_ASSUME)
#  if defined(HEDLEY_UNREACHABLE)
#    define HEDLEY_ASSUME(expr) HEDLEY_STATIC_CAST(void, ((expr) ? 1 : (HEDLEY_UNREACHABLE(), 1)))
#  else
#    define HEDLEY_ASSUME(expr) HEDLEY_STATIC_CAST(void, expr)
#  endif
#endif
#if defined(HEDLEY_UNREACHABLE)
#  if  \
      HEDLEY_TI_CL2000_VERSION_CHECK(6,2,0) || \
      HEDLEY_TI_CL6X_VERSION_CHECK(4,0,0)
#    define HEDLEY_UNREACHABLE_RETURN(value) return (HEDLEY_STATIC_CAST(void, HEDLEY_ASSUME(0)), (value))
#  else
#    define HEDLEY_UNREACHABLE_RETURN(value) HEDLEY_UNREACHABLE()
#  endif
#else
#  define HEDLEY_UNREACHABLE_RETURN(value) return (value)
#endif
#if !defined(HEDLEY_UNREACHABLE)
#  define HEDLEY_UNREACHABLE() HEDLEY_ASSUME(0)
#endif

HEDLEY_DIAGNOSTIC_PUSH
#if HEDLEY_HAS_WARNING("-Wpedantic")
#  pragma clang diagnostic ignored "-Wpedantic"
#endif
#if HEDLEY_HAS_WARNING("-Wc++98-compat-pedantic") && defined(__cplusplus)
#  pragma clang diagnostic ignored "-Wc++98-compat-pedantic"
#endif
#if HEDLEY_GCC_HAS_WARNING("-Wvariadic-macros",4,0,0)
#  if defined(__clang__)
#    pragma clang diagnostic ignored "-Wvariadic-macros"
#  elif defined(HEDLEY_GCC_VERSION)
#    pragma GCC diagnostic ignored "-Wvariadic-macros"
#  endif
#endif
#if defined(HEDLEY_NON_NULL)
#  undef HEDLEY_NON_NULL
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(nonnull) || \
  HEDLEY_GCC_VERSION_CHECK(3,3,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0)
#  define HEDLEY_NON_NULL(...) __attribute__((__nonnull__(__VA_ARGS__)))
#else
#  define HEDLEY_NON_NULL(...)
#endif
HEDLEY_DIAGNOSTIC_POP

#if defined(HEDLEY_PRINTF_FORMAT)
#  undef HEDLEY_PRINTF_FORMAT
#endif
#if defined(__MINGW32__) && HEDLEY_GCC_HAS_ATTRIBUTE(format,4,4,0) && !defined(__USE_MINGW_ANSI_STDIO)
#  define HEDLEY_PRINTF_FORMAT(string_idx,first_to_check) __attribute__((__format__(ms_printf, string_idx, first_to_check)))
#elif defined(__MINGW32__) && HEDLEY_GCC_HAS_ATTRIBUTE(format,4,4,0) && defined(__USE_MINGW_ANSI_STDIO)
#  define HEDLEY_PRINTF_FORMAT(string_idx,first_to_check) __attribute__((__format__(gnu_printf, string_idx, first_to_check)))
#elif \
  HEDLEY_HAS_ATTRIBUTE(format) || \
  HEDLEY_GCC_VERSION_CHECK(3,1,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_ARM_VERSION_CHECK(5,6,0) || \
  HEDLEY_IBM_VERSION_CHECK(10,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
  (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
  (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_PRINTF_FORMAT(string_idx,first_to_check) __attribute__((__format__(__printf__, string_idx, first_to_check)))
#elif HEDLEY_PELLES_VERSION_CHECK(6,0,0)
#  define HEDLEY_PRINTF_FORMAT(string_idx,first_to_check) __declspec(vaformat(printf,string_idx,first_to_check))
#else
#  define HEDLEY_PRINTF_FORMAT(string_idx,first_to_check)
#endif

#if defined(HEDLEY_CONSTEXPR)
#  undef HEDLEY_CONSTEXPR
#endif
#if defined(__cplusplus)
#  if __cplusplus >= 201103L
#    define HEDLEY_CONSTEXPR HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_(constexpr)
#  endif
#endif
#if !defined(HEDLEY_CONSTEXPR)
#  define HEDLEY_CONSTEXPR
#endif

#if defined(HEDLEY_PREDICT)
#  undef HEDLEY_PREDICT
#endif
#if defined(HEDLEY_LIKELY)
#  undef HEDLEY_LIKELY
#endif
#if defined(HEDLEY_UNLIKELY)
#  undef HEDLEY_UNLIKELY
#endif
#if defined(HEDLEY_UNPREDICTABLE)
#  undef HEDLEY_UNPREDICTABLE
#endif
#if HEDLEY_HAS_BUILTIN(__builtin_unpredictable)
#  define HEDLEY_UNPREDICTABLE(expr) __builtin_unpredictable((expr))
#endif
#if \
  (HEDLEY_HAS_BUILTIN(__builtin_expect_with_probability) && !defined(HEDLEY_PGI_VERSION) && !defined(HEDLEY_INTEL_VERSION)) || \
  HEDLEY_GCC_VERSION_CHECK(9,0,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_PREDICT(expr, value, probability) __builtin_expect_with_probability(  (expr), (value), (probability))
#  define HEDLEY_PREDICT_TRUE(expr, probability)   __builtin_expect_with_probability(!!(expr),    1   , (probability))
#  define HEDLEY_PREDICT_FALSE(expr, probability)  __builtin_expect_with_probability(!!(expr),    0   , (probability))
#  define HEDLEY_LIKELY(expr)                      __builtin_expect                 (!!(expr),    1                  )
#  define HEDLEY_UNLIKELY(expr)                    __builtin_expect                 (!!(expr),    0                  )
#elif \
  (HEDLEY_HAS_BUILTIN(__builtin_expect) && !defined(HEDLEY_INTEL_CL_VERSION)) || \
  HEDLEY_GCC_VERSION_CHECK(3,0,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  (HEDLEY_SUNPRO_VERSION_CHECK(5,15,0) && defined(__cplusplus)) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_IBM_VERSION_CHECK(10,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(4,7,0) || \
  HEDLEY_TI_CL430_VERSION_CHECK(3,1,0) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,1,0) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(6,1,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_TINYC_VERSION_CHECK(0,9,27) || \
  HEDLEY_CRAY_VERSION_CHECK(8,1,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_PREDICT(expr, expected, probability) \
     (((probability) >= 0.9) ? __builtin_expect((expr), (expected)) : (HEDLEY_STATIC_CAST(void, expected), (expr)))
#  define HEDLEY_PREDICT_TRUE(expr, probability) \
     (__extension__ ({ \
       double hedley_probability_ = (probability); \
       ((hedley_probability_ >= 0.9) ? __builtin_expect(!!(expr), 1) : ((hedley_probability_ <= 0.1) ? __builtin_expect(!!(expr), 0) : !!(expr))); \
     }))
#  define HEDLEY_PREDICT_FALSE(expr, probability) \
     (__extension__ ({ \
       double hedley_probability_ = (probability); \
       ((hedley_probability_ >= 0.9) ? __builtin_expect(!!(expr), 0) : ((hedley_probability_ <= 0.1) ? __builtin_expect(!!(expr), 1) : !!(expr))); \
     }))
#  define HEDLEY_LIKELY(expr)   __builtin_expect(!!(expr), 1)
#  define HEDLEY_UNLIKELY(expr) __builtin_expect(!!(expr), 0)
#else
#  define HEDLEY_PREDICT(expr, expected, probability) (HEDLEY_STATIC_CAST(void, expected), (expr))
#  define HEDLEY_PREDICT_TRUE(expr, probability) (!!(expr))
#  define HEDLEY_PREDICT_FALSE(expr, probability) (!!(expr))
#  define HEDLEY_LIKELY(expr) (!!(expr))
#  define HEDLEY_UNLIKELY(expr) (!!(expr))
#endif
#if !defined(HEDLEY_UNPREDICTABLE)
#  define HEDLEY_UNPREDICTABLE(expr) HEDLEY_PREDICT(expr, 1, 0.5)
#endif

#if defined(HEDLEY_MALLOC)
#  undef HEDLEY_MALLOC
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(malloc) || \
  HEDLEY_GCC_VERSION_CHECK(3,1,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_SUNPRO_VERSION_CHECK(5,11,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_IBM_VERSION_CHECK(12,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
  (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
  (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_MALLOC __attribute__((__malloc__))
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,10,0)
#  define HEDLEY_MALLOC _Pragma("returns_new_memory")
#elif \
  HEDLEY_MSVC_VERSION_CHECK(14,0,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_MALLOC __declspec(restrict)
#else
#  define HEDLEY_MALLOC
#endif

#if defined(HEDLEY_PURE)
#  undef HEDLEY_PURE
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(pure) || \
  HEDLEY_GCC_VERSION_CHECK(2,96,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_SUNPRO_VERSION_CHECK(5,11,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_IBM_VERSION_CHECK(10,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
  (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
  (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_PGI_VERSION_CHECK(17,10,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_PURE __attribute__((__pure__))
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,10,0)
#  define HEDLEY_PURE _Pragma("does_not_write_global_data")
#elif defined(__cplusplus) && \
    ( \
      HEDLEY_TI_CL430_VERSION_CHECK(2,0,1) || \
      HEDLEY_TI_CL6X_VERSION_CHECK(4,0,0) || \
      HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) \
    )
#  define HEDLEY_PURE _Pragma("FUNC_IS_PURE;")
#else
#  define HEDLEY_PURE
#endif

#if defined(HEDLEY_CONST)
#  undef HEDLEY_CONST
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(const) || \
  HEDLEY_GCC_VERSION_CHECK(2,5,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_SUNPRO_VERSION_CHECK(5,11,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_IBM_VERSION_CHECK(10,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
  (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
  (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_PGI_VERSION_CHECK(17,10,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_CONST __attribute__((__const__))
#elif \
  HEDLEY_SUNPRO_VERSION_CHECK(5,10,0)
#  define HEDLEY_CONST _Pragma("no_side_effect")
#else
#  define HEDLEY_CONST HEDLEY_PURE
#endif

#if defined(HEDLEY_RESTRICT)
#  undef HEDLEY_RESTRICT
#endif
#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) && !defined(__cplusplus)
#  define HEDLEY_RESTRICT restrict
#elif \
  HEDLEY_GCC_VERSION_CHECK(3,1,0) || \
  HEDLEY_MSVC_VERSION_CHECK(14,0,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_IBM_VERSION_CHECK(10,1,0) || \
  HEDLEY_PGI_VERSION_CHECK(17,10,0) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,2,4) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(8,1,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  (HEDLEY_SUNPRO_VERSION_CHECK(5,14,0) && defined(__cplusplus)) || \
  HEDLEY_IAR_VERSION_CHECK(8,0,0) || \
  defined(__clang__) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_RESTRICT __restrict
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,3,0) && !defined(__cplusplus)
#  define HEDLEY_RESTRICT _Restrict
#else
#  define HEDLEY_RESTRICT
#endif

#if defined(HEDLEY_INLINE)
#  undef HEDLEY_INLINE
#endif
#if \
  (defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L)) || \
  (defined(__cplusplus) && (__cplusplus >= 199711L))
#  define HEDLEY_INLINE inline
#elif \
  defined(HEDLEY_GCC_VERSION) || \
  HEDLEY_ARM_VERSION_CHECK(6,2,0)
#  define HEDLEY_INLINE __inline__
#elif \
  HEDLEY_MSVC_VERSION_CHECK(12,0,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,1,0) || \
  HEDLEY_TI_CL430_VERSION_CHECK(3,1,0) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,2,0) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(8,0,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_INLINE __inline
#else
#  define HEDLEY_INLINE
#endif

#if defined(HEDLEY_ALWAYS_INLINE)
#  undef HEDLEY_ALWAYS_INLINE
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(always_inline) || \
  HEDLEY_GCC_VERSION_CHECK(4,0,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_SUNPRO_VERSION_CHECK(5,11,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_IBM_VERSION_CHECK(10,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
  (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
  (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10) || \
  HEDLEY_IAR_VERSION_CHECK(8,10,0)
#  define HEDLEY_ALWAYS_INLINE __attribute__((__always_inline__)) HEDLEY_INLINE
#elif \
  HEDLEY_MSVC_VERSION_CHECK(12,0,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_ALWAYS_INLINE __forceinline
#elif defined(__cplusplus) && \
    ( \
      HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
      HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
      HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
      HEDLEY_TI_CL6X_VERSION_CHECK(6,1,0) || \
      HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
      HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) \
    )
#  define HEDLEY_ALWAYS_INLINE _Pragma("FUNC_ALWAYS_INLINE;")
#elif HEDLEY_IAR_VERSION_CHECK(8,0,0)
#  define HEDLEY_ALWAYS_INLINE _Pragma("inline=forced")
#else
#  define HEDLEY_ALWAYS_INLINE HEDLEY_INLINE
#endif

#if defined(HEDLEY_NEVER_INLINE)
#  undef HEDLEY_NEVER_INLINE
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(noinline) || \
  HEDLEY_GCC_VERSION_CHECK(4,0,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_SUNPRO_VERSION_CHECK(5,11,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_IBM_VERSION_CHECK(10,1,0) || \
  HEDLEY_TI_VERSION_CHECK(15,12,0) || \
  (HEDLEY_TI_ARMCL_VERSION_CHECK(4,8,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_ARMCL_VERSION_CHECK(5,2,0) || \
  (HEDLEY_TI_CL2000_VERSION_CHECK(6,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL2000_VERSION_CHECK(6,4,0) || \
  (HEDLEY_TI_CL430_VERSION_CHECK(4,0,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL430_VERSION_CHECK(4,3,0) || \
  (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) || \
  HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
  HEDLEY_TI_CLPRU_VERSION_CHECK(2,1,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10) || \
  HEDLEY_IAR_VERSION_CHECK(8,10,0)
#  define HEDLEY_NEVER_INLINE __attribute__((__noinline__))
#elif \
  HEDLEY_MSVC_VERSION_CHECK(13,10,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_NEVER_INLINE __declspec(noinline)
#elif HEDLEY_PGI_VERSION_CHECK(10,2,0)
#  define HEDLEY_NEVER_INLINE _Pragma("noinline")
#elif HEDLEY_TI_CL6X_VERSION_CHECK(6,0,0) && defined(__cplusplus)
#  define HEDLEY_NEVER_INLINE _Pragma("FUNC_CANNOT_INLINE;")
#elif HEDLEY_IAR_VERSION_CHECK(8,0,0)
#  define HEDLEY_NEVER_INLINE _Pragma("inline=never")
#elif HEDLEY_COMPCERT_VERSION_CHECK(3,2,0)
#  define HEDLEY_NEVER_INLINE __attribute((noinline))
#elif HEDLEY_PELLES_VERSION_CHECK(9,0,0)
#  define HEDLEY_NEVER_INLINE __declspec(noinline)
#else
#  define HEDLEY_NEVER_INLINE
#endif

#if defined(HEDLEY_PRIVATE)
#  undef HEDLEY_PRIVATE
#endif
#if defined(HEDLEY_PUBLIC)
#  undef HEDLEY_PUBLIC
#endif
#if defined(HEDLEY_IMPORT)
#  undef HEDLEY_IMPORT
#endif
#if defined(_WIN32) || defined(__CYGWIN__)
#  define HEDLEY_PRIVATE
#  define HEDLEY_PUBLIC   __declspec(dllexport)
#  define HEDLEY_IMPORT   __declspec(dllimport)
#else
#  if \
    HEDLEY_HAS_ATTRIBUTE(visibility) || \
    HEDLEY_GCC_VERSION_CHECK(3,3,0) || \
    HEDLEY_SUNPRO_VERSION_CHECK(5,11,0) || \
    HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
    HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
    HEDLEY_IBM_VERSION_CHECK(13,1,0) || \
    ( \
      defined(__TI_EABI__) && \
      ( \
        (HEDLEY_TI_CL6X_VERSION_CHECK(7,2,0) && defined(__TI_GNU_ATTRIBUTE_SUPPORT__)) || \
        HEDLEY_TI_CL6X_VERSION_CHECK(7,5,0) \
      ) \
    ) || \
    HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#    define HEDLEY_PRIVATE __attribute__((__visibility__("hidden")))
#    define HEDLEY_PUBLIC  __attribute__((__visibility__("default")))
#  else
#    define HEDLEY_PRIVATE
#    define HEDLEY_PUBLIC
#  endif
#  define HEDLEY_IMPORT    extern
#endif

#if defined(HEDLEY_NO_THROW)
#  undef HEDLEY_NO_THROW
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(nothrow) || \
  HEDLEY_GCC_VERSION_CHECK(3,3,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_NO_THROW __attribute__((__nothrow__))
#elif \
  HEDLEY_MSVC_VERSION_CHECK(13,1,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0)
#  define HEDLEY_NO_THROW __declspec(nothrow)
#else
#  define HEDLEY_NO_THROW
#endif

#if defined(HEDLEY_FALL_THROUGH)
# undef HEDLEY_FALL_THROUGH
#endif
#if defined(HEDLEY_INTEL_VERSION)
#  define HEDLEY_FALL_THROUGH
#elif \
  HEDLEY_HAS_ATTRIBUTE(fallthrough) || \
  HEDLEY_GCC_VERSION_CHECK(7,0,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_FALL_THROUGH __attribute__((__fallthrough__))
#elif HEDLEY_HAS_CPP_ATTRIBUTE_NS(clang,fallthrough)
#  define HEDLEY_FALL_THROUGH HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_([[clang::fallthrough]])
#elif HEDLEY_HAS_CPP_ATTRIBUTE(fallthrough)
#  define HEDLEY_FALL_THROUGH HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_([[fallthrough]])
#elif defined(__fallthrough) /* SAL */
#  define HEDLEY_FALL_THROUGH __fallthrough
#else
#  define HEDLEY_FALL_THROUGH
#endif

#if defined(HEDLEY_RETURNS_NON_NULL)
#  undef HEDLEY_RETURNS_NON_NULL
#endif
#if \
  HEDLEY_HAS_ATTRIBUTE(returns_nonnull) || \
  HEDLEY_GCC_VERSION_CHECK(4,9,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_RETURNS_NON_NULL __attribute__((__returns_nonnull__))
#elif defined(_Ret_notnull_) /* SAL */
#  define HEDLEY_RETURNS_NON_NULL _Ret_notnull_
#else
#  define HEDLEY_RETURNS_NON_NULL
#endif

#if defined(HEDLEY_ARRAY_PARAM)
#  undef HEDLEY_ARRAY_PARAM
#endif
#if \
  defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) && \
  !defined(__STDC_NO_VLA__) && \
  !defined(__cplusplus) && \
  !defined(HEDLEY_PGI_VERSION) && \
  !defined(HEDLEY_TINYC_VERSION)
#  define HEDLEY_ARRAY_PARAM(name) (name)
#else
#  define HEDLEY_ARRAY_PARAM(name)
#endif

#if defined(HEDLEY_IS_CONSTANT)
#  undef HEDLEY_IS_CONSTANT
#endif
#if defined(HEDLEY_REQUIRE_CONSTEXPR)
#  undef HEDLEY_REQUIRE_CONSTEXPR
#endif
/* HEDLEY_IS_CONSTEXPR_ is for
   HEDLEY INTERNAL USE ONLY.  API subject to change without notice. */
#if defined(HEDLEY_IS_CONSTEXPR_)
#  undef HEDLEY_IS_CONSTEXPR_
#endif
#if \
  HEDLEY_HAS_BUILTIN(__builtin_constant_p) || \
  HEDLEY_GCC_VERSION_CHECK(3,4,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_TINYC_VERSION_CHECK(0,9,19) || \
  HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
  HEDLEY_IBM_VERSION_CHECK(13,1,0) || \
  HEDLEY_TI_CL6X_VERSION_CHECK(6,1,0) || \
  (HEDLEY_SUNPRO_VERSION_CHECK(5,10,0) && !defined(__cplusplus)) || \
  HEDLEY_CRAY_VERSION_CHECK(8,1,0) || \
  HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#  define HEDLEY_IS_CONSTANT(expr) __builtin_constant_p(expr)
#endif
#if !defined(__cplusplus)
#  if \
       HEDLEY_HAS_BUILTIN(__builtin_types_compatible_p) || \
       HEDLEY_GCC_VERSION_CHECK(3,4,0) || \
       HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
       HEDLEY_IBM_VERSION_CHECK(13,1,0) || \
       HEDLEY_CRAY_VERSION_CHECK(8,1,0) || \
       HEDLEY_ARM_VERSION_CHECK(5,4,0) || \
       HEDLEY_TINYC_VERSION_CHECK(0,9,24)
#    if defined(__INTPTR_TYPE__)
#      define HEDLEY_IS_CONSTEXPR_(expr) __builtin_types_compatible_p(__typeof__((1 ? (void*) ((__INTPTR_TYPE__) ((expr) * 0)) : (int*) 0)), int*)
#    else
#      include <stdint.h>
#      define HEDLEY_IS_CONSTEXPR_(expr) __builtin_types_compatible_p(__typeof__((1 ? (void*) ((intptr_t) ((expr) * 0)) : (int*) 0)), int*)
#    endif
#  elif \
       ( \
          defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L) && \
          !defined(HEDLEY_SUNPRO_VERSION) && \
          !defined(HEDLEY_PGI_VERSION) && \
          !defined(HEDLEY_IAR_VERSION)) || \
       (HEDLEY_HAS_EXTENSION(c_generic_selections) && !defined(HEDLEY_IAR_VERSION)) || \
       HEDLEY_GCC_VERSION_CHECK(4,9,0) || \
       HEDLEY_INTEL_VERSION_CHECK(17,0,0) || \
       HEDLEY_IBM_VERSION_CHECK(12,1,0) || \
       HEDLEY_ARM_VERSION_CHECK(5,3,0)
#    if defined(__INTPTR_TYPE__)
#      define HEDLEY_IS_CONSTEXPR_(expr) _Generic((1 ? (void*) ((__INTPTR_TYPE__) ((expr) * 0)) : (int*) 0), int*: 1, void*: 0)
#    else
#      include <stdint.h>
#      define HEDLEY_IS_CONSTEXPR_(expr) _Generic((1 ? (void*) ((intptr_t) * 0) : (int*) 0), int*: 1, void*: 0)
#    endif
#  elif \
       defined(HEDLEY_GCC_VERSION) || \
       defined(HEDLEY_INTEL_VERSION) || \
       defined(HEDLEY_TINYC_VERSION) || \
       defined(HEDLEY_TI_ARMCL_VERSION) || \
       HEDLEY_TI_CL430_VERSION_CHECK(18,12,0) || \
       defined(HEDLEY_TI_CL2000_VERSION) || \
       defined(HEDLEY_TI_CL6X_VERSION) || \
       defined(HEDLEY_TI_CL7X_VERSION) || \
       defined(HEDLEY_TI_CLPRU_VERSION) || \
       defined(__clang__)
#    define HEDLEY_IS_CONSTEXPR_(expr) ( \
         sizeof(void) != \
         sizeof(*( \
           1 ? \
             ((void*) ((expr) * 0L) ) : \
             ((struct { char v[sizeof(void) * 2]; } *) 1) \
           ) \
         ) \
       )
#  endif
#endif
#if defined(HEDLEY_IS_CONSTEXPR_)
#  if !defined(HEDLEY_IS_CONSTANT)
#    define HEDLEY_IS_CONSTANT(expr) HEDLEY_IS_CONSTEXPR_(expr)
#  endif
#  define HEDLEY_REQUIRE_CONSTEXPR(expr) (HEDLEY_IS_CONSTEXPR_(expr) ? (expr) : (-1))
#else
#  if !defined(HEDLEY_IS_CONSTANT)
#    define HEDLEY_IS_CONSTANT(expr) (0)
#  endif
#  define HEDLEY_REQUIRE_CONSTEXPR(expr) (expr)
#endif

#if defined(HEDLEY_BEGIN_C_DECLS)
#  undef HEDLEY_BEGIN_C_DECLS
#endif
#if defined(HEDLEY_END_C_DECLS)
#  undef HEDLEY_END_C_DECLS
#endif
#if defined(HEDLEY_C_DECL)
#  undef HEDLEY_C_DECL
#endif
#if defined(__cplusplus)
#  define HEDLEY_BEGIN_C_DECLS extern "C" {
#  define HEDLEY_END_C_DECLS }
#  define HEDLEY_C_DECL extern "C"
#else
#  define HEDLEY_BEGIN_C_DECLS
#  define HEDLEY_END_C_DECLS
#  define HEDLEY_C_DECL
#endif

#if defined(HEDLEY_STATIC_ASSERT)
#  undef HEDLEY_STATIC_ASSERT
#endif
#if \
  !defined(__cplusplus) && ( \
      (defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)) || \
      (HEDLEY_HAS_FEATURE(c_static_assert) && !defined(HEDLEY_INTEL_CL_VERSION)) || \
      HEDLEY_GCC_VERSION_CHECK(6,0,0) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
      defined(_Static_assert) \
    )
#  define HEDLEY_STATIC_ASSERT(expr, message) _Static_assert(expr, message)
#elif \
  (defined(__cplusplus) && (__cplusplus >= 201103L)) || \
  HEDLEY_MSVC_VERSION_CHECK(16,0,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_STATIC_ASSERT(expr, message) HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_(static_assert(expr, message))
#else
#  define HEDLEY_STATIC_ASSERT(expr, message)
#endif

#if defined(HEDLEY_NULL)
#  undef HEDLEY_NULL
#endif
#if defined(__cplusplus)
#  if __cplusplus >= 201103L
#    define HEDLEY_NULL HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_(nullptr)
#  elif defined(NULL)
#    define HEDLEY_NULL NULL
#  else
#    define HEDLEY_NULL HEDLEY_STATIC_CAST(void*, 0)
#  endif
#elif defined(NULL)
#  define HEDLEY_NULL NULL
#else
#  define HEDLEY_NULL ((void*) 0)
#endif

#if defined(HEDLEY_MESSAGE)
#  undef HEDLEY_MESSAGE
#endif
#if HEDLEY_HAS_WARNING("-Wunknown-pragmas")
#  define HEDLEY_MESSAGE(msg) \
  HEDLEY_DIAGNOSTIC_PUSH \
  HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS \
  HEDLEY_PRAGMA(message msg) \
  HEDLEY_DIAGNOSTIC_POP
#elif \
  HEDLEY_GCC_VERSION_CHECK(4,4,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0)
#  define HEDLEY_MESSAGE(msg) HEDLEY_PRAGMA(message msg)
#elif HEDLEY_CRAY_VERSION_CHECK(5,0,0)
#  define HEDLEY_MESSAGE(msg) HEDLEY_PRAGMA(_CRI message msg)
#elif HEDLEY_IAR_VERSION_CHECK(8,0,0)
#  define HEDLEY_MESSAGE(msg) HEDLEY_PRAGMA(message(msg))
#elif HEDLEY_PELLES_VERSION_CHECK(2,0,0)
#  define HEDLEY_MESSAGE(msg) HEDLEY_PRAGMA(message(msg))
#else
#  define HEDLEY_MESSAGE(msg)
#endif

#if defined(HEDLEY_WARNING)
#  undef HEDLEY_WARNING
#endif
#if HEDLEY_HAS_WARNING("-Wunknown-pragmas")
#  define HEDLEY_WARNING(msg) \
  HEDLEY_DIAGNOSTIC_PUSH \
  HEDLEY_DIAGNOSTIC_DISABLE_UNKNOWN_PRAGMAS \
  HEDLEY_PRAGMA(clang warning msg) \
  HEDLEY_DIAGNOSTIC_POP
#elif \
  HEDLEY_GCC_VERSION_CHECK(4,8,0) || \
  HEDLEY_PGI_VERSION_CHECK(18,4,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0)
#  define HEDLEY_WARNING(msg) HEDLEY_PRAGMA(GCC warning msg)
#elif \
  HEDLEY_MSVC_VERSION_CHECK(15,0,0) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_WARNING(msg) HEDLEY_PRAGMA(message(msg))
#else
#  define HEDLEY_WARNING(msg) HEDLEY_MESSAGE(msg)
#endif

#if defined(HEDLEY_REQUIRE)
#  undef HEDLEY_REQUIRE
#endif
#if defined(HEDLEY_REQUIRE_MSG)
#  undef HEDLEY_REQUIRE_MSG
#endif
#if HEDLEY_HAS_ATTRIBUTE(diagnose_if)
#  if HEDLEY_HAS_WARNING("-Wgcc-compat")
#    define HEDLEY_REQUIRE(expr) \
       HEDLEY_DIAGNOSTIC_PUSH \
       _Pragma("clang diagnostic ignored \"-Wgcc-compat\"") \
       __attribute__((diagnose_if(!(expr), #expr, "error"))) \
       HEDLEY_DIAGNOSTIC_POP
#    define HEDLEY_REQUIRE_MSG(expr,msg) \
       HEDLEY_DIAGNOSTIC_PUSH \
       _Pragma("clang diagnostic ignored \"-Wgcc-compat\"") \
       __attribute__((diagnose_if(!(expr), msg, "error"))) \
       HEDLEY_DIAGNOSTIC_POP
#  else
#    define HEDLEY_REQUIRE(expr) __attribute__((diagnose_if(!(expr), #expr, "error")))
#    define HEDLEY_REQUIRE_MSG(expr,msg) __attribute__((diagnose_if(!(expr), msg, "error")))
#  endif
#else
#  define HEDLEY_REQUIRE(expr)
#  define HEDLEY_REQUIRE_MSG(expr,msg)
#endif

#if defined(HEDLEY_FLAGS)
#  undef HEDLEY_FLAGS
#endif
#if HEDLEY_HAS_ATTRIBUTE(flag_enum) && (!defined(__cplusplus) || HEDLEY_HAS_WARNING("-Wbitfield-enum-conversion"))
#  define HEDLEY_FLAGS __attribute__((__flag_enum__))
#else
#  define HEDLEY_FLAGS
#endif

#if defined(HEDLEY_FLAGS_CAST)
#  undef HEDLEY_FLAGS_CAST
#endif
#if HEDLEY_INTEL_VERSION_CHECK(19,0,0)
#  define HEDLEY_FLAGS_CAST(T, expr) (__extension__ ({ \
  HEDLEY_DIAGNOSTIC_PUSH \
      _Pragma("warning(disable:188)") \
      ((T) (expr)); \
      HEDLEY_DIAGNOSTIC_POP \
    }))
#else
#  define HEDLEY_FLAGS_CAST(T, expr) HEDLEY_STATIC_CAST(T, expr)
#endif

#if defined(HEDLEY_EMPTY_BASES)
#  undef HEDLEY_EMPTY_BASES
#endif
#if \
  (HEDLEY_MSVC_VERSION_CHECK(19,0,23918) && !HEDLEY_MSVC_VERSION_CHECK(20,0,0)) || \
  HEDLEY_INTEL_CL_VERSION_CHECK(2021,1,0)
#  define HEDLEY_EMPTY_BASES __declspec(empty_bases)
#else
#  define HEDLEY_EMPTY_BASES
#endif

/* Remaining macros are deprecated. */

#if defined(HEDLEY_GCC_NOT_CLANG_VERSION_CHECK)
#  undef HEDLEY_GCC_NOT_CLANG_VERSION_CHECK
#endif
#if defined(__clang__)
#  define HEDLEY_GCC_NOT_CLANG_VERSION_CHECK(major,minor,patch) (0)
#else
#  define HEDLEY_GCC_NOT_CLANG_VERSION_CHECK(major,minor,patch) HEDLEY_GCC_VERSION_CHECK(major,minor,patch)
#endif

#if defined(HEDLEY_CLANG_HAS_ATTRIBUTE)
#  undef HEDLEY_CLANG_HAS_ATTRIBUTE
#endif
#define HEDLEY_CLANG_HAS_ATTRIBUTE(attribute) HEDLEY_HAS_ATTRIBUTE(attribute)

#if defined(HEDLEY_CLANG_HAS_CPP_ATTRIBUTE)
#  undef HEDLEY_CLANG_HAS_CPP_ATTRIBUTE
#endif
#define HEDLEY_CLANG_HAS_CPP_ATTRIBUTE(attribute) HEDLEY_HAS_CPP_ATTRIBUTE(attribute)

#if defined(HEDLEY_CLANG_HAS_BUILTIN)
#  undef HEDLEY_CLANG_HAS_BUILTIN
#endif
#define HEDLEY_CLANG_HAS_BUILTIN(builtin) HEDLEY_HAS_BUILTIN(builtin)

#if defined(HEDLEY_CLANG_HAS_FEATURE)
#  undef HEDLEY_CLANG_HAS_FEATURE
#endif
#define HEDLEY_CLANG_HAS_FEATURE(feature) HEDLEY_HAS_FEATURE(feature)

#if defined(HEDLEY_CLANG_HAS_EXTENSION)
#  undef HEDLEY_CLANG_HAS_EXTENSION
#endif
#define HEDLEY_CLANG_HAS_EXTENSION(extension) HEDLEY_HAS_EXTENSION(extension)

#if defined(HEDLEY_CLANG_HAS_DECLSPEC_DECLSPEC_ATTRIBUTE)
#  undef HEDLEY_CLANG_HAS_DECLSPEC_DECLSPEC_ATTRIBUTE
#endif
#define HEDLEY_CLANG_HAS_DECLSPEC_ATTRIBUTE(attribute) HEDLEY_HAS_DECLSPEC_ATTRIBUTE(attribute)

#if defined(HEDLEY_CLANG_HAS_WARNING)
#  undef HEDLEY_CLANG_HAS_WARNING
#endif
#define HEDLEY_CLANG_HAS_WARNING(warning) HEDLEY_HAS_WARNING(warning)

#endif /* !defined(HEDLEY_VERSION) || (HEDLEY_VERSION < X) */
/* :: End simde/hedley.h :: */

#define SIMDE_VERSION_MAJOR 0
#define SIMDE_VERSION_MINOR 8
#define SIMDE_VERSION_MICRO 2
#define SIMDE_VERSION HEDLEY_VERSION_ENCODE(SIMDE_VERSION_MAJOR, SIMDE_VERSION_MINOR, SIMDE_VERSION_MICRO)
// Also update meson.build in the root directory of the repository

#include <stddef.h>
#include <stdint.h>

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/simde-detect-clang.h :: */
/* Detect Clang Version
 * Created by Evan Nemerson <evan@nemerson.com>
 *
 * To the extent possible under law, the author(s) have dedicated all
 * copyright and related and neighboring rights to this software to
 * the public domain worldwide. This software is distributed without
 * any warranty.
 *
 * For details, see <http://creativecommons.org/publicdomain/zero/1.0/>.
 * SPDX-License-Identifier: CC0-1.0
 */

/* This file was originally part of SIMDe
 * (<https://github.com/simd-everywhere/simde>).  You're free to do with it as
 * you please, but I do have a few small requests:
 *
 *  * If you make improvements, please submit them back to SIMDe
 *    (at <https://github.com/simd-everywhere/simde/issues>) so others can
 *    benefit from them.
 *  * Please keep a link to SIMDe intact so people know where to submit
 *    improvements.
 *  * If you expose it publicly, please change the SIMDE_ prefix to
 *    something specific to your project.
 *
 * The version numbers clang exposes (in the ___clang_major__,
 * __clang_minor__, and __clang_patchlevel__ macros) are unreliable.
 * Vendors such as Apple will define these values to their version
 * numbers; for example, "Apple Clang 4.0" is really clang 3.1, but
 * __clang_major__ and __clang_minor__ are defined to 4 and 0
 * respectively, instead of 3 and 1.
 *
 * The solution is *usually* to use clang's feature detection macros
 * (<https://clang.llvm.org/docs/LanguageExtensions.html#feature-checking-macros>)
 * to determine if the feature you're interested in is available.  This
 * generally works well, and it should probably be the first thing you
 * try.  Unfortunately, it's not possible to check for everything.  In
 * particular, compiler bugs.
 *
 * This file just uses the feature checking macros to detect features
 * added in specific versions of clang to identify which version of
 * clang the compiler is based on.
 *
 * Right now it only goes back to 3.6, but I'm happy to accept patches
 * to go back further.  And, of course, newer versions are welcome if
 * they're not already present, and if you find a way to detect a point
 * release that would be great, too!
 */

#if !defined(SIMDE_DETECT_CLANG_H)
#define SIMDE_DETECT_CLANG_H 1

/* Attempt to detect the upstream clang version number.  I usually only
 * worry about major version numbers (at least for 4.0+), but if you
 * need more resolution I'm happy to accept patches that are able to
 * detect minor versions as well.  That said, you'll probably have a
 * hard time with detection since AFAIK most minor releases don't add
 * anything we can detect. Updated based on
 * https://github.com/google/highway/blob/438c705a295176b96a50336527bb3e7ea365ffac/hwy/detect_compiler_arch.h#L73
 * - would welcome patches/updates there as well.
 */

#if defined(__clang__) && !defined(SIMDE_DETECT_CLANG_VERSION)
#  if __has_warning("-Wmissing-designated-field-initializers")
#    define SIMDE_DETECT_CLANG_VERSION 190000
#  elif __has_warning("-Woverriding-option")
#    define SIMDE_DETECT_CLANG_VERSION 180000
#  elif __has_attribute(unsafe_buffer_usage)  // no new warnings in 17.0
#    define SIMDE_DETECT_CLANG_VERSION 170000
#  elif __has_attribute(nouwtable)  // no new warnings in 16.0
#    define SIMDE_DETECT_CLANG_VERSION 160000
#  elif __has_warning("-Warray-parameter")
#    define SIMDE_DETECT_CLANG_VERSION 150000
#  elif __has_warning("-Wbitwise-instead-of-logical")
#    define SIMDE_DETECT_CLANG_VERSION 140000
#  elif __has_warning("-Waix-compat")
#    define SIMDE_DETECT_CLANG_VERSION 130000
#  elif __has_warning("-Wformat-insufficient-args")
#    define SIMDE_DETECT_CLANG_VERSION 120000
#  elif __has_warning("-Wimplicit-const-int-float-conversion")
#    define SIMDE_DETECT_CLANG_VERSION 110000
#  elif __has_warning("-Wmisleading-indentation")
#    define SIMDE_DETECT_CLANG_VERSION 100000
#  elif defined(__FILE_NAME__)
#    define SIMDE_DETECT_CLANG_VERSION 90000
#  elif __has_warning("-Wextra-semi-stmt") || __has_builtin(__builtin_rotateleft32)
#    define SIMDE_DETECT_CLANG_VERSION 80000
// For reasons unknown, Xcode 10.3 (Apple LLVM version 10.0.1) is apparently
// based on Clang 7, but does not support the warning we test.
// See https://en.wikipedia.org/wiki/Xcode#Toolchain_versions and
// https://trac.macports.org/wiki/XcodeVersionInfo.
#  elif __has_warning("-Wc++98-compat-extra-semi") || \
      (defined(__apple_build_version__) && __apple_build_version__ >= 10010000)
#    define SIMDE_DETECT_CLANG_VERSION 70000
#  elif __has_warning("-Wpragma-pack")
#    define SIMDE_DETECT_CLANG_VERSION 60000
#  elif __has_warning("-Wbitfield-enum-conversion")
#    define SIMDE_DETECT_CLANG_VERSION 50000
#  elif __has_attribute(diagnose_if)
#    define SIMDE_DETECT_CLANG_VERSION 40000
#  elif __has_warning("-Wcomma")
#    define SIMDE_DETECT_CLANG_VERSION 39000
#  elif __has_warning("-Wdouble-promotion")
#    define SIMDE_DETECT_CLANG_VERSION 38000
#  elif __has_warning("-Wshift-negative-value")
#    define SIMDE_DETECT_CLANG_VERSION 37000
#  elif __has_warning("-Wambiguous-ellipsis")
#    define SIMDE_DETECT_CLANG_VERSION 36000
#  else
#    define SIMDE_DETECT_CLANG_VERSION 1
#  endif
#endif /* defined(__clang__) && !defined(SIMDE_DETECT_CLANG_VERSION) */

/* The SIMDE_DETECT_CLANG_VERSION_CHECK macro is pretty
 * straightforward; it returns true if the compiler is a derivative
 * of clang >= the specified version.
 *
 * Since this file is often (primarily?) useful for working around bugs
 * it is also helpful to have a macro which returns true if only if the
 * compiler is a version of clang *older* than the specified version to
 * make it a bit easier to ifdef regions to add code for older versions,
 * such as pragmas to disable a specific warning. */

#if defined(SIMDE_DETECT_CLANG_VERSION)
#  define SIMDE_DETECT_CLANG_VERSION_CHECK(major, minor, revision) (SIMDE_DETECT_CLANG_VERSION >= ((major * 10000) + (minor * 1000) + (revision)))
#  define SIMDE_DETECT_CLANG_VERSION_NOT(major, minor, revision) (SIMDE_DETECT_CLANG_VERSION < ((major * 10000) + (minor * 1000) + (revision)))
#else
#  define SIMDE_DETECT_CLANG_VERSION_CHECK(major, minor, revision) (0)
#  define SIMDE_DETECT_CLANG_VERSION_NOT(major, minor, revision) (0)
#endif

#endif /* !defined(SIMDE_DETECT_CLANG_H) */
/* :: End simde/simde-detect-clang.h :: */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/simde-arch.h :: */
/* Architecture detection
 * Created by Evan Nemerson <evan@nemerson.com>
 *
 *   To the extent possible under law, the authors have waived all
 *   copyright and related or neighboring rights to this code.  For
 *   details, see the Creative Commons Zero 1.0 Universal license at
 *   <https://creativecommons.org/publicdomain/zero/1.0/>
 *
 * SPDX-License-Identifier: CC0-1.0
 *
 * Different compilers define different preprocessor macros for the
 * same architecture.  This is an attempt to provide a single
 * interface which is usable on any compiler.
 *
 * In general, a macro named SIMDE_ARCH_* is defined for each
 * architecture the CPU supports.  When there are multiple possible
 * versions, we try to define the macro to the target version.  For
 * example, if you want to check for i586+, you could do something
 * like:
 *
 *   #if defined(SIMDE_ARCH_X86) && (SIMDE_ARCH_X86 >= 5)
 *   ...
 *   #endif
 *
 * You could also just check that SIMDE_ARCH_X86 >= 5 without checking
 * if it's defined first, but some compilers may emit a warning about
 * an undefined macro being used (e.g., GCC with -Wundef).
 *
 * This was originally created for SIMDe
 * <https://github.com/simd-everywhere/simde> (hence the prefix), but this
 * header has no dependencies and may be used anywhere.  It is
 * originally based on information from
 * <https://sourceforge.net/p/predef/wiki/Architectures/>, though it
 * has been enhanced with additional information.
 *
 * If you improve this file, or find a bug, please file the issue at
 * <https://github.com/simd-everywhere/simde/issues>.  If you copy this into
 * your project, even if you change the prefix, please keep the links
 * to SIMDe intact so others know where to report issues, submit
 * enhancements, and find the latest version. */

#if !defined(SIMDE_ARCH_H)
#define SIMDE_ARCH_H

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */

/* Alpha
   <https://en.wikipedia.org/wiki/DEC_Alpha> */
#if defined(__alpha__) || defined(__alpha) || defined(_M_ALPHA)
#  if defined(__alpha_ev6__)
#    define SIMDE_ARCH_ALPHA 6
#  elif defined(__alpha_ev5__)
#    define SIMDE_ARCH_ALPHA 5
#  elif defined(__alpha_ev4__)
#    define SIMDE_ARCH_ALPHA 4
#  else
#    define SIMDE_ARCH_ALPHA 1
#  endif
#endif
#if defined(SIMDE_ARCH_ALPHA)
#  define SIMDE_ARCH_ALPHA_CHECK(version) ((version) <= SIMDE_ARCH_ALPHA)
#else
#  define SIMDE_ARCH_ALPHA_CHECK(version) (0)
#endif

/* Atmel AVR
   <https://en.wikipedia.org/wiki/Atmel_AVR> */
#if defined(__AVR_ARCH__)
#  define SIMDE_ARCH_AVR __AVR_ARCH__
#endif

/* AMD64 / x86_64
   <https://en.wikipedia.org/wiki/X86-64> */
#if defined(__amd64__) || defined(__amd64) || defined(__x86_64__) || defined(__x86_64) || defined(_M_X64) || defined(_M_AMD64)
#  if !defined(_M_ARM64EC)
#     define SIMDE_ARCH_AMD64 1000
#  endif
#endif

/* ARM
   <https://en.wikipedia.org/wiki/ARM_architecture> */
#if defined(__ARM_ARCH)
#  if __ARM_ARCH > 100
#    define SIMDE_ARCH_ARM (__ARM_ARCH)
#  else
#    define SIMDE_ARCH_ARM (__ARM_ARCH * 100)
#  endif
#elif defined(_M_ARM)
#  if _M_ARM > 100
#    define SIMDE_ARCH_ARM (_M_ARM)
#  else
#    define SIMDE_ARCH_ARM (_M_ARM * 100)
#  endif
#elif defined(_M_ARM64) || defined(_M_ARM64EC)
#  define SIMDE_ARCH_ARM 800
#elif defined(__arm__) || defined(__thumb__) || defined(__TARGET_ARCH_ARM) || defined(_ARM) || defined(_M_ARM) || defined(_M_ARM)
#  define SIMDE_ARCH_ARM 1
#endif
#if defined(SIMDE_ARCH_ARM)
#  define SIMDE_ARCH_ARM_CHECK(major, minor) (((major * 100) + (minor)) <= SIMDE_ARCH_ARM)
#else
#  define SIMDE_ARCH_ARM_CHECK(major, minor) (0)
#endif

/* AArch64
   <https://en.wikipedia.org/wiki/ARM_architecture> */
#if defined(__aarch64__) || defined(_M_ARM64) || defined(_M_ARM64EC)
#  define SIMDE_ARCH_AARCH64 1000
#endif
#if defined(SIMDE_ARCH_AARCH64)
#  define SIMDE_ARCH_AARCH64_CHECK(version) ((version) <= SIMDE_ARCH_AARCH64)
#else
#  define SIMDE_ARCH_AARCH64_CHECK(version) (0)
#endif

/* ARM SIMD ISA extensions */
#if defined(__ARM_NEON) || defined(SIMDE_ARCH_AARCH64)
#  if defined(SIMDE_ARCH_AARCH64)
#    define SIMDE_ARCH_ARM_NEON SIMDE_ARCH_AARCH64
#  elif defined(SIMDE_ARCH_ARM)
#    define SIMDE_ARCH_ARM_NEON SIMDE_ARCH_ARM
#  endif
#endif
#if defined(__ARM_FEATURE_AES) && __ARM_FEATURE_AES
#  define SIMDE_ARCH_ARM_AES
#endif
#if defined(__ARM_FEATURE_COMPLEX) && __ARM_FEATURE_COMPLEX
#  define SIMDE_ARCH_ARM_COMPLEX
#endif
#if defined(__ARM_FEATURE_CRYPTO) && __ARM_FEATURE_CRYPTO
#  define SIMDE_ARCH_ARM_CRYPTO
#endif
#if defined(__ARM_FEATURE_DOTPROD) && __ARM_FEATURE_DOTPROD
#  define SIMDE_ARCH_ARM_DOTPROD
#endif
#if defined(__ARM_FEATURE_FMA) && __ARM_FEATURE_FMA
#  define SIMDE_ARCH_ARM_FMA
#endif
#if defined(__ARM_FEATURE_FP16_FML) && __ARM_FEATURE_FP16_FML
#  define SIMDE_ARCH_ARM_FP16_FML
#endif
#if defined(__ARM_FEATURE_FRINT) && __ARM_FEATURE_FRINT
#  define SIMDE_ARCH_ARM_FRINT
#endif
#if defined(__ARM_FEATURE_MATMUL_INT8) && __ARM_FEATURE_MATMUL_INT8
#  define SIMDE_ARCH_ARM_MATMUL_INT8
#endif
#if defined(__ARM_FEATURE_SHA2) && __ARM_FEATURE_SHA2 && !defined(__APPLE_CC__)
#  define SIMDE_ARCH_ARM_SHA2
#endif
#if defined(__ARM_FEATURE_SHA3) && __ARM_FEATURE_SHA3
#  define SIMDE_ARCH_ARM_SHA3
#endif
#if defined(__ARM_FEATURE_SHA512) && __ARM_FEATURE_SHA512
#  define SIMDE_ARCH_ARM_SHA512
#endif
#if defined(__ARM_FEATURE_SM3) && __ARM_FEATURE_SM3
#  define SIMDE_ARCH_ARM_SM3
#endif
#if defined(__ARM_FEATURE_SM4) && __ARM_FEATURE_SM4
#  define SIMDE_ARCH_ARM_SM4
#endif
#if defined(__ARM_FEATURE_SVE) && __ARM_FEATURE_SVE
#  define SIMDE_ARCH_ARM_SVE
#endif
#if defined(__ARM_FEATURE_QRDMX) && __ARM_FEATURE_QRDMX
#  define SIMDE_ARCH_ARM_QRDMX
#endif

/* Blackfin
   <https://en.wikipedia.org/wiki/Blackfin> */
#if defined(__bfin) || defined(__BFIN__) || defined(__bfin__)
#  define SIMDE_ARCH_BLACKFIN 1
#endif

/* CRIS
   <https://en.wikipedia.org/wiki/ETRAX_CRIS> */
#if defined(__CRIS_arch_version)
#  define SIMDE_ARCH_CRIS __CRIS_arch_version
#elif defined(__cris__) || defined(__cris) || defined(__CRIS) || defined(__CRIS__)
#  define SIMDE_ARCH_CRIS 1
#endif

/* Convex
   <https://en.wikipedia.org/wiki/Convex_Computer> */
#if defined(__convex_c38__)
#  define SIMDE_ARCH_CONVEX 38
#elif defined(__convex_c34__)
#  define SIMDE_ARCH_CONVEX 34
#elif defined(__convex_c32__)
#  define SIMDE_ARCH_CONVEX 32
#elif defined(__convex_c2__)
#  define SIMDE_ARCH_CONVEX 2
#elif defined(__convex__)
#  define SIMDE_ARCH_CONVEX 1
#endif
#if defined(SIMDE_ARCH_CONVEX)
#  define SIMDE_ARCH_CONVEX_CHECK(version) ((version) <= SIMDE_ARCH_CONVEX)
#else
#  define SIMDE_ARCH_CONVEX_CHECK(version) (0)
#endif

/* Adapteva Epiphany
   <https://en.wikipedia.org/wiki/Adapteva_Epiphany> */
#if defined(__epiphany__)
#  define SIMDE_ARCH_EPIPHANY 1
#endif

/* Fujitsu FR-V
   <https://en.wikipedia.org/wiki/FR-V_(microprocessor)> */
#if defined(__frv__)
#  define SIMDE_ARCH_FRV 1
#endif

/* H8/300
   <https://en.wikipedia.org/wiki/H8_Family> */
#if defined(__H8300__)
#  define SIMDE_ARCH_H8300
#endif

/* Elbrus (8S, 8SV and successors)
   <https://en.wikipedia.org/wiki/Elbrus-8S> */
#if defined(__e2k__)
#  define SIMDE_ARCH_E2K
#endif

/* HP/PA / PA-RISC
   <https://en.wikipedia.org/wiki/PA-RISC> */
#if defined(__PA8000__) || defined(__HPPA20__) || defined(__RISC2_0__) || defined(_PA_RISC2_0)
#  define SIMDE_ARCH_HPPA 20
#elif defined(__PA7100__) || defined(__HPPA11__) || defined(_PA_RISC1_1)
#  define SIMDE_ARCH_HPPA 11
#elif defined(_PA_RISC1_0)
#  define SIMDE_ARCH_HPPA 10
#elif defined(__hppa__) || defined(__HPPA__) || defined(__hppa)
#  define SIMDE_ARCH_HPPA 1
#endif
#if defined(SIMDE_ARCH_HPPA)
#  define SIMDE_ARCH_HPPA_CHECK(version) ((version) <= SIMDE_ARCH_HPPA)
#else
#  define SIMDE_ARCH_HPPA_CHECK(version) (0)
#endif

/* x86
   <https://en.wikipedia.org/wiki/X86> */
#if defined(_M_IX86)
#  define SIMDE_ARCH_X86 (_M_IX86 / 100)
#elif defined(__I86__)
#  define SIMDE_ARCH_X86 __I86__
#elif defined(i686) || defined(__i686) || defined(__i686__)
#  define SIMDE_ARCH_X86 6
#elif defined(i586) || defined(__i586) || defined(__i586__)
#  define SIMDE_ARCH_X86 5
#elif defined(i486) || defined(__i486) || defined(__i486__)
#  define SIMDE_ARCH_X86 4
#elif defined(i386) || defined(__i386) || defined(__i386__)
#  define SIMDE_ARCH_X86 3
#elif defined(_X86_) || defined(__X86__) || defined(__THW_INTEL__)
#  define SIMDE_ARCH_X86 3
#endif
#if defined(SIMDE_ARCH_X86)
#  define SIMDE_ARCH_X86_CHECK(version) ((version) <= SIMDE_ARCH_X86)
#else
#  define SIMDE_ARCH_X86_CHECK(version) (0)
#endif

/* SIMD ISA extensions for x86/x86_64 and Elbrus */
#if defined(SIMDE_ARCH_X86) || defined(SIMDE_ARCH_AMD64) || defined(SIMDE_ARCH_E2K)
#  if defined(_M_IX86_FP)
#    define SIMDE_ARCH_X86_MMX
#    if (_M_IX86_FP >= 1)
#      define SIMDE_ARCH_X86_SSE 1
#    endif
#    if (_M_IX86_FP >= 2)
#      define SIMDE_ARCH_X86_SSE2 1
#    endif
#  elif defined(_M_X64)
#    define SIMDE_ARCH_X86_SSE 1
#    define SIMDE_ARCH_X86_SSE2 1
#  else
#    if defined(__MMX__)
#      define SIMDE_ARCH_X86_MMX 1
#    endif
#    if defined(__SSE__)
#      define SIMDE_ARCH_X86_SSE 1
#    endif
#    if defined(__SSE2__)
#      define SIMDE_ARCH_X86_SSE2 1
#    endif
#  endif
#  if defined(__SSE3__)
#    define SIMDE_ARCH_X86_SSE3 1
#  endif
#  if defined(__SSSE3__)
#    define SIMDE_ARCH_X86_SSSE3 1
#  endif
#  if defined(__SSE4_1__)
#    define SIMDE_ARCH_X86_SSE4_1 1
#  endif
#  if defined(__SSE4_2__)
#    define SIMDE_ARCH_X86_SSE4_2 1
#  endif
#  if defined(__XOP__)
#    define SIMDE_ARCH_X86_XOP 1
#  endif
#  if defined(__AVX__)
#    define SIMDE_ARCH_X86_AVX 1
#    if !defined(SIMDE_ARCH_X86_SSE3)
#      define SIMDE_ARCH_X86_SSE3 1
#    endif
#    if !defined(SIMDE_ARCH_X86_SSE4_1)
#      define SIMDE_ARCH_X86_SSE4_1 1
#    endif
#    if !defined(SIMDE_ARCH_X86_SSE4_2)
#      define SIMDE_ARCH_X86_SSE4_2 1
#    endif
#  endif
#  if defined(__AVX2__)
#    define SIMDE_ARCH_X86_AVX2 1
#    if defined(_MSC_VER)
#      define SIMDE_ARCH_X86_FMA 1
#    endif
#  endif
#  if defined(__FMA__)
#    define SIMDE_ARCH_X86_FMA 1
#    if !defined(SIMDE_ARCH_X86_AVX)
#      define SIMDE_ARCH_X86_AVX 1
#    endif
#  endif
#  if defined(__AVX512VP2INTERSECT__)
#    define SIMDE_ARCH_X86_AVX512VP2INTERSECT 1
#  endif
#  if defined(__AVX512BITALG__)
#    define SIMDE_ARCH_X86_AVX512BITALG 1
#  endif
#  if defined(__AVX512VPOPCNTDQ__)
#    define SIMDE_ARCH_X86_AVX512VPOPCNTDQ 1
#  endif
#  if defined(__AVX512VBMI__)
#    define SIMDE_ARCH_X86_AVX512VBMI 1
#  endif
#  if defined(__AVX512VBMI2__)
#    define SIMDE_ARCH_X86_AVX512VBMI2 1
#  endif
#  if defined(__AVX512VNNI__)
#    define SIMDE_ARCH_X86_AVX512VNNI 1
#  endif
#  if defined(__AVX5124VNNIW__)
#    define SIMDE_ARCH_X86_AVX5124VNNIW 1
#  endif
#  if defined(__AVX512BW__)
#    define SIMDE_ARCH_X86_AVX512BW 1
#  endif
#  if defined(__AVX512BF16__)
#    define SIMDE_ARCH_X86_AVX512BF16 1
#  endif
#  if defined(__AVX512CD__)
#    define SIMDE_ARCH_X86_AVX512CD 1
#  endif
#  if defined(__AVX512DQ__)
#    define SIMDE_ARCH_X86_AVX512DQ 1
#  endif
#  if defined(__AVX512F__)
#    define SIMDE_ARCH_X86_AVX512F 1
#  endif
#  if defined(__AVX512VL__)
#    define SIMDE_ARCH_X86_AVX512VL 1
#  endif
#  if defined(__AVX512FP16__)
#    define SIMDE_ARCH_X86_AVX512FP16 1
#  endif
#  if defined(__GFNI__)
#    define SIMDE_ARCH_X86_GFNI 1
#  endif
#  if defined(__PCLMUL__)
#    define SIMDE_ARCH_X86_PCLMUL 1
#  endif
#  if defined(__VPCLMULQDQ__)
#    define SIMDE_ARCH_X86_VPCLMULQDQ 1
#  endif
#  if defined(__F16C__) || (defined(HEDLEY_MSVC_VERSION) && HEDLEY_MSVC_VERSION_CHECK(19,30,0) && defined(SIMDE_ARCH_X86_AVX2) )
#    define SIMDE_ARCH_X86_F16C 1
#  endif
#  if defined(__AES__)
#    define SIMDE_ARCH_X86_AES 1
#  endif
#endif

/* Itanium
   <https://en.wikipedia.org/wiki/Itanium> */
#if defined(__ia64__) || defined(_IA64) || defined(__IA64__) || defined(__ia64) || defined(_M_IA64) || defined(__itanium__)
#  define SIMDE_ARCH_IA64 1
#endif

/* Renesas M32R
   <https://en.wikipedia.org/wiki/M32R> */
#if defined(__m32r__) || defined(__M32R__)
#  define SIMDE_ARCH_M32R
#endif

/* Motorola 68000
   <https://en.wikipedia.org/wiki/Motorola_68000> */
#if defined(__mc68060__) || defined(__MC68060__)
#  define SIMDE_ARCH_M68K 68060
#elif defined(__mc68040__) || defined(__MC68040__)
#  define SIMDE_ARCH_M68K 68040
#elif defined(__mc68030__) || defined(__MC68030__)
#  define SIMDE_ARCH_M68K 68030
#elif defined(__mc68020__) || defined(__MC68020__)
#  define SIMDE_ARCH_M68K 68020
#elif defined(__mc68010__) || defined(__MC68010__)
#  define SIMDE_ARCH_M68K 68010
#elif defined(__mc68000__) || defined(__MC68000__)
#  define SIMDE_ARCH_M68K 68000
#endif
#if defined(SIMDE_ARCH_M68K)
#  define SIMDE_ARCH_M68K_CHECK(version) ((version) <= SIMDE_ARCH_M68K)
#else
#  define SIMDE_ARCH_M68K_CHECK(version) (0)
#endif

/* Xilinx MicroBlaze
   <https://en.wikipedia.org/wiki/MicroBlaze> */
#if defined(__MICROBLAZE__) || defined(__microblaze__)
#  define SIMDE_ARCH_MICROBLAZE
#endif

/* MIPS
   <https://en.wikipedia.org/wiki/MIPS_architecture> */
#if defined(_MIPS_ISA_MIPS64R2)
#  define SIMDE_ARCH_MIPS 642
#elif defined(_MIPS_ISA_MIPS64)
#  define SIMDE_ARCH_MIPS 640
#elif defined(_MIPS_ISA_MIPS32R2)
#  define SIMDE_ARCH_MIPS 322
#elif defined(_MIPS_ISA_MIPS32)
#  define SIMDE_ARCH_MIPS 320
#elif defined(_MIPS_ISA_MIPS4)
#  define SIMDE_ARCH_MIPS 4
#elif defined(_MIPS_ISA_MIPS3)
#  define SIMDE_ARCH_MIPS 3
#elif defined(_MIPS_ISA_MIPS2)
#  define SIMDE_ARCH_MIPS 2
#elif defined(_MIPS_ISA_MIPS1)
#  define SIMDE_ARCH_MIPS 1
#elif defined(_MIPS_ISA_MIPS) || defined(__mips) || defined(__MIPS__)
#  define SIMDE_ARCH_MIPS 1
#endif
#if defined(SIMDE_ARCH_MIPS)
#  define SIMDE_ARCH_MIPS_CHECK(version) ((version) <= SIMDE_ARCH_MIPS)
#else
#  define SIMDE_ARCH_MIPS_CHECK(version) (0)
#endif

#if defined(__mips_loongson_mmi)
#  define SIMDE_ARCH_MIPS_LOONGSON_MMI 1
#endif

#if defined(__mips_msa)
#  define SIMDE_ARCH_MIPS_MSA 1
#endif

/* Matsushita MN10300
   <https://en.wikipedia.org/wiki/MN103> */
#if defined(__MN10300__) || defined(__mn10300__)
#  define SIMDE_ARCH_MN10300 1
#endif

/* POWER
   <https://en.wikipedia.org/wiki/IBM_POWER_Instruction_Set_Architecture> */
#if defined(_M_PPC)
#  define SIMDE_ARCH_POWER _M_PPC
#elif defined(_ARCH_PWR9)
#  define SIMDE_ARCH_POWER 900
#elif defined(_ARCH_PWR8)
#  define SIMDE_ARCH_POWER 800
#elif defined(_ARCH_PWR7)
#  define SIMDE_ARCH_POWER 700
#elif defined(_ARCH_PWR6)
#  define SIMDE_ARCH_POWER 600
#elif defined(_ARCH_PWR5)
#  define SIMDE_ARCH_POWER 500
#elif defined(_ARCH_PWR4)
#  define SIMDE_ARCH_POWER 400
#elif defined(_ARCH_440) || defined(__ppc440__)
#  define SIMDE_ARCH_POWER 440
#elif defined(_ARCH_450) || defined(__ppc450__)
#  define SIMDE_ARCH_POWER 450
#elif defined(_ARCH_601) || defined(__ppc601__)
#  define SIMDE_ARCH_POWER 601
#elif defined(_ARCH_603) || defined(__ppc603__)
#  define SIMDE_ARCH_POWER 603
#elif defined(_ARCH_604) || defined(__ppc604__)
#  define SIMDE_ARCH_POWER 604
#elif defined(_ARCH_605) || defined(__ppc605__)
#  define SIMDE_ARCH_POWER 605
#elif defined(_ARCH_620) || defined(__ppc620__)
#  define SIMDE_ARCH_POWER 620
#elif defined(__powerpc) || defined(__powerpc__) || defined(__POWERPC__) || defined(__ppc__) || defined(__PPC__) || defined(_ARCH_PPC) || defined(__ppc)
#  define SIMDE_ARCH_POWER 1
#endif
#if defined(SIMDE_ARCH_POWER)
  #define SIMDE_ARCH_POWER_CHECK(version) ((version) <= SIMDE_ARCH_POWER)
#else
  #define SIMDE_ARCH_POWER_CHECK(version) (0)
#endif

#if defined(__ALTIVEC__)
#  define SIMDE_ARCH_POWER_ALTIVEC SIMDE_ARCH_POWER
  #define SIMDE_ARCH_POWER_ALTIVEC_CHECK(version) ((version) <= SIMDE_ARCH_POWER)
#else
  #define SIMDE_ARCH_POWER_ALTIVEC_CHECK(version) (0)
#endif

/* RISC-V
   <https://en.wikipedia.org/wiki/RISC-V> */
#if defined(__riscv) || defined(__riscv__)
#  if __riscv_xlen == 64
#     define SIMDE_ARCH_RISCV64
#  elif __riscv_xlen == 32
#     define SIMDE_ARCH_RISCV32
#  endif
#endif

/* RISC-V SIMD ISA extensions */
#if defined(__riscv_zve32x)
#  define SIMDE_ARCH_RISCV_ZVE32X 1
#endif
#if defined(__riscv_zve32f)
#  define SIMDE_ARCH_RISCV_ZVE32F 1
#endif
#if defined(__riscv_zve64x)
#  define SIMDE_ARCH_RISCV_ZVE64X 1
#endif
#if defined(__riscv_zve64f)
#  define SIMDE_ARCH_RISCV_ZVE64F 1
#endif
#if defined(__riscv_zve64d)
#  define SIMDE_ARCH_RISCV_ZVE64D 1
#endif
#if defined(__riscv_v)
#  define SIMDE_ARCH_RISCV_V 1
#endif
#if defined(__riscv_zvfh)
#  define SIMDE_ARCH_RISCV_ZVFH 1
#endif
#if defined(__riscv_zvfhmin)
#  define SIMDE_ARCH_RISCV_ZVFHMIN 1
#endif

/* SPARC
   <https://en.wikipedia.org/wiki/SPARC> */
#if defined(__sparc_v9__) || defined(__sparcv9)
#  define SIMDE_ARCH_SPARC 9
#elif defined(__sparc_v8__) || defined(__sparcv8)
#  define SIMDE_ARCH_SPARC 8
#elif defined(__sparc_v7__) || defined(__sparcv7)
#  define SIMDE_ARCH_SPARC 7
#elif defined(__sparc_v6__) || defined(__sparcv6)
#  define SIMDE_ARCH_SPARC 6
#elif defined(__sparc_v5__) || defined(__sparcv5)
#  define SIMDE_ARCH_SPARC 5
#elif defined(__sparc_v4__) || defined(__sparcv4)
#  define SIMDE_ARCH_SPARC 4
#elif defined(__sparc_v3__) || defined(__sparcv3)
#  define SIMDE_ARCH_SPARC 3
#elif defined(__sparc_v2__) || defined(__sparcv2)
#  define SIMDE_ARCH_SPARC 2
#elif defined(__sparc_v1__) || defined(__sparcv1)
#  define SIMDE_ARCH_SPARC 1
#elif defined(__sparc__) || defined(__sparc)
#  define SIMDE_ARCH_SPARC 1
#endif
#if defined(SIMDE_ARCH_SPARC)
  #define SIMDE_ARCH_SPARC_CHECK(version) ((version) <= SIMDE_ARCH_SPARC)
#else
  #define SIMDE_ARCH_SPARC_CHECK(version) (0)
#endif

/* SuperH
   <https://en.wikipedia.org/wiki/SuperH> */
#if defined(__sh5__) || defined(__SH5__)
#  define SIMDE_ARCH_SUPERH 5
#elif defined(__sh4__) || defined(__SH4__)
#  define SIMDE_ARCH_SUPERH 4
#elif defined(__sh3__) || defined(__SH3__)
#  define SIMDE_ARCH_SUPERH 3
#elif defined(__sh2__) || defined(__SH2__)
#  define SIMDE_ARCH_SUPERH 2
#elif defined(__sh1__) || defined(__SH1__)
#  define SIMDE_ARCH_SUPERH 1
#elif defined(__sh__) || defined(__SH__)
#  define SIMDE_ARCH_SUPERH 1
#endif

/* IBM System z
   <https://en.wikipedia.org/wiki/IBM_System_z> */
#if defined(__370__) || defined(__THW_370__) || defined(__s390__) || defined(__s390x__) || defined(__zarch__) || defined(__SYSC_ZARCH__)
#  define SIMDE_ARCH_ZARCH __ARCH__
#endif
#if defined(SIMDE_ARCH_ZARCH)
  #define SIMDE_ARCH_ZARCH_CHECK(version) ((version) <= SIMDE_ARCH_ZARCH)
#else
  #define SIMDE_ARCH_ZARCH_CHECK(version) (0)
#endif

#if defined(SIMDE_ARCH_ZARCH) && defined(__VEC__)
  #define SIMDE_ARCH_ZARCH_ZVECTOR SIMDE_ARCH_ZARCH
#endif

/* TMS320 DSP
   <https://en.wikipedia.org/wiki/Texas_Instruments_TMS320> */
#if defined(_TMS320C6740) || defined(__TMS320C6740__)
#  define SIMDE_ARCH_TMS320 6740
#elif defined(_TMS320C6700_PLUS) || defined(__TMS320C6700_PLUS__)
#  define SIMDE_ARCH_TMS320 6701
#elif defined(_TMS320C6700) || defined(__TMS320C6700__)
#  define SIMDE_ARCH_TMS320 6700
#elif defined(_TMS320C6600) || defined(__TMS320C6600__)
#  define SIMDE_ARCH_TMS320 6600
#elif defined(_TMS320C6400_PLUS) || defined(__TMS320C6400_PLUS__)
#  define SIMDE_ARCH_TMS320 6401
#elif defined(_TMS320C6400) || defined(__TMS320C6400__)
#  define SIMDE_ARCH_TMS320 6400
#elif defined(_TMS320C6200) || defined(__TMS320C6200__)
#  define SIMDE_ARCH_TMS320 6200
#elif defined(_TMS320C55X) || defined(__TMS320C55X__)
#  define SIMDE_ARCH_TMS320 550
#elif defined(_TMS320C54X) || defined(__TMS320C54X__)
#  define SIMDE_ARCH_TMS320 540
#elif defined(_TMS320C28X) || defined(__TMS320C28X__)
#  define SIMDE_ARCH_TMS320 280
#endif
#if defined(SIMDE_ARCH_TMS320)
  #define SIMDE_ARCH_TMS320_CHECK(version) ((version) <= SIMDE_ARCH_TMS320)
#else
  #define SIMDE_ARCH_TMS320_CHECK(version) (0)
#endif

/* WebAssembly */
#if defined(__wasm__)
#  define SIMDE_ARCH_WASM 1
#endif

#if defined(SIMDE_ARCH_WASM) && defined(__wasm_simd128__)
#  define SIMDE_ARCH_WASM_SIMD128
#endif

#if defined(SIMDE_ARCH_WASM) && defined(__wasm_relaxed_simd__)
#  define SIMDE_ARCH_WASM_RELAXED_SIMD
#endif

/* Xtensa
   <https://en.wikipedia.org/wiki/> */
#if defined(__xtensa__) || defined(__XTENSA__)
#  define SIMDE_ARCH_XTENSA 1
#endif

/* Availability of 16-bit floating-point arithmetic intrinsics */
#if defined(__ARM_FEATURE_FP16_VECTOR_ARITHMETIC)
#  define SIMDE_ARCH_ARM_NEON_FP16
#endif

/* Availability of 16-bit brain floating-point arithmetic intrinsics */
#if defined(__ARM_FEATURE_BF16_VECTOR_ARITHMETIC)
#  define SIMDE_ARCH_ARM_NEON_BF16
#endif

/* LoongArch
   <https://en.wikipedia.org/wiki/Loongson#LoongArch> */
#if defined(__loongarch32)
#  define SIMDE_ARCH_LOONGARCH 1
#elif defined(__loongarch64)
#  define SIMDE_ARCH_LOONGARCH 2
#endif

/* LSX: LoongArch 128-bits SIMD extension */
#if defined(__loongarch_sx)
#  define SIMDE_ARCH_LOONGARCH_LSX 1
#endif

/* LASX: LoongArch 256-bits SIMD extension */
#if defined(__loongarch_asx)
#  define SIMDE_ARCH_LOONGARCH_LASX 2
#endif

#endif /* !defined(SIMDE_ARCH_H) */
/* :: End simde/simde-arch.h :: */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/simde-features.h :: */
/* SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Copyright:
 *   2020      Evan Nemerson <evan@nemerson.com>
 *   2023      Ju-Hung Li <jhlee@pllab.cs.nthu.edu.tw> (Copyright owned by NTHU pllab)
 */

/* simde-arch.h is used to determine which features are available according
   to the compiler.  However, we want to make it possible to forcibly enable
   or disable APIs */

#if !defined(SIMDE_FEATURES_H)
#define SIMDE_FEATURES_H

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/simde-diagnostic.h :: */
/* SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Copyright:
 *   2017-2020 Evan Nemerson <evan@nemerson.com>
 */

/* SIMDe targets a very wide range of standards and compilers, and our
 * goal is to compile cleanly even with extremely aggressive warnings
 * (i.e., -Weverything in clang, -Wextra in GCC, /W4 for MSVC, etc.)
 * treated as errors.
 *
 * While our preference is to resolve the underlying issue a given
 * diagnostic is warning us about, sometimes that's not possible.
 * Fixing a warning in one compiler may cause problems in another.
 * Sometimes a warning doesn't really apply to us (false positives),
 * and sometimes adhering to a warning would mean dropping a feature
 * we *know* the compiler supports since we have tested specifically
 * for the compiler or feature.
 *
 * When practical, warnings are only disabled for specific code.  For
 * a list of warnings which are enabled by default in all SIMDe code,
 * see SIMDE_DISABLE_UNWANTED_DIAGNOSTICS.  Note that we restore the
 * warning stack when SIMDe is done parsing, so code which includes
 * SIMDe is not deprived of these warnings.
 */

#if !defined(SIMDE_DIAGNOSTIC_H)
#define SIMDE_DIAGNOSTIC_H

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */

/* This is only to help us implement functions like _mm_undefined_ps. */
#if defined(SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_)
  #undef SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_
#endif
#if HEDLEY_HAS_WARNING("-Wuninitialized")
  #define SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_ _Pragma("clang diagnostic ignored \"-Wuninitialized\"")
#elif HEDLEY_GCC_VERSION_CHECK(4,2,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_ _Pragma("GCC diagnostic ignored \"-Wuninitialized\"")
#elif HEDLEY_PGI_VERSION_CHECK(19,10,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_ _Pragma("diag_suppress 549")
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,14,0) && defined(__cplusplus)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_ _Pragma("error_messages(off,SEC_UNINITIALIZED_MEM_READ,SEC_UNDEFINED_RETURN_VALUE,unassigned)")
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,14,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_ _Pragma("error_messages(off,SEC_UNINITIALIZED_MEM_READ,SEC_UNDEFINED_RETURN_VALUE)")
#elif HEDLEY_SUNPRO_VERSION_CHECK(5,12,0) && defined(__cplusplus)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_ _Pragma("error_messages(off,unassigned)")
#elif \
     HEDLEY_TI_VERSION_CHECK(16,9,9) || \
     HEDLEY_TI_CL6X_VERSION_CHECK(8,0,0) || \
     HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
     HEDLEY_TI_CLPRU_VERSION_CHECK(2,3,2)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_ _Pragma("diag_suppress 551")
#elif HEDLEY_INTEL_VERSION_CHECK(13,0,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_ _Pragma("warning(disable:592)")
#elif HEDLEY_MSVC_VERSION_CHECK(19,0,0) && !defined(__MSVC_RUNTIME_CHECKS)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNINITIALIZED_ __pragma(warning(disable:4700))
#endif

/* GCC emits a lot of "notes" about the ABI being different for things
 * in newer versions of GCC.  We don't really care because all our
 * functions are inlined and don't generate ABI. */
#if HEDLEY_GCC_VERSION_CHECK(7,0,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_PSABI_ _Pragma("GCC diagnostic ignored \"-Wpsabi\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_PSABI_
#endif

/* Since MMX uses x87 FP registers, you're supposed to call _mm_empty()
 * after each MMX function before any floating point instructions.
 * Some compilers warn about functions which use MMX functions but
 * don't call _mm_empty().  However, since SIMDe is implementyng the
 * MMX API we shouldn't be calling _mm_empty(); we leave it to the
 * caller to invoke simde_mm_empty(). */
#if HEDLEY_INTEL_VERSION_CHECK(19,0,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_NO_EMMS_INSTRUCTION_ _Pragma("warning(disable:13200 13203)")
#elif defined(HEDLEY_MSVC_VERSION)
  #define SIMDE_DIAGNOSTIC_DISABLE_NO_EMMS_INSTRUCTION_ __pragma(warning(disable:4799))
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_NO_EMMS_INSTRUCTION_
#endif

/* Intel is pushing people to use OpenMP SIMD instead of Cilk+, so they
 * emit a diagnostic if you use #pragma simd instead of
 * #pragma omp simd.  SIMDe supports OpenMP SIMD, you just need to
 * compile with -qopenmp or -qopenmp-simd and define
 * SIMDE_ENABLE_OPENMP.  Cilk+ is just a fallback. */
#if HEDLEY_INTEL_VERSION_CHECK(18,0,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_SIMD_PRAGMA_DEPRECATED_ _Pragma("warning(disable:3948)")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_SIMD_PRAGMA_DEPRECATED_
#endif

/* MSVC emits a diagnostic when we call a function (like
 * simde_mm_set_epi32) while initializing a struct.  We currently do
 * this a *lot* in the tests. */
#if \
  defined(HEDLEY_MSVC_VERSION)
  #define SIMDE_DIAGNOSTIC_DISABLE_NON_CONSTANT_AGGREGATE_INITIALIZER_ __pragma(warning(disable:4204))
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_NON_CONSTANT_AGGREGATE_INITIALIZER_
#endif

/* This warning needs a lot of work.  It is triggered if all you do is
 * pass the value to memcpy/__builtin_memcpy, or if you initialize a
 * member of the union, even if that member takes up the entire union.
 * Last tested with clang-10, hopefully things will improve in the
 * future; if clang fixes this I'd love to enable it. */
#if \
  HEDLEY_HAS_WARNING("-Wconditional-uninitialized")
  #define SIMDE_DIAGNOSTIC_DISABLE_CONDITIONAL_UNINITIALIZED_ _Pragma("clang diagnostic ignored \"-Wconditional-uninitialized\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_CONDITIONAL_UNINITIALIZED_
#endif

/* This warning is meant to catch things like `0.3 + 0.4 == 0.7`, which
 * will is false.  However, SIMDe uses these operations exclusively
 * for things like _mm_cmpeq_ps, for which we really do want to check
 * for equality (or inequality).
 *
 * If someone wants to put together a SIMDE_FLOAT_EQUAL(a, op, b) macro
 * which just wraps a check in some code do disable this diagnostic I'd
 * be happy to accept it. */
#if \
  HEDLEY_HAS_WARNING("-Wfloat-equal") || \
  HEDLEY_GCC_VERSION_CHECK(3,0,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_FLOAT_EQUAL_ _Pragma("GCC diagnostic ignored \"-Wfloat-equal\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_FLOAT_EQUAL_
#endif

/* This is because we use HEDLEY_STATIC_ASSERT for static assertions.
 * If Hedley can't find an implementation it will preprocess to
 * nothing, which means there will be a trailing semi-colon. */
#if HEDLEY_HAS_WARNING("-Wextra-semi")
  #define SIMDE_DIAGNOSTIC_DISABLE_EXTRA_SEMI_ _Pragma("clang diagnostic ignored \"-Wextra-semi\"")
#elif HEDLEY_GCC_VERSION_CHECK(8,1,0) && defined(__cplusplus)
  #define SIMDE_DIAGNOSTIC_DISABLE_EXTRA_SEMI_ _Pragma("GCC diagnostic ignored \"-Wextra-semi\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_EXTRA_SEMI_
#endif

/* We do use a few variadic macros, which technically aren't available
 * until C99 and C++11, but every compiler I'm aware of has supported
 * them for much longer.  That said, usage is isolated to the test
 * suite and compilers known to support them. */
#if HEDLEY_HAS_WARNING("-Wvariadic-macros") || HEDLEY_GCC_VERSION_CHECK(4,0,0)
  #if HEDLEY_HAS_WARNING("-Wc++98-compat-pedantic")
    #define SIMDE_DIAGNOSTIC_DISABLE_VARIADIC_MACROS_ \
      _Pragma("clang diagnostic ignored \"-Wvariadic-macros\"") \
      _Pragma("clang diagnostic ignored \"-Wc++98-compat-pedantic\"")
  #else
    #define SIMDE_DIAGNOSTIC_DISABLE_VARIADIC_MACROS_ _Pragma("GCC diagnostic ignored \"-Wvariadic-macros\"")
  #endif
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_VARIADIC_MACROS_
#endif

/* emscripten requires us to use a __wasm_unimplemented_simd128__ macro
 * before we can access certain SIMD intrinsics, but this diagnostic
 * warns about it being a reserved name.  It is a reserved name, but
 * it's reserved for the compiler and we are using it to convey
 * information to the compiler.
 *
 * This is also used when enabling native aliases since we don't get to
 * choose the macro names. */
#if HEDLEY_HAS_WARNING("-Wreserved-id-macro")
  #define SIMDE_DIAGNOSTIC_DISABLE_RESERVED_ID_MACRO_ _Pragma("clang diagnostic ignored \"-Wreserved-id-macro\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_RESERVED_ID_MACRO_
#endif

/* Similar to above; types like simde__m128i are reserved due to the
 * double underscore, but we didn't choose them, Intel did. */
#if HEDLEY_HAS_WARNING("-Wreserved-identifier")
  #define SIMDE_DIAGNOSTIC_DISABLE_RESERVED_ID_ _Pragma("clang diagnostic ignored \"-Wreserved-identifier\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_RESERVED_ID_
#endif

/* clang 3.8 warns about the packed attribute being unnecessary when
 * used in the _mm_loadu_* functions.  That *may* be true for version
 * 3.8, but for later versions it is crucial in order to make unaligned
 * access safe. */
#if HEDLEY_HAS_WARNING("-Wpacked")
  #define SIMDE_DIAGNOSTIC_DISABLE_PACKED_ _Pragma("clang diagnostic ignored \"-Wpacked\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_PACKED_
#endif

/* Triggered when assigning a float to a double implicitly.  We use
 * explicit casts in SIMDe, this is only used in the test suite. */
#if HEDLEY_HAS_WARNING("-Wdouble-promotion")
  #define SIMDE_DIAGNOSTIC_DISABLE_DOUBLE_PROMOTION_ _Pragma("clang diagnostic ignored \"-Wdouble-promotion\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_DOUBLE_PROMOTION_
#endif

/* Several compilers treat conformant array parameters as VLAs.  We
 * test to make sure we're in C mode (C++ doesn't support CAPs), and
 * that the version of the standard supports CAPs.  We also reject
 * some buggy compilers like MSVC (the logic is in Hedley if you want
 * to take a look), but with certain warnings enabled some compilers
 * still like to emit a diagnostic. */
#if HEDLEY_HAS_WARNING("-Wvla")
  #define SIMDE_DIAGNOSTIC_DISABLE_VLA_ _Pragma("clang diagnostic ignored \"-Wvla\"")
#elif HEDLEY_GCC_VERSION_CHECK(4,3,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_VLA_ _Pragma("GCC diagnostic ignored \"-Wvla\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_VLA_
#endif

/* If you add an unused attribute to a function and don't use it, clang
 * may emit this. */
#if HEDLEY_HAS_WARNING("-Wused-but-marked-unused")
  #define SIMDE_DIAGNOSTIC_DISABLE_USED_BUT_MARKED_UNUSED_ _Pragma("clang diagnostic ignored \"-Wused-but-marked-unused\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_USED_BUT_MARKED_UNUSED_
#endif

#if HEDLEY_HAS_WARNING("-Wpass-failed")
  #define SIMDE_DIAGNOSTIC_DISABLE_PASS_FAILED_ _Pragma("clang diagnostic ignored \"-Wpass-failed\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_PASS_FAILED_
#endif

#if HEDLEY_HAS_WARNING("-Wpadded")
  #define SIMDE_DIAGNOSTIC_DISABLE_PADDED_ _Pragma("clang diagnostic ignored \"-Wpadded\"")
#elif HEDLEY_MSVC_VERSION_CHECK(19,0,0) /* Likely goes back further */
  #define SIMDE_DIAGNOSTIC_DISABLE_PADDED_ __pragma(warning(disable:4324))
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_PADDED_
#endif

#if HEDLEY_HAS_WARNING("-Wzero-as-null-pointer-constant")
  #define SIMDE_DIAGNOSTIC_DISABLE_ZERO_AS_NULL_POINTER_CONSTANT_ _Pragma("clang diagnostic ignored \"-Wzero-as-null-pointer-constant\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_ZERO_AS_NULL_POINTER_CONSTANT_
#endif

#if HEDLEY_HAS_WARNING("-Wold-style-cast")
  #define SIMDE_DIAGNOSTIC_DISABLE_OLD_STYLE_CAST_ _Pragma("clang diagnostic ignored \"-Wold-style-cast\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_OLD_STYLE_CAST_
#endif

#if HEDLEY_HAS_WARNING("-Wcast-function-type") || HEDLEY_GCC_VERSION_CHECK(8,0,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_CAST_FUNCTION_TYPE_ _Pragma("GCC diagnostic ignored \"-Wcast-function-type\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_CAST_FUNCTION_TYPE_
#endif

/* clang will emit this warning when we use C99 extensions when not in
 * C99 mode, even though it does support this.  In such cases we check
 * the compiler and version first, so we know it's not a problem. */
#if HEDLEY_HAS_WARNING("-Wc99-extensions")
  #define SIMDE_DIAGNOSTIC_DISABLE_C99_EXTENSIONS_ _Pragma("clang diagnostic ignored \"-Wc99-extensions\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_C99_EXTENSIONS_
#endif

/* Similar problm as above; we rely on some basic C99 support, but clang
 * has started warning obut this even in C17 mode with -Weverything. */
#if HEDLEY_HAS_WARNING("-Wdeclaration-after-statement")
  #define SIMDE_DIAGNOSTIC_DISABLE_DECLARATION_AFTER_STATEMENT_ _Pragma("clang diagnostic ignored \"-Wdeclaration-after-statement\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_DECLARATION_AFTER_STATEMENT_
#endif

/* https://github.com/simd-everywhere/simde/issues/277 */
#if defined(HEDLEY_GCC_VERSION) && HEDLEY_GCC_VERSION_CHECK(4,6,0) && !HEDLEY_GCC_VERSION_CHECK(6,4,0) && defined(__cplusplus)
  #define SIMDE_DIAGNOSTIC_DISABLE_BUGGY_UNUSED_BUT_SET_VARIBALE_ _Pragma("GCC diagnostic ignored \"-Wunused-but-set-variable\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_BUGGY_UNUSED_BUT_SET_VARIBALE_
#endif

/* This is the warning that you normally define _CRT_SECURE_NO_WARNINGS
 * to silence, but you have to do that before including anything and
 * that would require reordering includes. */
#if defined(_MSC_VER)
  #define SIMDE_DIAGNOSTIC_DISABLE_ANNEX_K_ __pragma(warning(disable:4996))
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_ANNEX_K_
#endif

/* Some compilers, such as clang, may use `long long` for 64-bit
 * integers, but `long long` triggers a diagnostic with
 * -Wc++98-compat-pedantic which says 'long long' is incompatible with
 * C++98. */
#if HEDLEY_HAS_WARNING("-Wc++98-compat-pedantic")
  #if HEDLEY_HAS_WARNING("-Wc++11-long-long")
    #define SIMDE_DIAGNOSTIC_DISABLE_CPP98_COMPAT_PEDANTIC_ \
      _Pragma("clang diagnostic ignored \"-Wc++98-compat-pedantic\"") \
      _Pragma("clang diagnostic ignored \"-Wc++11-long-long\"")
  #else
    #define SIMDE_DIAGNOSTIC_DISABLE_CPP98_COMPAT_PEDANTIC_ _Pragma("clang diagnostic ignored \"-Wc++98-compat-pedantic\"")
  #endif
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_CPP98_COMPAT_PEDANTIC_
#endif

/* Some problem as above */
#if HEDLEY_HAS_WARNING("-Wc++11-long-long")
  #define SIMDE_DIAGNOSTIC_DISABLE_CPP11_LONG_LONG_ _Pragma("clang diagnostic ignored \"-Wc++11-long-long\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_CPP11_LONG_LONG_
#endif

/* emscripten emits this whenever stdin/stdout/stderr is used in a
 * macro. */
#if HEDLEY_HAS_WARNING("-Wdisabled-macro-expansion")
  #define SIMDE_DIAGNOSTIC_DISABLE_DISABLED_MACRO_EXPANSION_ _Pragma("clang diagnostic ignored \"-Wdisabled-macro-expansion\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_DISABLED_MACRO_EXPANSION_
#endif

/* Clang uses C11 generic selections to implement some AltiVec
 * functions, which triggers this diagnostic when not compiling
 * in C11 mode */
#if HEDLEY_HAS_WARNING("-Wc11-extensions")
  #define SIMDE_DIAGNOSTIC_DISABLE_C11_EXTENSIONS_ _Pragma("clang diagnostic ignored \"-Wc11-extensions\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_C11_EXTENSIONS_
#endif

/* Clang sometimes triggers this warning in macros in the AltiVec and
 * NEON headers, or due to missing functions. */
#if HEDLEY_HAS_WARNING("-Wvector-conversion")
  #define SIMDE_DIAGNOSTIC_DISABLE_VECTOR_CONVERSION_ _Pragma("clang diagnostic ignored \"-Wvector-conversion\"")
  /* For NEON, the situation with -Wvector-conversion in clang < 10 is
   * bad enough that we just disable the warning altogether.  On x86,
   * clang has similar issues on several sse4.2+ intrinsics before 3.8. */
  #if \
      (defined(SIMDE_ARCH_ARM) && SIMDE_DETECT_CLANG_VERSION_NOT(10,0,0)) || \
      SIMDE_DETECT_CLANG_VERSION_NOT(3,8,0)
    #define SIMDE_DIAGNOSTIC_DISABLE_BUGGY_VECTOR_CONVERSION_ SIMDE_DIAGNOSTIC_DISABLE_VECTOR_CONVERSION_
  #endif
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_VECTOR_CONVERSION_
#endif
#if !defined(SIMDE_DIAGNOSTIC_DISABLE_BUGGY_VECTOR_CONVERSION_)
  #define SIMDE_DIAGNOSTIC_DISABLE_BUGGY_VECTOR_CONVERSION_
#endif

/* Prior to 5.0, clang didn't support disabling diagnostics in
 * statement exprs.  As a result, some macros we use don't
 * properly silence warnings. */
#if SIMDE_DETECT_CLANG_VERSION_NOT(5,0,0) && HEDLEY_HAS_WARNING("-Wcast-qual") && HEDLEY_HAS_WARNING("-Wcast-align")
  #define SIMDE_DIAGNOSTIC_DISABLE_BUGGY_CASTS_ _Pragma("clang diagnostic ignored \"-Wcast-qual\"") _Pragma("clang diagnostic ignored \"-Wcast-align\"")
#elif SIMDE_DETECT_CLANG_VERSION_NOT(5,0,0) && HEDLEY_HAS_WARNING("-Wcast-qual")
  #define SIMDE_DIAGNOSTIC_DISABLE_BUGGY_CASTS_ _Pragma("clang diagnostic ignored \"-Wcast-qual\"")
#elif SIMDE_DETECT_CLANG_VERSION_NOT(5,0,0) && HEDLEY_HAS_WARNING("-Wcast-align")
  #define SIMDE_DIAGNOSTIC_DISABLE_BUGGY_CASTS_ _Pragma("clang diagnostic ignored \"-Wcast-align\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_BUGGY_CASTS_
#endif

/* SLEEF triggers this a *lot* in their headers */
#if HEDLEY_HAS_WARNING("-Wignored-qualifiers")
  #define SIMDE_DIAGNOSTIC_DISABLE_IGNORED_QUALIFIERS_ _Pragma("clang diagnostic ignored \"-Wignored-qualifiers\"")
#elif HEDLEY_GCC_VERSION_CHECK(4,3,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_IGNORED_QUALIFIERS_ _Pragma("GCC diagnostic ignored \"-Wignored-qualifiers\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_IGNORED_QUALIFIERS_
#endif

/* GCC emits this under some circumstances when using __int128 */
#if HEDLEY_GCC_VERSION_CHECK(4,8,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_PEDANTIC_ _Pragma("GCC diagnostic ignored \"-Wpedantic\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_PEDANTIC_
#endif

/* MSVC doesn't like (__assume(0), code) and will warn about code being
 * unreachable, but we want it there because not all compilers
 * understand the unreachable macro and will complain if it is missing.
 * I'm planning on adding a new macro to Hedley to handle this a bit
 * more elegantly, but until then... */
#if defined(HEDLEY_MSVC_VERSION)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNREACHABLE_ __pragma(warning(disable:4702))
#elif defined(__clang__)
  #define SIMDE_DIAGNOSTIC_DISABLE_UNREACHABLE_ HEDLEY_PRAGMA(clang diagnostic ignored "-Wunreachable-code")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_UNREACHABLE_
#endif

/* This is a false positive from GCC in a few places. */
#if HEDLEY_GCC_VERSION_CHECK(4,7,0)
  #define SIMDE_DIAGNOSTIC_DISABLE_MAYBE_UNINITIAZILED_ _Pragma("GCC diagnostic ignored \"-Wmaybe-uninitialized\"")
#else
  #define SIMDE_DIAGNOSTIC_DISABLE_MAYBE_UNINITIAZILED_
#endif

#if defined(SIMDE_ENABLE_NATIVE_ALIASES)
  #define SIMDE_DISABLE_UNWANTED_DIAGNOSTICS_NATIVE_ALIASES_ \
    SIMDE_DIAGNOSTIC_DISABLE_RESERVED_ID_MACRO_
#else
  #define SIMDE_DISABLE_UNWANTED_DIAGNOSTICS_NATIVE_ALIASES_
#endif

/* Some native functions on E2K with instruction set < v6 are declared
 * as deprecated due to inefficiency. Still they are more efficient
 * than SIMDe implementation. So we're using them, and switching off
 * these deprecation warnings. */
#if defined(HEDLEY_MCST_LCC_VERSION)
#  define SIMDE_LCC_DISABLE_DEPRECATED_WARNINGS _Pragma("diag_suppress 1215,1444")
#  define SIMDE_LCC_REVERT_DEPRECATED_WARNINGS _Pragma("diag_default 1215,1444")
#else
#  define SIMDE_LCC_DISABLE_DEPRECATED_WARNINGS
#  define SIMDE_LCC_REVERT_DEPRECATED_WARNINGS
#endif

#define SIMDE_DISABLE_UNWANTED_DIAGNOSTICS \
  HEDLEY_DIAGNOSTIC_DISABLE_UNUSED_FUNCTION \
  SIMDE_DISABLE_UNWANTED_DIAGNOSTICS_NATIVE_ALIASES_ \
  SIMDE_DIAGNOSTIC_DISABLE_PSABI_ \
  SIMDE_DIAGNOSTIC_DISABLE_NO_EMMS_INSTRUCTION_ \
  SIMDE_DIAGNOSTIC_DISABLE_SIMD_PRAGMA_DEPRECATED_ \
  SIMDE_DIAGNOSTIC_DISABLE_CONDITIONAL_UNINITIALIZED_ \
  SIMDE_DIAGNOSTIC_DISABLE_DECLARATION_AFTER_STATEMENT_ \
  SIMDE_DIAGNOSTIC_DISABLE_FLOAT_EQUAL_ \
  SIMDE_DIAGNOSTIC_DISABLE_NON_CONSTANT_AGGREGATE_INITIALIZER_ \
  SIMDE_DIAGNOSTIC_DISABLE_EXTRA_SEMI_ \
  SIMDE_DIAGNOSTIC_DISABLE_VLA_ \
  SIMDE_DIAGNOSTIC_DISABLE_USED_BUT_MARKED_UNUSED_ \
  SIMDE_DIAGNOSTIC_DISABLE_PASS_FAILED_ \
  SIMDE_DIAGNOSTIC_DISABLE_CPP98_COMPAT_PEDANTIC_ \
  SIMDE_DIAGNOSTIC_DISABLE_CPP11_LONG_LONG_ \
  SIMDE_DIAGNOSTIC_DISABLE_BUGGY_UNUSED_BUT_SET_VARIBALE_ \
  SIMDE_DIAGNOSTIC_DISABLE_BUGGY_CASTS_ \
  SIMDE_DIAGNOSTIC_DISABLE_BUGGY_VECTOR_CONVERSION_ \
  SIMDE_DIAGNOSTIC_DISABLE_RESERVED_ID_

#endif /* !defined(SIMDE_DIAGNOSTIC_H) */
/* :: End simde/simde-diagnostic.h :: */

#if !defined(SIMDE_X86_SVML_NATIVE) && !defined(SIMDE_X86_SVML_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_SVML)
    #define SIMDE_X86_SVML_NATIVE
  #endif
#endif

#if !defined(SIMDE_X86_AVX512VP2INTERSECT_NATIVE) && !defined(SIMDE_X86_AVX512VP2INTERSECT_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512VP2INTERSECT)
    #define SIMDE_X86_AVX512VP2INTERSECT_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512VP2INTERSECT_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512VPOPCNTDQ_NATIVE) && !defined(SIMDE_X86_AVX512VPOPCNTDQ_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512VPOPCNTDQ)
    #define SIMDE_X86_AVX512VPOPCNTDQ_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512VPOPCNTDQ_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512BITALG_NATIVE) && !defined(SIMDE_X86_AVX512BITALG_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512BITALG)
    #define SIMDE_X86_AVX512BITALG_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512BITALG_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512VBMI_NATIVE) && !defined(SIMDE_X86_AVX512VBMI_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512VBMI)
    #define SIMDE_X86_AVX512VBMI_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512VBMI_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512VBMI2_NATIVE) && !defined(SIMDE_X86_AVX512VBMI2_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512VBMI2)
    #define SIMDE_X86_AVX512VBMI2_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512VBMI2_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512VNNI_NATIVE) && !defined(SIMDE_X86_AVX512VNNI_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512VNNI)
    #define SIMDE_X86_AVX512VNNI_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512VNNI_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX5124VNNIW_NATIVE) && !defined(SIMDE_X86_AVX5124VNNIW_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX5124VNNIW)
    #define SIMDE_X86_AVX5124VNNIW_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX5124VNNIW_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512CD_NATIVE) && !defined(SIMDE_X86_AVX512CD_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512CD)
    #define SIMDE_X86_AVX512CD_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512CD_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512DQ_NATIVE) && !defined(SIMDE_X86_AVX512DQ_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512DQ)
    #define SIMDE_X86_AVX512DQ_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512DQ_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512VL_NATIVE) && !defined(SIMDE_X86_AVX512VL_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512VL)
    #define SIMDE_X86_AVX512VL_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512VL_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512BW_NATIVE) && !defined(SIMDE_X86_AVX512BW_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512BW)
    #define SIMDE_X86_AVX512BW_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512BW_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512FP16_NATIVE) && !defined(SIMDE_X86_AVX512FP16_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512FP16)
    #define SIMDE_X86_AVX512FP16_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512BW_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512BF16_NATIVE) && !defined(SIMDE_X86_AVX512BF16_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512BF16)
    #define SIMDE_X86_AVX512BF16_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512BF16_NATIVE) && !defined(SIMDE_X86_AVX512F_NATIVE)
  #define SIMDE_X86_AVX512F_NATIVE
#endif

#if !defined(SIMDE_X86_AVX512F_NATIVE) && !defined(SIMDE_X86_AVX512F_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX512F)
    #define SIMDE_X86_AVX512F_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX512F_NATIVE) && !defined(SIMDE_X86_AVX2_NATIVE)
  #define SIMDE_X86_AVX2_NATIVE
#endif

#if !defined(SIMDE_X86_FMA_NATIVE) && !defined(SIMDE_X86_FMA_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_FMA)
    #define SIMDE_X86_FMA_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_FMA_NATIVE) && !defined(SIMDE_X86_AVX_NATIVE)
  #define SIMDE_X86_AVX_NATIVE
#endif

#if !defined(SIMDE_X86_AVX2_NATIVE) && !defined(SIMDE_X86_AVX2_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX2)
    #define SIMDE_X86_AVX2_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX2_NATIVE) && !defined(SIMDE_X86_AVX_NATIVE)
  #define SIMDE_X86_AVX_NATIVE
#endif

#if !defined(SIMDE_X86_AVX_NATIVE) && !defined(SIMDE_X86_AVX_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AVX)
    #define SIMDE_X86_AVX_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AVX_NATIVE) && !defined(SIMDE_X86_SSE4_2_NATIVE)
  #define SIMDE_X86_SSE4_2_NATIVE
#endif

#if !defined(SIMDE_X86_XOP_NATIVE) && !defined(SIMDE_X86_XOP_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_XOP)
    #define SIMDE_X86_XOP_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_XOP_NATIVE) && !defined(SIMDE_X86_SSE4_2_NATIVE)
  #define SIMDE_X86_SSE4_2_NATIVE
#endif

#if !defined(SIMDE_X86_SSE4_2_NATIVE) && !defined(SIMDE_X86_SSE4_2_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_SSE4_2)
    #define SIMDE_X86_SSE4_2_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_SSE4_2_NATIVE) && !defined(SIMDE_X86_SSE4_1_NATIVE)
  #define SIMDE_X86_SSE4_1_NATIVE
#endif

#if !defined(SIMDE_X86_SSE4_1_NATIVE) && !defined(SIMDE_X86_SSE4_1_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_SSE4_1)
    #define SIMDE_X86_SSE4_1_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_SSE4_1_NATIVE) && !defined(SIMDE_X86_SSSE3_NATIVE)
  #define SIMDE_X86_SSSE3_NATIVE
#endif

#if !defined(SIMDE_X86_SSSE3_NATIVE) && !defined(SIMDE_X86_SSSE3_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_SSSE3)
    #define SIMDE_X86_SSSE3_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_SSSE3_NATIVE) && !defined(SIMDE_X86_SSE3_NATIVE)
  #define SIMDE_X86_SSE3_NATIVE
#endif

#if !defined(SIMDE_X86_SSE3_NATIVE) && !defined(SIMDE_X86_SSE3_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_SSE3)
    #define SIMDE_X86_SSE3_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_SSE3_NATIVE) && !defined(SIMDE_X86_SSE2_NATIVE)
  #define SIMDE_X86_SSE2_NATIVE
#endif

#if !defined(SIMDE_X86_AES_NATIVE) && !defined(SIMDE_X86_AES_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_AES)
    #define SIMDE_X86_AES_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_AES_NATIVE) && !defined(SIMDE_X86_SSE2_NATIVE)
  #define SIMDE_X86_SSE2_NATIVE
#endif

#if !defined(SIMDE_X86_SSE2_NATIVE) && !defined(SIMDE_X86_SSE2_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_SSE2)
    #define SIMDE_X86_SSE2_NATIVE
  #endif
#endif
#if defined(SIMDE_X86_SSE2_NATIVE) && !defined(SIMDE_X86_SSE_NATIVE)
  #define SIMDE_X86_SSE_NATIVE
#endif

#if !defined(SIMDE_X86_SSE_NATIVE) && !defined(SIMDE_X86_SSE_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_SSE)
    #define SIMDE_X86_SSE_NATIVE
  #endif
#endif

#if !defined(SIMDE_X86_MMX_NATIVE) && !defined(SIMDE_X86_MMX_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_MMX)
    #define SIMDE_X86_MMX_NATIVE
  #endif
#endif

#if !defined(SIMDE_X86_GFNI_NATIVE) && !defined(SIMDE_X86_GFNI_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_GFNI)
    #define SIMDE_X86_GFNI_NATIVE
  #endif
#endif

#if !defined(SIMDE_X86_PCLMUL_NATIVE) && !defined(SIMDE_X86_PCLMUL_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_PCLMUL)
    #define SIMDE_X86_PCLMUL_NATIVE
  #endif
#endif

#if !defined(SIMDE_X86_VPCLMULQDQ_NATIVE) && !defined(SIMDE_X86_VPCLMULQDQ_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_VPCLMULQDQ)
    #define SIMDE_X86_VPCLMULQDQ_NATIVE
  #endif
#endif

#if !defined(SIMDE_X86_F16C_NATIVE) && !defined(SIMDE_X86_F16C_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86_F16C)
    #define SIMDE_X86_F16C_NATIVE
  #endif
#endif

#if !defined(SIMDE_X86_SVML_NATIVE) && !defined(SIMDE_X86_SVML_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_X86) && (defined(__INTEL_COMPILER) || (HEDLEY_MSVC_VERSION_CHECK(14, 20, 0) && !defined(__clang__)))
    #define SIMDE_X86_SVML_NATIVE
  #endif
#endif

#if defined(HEDLEY_MSVC_VERSION)
  #pragma warning(push)
  #pragma warning(disable:4799)
#endif

#if \
    defined(SIMDE_X86_AVX_NATIVE) || defined(SIMDE_X86_GFNI_NATIVE) || defined(SIMDE_X86_SVML_NATIVE)
  #include <immintrin.h>
#elif defined(SIMDE_X86_SSE4_2_NATIVE)
  #include <nmmintrin.h>
#elif defined(SIMDE_X86_SSE4_1_NATIVE)
  #include <smmintrin.h>
#elif defined(SIMDE_X86_SSSE3_NATIVE)
  #include <tmmintrin.h>
#elif defined(SIMDE_X86_SSE3_NATIVE)
  #include <pmmintrin.h>
#elif defined(SIMDE_X86_SSE2_NATIVE)
  #include <emmintrin.h>
#elif defined(SIMDE_X86_SSE_NATIVE)
  #include <xmmintrin.h>
#elif defined(SIMDE_X86_MMX_NATIVE)
  #include <mmintrin.h>
#endif

#if defined(SIMDE_X86_XOP_NATIVE)
  #if defined(_MSC_VER)
    #include <intrin.h>
  #else
    #include <x86intrin.h>
  #endif
#endif

#if defined(SIMDE_X86_AES_NATIVE)
  #include <wmmintrin.h>
#endif

#if defined(HEDLEY_MSVC_VERSION)
  #pragma warning(pop)
#endif

#if !defined(SIMDE_ARM_NEON_A64V8_NATIVE) && !defined(SIMDE_ARM_NEON_A64V8_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_ARM_NEON) && defined(SIMDE_ARCH_AARCH64) && SIMDE_ARCH_ARM_CHECK(8,0)
    #define SIMDE_ARM_NEON_A64V8_NATIVE
  #endif
#endif
#if defined(SIMDE_ARM_NEON_A64V8_NATIVE) && !defined(SIMDE_ARM_NEON_A32V8_NATIVE)
  #define SIMDE_ARM_NEON_A32V8_NATIVE
#endif

#if !defined(SIMDE_ARM_NEON_A32V8_NATIVE) && !defined(SIMDE_ARM_NEON_A32V8_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_ARM_NEON) && SIMDE_ARCH_ARM_CHECK(8,0) && (__ARM_NEON_FP & 0x02)
    #define SIMDE_ARM_NEON_A32V8_NATIVE
  #endif
#endif
#if defined(__ARM_ACLE)
  #include <arm_acle.h>
#endif
#if defined(SIMDE_ARM_NEON_A32V8_NATIVE) && !defined(SIMDE_ARM_NEON_A32V7_NATIVE)
  #define SIMDE_ARM_NEON_A32V7_NATIVE
#endif

#if !defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_ARM_NEON_A32V7_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_ARM_NEON) && SIMDE_ARCH_ARM_CHECK(7,0)
    #define SIMDE_ARM_NEON_A32V7_NATIVE
  #endif
#endif
#if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
  #include <arm_neon.h>
  #if defined(__ARM_FEATURE_FP16_VECTOR_ARITHMETIC)
    #include <arm_fp16.h>
  #endif
#endif

#if !defined(SIMDE_ARM_SVE_NATIVE) && !defined(SIMDE_ARM_SVE_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_ARM_SVE)
    #define SIMDE_ARM_SVE_NATIVE
    #include <arm_sve.h>
  #endif
#endif

#if !defined(SIMDE_RISCV_V_NATIVE) && !defined(SIMDE_RISCV_V_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_RISCV_V)
    #define SIMDE_RISCV_V_NATIVE
  #endif
#endif
#if defined(SIMDE_RISCV_V_NATIVE)
  #include <riscv_vector.h>
#endif

#if !defined(SIMDE_WASM_SIMD128_NATIVE) && !defined(SIMDE_WASM_SIMD128_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_WASM_SIMD128)
    #define SIMDE_WASM_SIMD128_NATIVE
  #endif
#endif

#if !defined(SIMDE_WASM_RELAXED_SIMD_NATIVE) && !defined(SIMDE_WASM_RELAXED_SIMD_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_WASM_RELAXED_SIMD)
    #define SIMDE_WASM_RELAXED_SIMD_NATIVE
  #endif
#endif
#if defined(SIMDE_WASM_SIMD128_NATIVE) || defined(SIMDE_WASM_RELAXED_SIMD_NATIVE)
  #include <wasm_simd128.h>
#endif

#if !defined(SIMDE_POWER_ALTIVEC_P9_NATIVE) && !defined(SIMDE_POWER_ALTIVEC_P9_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if SIMDE_ARCH_POWER_ALTIVEC_CHECK(900)
    #define SIMDE_POWER_ALTIVEC_P9_NATIVE
  #endif
#endif
#if defined(SIMDE_POWER_ALTIVEC_P9_NATIVE) && !defined(SIMDE_POWER_ALTIVEC_P8)
  #define SIMDE_POWER_ALTIVEC_P8_NATIVE
#endif

#if !defined(SIMDE_POWER_ALTIVEC_P8_NATIVE) && !defined(SIMDE_POWER_ALTIVEC_P8_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if SIMDE_ARCH_POWER_ALTIVEC_CHECK(800)
    #define SIMDE_POWER_ALTIVEC_P8_NATIVE
  #endif
#endif
#if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE) && !defined(SIMDE_POWER_ALTIVEC_P7)
  #define SIMDE_POWER_ALTIVEC_P7_NATIVE
#endif

#if !defined(SIMDE_POWER_ALTIVEC_P7_NATIVE) && !defined(SIMDE_POWER_ALTIVEC_P7_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if SIMDE_ARCH_POWER_ALTIVEC_CHECK(700)
    #define SIMDE_POWER_ALTIVEC_P7_NATIVE
  #endif
#endif
#if defined(SIMDE_POWER_ALTIVEC_P7_NATIVE) && !defined(SIMDE_POWER_ALTIVEC_P6)
  #define SIMDE_POWER_ALTIVEC_P6_NATIVE
#endif

#if !defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) && !defined(SIMDE_POWER_ALTIVEC_P6_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if SIMDE_ARCH_POWER_ALTIVEC_CHECK(600)
    #define SIMDE_POWER_ALTIVEC_P6_NATIVE
  #endif
#endif
#if defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) && !defined(SIMDE_POWER_ALTIVEC_P5)
  #define SIMDE_POWER_ALTIVEC_P5_NATIVE
#endif

#if !defined(SIMDE_POWER_ALTIVEC_P5_NATIVE) && !defined(SIMDE_POWER_ALTIVEC_P5_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if SIMDE_ARCH_POWER_ALTIVEC_CHECK(500)
    #define SIMDE_POWER_ALTIVEC_P5_NATIVE
  #endif
#endif

#if !defined(SIMDE_ZARCH_ZVECTOR_15_NATIVE) && !defined(SIMDE_ZARCH_ZVECTOR_15_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if SIMDE_ARCH_ZARCH_CHECK(13) && defined(SIMDE_ARCH_ZARCH_ZVECTOR)
    #define SIMDE_ZARCH_ZVECTOR_15_NATIVE
  #endif
#endif

#if !defined(SIMDE_ZARCH_ZVECTOR_14_NATIVE) && !defined(SIMDE_ZARCH_ZVECTOR_14_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if SIMDE_ARCH_ZARCH_CHECK(12) && defined(SIMDE_ARCH_ZARCH_ZVECTOR)
    #define SIMDE_ZARCH_ZVECTOR_14_NATIVE
  #endif
#endif

#if !defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE) && !defined(SIMDE_ZARCH_ZVECTOR_13_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if SIMDE_ARCH_ZARCH_CHECK(11) && defined(SIMDE_ARCH_ZARCH_ZVECTOR)
    #define SIMDE_ZARCH_ZVECTOR_13_NATIVE
  #endif
#endif

#if defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
  /* AltiVec conflicts with lots of stuff.  The bool keyword conflicts
   * with the bool keyword in C++ and the bool macro in C99+ (defined
   * in stdbool.h).  The vector keyword conflicts with std::vector in
   * C++ if you are `using std;`.
   *
   * Luckily AltiVec allows you to use `__vector`/`__bool`/`__pixel`
   * instead, but altivec.h will unconditionally define
   * `vector`/`bool`/`pixel` so we need to work around that.
   *
   * Unfortunately this means that if your code uses AltiVec directly
   * it may break.  If this is the case you'll want to define
   * `SIMDE_POWER_ALTIVEC_NO_UNDEF` before including SIMDe.  Or, even
   * better, port your code to use the double-underscore versions. */
  #if defined(bool)
    #undef bool
  #endif

  #if defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
    #include <altivec.h>

    #if !defined(SIMDE_POWER_ALTIVEC_NO_UNDEF)
      #if defined(vector)
        #undef vector
      #endif
      #if defined(pixel)
        #undef pixel
      #endif
      #if defined(bool)
        #undef bool
      #endif
    #endif /* !defined(SIMDE_POWER_ALTIVEC_NO_UNDEF) */
  #elif defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
    #include <vecintrin.h>
  #endif

  /* Use these intsead of vector/pixel/bool in SIMDe. */
  #define SIMDE_POWER_ALTIVEC_VECTOR(T) __vector T
  #define SIMDE_POWER_ALTIVEC_PIXEL __pixel
  #define SIMDE_POWER_ALTIVEC_BOOL __bool

  /* Re-define bool if we're using stdbool.h */
  #if !defined(__cplusplus) && defined(__bool_true_false_are_defined) && !defined(SIMDE_POWER_ALTIVEC_NO_UNDEF)
    #define bool _Bool
  #endif
#endif

#if !defined(SIMDE_MIPS_LOONGSON_MMI_NATIVE) && !defined(SIMDE_MIPS_LOONGSON_MMI_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_MIPS_LOONGSON_MMI)
    #define SIMDE_MIPS_LOONGSON_MMI_NATIVE  1
  #endif
#endif
#if defined(SIMDE_MIPS_LOONGSON_MMI_NATIVE)
  #include <loongson-mmiintrin.h>
#endif

#if !defined(SIMDE_MIPS_MSA_NATIVE) && !defined(SIMDE_MIPS_MSA_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_MIPS_MSA)
    #define SIMDE_MIPS_MSA_NATIVE  1
  #endif
#endif
#if defined(SIMDE_MIPS_MSA_NATIVE)
  #include <msa.h>
#endif

/* This is used to determine whether or not to fall back on a vector
 * function in an earlier ISA extensions, as well as whether
 * we expected any attempts at vectorization to be fruitful or if we
 * expect to always be running serial code.
 *
 * Note that, for some architectures (okay, *one* architecture) there
 * can be a split where some types are supported for one vector length
 * but others only for a shorter length.  Therefore, it is possible to
 * provide separate values for float/int/double types. */

#if !defined(SIMDE_NATURAL_VECTOR_SIZE)
  #if defined(SIMDE_X86_AVX512F_NATIVE)
    #define SIMDE_NATURAL_VECTOR_SIZE (512)
  #elif defined(SIMDE_X86_AVX2_NATIVE)
    #define SIMDE_NATURAL_VECTOR_SIZE (256)
  #elif defined(SIMDE_X86_AVX_NATIVE)
    #define SIMDE_NATURAL_FLOAT_VECTOR_SIZE (256)
    #define SIMDE_NATURAL_INT_VECTOR_SIZE (128)
    #define SIMDE_NATURAL_DOUBLE_VECTOR_SIZE (128)
  #elif \
      defined(SIMDE_X86_SSE2_NATIVE) || \
      defined(SIMDE_ARM_NEON_A32V7_NATIVE) || \
      defined(SIMDE_WASM_SIMD128_NATIVE) || \
      defined(SIMDE_POWER_ALTIVEC_P5_NATIVE) || \
      defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE) || \
      defined(SIMDE_MIPS_MSA_NATIVE)
    #define SIMDE_NATURAL_VECTOR_SIZE (128)
  #elif defined(SIMDE_X86_SSE_NATIVE)
    #define SIMDE_NATURAL_FLOAT_VECTOR_SIZE (128)
    #define SIMDE_NATURAL_INT_VECTOR_SIZE (64)
    #define SIMDE_NATURAL_DOUBLE_VECTOR_SIZE (0)
  #elif defined(SIMDE_RISCV_V_NATIVE) && defined(__riscv_v_fixed_vlen)
        //FIXME : SIMDE_NATURAL_VECTOR_SIZE == __riscv_v_fixed_vlen
        #define SIMDE_NATURAL_VECTOR_SIZE (128)
  #endif

  #if !defined(SIMDE_NATURAL_VECTOR_SIZE)
    #if defined(SIMDE_NATURAL_FLOAT_VECTOR_SIZE)
      #define SIMDE_NATURAL_VECTOR_SIZE SIMDE_NATURAL_FLOAT_VECTOR_SIZE
    #elif defined(SIMDE_NATURAL_INT_VECTOR_SIZE)
      #define SIMDE_NATURAL_VECTOR_SIZE SIMDE_NATURAL_INT_VECTOR_SIZE
    #elif defined(SIMDE_NATURAL_DOUBLE_VECTOR_SIZE)
      #define SIMDE_NATURAL_VECTOR_SIZE SIMDE_NATURAL_DOUBLE_VECTOR_SIZE
    #else
      #define SIMDE_NATURAL_VECTOR_SIZE (0)
    #endif
  #endif

  #if !defined(SIMDE_NATURAL_FLOAT_VECTOR_SIZE)
    #define SIMDE_NATURAL_FLOAT_VECTOR_SIZE SIMDE_NATURAL_VECTOR_SIZE
  #endif
  #if !defined(SIMDE_NATURAL_INT_VECTOR_SIZE)
    #define SIMDE_NATURAL_INT_VECTOR_SIZE SIMDE_NATURAL_VECTOR_SIZE
  #endif
  #if !defined(SIMDE_NATURAL_DOUBLE_VECTOR_SIZE)
    #define SIMDE_NATURAL_DOUBLE_VECTOR_SIZE SIMDE_NATURAL_VECTOR_SIZE
  #endif
#endif

#define SIMDE_NATURAL_VECTOR_SIZE_LE(x) ((SIMDE_NATURAL_VECTOR_SIZE > 0) && (SIMDE_NATURAL_VECTOR_SIZE <= (x)))
#define SIMDE_NATURAL_VECTOR_SIZE_GE(x) ((SIMDE_NATURAL_VECTOR_SIZE > 0) && (SIMDE_NATURAL_VECTOR_SIZE >= (x)))
#define SIMDE_NATURAL_FLOAT_VECTOR_SIZE_LE(x) ((SIMDE_NATURAL_FLOAT_VECTOR_SIZE > 0) && (SIMDE_NATURAL_FLOAT_VECTOR_SIZE <= (x)))
#define SIMDE_NATURAL_FLOAT_VECTOR_SIZE_GE(x) ((SIMDE_NATURAL_FLOAT_VECTOR_SIZE > 0) && (SIMDE_NATURAL_FLOAT_VECTOR_SIZE >= (x)))
#define SIMDE_NATURAL_INT_VECTOR_SIZE_LE(x) ((SIMDE_NATURAL_INT_VECTOR_SIZE > 0) && (SIMDE_NATURAL_INT_VECTOR_SIZE <= (x)))
#define SIMDE_NATURAL_INT_VECTOR_SIZE_GE(x) ((SIMDE_NATURAL_INT_VECTOR_SIZE > 0) && (SIMDE_NATURAL_INT_VECTOR_SIZE >= (x)))
#define SIMDE_NATURAL_DOUBLE_VECTOR_SIZE_LE(x) ((SIMDE_NATURAL_DOUBLE_VECTOR_SIZE > 0) && (SIMDE_NATURAL_DOUBLE_VECTOR_SIZE <= (x)))
#define SIMDE_NATURAL_DOUBLE_VECTOR_SIZE_GE(x) ((SIMDE_NATURAL_DOUBLE_VECTOR_SIZE > 0) && (SIMDE_NATURAL_DOUBLE_VECTOR_SIZE >= (x)))

/* Native aliases */
#if defined(SIMDE_ENABLE_NATIVE_ALIASES)
  #if !defined(SIMDE_X86_MMX_NATIVE)
    #define SIMDE_X86_MMX_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_SSE_NATIVE)
    #define SIMDE_X86_SSE_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_SSE2_NATIVE)
    #define SIMDE_X86_SSE2_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_SSE3_NATIVE)
    #define SIMDE_X86_SSE3_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_SSSE3_NATIVE)
    #define SIMDE_X86_SSSE3_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_SSE4_1_NATIVE)
    #define SIMDE_X86_SSE4_1_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_SSE4_2_NATIVE)
    #define SIMDE_X86_SSE4_2_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX_NATIVE)
    #define SIMDE_X86_AVX_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX2_NATIVE)
    #define SIMDE_X86_AVX2_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_FMA_NATIVE)
    #define SIMDE_X86_FMA_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512F_NATIVE)
    #define SIMDE_X86_AVX512F_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512VL_NATIVE)
    #define SIMDE_X86_AVX512VL_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512VBMI_NATIVE)
    #define SIMDE_X86_AVX512VBMI_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512VBMI2_NATIVE)
    #define SIMDE_X86_AVX512VBMI2_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512BW_NATIVE)
    #define SIMDE_X86_AVX512BW_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512VNNI_NATIVE)
    #define SIMDE_X86_AVX512VNNI_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX5124VNNIW_NATIVE)
    #define SIMDE_X86_AVX5124VNNIW_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512BF16_NATIVE)
    #define SIMDE_X86_AVX512BF16_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512BITALG_NATIVE)
    #define SIMDE_X86_AVX512BITALG_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512VPOPCNTDQ_NATIVE)
    #define SIMDE_X86_AVX512VPOPCNTDQ_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512VP2INTERSECT_NATIVE)
    #define SIMDE_X86_AVX512VP2INTERSECT_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512DQ_NATIVE)
    #define SIMDE_X86_AVX512DQ_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512CD_NATIVE)
    #define SIMDE_X86_AVX512CD_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AVX512FP16_NATIVE)
    #define SIMDE_X86_AVX512FP16_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_GFNI_NATIVE)
    #define SIMDE_X86_GFNI_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_PCLMUL_NATIVE)
    #define SIMDE_X86_PCLMUL_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_VPCLMULQDQ_NATIVE)
    #define SIMDE_X86_VPCLMULQDQ_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_F16C_NATIVE)
    #define SIMDE_X86_F16C_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_AES_NATIVE)
    #define SIMDE_X86_AES_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_X86_SVML_NATIVE)
    #define SIMDE_X86_SVML_ENABLE_NATIVE_ALIASES
  #endif

  #if !defined(SIMDE_ARM_NEON_A32V7_NATIVE)
    #define SIMDE_ARM_NEON_A32V7_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_ARM_NEON_A32V8_NATIVE)
    #define SIMDE_ARM_NEON_A32V8_ENABLE_NATIVE_ALIASES
  #endif
  #if !defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    #define SIMDE_ARM_NEON_A64V8_ENABLE_NATIVE_ALIASES
  #endif

  #if !defined(SIMDE_ARM_SVE_NATIVE)
    #define SIMDE_ARM_SVE_ENABLE_NATIVE_ALIASES
  #endif

  #if !defined(SIMDE_RISCV_V_NATIVE)
    #define SIMDE_RISCV_V_ENABLE_NATIVE_ALIASES
  #endif

  #if !defined(SIMDE_MIPS_MSA_NATIVE)
    #define SIMDE_MIPS_MSA_ENABLE_NATIVE_ALIASES
  #endif

  #if !defined(SIMDE_WASM_SIMD128_NATIVE)
    #define SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES
  #endif
#endif

/* Are floating point values stored using IEEE 754?  Knowing
 * this at during preprocessing is a bit tricky, mostly because what
 * we're curious about is how values are stored and not whether the
 * implementation is fully conformant in terms of rounding, NaN
 * handling, etc.
 *
 * For example, if you use -ffast-math or -Ofast on
 * GCC or clang IEEE 754 isn't strictly followed, therefore IEE 754
 * support is not advertised (by defining __STDC_IEC_559__).
 *
 * However, what we care about is whether it is safe to assume that
 * floating point values are stored in IEEE 754 format, in which case
 * we can provide faster implementations of some functions.
 *
 * Luckily every vaugely modern architecture I'm aware of uses IEEE 754-
 * so we just assume IEEE 754 for now.  There is a test which verifies
 * this, if that test fails sowewhere please let us know and we'll add
 * an exception for that platform.  Meanwhile, you can define
 * SIMDE_NO_IEEE754_STORAGE. */
#if !defined(SIMDE_IEEE754_STORAGE) && !defined(SIMDE_NO_IEE754_STORAGE)
  #define SIMDE_IEEE754_STORAGE
#endif

#if defined(SIMDE_ARCH_ARM_NEON_FP16)
  #define SIMDE_ARM_NEON_FP16
#endif

#if defined(SIMDE_ARCH_ARM_NEON_BF16)
  #define SIMDE_ARM_NEON_BF16
#endif

#if !defined(SIMDE_LOONGARCH_LASX_NATIVE) && !defined(SIMDE_LOONGARCH_LASX_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_LOONGARCH_LASX)
    #define SIMDE_LOONGARCH_LASX_NATIVE
  #endif
#endif

#if !defined(SIMDE_LOONGARCH_LSX_NATIVE) && !defined(SIMDE_LOONGARCH_LSX_NO_NATIVE) && !defined(SIMDE_NO_NATIVE)
  #if defined(SIMDE_ARCH_LOONGARCH_LSX)
    #define SIMDE_LOONGARCH_LSX_NATIVE
  #endif
#endif

#if defined(SIMDE_LOONGARCH_LASX_NATIVE)
  #include <lasxintrin.h>
#endif
#if defined(SIMDE_LOONGARCH_LSX_NATIVE)
  #include <lsxintrin.h>
#endif

#endif /* !defined(SIMDE_FEATURES_H) */
/* :: End simde/simde-features.h :: */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/simde-math.h :: */
/* SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Copyright:
 *   2017-2020 Evan Nemerson <evan@nemerson.com>
 *   2023      Yi-Yen Chung <eric681@andestech.com> (Copyright owned by Andes Technology)
 */

/* Attempt to find math functions.  Functions may be in <cmath>,
 * <math.h>, compiler built-ins/intrinsics, or platform/architecture
 * specific headers.  In some cases, especially those not built in to
 * libm, we may need to define our own implementations. */

#if !defined(SIMDE_MATH_H)
#define SIMDE_MATH_H 1

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */

#include <stdint.h>
#if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
  #include <arm_neon.h>
#endif

HEDLEY_DIAGNOSTIC_PUSH
SIMDE_DISABLE_UNWANTED_DIAGNOSTICS

/* SLEEF support
 * https://sleef.org/
 *
 * If you include <sleef.h> prior to including SIMDe, SIMDe will use
 * SLEEF.  You can also define SIMDE_MATH_SLEEF_ENABLE prior to
 * including SIMDe to force the issue.
 *
 * Note that SLEEF does requires linking to libsleef.
 *
 * By default, SIMDe will use the 1 ULP functions, but if you use
 * SIMDE_ACCURACY_PREFERENCE of 0 we will use up to 4 ULP.  This is
 * only the case for the simde_math_* functions; for code in other
 * SIMDe headers which calls SLEEF directly we may use functions with
 * greater error if the API we're implementing is less precise (for
 * example, SVML guarantees 4 ULP, so we will generally use the 3.5
 * ULP functions from SLEEF). */
#if !defined(SIMDE_MATH_SLEEF_DISABLE)
  #if defined(__SLEEF_H__)
    #define SIMDE_MATH_SLEEF_ENABLE
  #endif
#endif

#if defined(SIMDE_MATH_SLEEF_ENABLE) && !defined(__SLEEF_H__)
  HEDLEY_DIAGNOSTIC_PUSH
  SIMDE_DIAGNOSTIC_DISABLE_IGNORED_QUALIFIERS_
  #include <sleef.h>
  HEDLEY_DIAGNOSTIC_POP
#endif

#if defined(SIMDE_MATH_SLEEF_ENABLE) && defined(__SLEEF_H__)
  #if defined(SLEEF_VERSION_MAJOR)
    #define SIMDE_MATH_SLEEF_VERSION_CHECK(major, minor, patch) (HEDLEY_VERSION_ENCODE(SLEEF_VERSION_MAJOR, SLEEF_VERSION_MINOR, SLEEF_VERSION_PATCHLEVEL) >= HEDLEY_VERSION_ENCODE(major, minor, patch))
  #else
    #define SIMDE_MATH_SLEEF_VERSION_CHECK(major, minor, patch) (HEDLEY_VERSION_ENCODE(3,0,0) >= HEDLEY_VERSION_ENCODE(major, minor, patch))
  #endif
#else
  #define SIMDE_MATH_SLEEF_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(__has_builtin)
  #define SIMDE_MATH_BUILTIN_LIBM(func) __has_builtin(__builtin_##func)
#elif \
    HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
    HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
    HEDLEY_GCC_VERSION_CHECK(4,4,0)
  #define SIMDE_MATH_BUILTIN_LIBM(func) (1)
#else
  #define SIMDE_MATH_BUILTIN_LIBM(func) (0)
#endif

#if defined(HUGE_VAL)
  /* Looks like <math.h> or <cmath> has already been included. */

  /* The math.h from libc++ (yes, the C header from the C++ standard
   * library) will define an isnan function, but not an isnan macro
   * like the C standard requires.  So we detect the header guards
   * macro libc++ uses. */
  #if defined(isnan) || (defined(_LIBCPP_MATH_H) && !defined(_LIBCPP_CMATH))
    #define SIMDE_MATH_HAVE_MATH_H
  #elif defined(__cplusplus)
    #define SIMDE_MATH_HAVE_CMATH
  #endif
#elif defined(__has_include)
  #if defined(__cplusplus) && (__cplusplus >= 201103L) && __has_include(<cmath>)
    #define SIMDE_MATH_HAVE_CMATH
    #include <cmath>
  #elif __has_include(<math.h>)
    #define SIMDE_MATH_HAVE_MATH_H
    #include <math.h>
  #elif !defined(SIMDE_MATH_NO_LIBM)
    #define SIMDE_MATH_NO_LIBM
  #endif
#elif !defined(SIMDE_MATH_NO_LIBM)
  #if defined(__cplusplus) && (__cplusplus >= 201103L)
    #define SIMDE_MATH_HAVE_CMATH
    HEDLEY_DIAGNOSTIC_PUSH
    #if defined(HEDLEY_MSVC_VERSION)
      /* VS 14 emits this diagnostic about noexcept being used on a
       * <cmath> function, which we can't do anything about. */
      #pragma warning(disable:4996)
    #endif
    #include <cmath>
    HEDLEY_DIAGNOSTIC_POP
  #else
    #define SIMDE_MATH_HAVE_MATH_H
    #include <math.h>
  #endif
#endif

#if !defined(SIMDE_MATH_INFINITY)
  #if \
      HEDLEY_HAS_BUILTIN(__builtin_inf) || \
      HEDLEY_GCC_VERSION_CHECK(3,3,0) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
      HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
      HEDLEY_CRAY_VERSION_CHECK(8,1,0)
    #define SIMDE_MATH_INFINITY (__builtin_inf())
  #elif defined(INFINITY)
    #define SIMDE_MATH_INFINITY INFINITY
  #endif
#endif

#if !defined(SIMDE_INFINITYF)
  #if \
      HEDLEY_HAS_BUILTIN(__builtin_inff) || \
      HEDLEY_GCC_VERSION_CHECK(3,3,0) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
      HEDLEY_CRAY_VERSION_CHECK(8,1,0) || \
      HEDLEY_IBM_VERSION_CHECK(13,1,0)
    #define SIMDE_MATH_INFINITYF (__builtin_inff())
  #elif defined(INFINITYF)
    #define SIMDE_MATH_INFINITYF INFINITYF
  #elif defined(SIMDE_MATH_INFINITY)
    #define SIMDE_MATH_INFINITYF HEDLEY_STATIC_CAST(float, SIMDE_MATH_INFINITY)
  #endif
#endif

#if !defined(SIMDE_MATH_NAN)
  #if \
      HEDLEY_HAS_BUILTIN(__builtin_nan) || \
      HEDLEY_GCC_VERSION_CHECK(3,3,0) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
      HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
      HEDLEY_CRAY_VERSION_CHECK(8,1,0) || \
      HEDLEY_IBM_VERSION_CHECK(13,1,0)
    #define SIMDE_MATH_NAN (__builtin_nan(""))
  #elif defined(NAN)
    #define SIMDE_MATH_NAN NAN
  #endif
#endif

#if !defined(SIMDE_NANF)
  #if \
      HEDLEY_HAS_BUILTIN(__builtin_nanf) || \
      HEDLEY_GCC_VERSION_CHECK(3,3,0) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
      HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
      HEDLEY_CRAY_VERSION_CHECK(8,1,0)
    #define SIMDE_MATH_NANF (__builtin_nanf(""))
  #elif defined(NANF)
    #define SIMDE_MATH_NANF NANF
  #elif defined(SIMDE_MATH_NAN)
    #define SIMDE_MATH_NANF HEDLEY_STATIC_CAST(float, SIMDE_MATH_NAN)
  #endif
#endif

#if !defined(SIMDE_MATH_PI)
  #if defined(M_PI)
    #define SIMDE_MATH_PI M_PI
  #else
    #define SIMDE_MATH_PI 3.14159265358979323846
  #endif
#endif

#if !defined(SIMDE_MATH_PIF)
  #if defined(M_PI)
    #define SIMDE_MATH_PIF HEDLEY_STATIC_CAST(float, M_PI)
  #else
    #define SIMDE_MATH_PIF 3.14159265358979323846f
  #endif
#endif

#if !defined(SIMDE_MATH_PI_OVER_180)
  #define SIMDE_MATH_PI_OVER_180 0.0174532925199432957692369076848861271344287188854172545609719144
#endif

#if !defined(SIMDE_MATH_PI_OVER_180F)
  #define SIMDE_MATH_PI_OVER_180F 0.0174532925199432957692369076848861271344287188854172545609719144f
#endif

#if !defined(SIMDE_MATH_180_OVER_PI)
  #define SIMDE_MATH_180_OVER_PI 57.295779513082320876798154814105170332405472466564321549160243861
#endif

#if !defined(SIMDE_MATH_180_OVER_PIF)
  #define SIMDE_MATH_180_OVER_PIF 57.295779513082320876798154814105170332405472466564321549160243861f
#endif

#if !defined(SIMDE_MATH_FLT_MIN)
  #if defined(__FLT_MIN__)
    #define SIMDE_MATH_FLT_MIN __FLT_MIN__
  #else
    #if !defined(FLT_MIN)
      #if defined(__cplusplus)
        #include <cfloat>
      #else
        #include <float.h>
      #endif
    #endif
    #define SIMDE_MATH_FLT_MIN FLT_MIN
  #endif
#endif

#if !defined(SIMDE_MATH_FLT_MAX)
  #if defined(__FLT_MAX__)
    #define SIMDE_MATH_FLT_MAX __FLT_MAX__
  #else
    #if !defined(FLT_MAX)
      #if defined(__cplusplus)
        #include <cfloat>
      #else
        #include <float.h>
      #endif
    #endif
    #define SIMDE_MATH_FLT_MAX FLT_MAX
  #endif
#endif

#if !defined(SIMDE_MATH_DBL_MIN)
  #if defined(__DBL_MIN__)
    #define SIMDE_MATH_DBL_MIN __DBL_MIN__
  #else
    #if !defined(DBL_MIN)
      #if defined(__cplusplus)
        #include <cfloat>
      #else
        #include <float.h>
      #endif
    #endif
    #define SIMDE_MATH_DBL_MIN DBL_MIN
  #endif
#endif

#if !defined(SIMDE_MATH_DBL_MAX)
  #if defined(__DBL_MAX__)
    #define SIMDE_MATH_DBL_MAX __DBL_MAX__
  #else
    #if !defined(DBL_MAX)
      #if defined(__cplusplus)
        #include <cfloat>
      #else
        #include <float.h>
      #endif
    #endif
    #define SIMDE_MATH_DBL_MAX DBL_MAX
  #endif
#endif

/*** Classification macros from C99 ***/

#if !defined(simde_math_isinf)
  #if SIMDE_MATH_BUILTIN_LIBM(isinf)
    #define simde_math_isinf(v) __builtin_isinf(v)
  #elif defined(isinf) || defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_isinf(v) isinf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_isinf(v) std::isinf(v)
  #endif
#endif

#if !defined(simde_math_isinff)
  #if HEDLEY_HAS_BUILTIN(__builtin_isinff) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
      HEDLEY_ARM_VERSION_CHECK(4,1,0)
    #define simde_math_isinff(v) __builtin_isinff(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_isinff(v) std::isinf(v)
  #elif defined(simde_math_isinf)
    #define simde_math_isinff(v) simde_math_isinf(HEDLEY_STATIC_CAST(double, v))
  #endif
#endif

#if !defined(simde_math_isnan)
  #if SIMDE_MATH_BUILTIN_LIBM(isnan)
    #define simde_math_isnan(v) __builtin_isnan(v)
  #elif defined(isnan) || defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_isnan(v) isnan(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_isnan(v) std::isnan(v)
  #endif
#endif

#if !defined(simde_math_isnanf)
  #if HEDLEY_HAS_BUILTIN(__builtin_isnanf) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
      HEDLEY_ARM_VERSION_CHECK(4,1,0)
    /* XL C/C++ has __builtin_isnan but not __builtin_isnanf */
    #define simde_math_isnanf(v) __builtin_isnanf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_isnanf(v) std::isnan(v)
  #elif defined(simde_math_isnan)
    #define simde_math_isnanf(v) simde_math_isnan(HEDLEY_STATIC_CAST(double, v))
  #endif
#endif

#if !defined(simde_math_isnormal)
  #if SIMDE_MATH_BUILTIN_LIBM(isnormal)
    #define simde_math_isnormal(v) __builtin_isnormal(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_isnormal(v) isnormal(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_isnormal(v) std::isnormal(v)
  #endif
#endif

#if !defined(simde_math_isnormalf)
  #if HEDLEY_HAS_BUILTIN(__builtin_isnormalf)
    #define simde_math_isnormalf(v) __builtin_isnormalf(v)
  #elif SIMDE_MATH_BUILTIN_LIBM(isnormal)
    #define simde_math_isnormalf(v) __builtin_isnormal(v)
  #elif defined(isnormalf)
    #define simde_math_isnormalf(v) isnormalf(v)
  #elif defined(isnormal) || defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_isnormalf(v) isnormal(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_isnormalf(v) std::isnormal(v)
  #elif defined(simde_math_isnormal)
    #define simde_math_isnormalf(v) simde_math_isnormal(v)
  #endif
#endif

#if !defined(simde_math_issubnormalf)
  #if SIMDE_MATH_BUILTIN_LIBM(fpclassify)
    #define simde_math_issubnormalf(v) __builtin_fpclassify(0, 0, 0, 1, 0, v)
  #elif defined(fpclassify)
    #define simde_math_issubnormalf(v) (fpclassify(v) == FP_SUBNORMAL)
  #elif defined(SIMDE_IEEE754_STORAGE)
    #define simde_math_issubnormalf(v) (((simde_float32_as_uint32(v) & UINT32_C(0x7F800000)) == UINT32_C(0)) && ((simde_float32_as_uint32(v) & UINT32_C(0x007FFFFF)) != UINT32_C(0)))
  #endif
#endif

#if !defined(simde_math_issubnormal)
  #if SIMDE_MATH_BUILTIN_LIBM(fpclassify)
    #define simde_math_issubnormal(v) __builtin_fpclassify(0, 0, 0, 1, 0, v)
  #elif defined(fpclassify)
    #define simde_math_issubnormal(v) (fpclassify(v) == FP_SUBNORMAL)
  #elif defined(SIMDE_IEEE754_STORAGE)
    #define simde_math_issubnormal(v) (((simde_float64_as_uint64(v) & UINT64_C(0x7FF0000000000000)) == UINT64_C(0)) && ((simde_float64_as_uint64(v) & UINT64_C(0x00FFFFFFFFFFFFF)) != UINT64_C(0)))
  #endif
#endif

#if defined(FP_NAN)
  #define SIMDE_MATH_FP_NAN FP_NAN
#else
  #define SIMDE_MATH_FP_NAN 0
#endif
#if defined(FP_INFINITE)
  #define SIMDE_MATH_FP_INFINITE FP_INFINITE
#else
  #define SIMDE_MATH_FP_INFINITE 1
#endif
#if defined(FP_ZERO)
  #define SIMDE_MATH_FP_ZERO FP_ZERO
#else
  #define SIMDE_MATH_FP_ZERO 2
#endif
#if defined(FP_SUBNORMAL)
  #define SIMDE_MATH_FP_SUBNORMAL FP_SUBNORMAL
#else
  #define SIMDE_MATH_FP_SUBNORMAL 3
#endif
#if defined(FP_NORMAL)
  #define SIMDE_MATH_FP_NORMAL FP_NORMAL
#else
  #define SIMDE_MATH_FP_NORMAL 4
#endif

static HEDLEY_INLINE
int
simde_math_fpclassifyf(float v) {
  #if SIMDE_MATH_BUILTIN_LIBM(fpclassify)
    return __builtin_fpclassify(SIMDE_MATH_FP_NAN, SIMDE_MATH_FP_INFINITE, SIMDE_MATH_FP_NORMAL, SIMDE_MATH_FP_SUBNORMAL, SIMDE_MATH_FP_ZERO, v);
  #elif defined(fpclassify)
    return fpclassify(v);
  #else
    return
      simde_math_isnormalf(v) ? SIMDE_MATH_FP_NORMAL    :
      (v == 0.0f)             ? SIMDE_MATH_FP_ZERO      :
      simde_math_isnanf(v)    ? SIMDE_MATH_FP_NAN       :
      simde_math_isinff(v)    ? SIMDE_MATH_FP_INFINITE  :
                                SIMDE_MATH_FP_SUBNORMAL;
  #endif
}

static HEDLEY_INLINE
int
simde_math_fpclassify(double v) {
  #if SIMDE_MATH_BUILTIN_LIBM(fpclassify)
    return __builtin_fpclassify(SIMDE_MATH_FP_NAN, SIMDE_MATH_FP_INFINITE, SIMDE_MATH_FP_NORMAL, SIMDE_MATH_FP_SUBNORMAL, SIMDE_MATH_FP_ZERO, v);
  #elif defined(fpclassify)
    return fpclassify(v);
  #else
    return
      simde_math_isnormal(v) ? SIMDE_MATH_FP_NORMAL    :
      (v == 0.0)             ? SIMDE_MATH_FP_ZERO      :
      simde_math_isnan(v)    ? SIMDE_MATH_FP_NAN       :
      simde_math_isinf(v)    ? SIMDE_MATH_FP_INFINITE  :
                               SIMDE_MATH_FP_SUBNORMAL;
  #endif
}

#define SIMDE_MATH_FP_QNAN      0x01
#define SIMDE_MATH_FP_PZERO     0x02
#define SIMDE_MATH_FP_NZERO     0x04
#define SIMDE_MATH_FP_PINF      0x08
#define SIMDE_MATH_FP_NINF      0x10
#define SIMDE_MATH_FP_DENORMAL  0x20
#define SIMDE_MATH_FP_NEGATIVE  0x40
#define SIMDE_MATH_FP_SNAN      0x80

static HEDLEY_INLINE
uint8_t
simde_math_fpclassf(float v, const int imm8) {
  union {
    float f;
    uint32_t u;
  } fu;
  fu.f = v;
  uint32_t bits = fu.u;
  uint8_t NegNum = (bits >> 31) & 1;
  uint32_t const ExpMask = 0x3F800000; // [30:23]
  uint32_t const MantMask = 0x007FFFFF; // [22:0]
  uint8_t ExpAllOnes = ((bits & ExpMask) == ExpMask);
  uint8_t ExpAllZeros = ((bits & ExpMask) == 0);
  uint8_t MantAllZeros = ((bits & MantMask) == 0);
  uint8_t ZeroNumber = ExpAllZeros & MantAllZeros;
  uint8_t SignalingBit = (bits >> 22) & 1;

  uint8_t result = 0;
  uint8_t qNaN_res = ExpAllOnes & (!MantAllZeros) & SignalingBit;
  uint8_t Pzero_res = (!NegNum) & ExpAllZeros & MantAllZeros;
  uint8_t Nzero_res = NegNum & ExpAllZeros & MantAllZeros;
  uint8_t Pinf_res = (!NegNum) & ExpAllOnes & MantAllZeros;
  uint8_t Ninf_res = NegNum & ExpAllOnes & MantAllZeros;
  uint8_t Denorm_res = ExpAllZeros & (!MantAllZeros);
  uint8_t FinNeg_res = NegNum & (!ExpAllOnes) & (!ZeroNumber);
  uint8_t sNaN_res = ExpAllOnes & (!MantAllZeros) & (!SignalingBit);
  result = (((imm8 >> 0) & qNaN_res)   | \
            ((imm8 >> 1) & Pzero_res)  | \
            ((imm8 >> 2) & Nzero_res)  | \
            ((imm8 >> 3) & Pinf_res)   | \
            ((imm8 >> 4) & Ninf_res)   | \
            ((imm8 >> 5) & Denorm_res) | \
            ((imm8 >> 6) & FinNeg_res) | \
            ((imm8 >> 7) & sNaN_res));
  return result;
}

static HEDLEY_INLINE
uint8_t
simde_math_fpclass(double v, const int imm8) {
  union {
    double d;
    uint64_t u;
  } du;
  du.d = v;
  uint64_t bits = du.u;
  uint8_t NegNum = (bits >> 63) & 1;
  uint64_t const ExpMask =  0x3FF0000000000000; // [62:52]
  uint64_t const MantMask = 0x000FFFFFFFFFFFFF; // [51:0]
  uint8_t ExpAllOnes = ((bits & ExpMask) == ExpMask);
  uint8_t ExpAllZeros = ((bits & ExpMask) == 0);
  uint8_t MantAllZeros = ((bits & MantMask) == 0);
  uint8_t ZeroNumber = ExpAllZeros & MantAllZeros;
  uint8_t SignalingBit = (bits >> 51) & 1;

  uint8_t result = 0;
  uint8_t qNaN_res = ExpAllOnes & (!MantAllZeros) & SignalingBit;
  uint8_t Pzero_res = (!NegNum) & ExpAllZeros & MantAllZeros;
  uint8_t Nzero_res = NegNum & ExpAllZeros & MantAllZeros;
  uint8_t Pinf_res = (!NegNum) & ExpAllOnes & MantAllZeros;
  uint8_t Ninf_res = NegNum & ExpAllOnes & MantAllZeros;
  uint8_t Denorm_res = ExpAllZeros & (!MantAllZeros);
  uint8_t FinNeg_res = NegNum & (!ExpAllOnes) & (!ZeroNumber);
  uint8_t sNaN_res = ExpAllOnes & (!MantAllZeros) & (!SignalingBit);
  result = (((imm8 >> 0) & qNaN_res)   | \
            ((imm8 >> 1) & Pzero_res)  | \
            ((imm8 >> 2) & Nzero_res)  | \
            ((imm8 >> 3) & Pinf_res)   | \
            ((imm8 >> 4) & Ninf_res)   | \
            ((imm8 >> 5) & Denorm_res) | \
            ((imm8 >> 6) & FinNeg_res) | \
            ((imm8 >> 7) & sNaN_res));
  return result;
}

/*** Manipulation functions ***/

#if !defined(simde_math_nextafter)
  #if \
      (HEDLEY_HAS_BUILTIN(__builtin_nextafter) && !defined(HEDLEY_IBM_VERSION)) || \
      HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
      HEDLEY_GCC_VERSION_CHECK(3,4,0) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0)
    #define simde_math_nextafter(x, y) __builtin_nextafter(x, y)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_nextafter(x, y) std::nextafter(x, y)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_nextafter(x, y) nextafter(x, y)
  #endif
#endif

#if !defined(simde_math_nextafterf)
  #if \
      (HEDLEY_HAS_BUILTIN(__builtin_nextafterf) && !defined(HEDLEY_IBM_VERSION)) || \
      HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
      HEDLEY_GCC_VERSION_CHECK(3,4,0) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0)
    #define simde_math_nextafterf(x, y) __builtin_nextafterf(x, y)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_nextafterf(x, y) std::nextafter(x, y)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_nextafterf(x, y) nextafterf(x, y)
  #endif
#endif

/*** Functions from C99 ***/

#if !defined(simde_math_abs)
  #if SIMDE_MATH_BUILTIN_LIBM(abs)
    #define simde_math_abs(v) __builtin_abs(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_abs(v) std::abs(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_abs(v) abs(v)
  #endif
#endif

#if !defined(simde_math_labs)
  #if SIMDE_MATH_BUILTIN_LIBM(labs)
    #define simde_math_labs(v) __builtin_labs(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_labs(v) std::labs(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_labs(v) labs(v)
  #endif
#endif

#if !defined(simde_math_llabs)
  #if SIMDE_MATH_BUILTIN_LIBM(llabs)
    #define simde_math_llabs(v) __builtin_llabs(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_llabs(v) std::llabs(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_llabs(v) llabs(v)
  #endif
#endif

#if !defined(simde_math_fabsf)
  #if SIMDE_MATH_BUILTIN_LIBM(fabsf)
    #define simde_math_fabsf(v) __builtin_fabsf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_fabsf(v) std::abs(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_fabsf(v) fabsf(v)
  #endif
#endif

#if !defined(simde_math_acos)
  #if SIMDE_MATH_BUILTIN_LIBM(acos)
    #define simde_math_acos(v) __builtin_acos(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_acos(v) std::acos(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_acos(v) acos(v)
  #endif
#endif

#if !defined(simde_math_acosf)
  #if SIMDE_MATH_BUILTIN_LIBM(acosf)
    #define simde_math_acosf(v) __builtin_acosf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_acosf(v) std::acos(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_acosf(v) acosf(v)
  #endif
#endif

#if !defined(simde_math_acosh)
  #if SIMDE_MATH_BUILTIN_LIBM(acosh)
    #define simde_math_acosh(v) __builtin_acosh(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_acosh(v) std::acosh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_acosh(v) acosh(v)
  #endif
#endif

#if !defined(simde_math_acoshf)
  #if SIMDE_MATH_BUILTIN_LIBM(acoshf)
    #define simde_math_acoshf(v) __builtin_acoshf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_acoshf(v) std::acosh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_acoshf(v) acoshf(v)
  #endif
#endif

#if !defined(simde_math_asin)
  #if SIMDE_MATH_BUILTIN_LIBM(asin)
    #define simde_math_asin(v) __builtin_asin(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_asin(v) std::asin(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_asin(v) asin(v)
  #endif
#endif

#if !defined(simde_math_asinf)
  #if SIMDE_MATH_BUILTIN_LIBM(asinf)
    #define simde_math_asinf(v) __builtin_asinf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_asinf(v) std::asin(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_asinf(v) asinf(v)
  #endif
#endif

#if !defined(simde_math_asinh)
  #if SIMDE_MATH_BUILTIN_LIBM(asinh)
    #define simde_math_asinh(v) __builtin_asinh(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_asinh(v) std::asinh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_asinh(v) asinh(v)
  #endif
#endif

#if !defined(simde_math_asinhf)
  #if SIMDE_MATH_BUILTIN_LIBM(asinhf)
    #define simde_math_asinhf(v) __builtin_asinhf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_asinhf(v) std::asinh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_asinhf(v) asinhf(v)
  #endif
#endif

#if !defined(simde_math_atan)
  #if SIMDE_MATH_BUILTIN_LIBM(atan)
    #define simde_math_atan(v) __builtin_atan(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_atan(v) std::atan(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_atan(v) atan(v)
  #endif
#endif

#if !defined(simde_math_atan2)
  #if SIMDE_MATH_BUILTIN_LIBM(atan2)
    #define simde_math_atan2(y, x) __builtin_atan2(y, x)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_atan2(y, x) std::atan2(y, x)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_atan2(y, x) atan2(y, x)
  #endif
#endif

#if !defined(simde_math_atan2f)
  #if SIMDE_MATH_BUILTIN_LIBM(atan2f)
    #define simde_math_atan2f(y, x) __builtin_atan2f(y, x)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_atan2f(y, x) std::atan2(y, x)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_atan2f(y, x) atan2f(y, x)
  #endif
#endif

#if !defined(simde_math_atanf)
  #if SIMDE_MATH_BUILTIN_LIBM(atanf)
    #define simde_math_atanf(v) __builtin_atanf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_atanf(v) std::atan(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_atanf(v) atanf(v)
  #endif
#endif

#if !defined(simde_math_atanh)
  #if SIMDE_MATH_BUILTIN_LIBM(atanh)
    #define simde_math_atanh(v) __builtin_atanh(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_atanh(v) std::atanh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_atanh(v) atanh(v)
  #endif
#endif

#if !defined(simde_math_atanhf)
  #if SIMDE_MATH_BUILTIN_LIBM(atanhf)
    #define simde_math_atanhf(v) __builtin_atanhf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_atanhf(v) std::atanh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_atanhf(v) atanhf(v)
  #endif
#endif

#if !defined(simde_math_cbrt)
  #if SIMDE_MATH_BUILTIN_LIBM(cbrt)
    #define simde_math_cbrt(v) __builtin_cbrt(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_cbrt(v) std::cbrt(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_cbrt(v) cbrt(v)
  #endif
#endif

#if !defined(simde_math_cbrtf)
  #if SIMDE_MATH_BUILTIN_LIBM(cbrtf)
    #define simde_math_cbrtf(v) __builtin_cbrtf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_cbrtf(v) std::cbrt(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_cbrtf(v) cbrtf(v)
  #endif
#endif

#if !defined(simde_math_ceil)
  #if SIMDE_MATH_BUILTIN_LIBM(ceil)
    #define simde_math_ceil(v) __builtin_ceil(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_ceil(v) std::ceil(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_ceil(v) ceil(v)
  #endif
#endif

#if !defined(simde_math_ceilf)
  #if SIMDE_MATH_BUILTIN_LIBM(ceilf)
    #define simde_math_ceilf(v) __builtin_ceilf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_ceilf(v) std::ceil(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_ceilf(v) ceilf(v)
  #endif
#endif

#if !defined(simde_math_copysign)
  #if SIMDE_MATH_BUILTIN_LIBM(copysign)
    #define simde_math_copysign(x, y) __builtin_copysign(x, y)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_copysign(x, y) std::copysign(x, y)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_copysign(x, y) copysign(x, y)
  #endif
#endif

#if !defined(simde_math_copysignf)
  #if SIMDE_MATH_BUILTIN_LIBM(copysignf)
    #define simde_math_copysignf(x, y) __builtin_copysignf(x, y)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_copysignf(x, y) std::copysignf(x, y)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_copysignf(x, y) copysignf(x, y)
  #endif
#endif

#if !defined(simde_math_signbit)
  #if SIMDE_MATH_BUILTIN_LIBM(signbit)
    #if (!defined(__clang__) || SIMDE_DETECT_CLANG_VERSION_CHECK(7,0,0))
      #define simde_math_signbit(x) __builtin_signbit(x)
    #else
      #define simde_math_signbit(x) __builtin_signbit(HEDLEY_STATIC_CAST(double, (x)))
    #endif
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_signbit(x) std::signbit(x)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_signbit(x) signbit(x)
  #endif
#endif

#if !defined(simde_math_cos)
  #if SIMDE_MATH_BUILTIN_LIBM(cos)
    #define simde_math_cos(v) __builtin_cos(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_cos(v) std::cos(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_cos(v) cos(v)
  #endif
#endif

#if !defined(simde_math_cosf)
  #if defined(SIMDE_MATH_SLEEF_ENABLE)
    #if SIMDE_ACCURACY_PREFERENCE < 1
      #define simde_math_cosf(v) Sleef_cosf_u35(v)
    #else
      #define simde_math_cosf(v) Sleef_cosf_u10(v)
    #endif
  #elif SIMDE_MATH_BUILTIN_LIBM(cosf)
    #define simde_math_cosf(v) __builtin_cosf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_cosf(v) std::cos(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_cosf(v) cosf(v)
  #endif
#endif

#if !defined(simde_math_cosh)
  #if SIMDE_MATH_BUILTIN_LIBM(cosh)
    #define simde_math_cosh(v) __builtin_cosh(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_cosh(v) std::cosh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_cosh(v) cosh(v)
  #endif
#endif

#if !defined(simde_math_coshf)
  #if SIMDE_MATH_BUILTIN_LIBM(coshf)
    #define simde_math_coshf(v) __builtin_coshf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_coshf(v) std::cosh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_coshf(v) coshf(v)
  #endif
#endif

#if !defined(simde_math_erf)
  #if SIMDE_MATH_BUILTIN_LIBM(erf)
    #define simde_math_erf(v) __builtin_erf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_erf(v) std::erf(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_erf(v) erf(v)
  #endif
#endif

#if !defined(simde_math_erff)
  #if SIMDE_MATH_BUILTIN_LIBM(erff)
    #define simde_math_erff(v) __builtin_erff(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_erff(v) std::erf(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_erff(v) erff(v)
  #endif
#endif

#if !defined(simde_math_erfc)
  #if SIMDE_MATH_BUILTIN_LIBM(erfc)
    #define simde_math_erfc(v) __builtin_erfc(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_erfc(v) std::erfc(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_erfc(v) erfc(v)
  #endif
#endif

#if !defined(simde_math_erfcf)
  #if SIMDE_MATH_BUILTIN_LIBM(erfcf)
    #define simde_math_erfcf(v) __builtin_erfcf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_erfcf(v) std::erfc(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_erfcf(v) erfcf(v)
  #endif
#endif

#if !defined(simde_math_exp)
  #if SIMDE_MATH_BUILTIN_LIBM(exp)
    #define simde_math_exp(v) __builtin_exp(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_exp(v) std::exp(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_exp(v) exp(v)
  #endif
#endif

#if !defined(simde_math_expf)
  #if SIMDE_MATH_BUILTIN_LIBM(expf)
    #define simde_math_expf(v) __builtin_expf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_expf(v) std::exp(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_expf(v) expf(v)
  #endif
#endif

#if !defined(simde_math_expm1)
  #if SIMDE_MATH_BUILTIN_LIBM(expm1)
    #define simde_math_expm1(v) __builtin_expm1(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_expm1(v) std::expm1(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_expm1(v) expm1(v)
  #endif
#endif

#if !defined(simde_math_expm1f)
  #if SIMDE_MATH_BUILTIN_LIBM(expm1f)
    #define simde_math_expm1f(v) __builtin_expm1f(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_expm1f(v) std::expm1(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_expm1f(v) expm1f(v)
  #endif
#endif

#if !defined(simde_math_exp2)
  #if SIMDE_MATH_BUILTIN_LIBM(exp2)
    #define simde_math_exp2(v) __builtin_exp2(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_exp2(v) std::exp2(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_exp2(v) exp2(v)
  #endif
#endif

#if !defined(simde_math_exp2f)
  #if SIMDE_MATH_BUILTIN_LIBM(exp2f)
    #define simde_math_exp2f(v) __builtin_exp2f(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_exp2f(v) std::exp2(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_exp2f(v) exp2f(v)
  #endif
#endif

#if HEDLEY_HAS_BUILTIN(__builtin_exp10) ||  HEDLEY_GCC_VERSION_CHECK(3,4,0)
  #  define simde_math_exp10(v) __builtin_exp10(v)
#else
#  define simde_math_exp10(v) pow(10.0, (v))
#endif

#if HEDLEY_HAS_BUILTIN(__builtin_exp10f) ||  HEDLEY_GCC_VERSION_CHECK(3,4,0)
  #  define simde_math_exp10f(v) __builtin_exp10f(v)
#else
#  define simde_math_exp10f(v) powf(10.0f, (v))
#endif

#if !defined(simde_math_fabs)
  #if SIMDE_MATH_BUILTIN_LIBM(fabs)
    #define simde_math_fabs(v) __builtin_fabs(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_fabs(v) std::fabs(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_fabs(v) fabs(v)
  #endif
#endif

#if !defined(simde_math_fabsf)
  #if SIMDE_MATH_BUILTIN_LIBM(fabsf)
    #define simde_math_fabsf(v) __builtin_fabsf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_fabsf(v) std::fabs(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_fabsf(v) fabsf(v)
  #endif
#endif

#if !defined(simde_math_floor)
  #if SIMDE_MATH_BUILTIN_LIBM(floor)
    #define simde_math_floor(v) __builtin_floor(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_floor(v) std::floor(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_floor(v) floor(v)
  #endif
#endif

#if !defined(simde_math_floorf)
  #if SIMDE_MATH_BUILTIN_LIBM(floorf)
    #define simde_math_floorf(v) __builtin_floorf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_floorf(v) std::floor(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_floorf(v) floorf(v)
  #endif
#endif

#if !defined(simde_math_fma)
  #if SIMDE_MATH_BUILTIN_LIBM(fma)
    #define simde_math_fma(x, y, z) __builtin_fma(x, y, z)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_fma(x, y, z) std::fma(x, y, z)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_fma(x, y, z) fma(x, y, z)
  #endif
#endif

#if !defined(simde_math_fmaf)
  #if SIMDE_MATH_BUILTIN_LIBM(fmaf)
    #define simde_math_fmaf(x, y, z) __builtin_fmaf(x, y, z)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_fmaf(x, y, z) std::fma(x, y, z)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_fmaf(x, y, z) fmaf(x, y, z)
  #endif
#endif

#if !defined(simde_math_fmax)
  #if SIMDE_MATH_BUILTIN_LIBM(fmax)
    #define simde_math_fmax(x, y) __builtin_fmax(x, y)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_fmax(x, y) std::fmax(x, y)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_fmax(x, y) fmax(x, y)
  #endif
#endif

#if !defined(simde_math_fmaxf)
  #if SIMDE_MATH_BUILTIN_LIBM(fmaxf)
    #define simde_math_fmaxf(x, y) __builtin_fmaxf(x, y)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_fmaxf(x, y) std::fmax(x, y)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_fmaxf(x, y) fmaxf(x, y)
  #endif
#endif

#if !defined(simde_math_hypot)
  #if SIMDE_MATH_BUILTIN_LIBM(hypot)
    #define simde_math_hypot(y, x) __builtin_hypot(y, x)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_hypot(y, x) std::hypot(y, x)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_hypot(y, x) hypot(y, x)
  #endif
#endif

#if !defined(simde_math_hypotf)
  #if SIMDE_MATH_BUILTIN_LIBM(hypotf)
    #define simde_math_hypotf(y, x) __builtin_hypotf(y, x)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_hypotf(y, x) std::hypot(y, x)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_hypotf(y, x) hypotf(y, x)
  #endif
#endif

#if !defined(simde_math_log)
  #if SIMDE_MATH_BUILTIN_LIBM(log)
    #define simde_math_log(v) __builtin_log(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_log(v) std::log(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_log(v) log(v)
  #endif
#endif

#if !defined(simde_math_logf)
  #if SIMDE_MATH_BUILTIN_LIBM(logf)
    #define simde_math_logf(v) __builtin_logf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_logf(v) std::log(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_logf(v) logf(v)
  #endif
#endif

#if !defined(simde_math_logb)
  #if SIMDE_MATH_BUILTIN_LIBM(logb)
    #define simde_math_logb(v) __builtin_logb(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_logb(v) std::logb(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_logb(v) logb(v)
  #endif
#endif

#if !defined(simde_math_logbf)
  #if SIMDE_MATH_BUILTIN_LIBM(logbf)
    #define simde_math_logbf(v) __builtin_logbf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_logbf(v) std::logb(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_logbf(v) logbf(v)
  #endif
#endif

#if !defined(simde_math_log1p)
  #if SIMDE_MATH_BUILTIN_LIBM(log1p)
    #define simde_math_log1p(v) __builtin_log1p(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_log1p(v) std::log1p(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_log1p(v) log1p(v)
  #endif
#endif

#if !defined(simde_math_log1pf)
  #if SIMDE_MATH_BUILTIN_LIBM(log1pf)
    #define simde_math_log1pf(v) __builtin_log1pf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_log1pf(v) std::log1p(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_log1pf(v) log1pf(v)
  #endif
#endif

#if !defined(simde_math_log2)
  #if SIMDE_MATH_BUILTIN_LIBM(log2)
    #define simde_math_log2(v) __builtin_log2(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_log2(v) std::log2(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_log2(v) log2(v)
  #endif
#endif

#if !defined(simde_math_log2f)
  #if SIMDE_MATH_BUILTIN_LIBM(log2f)
    #define simde_math_log2f(v) __builtin_log2f(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_log2f(v) std::log2(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_log2f(v) log2f(v)
  #endif
#endif

#if !defined(simde_math_log10)
  #if SIMDE_MATH_BUILTIN_LIBM(log10)
    #define simde_math_log10(v) __builtin_log10(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_log10(v) std::log10(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_log10(v) log10(v)
  #endif
#endif

#if !defined(simde_math_log10f)
  #if SIMDE_MATH_BUILTIN_LIBM(log10f)
    #define simde_math_log10f(v) __builtin_log10f(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_log10f(v) std::log10(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_log10f(v) log10f(v)
  #endif
#endif

#if !defined(simde_math_modf)
  #if SIMDE_MATH_BUILTIN_LIBM(modf)
    #define simde_math_modf(x, iptr) __builtin_modf(x, iptr)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_modf(x, iptr) std::modf(x, iptr)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_modf(x, iptr) modf(x, iptr)
  #endif
#endif

#if !defined(simde_math_modff)
  #if SIMDE_MATH_BUILTIN_LIBM(modff)
    #define simde_math_modff(x, iptr) __builtin_modff(x, iptr)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_modff(x, iptr) std::modf(x, iptr)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_modff(x, iptr) modff(x, iptr)
  #endif
#endif

#if !defined(simde_math_nearbyint)
  #if SIMDE_MATH_BUILTIN_LIBM(nearbyint)
    #define simde_math_nearbyint(v) __builtin_nearbyint(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_nearbyint(v) std::nearbyint(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_nearbyint(v) nearbyint(v)
  #endif
#endif

#if !defined(simde_math_nearbyintf)
  #if SIMDE_MATH_BUILTIN_LIBM(nearbyintf)
    #define simde_math_nearbyintf(v) __builtin_nearbyintf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_nearbyintf(v) std::nearbyint(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_nearbyintf(v) nearbyintf(v)
  #endif
#endif

#if !defined(simde_math_pow)
  #if SIMDE_MATH_BUILTIN_LIBM(pow)
    #define simde_math_pow(y, x) __builtin_pow(y, x)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_pow(y, x) std::pow(y, x)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_pow(y, x) pow(y, x)
  #endif
#endif

#if !defined(simde_math_powf)
  #if SIMDE_MATH_BUILTIN_LIBM(powf)
    #define simde_math_powf(y, x) __builtin_powf(y, x)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_powf(y, x) std::pow(y, x)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_powf(y, x) powf(y, x)
  #endif
#endif

#if !defined(simde_math_rint)
  #if SIMDE_MATH_BUILTIN_LIBM(rint)
    #define simde_math_rint(v) __builtin_rint(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_rint(v) std::rint(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_rint(v) rint(v)
  #endif
#endif

#if !defined(simde_math_rintf)
  #if SIMDE_MATH_BUILTIN_LIBM(rintf)
    #define simde_math_rintf(v) __builtin_rintf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_rintf(v) std::rint(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_rintf(v) rintf(v)
  #endif
#endif

#if !defined(simde_math_round)
  #if SIMDE_MATH_BUILTIN_LIBM(round)
    #define simde_math_round(v) __builtin_round(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_round(v) std::round(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_round(v) round(v)
  #endif
#endif

#if !defined(simde_math_roundf)
  #if SIMDE_MATH_BUILTIN_LIBM(roundf)
    #define simde_math_roundf(v) __builtin_roundf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_roundf(v) std::round(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_roundf(v) roundf(v)
  #endif
#endif

#if !defined(simde_math_roundeven)
  #if \
     ((!defined(HEDLEY_EMSCRIPTEN_VERSION) || HEDLEY_EMSCRIPTEN_VERSION_CHECK(3, 1, 43)) && HEDLEY_HAS_BUILTIN(__builtin_roundeven)) || \
      HEDLEY_GCC_VERSION_CHECK(10,0,0)
    #define simde_math_roundeven(v) __builtin_roundeven(v)
  #elif defined(simde_math_round) && defined(simde_math_fabs)
    static HEDLEY_INLINE
    double
    simde_math_roundeven(double v) {
      double rounded = simde_math_round(v);
      double diff = rounded - v;
      if (HEDLEY_UNLIKELY(simde_math_fabs(diff) == 0.5) && (HEDLEY_STATIC_CAST(int64_t, rounded) & 1)) {
        rounded = v - diff;
      }
      return rounded;
    }
    #define simde_math_roundeven simde_math_roundeven
  #endif
#endif

#if !defined(simde_math_roundevenf)
  #if \
     ((!defined(HEDLEY_EMSCRIPTEN_VERSION) || HEDLEY_EMSCRIPTEN_VERSION_CHECK(3, 1, 43)) && HEDLEY_HAS_BUILTIN(__builtin_roundevenf)) || \
      HEDLEY_GCC_VERSION_CHECK(10,0,0)
    #define simde_math_roundevenf(v) __builtin_roundevenf(v)
  #elif defined(simde_math_roundf) && defined(simde_math_fabsf)
    static HEDLEY_INLINE
    float
    simde_math_roundevenf(float v) {
      float rounded = simde_math_roundf(v);
      float diff = rounded - v;
      if (HEDLEY_UNLIKELY(simde_math_fabsf(diff) == 0.5f) && (HEDLEY_STATIC_CAST(int32_t, rounded) & 1)) {
        rounded = v - diff;
      }
      return rounded;
    }
    #define simde_math_roundevenf simde_math_roundevenf
  #endif
#endif

#if !defined(simde_math_sin)
  #if SIMDE_MATH_BUILTIN_LIBM(sin)
    #define simde_math_sin(v) __builtin_sin(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_sin(v) std::sin(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_sin(v) sin(v)
  #endif
#endif

#if !defined(simde_math_sinf)
  #if SIMDE_MATH_BUILTIN_LIBM(sinf)
    #define simde_math_sinf(v) __builtin_sinf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_sinf(v) std::sin(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_sinf(v) sinf(v)
  #endif
#endif

#if !defined(simde_math_sinh)
  #if SIMDE_MATH_BUILTIN_LIBM(sinh)
    #define simde_math_sinh(v) __builtin_sinh(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_sinh(v) std::sinh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_sinh(v) sinh(v)
  #endif
#endif

#if !defined(simde_math_sinhf)
  #if SIMDE_MATH_BUILTIN_LIBM(sinhf)
    #define simde_math_sinhf(v) __builtin_sinhf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_sinhf(v) std::sinh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_sinhf(v) sinhf(v)
  #endif
#endif

#if !defined(simde_math_sqrt)
  #if SIMDE_MATH_BUILTIN_LIBM(sqrt)
    #define simde_math_sqrt(v) __builtin_sqrt(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_sqrt(v) std::sqrt(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_sqrt(v) sqrt(v)
  #endif
#endif

#if !defined(simde_math_sqrtf)
  #if SIMDE_MATH_BUILTIN_LIBM(sqrtf)
    #define simde_math_sqrtf(v) __builtin_sqrtf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_sqrtf(v) std::sqrt(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_sqrtf(v) sqrtf(v)
  #endif
#endif

#if !defined(simde_math_sqrtl)
  #if SIMDE_MATH_BUILTIN_LIBM(sqrtl)
    #define simde_math_sqrtl(v) __builtin_sqrtl(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_sqrtl(v) std::sqrt(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_sqrtl(v) sqrtl(v)
  #endif
#endif

#if !defined(simde_math_tan)
  #if SIMDE_MATH_BUILTIN_LIBM(tan)
    #define simde_math_tan(v) __builtin_tan(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_tan(v) std::tan(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_tan(v) tan(v)
  #endif
#endif

#if !defined(simde_math_tanf)
  #if SIMDE_MATH_BUILTIN_LIBM(tanf)
    #define simde_math_tanf(v) __builtin_tanf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_tanf(v) std::tan(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_tanf(v) tanf(v)
  #endif
#endif

#if !defined(simde_math_tanh)
  #if SIMDE_MATH_BUILTIN_LIBM(tanh)
    #define simde_math_tanh(v) __builtin_tanh(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_tanh(v) std::tanh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_tanh(v) tanh(v)
  #endif
#endif

#if !defined(simde_math_tanhf)
  #if SIMDE_MATH_BUILTIN_LIBM(tanhf)
    #define simde_math_tanhf(v) __builtin_tanhf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_tanhf(v) std::tanh(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_tanhf(v) tanhf(v)
  #endif
#endif

#if !defined(simde_math_trunc)
  #if SIMDE_MATH_BUILTIN_LIBM(trunc)
    #define simde_math_trunc(v) __builtin_trunc(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_trunc(v) std::trunc(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_trunc(v) trunc(v)
  #endif
#endif

#if !defined(simde_math_truncf)
  #if SIMDE_MATH_BUILTIN_LIBM(truncf)
    #define simde_math_truncf(v) __builtin_truncf(v)
  #elif defined(SIMDE_MATH_HAVE_CMATH)
    #define simde_math_truncf(v) std::trunc(v)
  #elif defined(SIMDE_MATH_HAVE_MATH_H)
    #define simde_math_truncf(v) truncf(v)
  #endif
#endif

/*** Comparison macros (which don't raise invalid errors) ***/

#if defined(isunordered)
  #define simde_math_isunordered(x, y) isunordered(x, y)
#elif HEDLEY_HAS_BUILTIN(__builtin_isunordered)
  #define simde_math_isunordered(x, y) __builtin_isunordered(x, y)
#else
  static HEDLEY_INLINE
  int simde_math_isunordered(double x, double y) {
    return (x != y) && (x != x || y != y);
  }
  #define simde_math_isunordered simde_math_isunordered

  static HEDLEY_INLINE
  int simde_math_isunorderedf(float x, float y) {
    return (x != y) && (x != x || y != y);
  }
  #define simde_math_isunorderedf simde_math_isunorderedf
#endif
#if !defined(simde_math_isunorderedf)
  #define simde_math_isunorderedf simde_math_isunordered
#endif

/*** Additional functions not in libm ***/

#if defined(simde_math_fabs) && defined(simde_math_sqrt) && defined(simde_math_exp)
  static HEDLEY_INLINE
  double
  simde_math_cdfnorm(double x) {
    /* https://www.johndcook.com/blog/cpp_phi/
    * Public Domain */
    static const double a1 =  0.254829592;
    static const double a2 = -0.284496736;
    static const double a3 =  1.421413741;
    static const double a4 = -1.453152027;
    static const double a5 =  1.061405429;
    static const double p  =  0.3275911;

    const int sign = x < 0;
    x = simde_math_fabs(x) / simde_math_sqrt(2.0);

    /* A&S formula 7.1.26 */
    double t = 1.0 / (1.0 + p * x);
    double y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * simde_math_exp(-x * x);

    return 0.5 * (1.0 + (sign ? -y : y));
  }
  #define simde_math_cdfnorm simde_math_cdfnorm
#endif

#if defined(simde_math_fabsf) && defined(simde_math_sqrtf) && defined(simde_math_expf)
  static HEDLEY_INLINE
  float
  simde_math_cdfnormf(float x) {
    /* https://www.johndcook.com/blog/cpp_phi/
    * Public Domain */
    static const float a1 =  0.254829592f;
    static const float a2 = -0.284496736f;
    static const float a3 =  1.421413741f;
    static const float a4 = -1.453152027f;
    static const float a5 =  1.061405429f;
    static const float p  =  0.3275911f;

    const int sign = x < 0;
    x = simde_math_fabsf(x) / simde_math_sqrtf(2.0f);

    /* A&S formula 7.1.26 */
    float t = 1.0f / (1.0f + p * x);
    float y = 1.0f - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * simde_math_expf(-x * x);

    return 0.5f * (1.0f + (sign ? -y : y));
  }
  #define simde_math_cdfnormf simde_math_cdfnormf
#endif

#if !defined(simde_math_cdfnorminv) && defined(simde_math_log) && defined(simde_math_sqrt)
  /*https://web.archive.org/web/20150910081113/http://home.online.no/~pjacklam/notes/invnorm/impl/sprouse/ltqnorm.c*/
  static HEDLEY_INLINE
  double
  simde_math_cdfnorminv(double p) {
    static const double a[6] = {
      -3.969683028665376e+01,
       2.209460984245205e+02,
      -2.759285104469687e+02,
       1.383577518672690e+02,
      -3.066479806614716e+01,
       2.506628277459239e+00
    };

    static const double b[5] = {
      -5.447609879822406e+01,
       1.615858368580409e+02,
      -1.556989798598866e+02,
       6.680131188771972e+01,
      -1.328068155288572e+01
    };

    static const double c[6] = {
      -7.784894002430293e-03,
      -3.223964580411365e-01,
      -2.400758277161838e+00,
      -2.549732539343734e+00,
       4.374664141464968e+00,
       2.938163982698783e+00
    };

    static const double d[4] = {
      7.784695709041462e-03,
      3.224671290700398e-01,
      2.445134137142996e+00,
      3.754408661907416e+00
    };

    static const double low  = 0.02425;
    static const double high = 0.97575;
    double q, r;

    if (p < 0 || p > 1) {
      return 0.0;
    } else if (p == 0) {
      return -SIMDE_MATH_INFINITY;
    } else if (p == 1) {
      return SIMDE_MATH_INFINITY;
    } else if (p < low) {
      q = simde_math_sqrt(-2.0 * simde_math_log(p));
      return
        (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        (((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
    } else if (p > high) {
      q = simde_math_sqrt(-2.0 * simde_math_log(1.0 - p));
      return
        -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
         (((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
    } else {
      q = p - 0.5;
      r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
}
#define simde_math_cdfnorminv simde_math_cdfnorminv
#endif

#if !defined(simde_math_cdfnorminvf) && defined(simde_math_logf) && defined(simde_math_sqrtf)
  static HEDLEY_INLINE
  float
  simde_math_cdfnorminvf(float p) {
    static const float a[6] = {
      -3.969683028665376e+01f,
       2.209460984245205e+02f,
      -2.759285104469687e+02f,
       1.383577518672690e+02f,
      -3.066479806614716e+01f,
       2.506628277459239e+00f
    };
    static const float b[5] = {
      -5.447609879822406e+01f,
       1.615858368580409e+02f,
      -1.556989798598866e+02f,
       6.680131188771972e+01f,
      -1.328068155288572e+01f
    };
    static const float c[6] = {
      -7.784894002430293e-03f,
      -3.223964580411365e-01f,
      -2.400758277161838e+00f,
      -2.549732539343734e+00f,
       4.374664141464968e+00f,
       2.938163982698783e+00f
    };
    static const float d[4] = {
      7.784695709041462e-03f,
      3.224671290700398e-01f,
      2.445134137142996e+00f,
      3.754408661907416e+00f
    };
    static const float low  = 0.02425f;
    static const float high = 0.97575f;
    float q, r;

    if (p < 0 || p > 1) {
      return 0.0f;
    } else if (p == 0) {
      return -SIMDE_MATH_INFINITYF;
    } else if (p == 1) {
      return SIMDE_MATH_INFINITYF;
    } else if (p < low) {
      q = simde_math_sqrtf(-2.0f * simde_math_logf(p));
      return
        (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        (((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
    } else if (p > high) {
      q = simde_math_sqrtf(-2.0f * simde_math_logf(1.0f - p));
      return
        -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
         (((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
    } else {
      q = p - 0.5f;
      r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
         q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
  }
  #define simde_math_cdfnorminvf simde_math_cdfnorminvf
#endif

#if !defined(simde_math_erfinv) && defined(simde_math_log) && defined(simde_math_copysign) && defined(simde_math_sqrt)
  static HEDLEY_INLINE
  double
  simde_math_erfinv(double x) {
    /* https://stackoverflow.com/questions/27229371/inverse-error-function-in-c
     *
     * The original answer on SO uses a constant of 0.147, but in my
     * testing 0.14829094707965850830078125 gives a lower average absolute error
     * (0.0001410958211636170744895935 vs. 0.0001465479290345683693885803).
     * That said, if your goal is to minimize the *maximum* absolute
     * error, 0.15449436008930206298828125 provides significantly better
     * results; 0.0009250640869140625000000000 vs ~ 0.005. */
    double tt1, tt2, lnx;
    double sgn = simde_math_copysign(1.0, x);

    x = (1.0 - x) * (1.0 + x);
    lnx = simde_math_log(x);

    tt1 = 2.0 / (SIMDE_MATH_PI * 0.14829094707965850830078125) + 0.5 * lnx;
    tt2 = (1.0 / 0.14829094707965850830078125) * lnx;

    return sgn * simde_math_sqrt(-tt1 + simde_math_sqrt(tt1 * tt1 - tt2));
  }
  #define simde_math_erfinv simde_math_erfinv
#endif

#if !defined(simde_math_erfinvf) && defined(simde_math_logf) && defined(simde_math_copysignf) && defined(simde_math_sqrtf)
  static HEDLEY_INLINE
  float
  simde_math_erfinvf(float x) {
    float tt1, tt2, lnx;
    float sgn = simde_math_copysignf(1.0f, x);

    x = (1.0f - x) * (1.0f + x);
    lnx = simde_math_logf(x);

    tt1 = 2.0f / (SIMDE_MATH_PIF * 0.14829094707965850830078125f) + 0.5f * lnx;
    tt2 = (1.0f / 0.14829094707965850830078125f) * lnx;

    return sgn * simde_math_sqrtf(-tt1 + simde_math_sqrtf(tt1 * tt1 - tt2));
  }
  #define simde_math_erfinvf simde_math_erfinvf
#endif

#if !defined(simde_math_erfcinv) && defined(simde_math_erfinv) && defined(simde_math_log) && defined(simde_math_sqrt)
  static HEDLEY_INLINE
  double
  simde_math_erfcinv(double x) {
    if(x >= 0.0625 && x < 2.0) {
      return simde_math_erfinv(1.0 - x);
    } else if (x < 0.0625 && x >= 1.0e-100) {
      static const double p[6] = {
        0.1550470003116,
        1.382719649631,
        0.690969348887,
        -1.128081391617,
        0.680544246825,
        -0.16444156791
      };
      static const double q[3] = {
        0.155024849822,
        1.385228141995,
        1.000000000000
      };

      const double t = 1.0 / simde_math_sqrt(-simde_math_log(x));
      return (p[0] / t + p[1] + t * (p[2] + t * (p[3] + t * (p[4] + t * p[5])))) /
            (q[0] + t * (q[1] + t * (q[2])));
    } else if (x < 1.0e-100 && x >= SIMDE_MATH_DBL_MIN) {
      static const double p[4] = {
        0.00980456202915,
        0.363667889171,
        0.97302949837,
        -0.5374947401
      };
      static const double q[3] = {
        0.00980451277802,
        0.363699971544,
        1.000000000000
      };

      const double t = 1.0 / simde_math_sqrt(-simde_math_log(x));
      return (p[0] / t + p[1] + t * (p[2] + t * p[3])) /
             (q[0] + t * (q[1] + t * (q[2])));
    } else if (!simde_math_isnormal(x)) {
      return SIMDE_MATH_INFINITY;
    } else {
      return -SIMDE_MATH_INFINITY;
    }
  }

  #define simde_math_erfcinv simde_math_erfcinv
#endif

#if !defined(simde_math_erfcinvf) && defined(simde_math_erfinvf) && defined(simde_math_logf) && defined(simde_math_sqrtf)
  static HEDLEY_INLINE
  float
  simde_math_erfcinvf(float x) {
    if(x >= 0.0625f && x < 2.0f) {
      return simde_math_erfinvf(1.0f - x);
    } else if (x < 0.0625f && x >= SIMDE_MATH_FLT_MIN) {
      static const float p[6] = {
         0.1550470003116f,
         1.382719649631f,
         0.690969348887f,
        -1.128081391617f,
         0.680544246825f
        -0.164441567910f
      };
      static const float q[3] = {
        0.155024849822f,
        1.385228141995f,
        1.000000000000f
      };

      const float t = 1.0f / simde_math_sqrtf(-simde_math_logf(x));
      return (p[0] / t + p[1] + t * (p[2] + t * (p[3] + t * (p[4] + t * p[5])))) /
             (q[0] + t * (q[1] + t * (q[2])));
    } else if (x < SIMDE_MATH_FLT_MIN && simde_math_isnormalf(x)) {
      static const float p[4] = {
        0.00980456202915f,
        0.36366788917100f,
        0.97302949837000f,
        -0.5374947401000f
      };
      static const float q[3] = {
        0.00980451277802f,
        0.36369997154400f,
        1.00000000000000f
      };

      const float t = 1.0f / simde_math_sqrtf(-simde_math_logf(x));
      return (p[0] / t + p[1] + t * (p[2] + t * p[3])) /
             (q[0] + t * (q[1] + t * (q[2])));
    } else {
      return simde_math_isnormalf(x) ? -SIMDE_MATH_INFINITYF : SIMDE_MATH_INFINITYF;
    }
  }

  #define simde_math_erfcinvf simde_math_erfcinvf
#endif

static HEDLEY_INLINE
double
simde_math_rad2deg(double radians) {
 return radians * SIMDE_MATH_180_OVER_PI;
}

static HEDLEY_INLINE
float
simde_math_rad2degf(float radians) {
    return radians * SIMDE_MATH_180_OVER_PIF;
}

static HEDLEY_INLINE
double
simde_math_deg2rad(double degrees) {
  return degrees * SIMDE_MATH_PI_OVER_180;
}

static HEDLEY_INLINE
float
simde_math_deg2radf(float degrees) {
    return degrees * (SIMDE_MATH_PI_OVER_180F);
}

/***  Saturated arithmetic ***/

static HEDLEY_INLINE
int8_t
simde_math_adds_i8(int8_t a, int8_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqaddb_s8(a, b);
  #else
    uint8_t a_ = HEDLEY_STATIC_CAST(uint8_t, a);
    uint8_t b_ = HEDLEY_STATIC_CAST(uint8_t, b);
    uint8_t r_ = a_ + b_;

    a_ = (a_ >> ((8 * sizeof(r_)) - 1)) + INT8_MAX;
    if (HEDLEY_STATIC_CAST(int8_t, ((a_ ^ b_) | ~(b_ ^ r_))) >= 0) {
      r_ = a_;
    }

    return HEDLEY_STATIC_CAST(int8_t, r_);
  #endif
}

static HEDLEY_INLINE
int16_t
simde_math_adds_i16(int16_t a, int16_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqaddh_s16(a, b);
  #else
    uint16_t a_ = HEDLEY_STATIC_CAST(uint16_t, a);
    uint16_t b_ = HEDLEY_STATIC_CAST(uint16_t, b);
    uint16_t r_ = a_ + b_;

    a_ = (a_ >> ((8 * sizeof(r_)) - 1)) + INT16_MAX;
    if (HEDLEY_STATIC_CAST(int16_t, ((a_ ^ b_) | ~(b_ ^ r_))) >= 0) {
      r_ = a_;
    }

    return HEDLEY_STATIC_CAST(int16_t, r_);
  #endif
}

static HEDLEY_INLINE
int32_t
simde_math_adds_i32(int32_t a, int32_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqadds_s32(a, b);
  #else
    uint32_t a_ = HEDLEY_STATIC_CAST(uint32_t, a);
    uint32_t b_ = HEDLEY_STATIC_CAST(uint32_t, b);
    uint32_t r_ = a_ + b_;

    a_ = (a_ >> ((8 * sizeof(r_)) - 1)) + INT32_MAX;
    if (HEDLEY_STATIC_CAST(int32_t, ((a_ ^ b_) | ~(b_ ^ r_))) >= 0) {
      r_ = a_;
    }

    return HEDLEY_STATIC_CAST(int32_t, r_);
  #endif
}

static HEDLEY_INLINE
int64_t
simde_math_adds_i64(int64_t a, int64_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqaddd_s64(a, b);
  #else
    uint64_t a_ = HEDLEY_STATIC_CAST(uint64_t, a);
    uint64_t b_ = HEDLEY_STATIC_CAST(uint64_t, b);
    uint64_t r_ = a_ + b_;

    a_ = (a_ >> ((8 * sizeof(r_)) - 1)) + INT64_MAX;
    if (HEDLEY_STATIC_CAST(int64_t, ((a_ ^ b_) | ~(b_ ^ r_))) >= 0) {
      r_ = a_;
    }

    return HEDLEY_STATIC_CAST(int64_t, r_);
  #endif
}

static HEDLEY_INLINE
uint8_t
simde_math_adds_u8(uint8_t a, uint8_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqaddb_u8(a, b);
  #else
    uint8_t r = a + b;
    r |= -(r < a);
    return r;
  #endif
}

static HEDLEY_INLINE
uint16_t
simde_math_adds_u16(uint16_t a, uint16_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqaddh_u16(a, b);
  #else
    uint16_t r = a + b;
    r |= -(r < a);
    return r;
  #endif
}

static HEDLEY_INLINE
uint32_t
simde_math_adds_u32(uint32_t a, uint32_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqadds_u32(a, b);
  #else
    uint32_t r = a + b;
    r |= -(r < a);
    return r;
  #endif
}

static HEDLEY_INLINE
uint64_t
simde_math_adds_u64(uint64_t a, uint64_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqaddd_u64(a, b);
  #else
    uint64_t r = a + b;
    r |= -(r < a);
    return r;
  #endif
}

static HEDLEY_INLINE
int8_t
simde_math_subs_i8(int8_t a, int8_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqsubb_s8(a, b);
  #else
    uint8_t a_ = HEDLEY_STATIC_CAST(uint8_t, a);
    uint8_t b_ = HEDLEY_STATIC_CAST(uint8_t, b);
    uint8_t r_ = a_ - b_;

    a_ = (a_ >> 7) + INT8_MAX;

    if (HEDLEY_STATIC_CAST(int8_t, (a_ ^ b_) & (a_ ^ r_)) < 0) {
      r_ = a_;
    }

    return HEDLEY_STATIC_CAST(int8_t, r_);
  #endif
}

static HEDLEY_INLINE
int16_t
simde_math_subs_i16(int16_t a, int16_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqsubh_s16(a, b);
  #else
    uint16_t a_ = HEDLEY_STATIC_CAST(uint16_t, a);
    uint16_t b_ = HEDLEY_STATIC_CAST(uint16_t, b);
    uint16_t r_ = a_ - b_;

    a_ = (a_ >> 15) + INT16_MAX;

    if (HEDLEY_STATIC_CAST(int16_t, (a_ ^ b_) & (a_ ^ r_)) < 0) {
      r_ = a_;
    }

    return HEDLEY_STATIC_CAST(int16_t, r_);
  #endif
}

static HEDLEY_INLINE
int32_t
simde_math_subs_i32(int32_t a, int32_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqsubs_s32(a, b);
  #else
    uint32_t a_ = HEDLEY_STATIC_CAST(uint32_t, a);
    uint32_t b_ = HEDLEY_STATIC_CAST(uint32_t, b);
    uint32_t r_ = a_ - b_;

    a_ = (a_ >> 31) + INT32_MAX;

    if (HEDLEY_STATIC_CAST(int32_t, (a_ ^ b_) & (a_ ^ r_)) < 0) {
      r_ = a_;
    }

    return HEDLEY_STATIC_CAST(int32_t, r_);
  #endif
}

static HEDLEY_INLINE
int64_t
simde_math_subs_i64(int64_t a, int64_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqsubd_s64(a, b);
  #else
    uint64_t a_ = HEDLEY_STATIC_CAST(uint64_t, a);
    uint64_t b_ = HEDLEY_STATIC_CAST(uint64_t, b);
    uint64_t r_ = a_ - b_;

    a_ = (a_ >> 63) + INT64_MAX;

    if (HEDLEY_STATIC_CAST(int64_t, (a_ ^ b_) & (a_ ^ r_)) < 0) {
      r_ = a_;
    }

    return HEDLEY_STATIC_CAST(int64_t, r_);
  #endif
}

static HEDLEY_INLINE
uint8_t
simde_math_subs_u8(uint8_t a, uint8_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqsubb_u8(a, b);
  #else
    uint8_t res = a - b;
    res &= -(res <= a);
    return res;
  #endif
}

static HEDLEY_INLINE
uint16_t
simde_math_subs_u16(uint16_t a, uint16_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqsubh_u16(a, b);
  #else
    uint16_t res = a - b;
    res &= -(res <= a);
    return res;
  #endif
}

static HEDLEY_INLINE
uint32_t
simde_math_subs_u32(uint32_t a, uint32_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqsubs_u32(a, b);
  #else
    uint32_t res = a - b;
    res &= -(res <= a);
    return res;
  #endif
}

static HEDLEY_INLINE
uint64_t
simde_math_subs_u64(uint64_t a, uint64_t b) {
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    return vqsubd_u64(a, b);
  #else
    uint64_t res = a - b;
    res &= -(res <= a);
    return res;
  #endif
}

HEDLEY_DIAGNOSTIC_POP

#endif /* !defined(SIMDE_MATH_H) */
/* :: End simde/simde-math.h :: */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/simde-constify.h :: */
/* SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Copyright:
 *   2020      Evan Nemerson <evan@nemerson.com>
 */

/* Constify macros.  For internal use only.
 *
 * These are used to make it possible to call a function which takes
 * an Integer Constant Expression (ICE) using a compile time constant.
 * Technically it would also be possible to use a value not trivially
 * known by the compiler, but there would be a siginficant performance
 * hit (a switch switch is used).
 *
 * The basic idea is pretty simple; we just emit a do while loop which
 * contains a switch with a case for every possible value of the
 * constant.
 *
 * As long as the value you pass to the function in constant, pretty
 * much any copmiler shouldn't have a problem generating exactly the
 * same code as if you had used an ICE.
 *
 * This is intended to be used in the SIMDe implementations of
 * functions the compilers require to be an ICE, but the other benefit
 * is that if we also disable the warnings from
 * SIMDE_REQUIRE_CONSTANT_RANGE we can actually just allow the tests
 * to use non-ICE parameters
 */

#if !defined(SIMDE_CONSTIFY_H)
#define SIMDE_CONSTIFY_H

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */

HEDLEY_DIAGNOSTIC_PUSH
SIMDE_DIAGNOSTIC_DISABLE_VARIADIC_MACROS_
SIMDE_DIAGNOSTIC_DISABLE_CPP98_COMPAT_PEDANTIC_

#define SIMDE_CONSTIFY_2_(func_name, result, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case 0: result = func_name(__VA_ARGS__, 0); break; \
      case 1: result = func_name(__VA_ARGS__, 1); break; \
      default: result = default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_4_(func_name, result, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case 0: result = func_name(__VA_ARGS__, 0); break; \
      case 1: result = func_name(__VA_ARGS__, 1); break; \
      case 2: result = func_name(__VA_ARGS__, 2); break; \
      case 3: result = func_name(__VA_ARGS__, 3); break; \
      default: result = default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_8_(func_name, result, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case 0: result = func_name(__VA_ARGS__, 0); break; \
      case 1: result = func_name(__VA_ARGS__, 1); break; \
      case 2: result = func_name(__VA_ARGS__, 2); break; \
      case 3: result = func_name(__VA_ARGS__, 3); break; \
      case 4: result = func_name(__VA_ARGS__, 4); break; \
      case 5: result = func_name(__VA_ARGS__, 5); break; \
      case 6: result = func_name(__VA_ARGS__, 6); break; \
      case 7: result = func_name(__VA_ARGS__, 7); break; \
      default: result = default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_16_(func_name, result, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case  0: result = func_name(__VA_ARGS__,  0); break; \
      case  1: result = func_name(__VA_ARGS__,  1); break; \
      case  2: result = func_name(__VA_ARGS__,  2); break; \
      case  3: result = func_name(__VA_ARGS__,  3); break; \
      case  4: result = func_name(__VA_ARGS__,  4); break; \
      case  5: result = func_name(__VA_ARGS__,  5); break; \
      case  6: result = func_name(__VA_ARGS__,  6); break; \
      case  7: result = func_name(__VA_ARGS__,  7); break; \
      case  8: result = func_name(__VA_ARGS__,  8); break; \
      case  9: result = func_name(__VA_ARGS__,  9); break; \
      case 10: result = func_name(__VA_ARGS__, 10); break; \
      case 11: result = func_name(__VA_ARGS__, 11); break; \
      case 12: result = func_name(__VA_ARGS__, 12); break; \
      case 13: result = func_name(__VA_ARGS__, 13); break; \
      case 14: result = func_name(__VA_ARGS__, 14); break; \
      case 15: result = func_name(__VA_ARGS__, 15); break; \
      default: result = default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_32_(func_name, result, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case  0: result = func_name(__VA_ARGS__,  0); break; \
      case  1: result = func_name(__VA_ARGS__,  1); break; \
      case  2: result = func_name(__VA_ARGS__,  2); break; \
      case  3: result = func_name(__VA_ARGS__,  3); break; \
      case  4: result = func_name(__VA_ARGS__,  4); break; \
      case  5: result = func_name(__VA_ARGS__,  5); break; \
      case  6: result = func_name(__VA_ARGS__,  6); break; \
      case  7: result = func_name(__VA_ARGS__,  7); break; \
      case  8: result = func_name(__VA_ARGS__,  8); break; \
      case  9: result = func_name(__VA_ARGS__,  9); break; \
      case 10: result = func_name(__VA_ARGS__, 10); break; \
      case 11: result = func_name(__VA_ARGS__, 11); break; \
      case 12: result = func_name(__VA_ARGS__, 12); break; \
      case 13: result = func_name(__VA_ARGS__, 13); break; \
      case 14: result = func_name(__VA_ARGS__, 14); break; \
      case 15: result = func_name(__VA_ARGS__, 15); break; \
      case 16: result = func_name(__VA_ARGS__, 16); break; \
      case 17: result = func_name(__VA_ARGS__, 17); break; \
      case 18: result = func_name(__VA_ARGS__, 18); break; \
      case 19: result = func_name(__VA_ARGS__, 19); break; \
      case 20: result = func_name(__VA_ARGS__, 20); break; \
      case 21: result = func_name(__VA_ARGS__, 21); break; \
      case 22: result = func_name(__VA_ARGS__, 22); break; \
      case 23: result = func_name(__VA_ARGS__, 23); break; \
      case 24: result = func_name(__VA_ARGS__, 24); break; \
      case 25: result = func_name(__VA_ARGS__, 25); break; \
      case 26: result = func_name(__VA_ARGS__, 26); break; \
      case 27: result = func_name(__VA_ARGS__, 27); break; \
      case 28: result = func_name(__VA_ARGS__, 28); break; \
      case 29: result = func_name(__VA_ARGS__, 29); break; \
      case 30: result = func_name(__VA_ARGS__, 30); break; \
      case 31: result = func_name(__VA_ARGS__, 31); break; \
      default: result = default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_64_(func_name, result, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case  0: result = func_name(__VA_ARGS__,  0); break; \
      case  1: result = func_name(__VA_ARGS__,  1); break; \
      case  2: result = func_name(__VA_ARGS__,  2); break; \
      case  3: result = func_name(__VA_ARGS__,  3); break; \
      case  4: result = func_name(__VA_ARGS__,  4); break; \
      case  5: result = func_name(__VA_ARGS__,  5); break; \
      case  6: result = func_name(__VA_ARGS__,  6); break; \
      case  7: result = func_name(__VA_ARGS__,  7); break; \
      case  8: result = func_name(__VA_ARGS__,  8); break; \
      case  9: result = func_name(__VA_ARGS__,  9); break; \
      case 10: result = func_name(__VA_ARGS__, 10); break; \
      case 11: result = func_name(__VA_ARGS__, 11); break; \
      case 12: result = func_name(__VA_ARGS__, 12); break; \
      case 13: result = func_name(__VA_ARGS__, 13); break; \
      case 14: result = func_name(__VA_ARGS__, 14); break; \
      case 15: result = func_name(__VA_ARGS__, 15); break; \
      case 16: result = func_name(__VA_ARGS__, 16); break; \
      case 17: result = func_name(__VA_ARGS__, 17); break; \
      case 18: result = func_name(__VA_ARGS__, 18); break; \
      case 19: result = func_name(__VA_ARGS__, 19); break; \
      case 20: result = func_name(__VA_ARGS__, 20); break; \
      case 21: result = func_name(__VA_ARGS__, 21); break; \
      case 22: result = func_name(__VA_ARGS__, 22); break; \
      case 23: result = func_name(__VA_ARGS__, 23); break; \
      case 24: result = func_name(__VA_ARGS__, 24); break; \
      case 25: result = func_name(__VA_ARGS__, 25); break; \
      case 26: result = func_name(__VA_ARGS__, 26); break; \
      case 27: result = func_name(__VA_ARGS__, 27); break; \
      case 28: result = func_name(__VA_ARGS__, 28); break; \
      case 29: result = func_name(__VA_ARGS__, 29); break; \
      case 30: result = func_name(__VA_ARGS__, 30); break; \
      case 31: result = func_name(__VA_ARGS__, 31); break; \
      case 32: result = func_name(__VA_ARGS__, 32); break; \
      case 33: result = func_name(__VA_ARGS__, 33); break; \
      case 34: result = func_name(__VA_ARGS__, 34); break; \
      case 35: result = func_name(__VA_ARGS__, 35); break; \
      case 36: result = func_name(__VA_ARGS__, 36); break; \
      case 37: result = func_name(__VA_ARGS__, 37); break; \
      case 38: result = func_name(__VA_ARGS__, 38); break; \
      case 39: result = func_name(__VA_ARGS__, 39); break; \
      case 40: result = func_name(__VA_ARGS__, 40); break; \
      case 41: result = func_name(__VA_ARGS__, 41); break; \
      case 42: result = func_name(__VA_ARGS__, 42); break; \
      case 43: result = func_name(__VA_ARGS__, 43); break; \
      case 44: result = func_name(__VA_ARGS__, 44); break; \
      case 45: result = func_name(__VA_ARGS__, 45); break; \
      case 46: result = func_name(__VA_ARGS__, 46); break; \
      case 47: result = func_name(__VA_ARGS__, 47); break; \
      case 48: result = func_name(__VA_ARGS__, 48); break; \
      case 49: result = func_name(__VA_ARGS__, 49); break; \
      case 50: result = func_name(__VA_ARGS__, 50); break; \
      case 51: result = func_name(__VA_ARGS__, 51); break; \
      case 52: result = func_name(__VA_ARGS__, 52); break; \
      case 53: result = func_name(__VA_ARGS__, 53); break; \
      case 54: result = func_name(__VA_ARGS__, 54); break; \
      case 55: result = func_name(__VA_ARGS__, 55); break; \
      case 56: result = func_name(__VA_ARGS__, 56); break; \
      case 57: result = func_name(__VA_ARGS__, 57); break; \
      case 58: result = func_name(__VA_ARGS__, 58); break; \
      case 59: result = func_name(__VA_ARGS__, 59); break; \
      case 60: result = func_name(__VA_ARGS__, 60); break; \
      case 61: result = func_name(__VA_ARGS__, 61); break; \
      case 62: result = func_name(__VA_ARGS__, 62); break; \
      case 63: result = func_name(__VA_ARGS__, 63); break; \
      default: result = default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_2_NO_RESULT_(func_name, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case 0: func_name(__VA_ARGS__, 0); break; \
      case 1: func_name(__VA_ARGS__, 1); break; \
      default: default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_4_NO_RESULT_(func_name, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case 0: func_name(__VA_ARGS__, 0); break; \
      case 1: func_name(__VA_ARGS__, 1); break; \
      case 2: func_name(__VA_ARGS__, 2); break; \
      case 3: func_name(__VA_ARGS__, 3); break; \
      default: default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_8_NO_RESULT_(func_name, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case 0: func_name(__VA_ARGS__, 0); break; \
      case 1: func_name(__VA_ARGS__, 1); break; \
      case 2: func_name(__VA_ARGS__, 2); break; \
      case 3: func_name(__VA_ARGS__, 3); break; \
      case 4: func_name(__VA_ARGS__, 4); break; \
      case 5: func_name(__VA_ARGS__, 5); break; \
      case 6: func_name(__VA_ARGS__, 6); break; \
      case 7: func_name(__VA_ARGS__, 7); break; \
      default: default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_16_NO_RESULT_(func_name, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case  0: func_name(__VA_ARGS__,  0); break; \
      case  1: func_name(__VA_ARGS__,  1); break; \
      case  2: func_name(__VA_ARGS__,  2); break; \
      case  3: func_name(__VA_ARGS__,  3); break; \
      case  4: func_name(__VA_ARGS__,  4); break; \
      case  5: func_name(__VA_ARGS__,  5); break; \
      case  6: func_name(__VA_ARGS__,  6); break; \
      case  7: func_name(__VA_ARGS__,  7); break; \
      case  8: func_name(__VA_ARGS__,  8); break; \
      case  9: func_name(__VA_ARGS__,  9); break; \
      case 10: func_name(__VA_ARGS__, 10); break; \
      case 11: func_name(__VA_ARGS__, 11); break; \
      case 12: func_name(__VA_ARGS__, 12); break; \
      case 13: func_name(__VA_ARGS__, 13); break; \
      case 14: func_name(__VA_ARGS__, 14); break; \
      case 15: func_name(__VA_ARGS__, 15); break; \
      default: default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_32_NO_RESULT_(func_name, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case  0: func_name(__VA_ARGS__,  0); break; \
      case  1: func_name(__VA_ARGS__,  1); break; \
      case  2: func_name(__VA_ARGS__,  2); break; \
      case  3: func_name(__VA_ARGS__,  3); break; \
      case  4: func_name(__VA_ARGS__,  4); break; \
      case  5: func_name(__VA_ARGS__,  5); break; \
      case  6: func_name(__VA_ARGS__,  6); break; \
      case  7: func_name(__VA_ARGS__,  7); break; \
      case  8: func_name(__VA_ARGS__,  8); break; \
      case  9: func_name(__VA_ARGS__,  9); break; \
      case 10: func_name(__VA_ARGS__, 10); break; \
      case 11: func_name(__VA_ARGS__, 11); break; \
      case 12: func_name(__VA_ARGS__, 12); break; \
      case 13: func_name(__VA_ARGS__, 13); break; \
      case 14: func_name(__VA_ARGS__, 14); break; \
      case 15: func_name(__VA_ARGS__, 15); break; \
      case 16: func_name(__VA_ARGS__, 16); break; \
      case 17: func_name(__VA_ARGS__, 17); break; \
      case 18: func_name(__VA_ARGS__, 18); break; \
      case 19: func_name(__VA_ARGS__, 19); break; \
      case 20: func_name(__VA_ARGS__, 20); break; \
      case 21: func_name(__VA_ARGS__, 21); break; \
      case 22: func_name(__VA_ARGS__, 22); break; \
      case 23: func_name(__VA_ARGS__, 23); break; \
      case 24: func_name(__VA_ARGS__, 24); break; \
      case 25: func_name(__VA_ARGS__, 25); break; \
      case 26: func_name(__VA_ARGS__, 26); break; \
      case 27: func_name(__VA_ARGS__, 27); break; \
      case 28: func_name(__VA_ARGS__, 28); break; \
      case 29: func_name(__VA_ARGS__, 29); break; \
      case 30: func_name(__VA_ARGS__, 30); break; \
      case 31: func_name(__VA_ARGS__, 31); break; \
      default: default_case; break; \
    } \
  } while (0)

#define SIMDE_CONSTIFY_64_NO_RESULT_(func_name, default_case, imm, ...) \
  do { \
    switch(imm) { \
      case  0: func_name(__VA_ARGS__,  0); break; \
      case  1: func_name(__VA_ARGS__,  1); break; \
      case  2: func_name(__VA_ARGS__,  2); break; \
      case  3: func_name(__VA_ARGS__,  3); break; \
      case  4: func_name(__VA_ARGS__,  4); break; \
      case  5: func_name(__VA_ARGS__,  5); break; \
      case  6: func_name(__VA_ARGS__,  6); break; \
      case  7: func_name(__VA_ARGS__,  7); break; \
      case  8: func_name(__VA_ARGS__,  8); break; \
      case  9: func_name(__VA_ARGS__,  9); break; \
      case 10: func_name(__VA_ARGS__, 10); break; \
      case 11: func_name(__VA_ARGS__, 11); break; \
      case 12: func_name(__VA_ARGS__, 12); break; \
      case 13: func_name(__VA_ARGS__, 13); break; \
      case 14: func_name(__VA_ARGS__, 14); break; \
      case 15: func_name(__VA_ARGS__, 15); break; \
      case 16: func_name(__VA_ARGS__, 16); break; \
      case 17: func_name(__VA_ARGS__, 17); break; \
      case 18: func_name(__VA_ARGS__, 18); break; \
      case 19: func_name(__VA_ARGS__, 19); break; \
      case 20: func_name(__VA_ARGS__, 20); break; \
      case 21: func_name(__VA_ARGS__, 21); break; \
      case 22: func_name(__VA_ARGS__, 22); break; \
      case 23: func_name(__VA_ARGS__, 23); break; \
      case 24: func_name(__VA_ARGS__, 24); break; \
      case 25: func_name(__VA_ARGS__, 25); break; \
      case 26: func_name(__VA_ARGS__, 26); break; \
      case 27: func_name(__VA_ARGS__, 27); break; \
      case 28: func_name(__VA_ARGS__, 28); break; \
      case 29: func_name(__VA_ARGS__, 29); break; \
      case 30: func_name(__VA_ARGS__, 30); break; \
      case 31: func_name(__VA_ARGS__, 31); break; \
      case 32: func_name(__VA_ARGS__, 32); break; \
      case 33: func_name(__VA_ARGS__, 33); break; \
      case 34: func_name(__VA_ARGS__, 34); break; \
      case 35: func_name(__VA_ARGS__, 35); break; \
      case 36: func_name(__VA_ARGS__, 36); break; \
      case 37: func_name(__VA_ARGS__, 37); break; \
      case 38: func_name(__VA_ARGS__, 38); break; \
      case 39: func_name(__VA_ARGS__, 39); break; \
      case 40: func_name(__VA_ARGS__, 40); break; \
      case 41: func_name(__VA_ARGS__, 41); break; \
      case 42: func_name(__VA_ARGS__, 42); break; \
      case 43: func_name(__VA_ARGS__, 43); break; \
      case 44: func_name(__VA_ARGS__, 44); break; \
      case 45: func_name(__VA_ARGS__, 45); break; \
      case 46: func_name(__VA_ARGS__, 46); break; \
      case 47: func_name(__VA_ARGS__, 47); break; \
      case 48: func_name(__VA_ARGS__, 48); break; \
      case 49: func_name(__VA_ARGS__, 49); break; \
      case 50: func_name(__VA_ARGS__, 50); break; \
      case 51: func_name(__VA_ARGS__, 51); break; \
      case 52: func_name(__VA_ARGS__, 52); break; \
      case 53: func_name(__VA_ARGS__, 53); break; \
      case 54: func_name(__VA_ARGS__, 54); break; \
      case 55: func_name(__VA_ARGS__, 55); break; \
      case 56: func_name(__VA_ARGS__, 56); break; \
      case 57: func_name(__VA_ARGS__, 57); break; \
      case 58: func_name(__VA_ARGS__, 58); break; \
      case 59: func_name(__VA_ARGS__, 59); break; \
      case 60: func_name(__VA_ARGS__, 60); break; \
      case 61: func_name(__VA_ARGS__, 61); break; \
      case 62: func_name(__VA_ARGS__, 62); break; \
      case 63: func_name(__VA_ARGS__, 63); break; \
      default: default_case; break; \
    } \
  } while (0)

HEDLEY_DIAGNOSTIC_POP

#endif
/* :: End simde/simde-constify.h :: */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/simde-align.h :: */
/* Alignment
 * Created by Evan Nemerson <evan@nemerson.com>
 *
 *   To the extent possible under law, the authors have waived all
 *   copyright and related or neighboring rights to this code.  For
 *   details, see the Creative Commons Zero 1.0 Universal license at
 *   <https://creativecommons.org/publicdomain/zero/1.0/>
 *
 * SPDX-License-Identifier: CC0-1.0
 *
 **********************************************************************
 *
 * This is portability layer which should help iron out some
 * differences across various compilers, as well as various versions of
 * C and C++.
 *
 * It was originally developed for SIMD Everywhere
 * (<https://github.com/simd-everywhere/simde>), but since its only
 * dependency is Hedley (<https://nemequ.github.io/hedley>, also CC0)
 * it can easily be used in other projects, so please feel free to do
 * so.
 *
 * If you do use this in your project, please keep a link to SIMDe in
 * your code to remind you where to report any bugs and/or check for
 * updated versions.
 *
 * # API Overview
 *
 * The API has several parts, and most macros have a few variations.
 * There are APIs for declaring aligned fields/variables, optimization
 * hints, and run-time alignment checks.
 *
 * Briefly, macros ending with "_TO" take numeric values and are great
 * when you know the value you would like to use.  Macros ending with
 * "_LIKE", on the other hand, accept a type and are used when you want
 * to use the alignment of a type instead of hardcoding a value.
 *
 * Documentation for each section of the API is inline.
 *
 * True to form, MSVC is the main problem and imposes several
 * limitations on the effectiveness of the APIs.  Detailed descriptions
 * of the limitations of each macro are inline, but in general:
 *
 *  * On C11+ or C++11+ code written using this API will work.  The
 *    ASSUME macros may or may not generate a hint to the compiler, but
 *    that is only an optimization issue and will not actually cause
 *    failures.
 *  * If you're using pretty much any compiler other than MSVC,
 *    everything should basically work as well as in C11/C++11.
 */

#if !defined(SIMDE_ALIGN_H)
#define SIMDE_ALIGN_H

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */

/* I know this seems a little silly, but some non-hosted compilers
 * don't have stddef.h, so we try to accommodate them. */
#if !defined(SIMDE_ALIGN_SIZE_T_)
  #if defined(__SIZE_TYPE__)
    #define SIMDE_ALIGN_SIZE_T_ __SIZE_TYPE__
  #elif defined(__SIZE_T_TYPE__)
    #define SIMDE_ALIGN_SIZE_T_ __SIZE_TYPE__
  #elif defined(__cplusplus)
    #include <cstddef>
    #define SIMDE_ALIGN_SIZE_T_ size_t
  #else
    #include <stddef.h>
    #define SIMDE_ALIGN_SIZE_T_ size_t
  #endif
#endif

#if !defined(SIMDE_ALIGN_INTPTR_T_)
  #if defined(__INTPTR_TYPE__)
    #define SIMDE_ALIGN_INTPTR_T_ __INTPTR_TYPE__
  #elif defined(__PTRDIFF_TYPE__)
    #define SIMDE_ALIGN_INTPTR_T_ __PTRDIFF_TYPE__
  #elif defined(__PTRDIFF_T_TYPE__)
    #define SIMDE_ALIGN_INTPTR_T_ __PTRDIFF_T_TYPE__
  #elif defined(__cplusplus)
    #include <cstddef>
    #define SIMDE_ALIGN_INTPTR_T_ ptrdiff_t
  #else
    #include <stddef.h>
    #define SIMDE_ALIGN_INTPTR_T_ ptrdiff_t
  #endif
#endif

#if defined(SIMDE_ALIGN_DEBUG)
  #if defined(__cplusplus)
    #include <cstdio>
  #else
    #include <stdio.h>
  #endif
#endif

/* SIMDE_ALIGN_OF(Type)
 *
 * The SIMDE_ALIGN_OF macro works like alignof, or _Alignof, or
 * __alignof, or __alignof__, or __ALIGNOF__, depending on the compiler.
 * It isn't defined everywhere (only when the compiler has some alignof-
 * like feature we can use to implement it), but it should work in most
 * modern compilers, as well as C11 and C++11.
 *
 * If we can't find an implementation for SIMDE_ALIGN_OF then the macro
 * will not be defined, so if you can handle that situation sensibly
 * you may need to sprinkle some ifdefs into your code.
 */
#if \
    (defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)) || \
    (0 && HEDLEY_HAS_FEATURE(c_alignof))
  #define SIMDE_ALIGN_OF(Type) _Alignof(Type)
#elif \
    (defined(__cplusplus) && (__cplusplus >= 201103L)) || \
    (0 && HEDLEY_HAS_FEATURE(cxx_alignof))
  #define SIMDE_ALIGN_OF(Type) alignof(Type)
#elif \
    HEDLEY_GCC_VERSION_CHECK(2,95,0) || \
    HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
    HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
    HEDLEY_SUNPRO_VERSION_CHECK(5,13,0) || \
    HEDLEY_TINYC_VERSION_CHECK(0,9,24) || \
    HEDLEY_PGI_VERSION_CHECK(19,10,0) || \
    HEDLEY_CRAY_VERSION_CHECK(10,0,0) || \
    HEDLEY_TI_ARMCL_VERSION_CHECK(16,9,0) || \
    HEDLEY_TI_CL2000_VERSION_CHECK(16,9,0) || \
    HEDLEY_TI_CL6X_VERSION_CHECK(8,0,0) || \
    HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
    HEDLEY_TI_CL430_VERSION_CHECK(16,9,0) || \
    HEDLEY_TI_CLPRU_VERSION_CHECK(2,3,2) || \
    HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10) || \
    defined(__IBM__ALIGNOF__) || \
    defined(__clang__)
  #define SIMDE_ALIGN_OF(Type) __alignof__(Type)
#elif \
  HEDLEY_IAR_VERSION_CHECK(8,40,0)
  #define SIMDE_ALIGN_OF(Type) __ALIGNOF__(Type)
#elif \
  HEDLEY_MSVC_VERSION_CHECK(19,0,0)
  /* Probably goes back much further, but MS takes down their old docs.
   * If you can verify that this works in earlier versions please let
   * me know! */
  #define SIMDE_ALIGN_OF(Type) __alignof(Type)
#endif

/* SIMDE_ALIGN_MAXIMUM:
 *
 * This is the maximum alignment that the compiler supports.  You can
 * define the value prior to including SIMDe if necessary, but in that
 * case *please* submit an issue so we can add the platform to the
 * detection code.
 *
 * Most compilers are okay with types which are aligned beyond what
 * they think is the maximum, as long as the alignment is a power
 * of two.  Older versions of MSVC is the exception, so we need to cap
 * the alignment requests at values that the implementation supports.
 *
 * XL C/C++ will accept values larger than 16 (which is the alignment
 * of an AltiVec vector), but will not reliably align to the larger
 * value, so so we cap the value at 16 there.
 *
 * If the compiler accepts any power-of-two value within reason then
 * this macro should be left undefined, and the SIMDE_ALIGN_CAP
 * macro will just return the value passed to it. */
#if !defined(SIMDE_ALIGN_MAXIMUM)
  #if defined(HEDLEY_MSVC_VERSION)
    #if HEDLEY_MSVC_VERSION_CHECK(19, 16, 0)
      // Visual studio 2017 and newer does not need a max
    #else
      #if defined(_M_IX86) || defined(_M_AMD64)
        #if HEDLEY_MSVC_VERSION_CHECK(19,14,0)
          #define SIMDE_ALIGN_PLATFORM_MAXIMUM 64
        #elif HEDLEY_MSVC_VERSION_CHECK(16,0,0)
          /* VS 2010 is really a guess based on Wikipedia; if anyone can
           * test with old VS versions I'd really appreciate it. */
          #define SIMDE_ALIGN_PLATFORM_MAXIMUM 32
        #else
          #define SIMDE_ALIGN_PLATFORM_MAXIMUM 16
        #endif
      #elif defined(_M_ARM) || defined(_M_ARM64)
        #define SIMDE_ALIGN_PLATFORM_MAXIMUM 8
      #endif
    #endif
  #elif defined(HEDLEY_IBM_VERSION)
    #define SIMDE_ALIGN_PLATFORM_MAXIMUM 16
  #endif
#endif

/* You can mostly ignore these; they're intended for internal use.
 * If you do need to use them please let me know; if they fulfill
 * a common use case I'll probably drop the trailing underscore
 * and make them part of the public API. */
#if defined(SIMDE_ALIGN_PLATFORM_MAXIMUM)
  #if SIMDE_ALIGN_PLATFORM_MAXIMUM >= 64
    #define SIMDE_ALIGN_64_ 64
    #define SIMDE_ALIGN_32_ 32
    #define SIMDE_ALIGN_16_ 16
    #define SIMDE_ALIGN_8_ 8
  #elif SIMDE_ALIGN_PLATFORM_MAXIMUM >= 32
    #define SIMDE_ALIGN_64_ 32
    #define SIMDE_ALIGN_32_ 32
    #define SIMDE_ALIGN_16_ 16
    #define SIMDE_ALIGN_8_ 8
  #elif SIMDE_ALIGN_PLATFORM_MAXIMUM >= 16
    #define SIMDE_ALIGN_64_ 16
    #define SIMDE_ALIGN_32_ 16
    #define SIMDE_ALIGN_16_ 16
    #define SIMDE_ALIGN_8_ 8
  #elif SIMDE_ALIGN_PLATFORM_MAXIMUM >= 8
    #define SIMDE_ALIGN_64_ 8
    #define SIMDE_ALIGN_32_ 8
    #define SIMDE_ALIGN_16_ 8
    #define SIMDE_ALIGN_8_ 8
  #else
    #error Max alignment expected to be >= 8
  #endif
#else
  #define SIMDE_ALIGN_64_ 64
  #define SIMDE_ALIGN_32_ 32
  #define SIMDE_ALIGN_16_ 16
  #define SIMDE_ALIGN_8_ 8
#endif

/**
 * SIMDE_ALIGN_CAP(Alignment)
 *
 * Returns the minimum of Alignment or SIMDE_ALIGN_MAXIMUM.
 */
#if defined(SIMDE_ALIGN_MAXIMUM)
  #define SIMDE_ALIGN_CAP(Alignment) (((Alignment) < (SIMDE_ALIGN_PLATFORM_MAXIMUM)) ? (Alignment) : (SIMDE_ALIGN_PLATFORM_MAXIMUM))
#else
  #define SIMDE_ALIGN_CAP(Alignment) (Alignment)
#endif

/* SIMDE_ALIGN_TO(Alignment)
 *
 * SIMDE_ALIGN_TO is used to declare types or variables.  It basically
 * maps to the align attribute in most compilers, the align declspec
 * in MSVC, or _Alignas/alignas in C11/C++11.
 *
 * Example:
 *
 *   struct i32x4 {
 *     SIMDE_ALIGN_TO(16) int32_t values[4];
 *   }
 *
 * Limitations:
 *
 * MSVC requires that the Alignment parameter be numeric; you can't do
 * something like `SIMDE_ALIGN_TO(SIMDE_ALIGN_OF(int))`.  This is
 * unfortunate because that's really how the LIKE macros are
 * implemented, and I am not aware of a way to get anything like this
 * to work without using the C11/C++11 keywords.
 *
 * It also means that we can't use SIMDE_ALIGN_CAP to limit the
 * alignment to the value specified, which MSVC also requires, so on
 * MSVC you should use the `SIMDE_ALIGN_TO_8/16/32/64` macros instead.
 * They work like `SIMDE_ALIGN_TO(SIMDE_ALIGN_CAP(Alignment))` would,
 * but should be safe to use on MSVC.
 *
 * All this is to say that, if you want your code to work on MSVC, you
 * should use the SIMDE_ALIGN_TO_8/16/32/64 macros below instead of
 * SIMDE_ALIGN_TO(8/16/32/64).
 */
#if \
    HEDLEY_HAS_ATTRIBUTE(aligned) || \
    HEDLEY_GCC_VERSION_CHECK(2,95,0) || \
    HEDLEY_CRAY_VERSION_CHECK(8,4,0) || \
    HEDLEY_IBM_VERSION_CHECK(11,1,0) || \
    HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
    HEDLEY_PGI_VERSION_CHECK(19,4,0) || \
    HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
    HEDLEY_TINYC_VERSION_CHECK(0,9,24) || \
    HEDLEY_TI_ARMCL_VERSION_CHECK(16,9,0) || \
    HEDLEY_TI_CL2000_VERSION_CHECK(16,9,0) || \
    HEDLEY_TI_CL6X_VERSION_CHECK(8,0,0) || \
    HEDLEY_TI_CL7X_VERSION_CHECK(1,2,0) || \
    HEDLEY_TI_CL430_VERSION_CHECK(16,9,0) || \
    HEDLEY_TI_CLPRU_VERSION_CHECK(2,3,2)
  #define SIMDE_ALIGN_TO(Alignment) __attribute__((__aligned__(SIMDE_ALIGN_CAP(Alignment))))
#elif \
    (defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L))
  #define SIMDE_ALIGN_TO(Alignment) _Alignas(SIMDE_ALIGN_CAP(Alignment))
#elif \
    (defined(__cplusplus) && (__cplusplus >= 201103L))
  #define SIMDE_ALIGN_TO(Alignment) alignas(SIMDE_ALIGN_CAP(Alignment))
#elif \
    defined(HEDLEY_MSVC_VERSION)
  #define SIMDE_ALIGN_TO(Alignment) __declspec(align(Alignment))
  /* Unfortunately MSVC can't handle __declspec(align(__alignof(Type)));
   * the alignment passed to the declspec has to be an integer. */
  #define SIMDE_ALIGN_OF_UNUSABLE_FOR_LIKE
#endif
#define SIMDE_ALIGN_TO_64 SIMDE_ALIGN_TO(SIMDE_ALIGN_64_)
#define SIMDE_ALIGN_TO_32 SIMDE_ALIGN_TO(SIMDE_ALIGN_32_)
#define SIMDE_ALIGN_TO_16 SIMDE_ALIGN_TO(SIMDE_ALIGN_16_)
#define SIMDE_ALIGN_TO_8 SIMDE_ALIGN_TO(SIMDE_ALIGN_8_)

/* SIMDE_ALIGN_ASSUME_TO(Pointer, Alignment)
 *
 * SIMDE_ALIGN_ASSUME_TO is semantically similar to C++20's
 * std::assume_aligned, or __builtin_assume_aligned.  It tells the
 * compiler to assume that the provided pointer is aligned to an
 * `Alignment`-byte boundary.
 *
 * If you define SIMDE_ALIGN_DEBUG prior to including this header then
 * SIMDE_ALIGN_ASSUME_TO will turn into a runtime check.   We don't
 * integrate with NDEBUG in this header, but it may be a good idea to
 * put something like this in your code:
 *
 *   #if !defined(NDEBUG)
 *     #define SIMDE_ALIGN_DEBUG
 *   #endif
 *   #include <.../simde-align.h>
 */
#if \
    HEDLEY_HAS_BUILTIN(__builtin_assume_aligned) || \
    HEDLEY_GCC_VERSION_CHECK(4,7,0)
  #define SIMDE_ALIGN_ASSUME_TO_UNCHECKED(Pointer, Alignment) \
    HEDLEY_REINTERPRET_CAST(__typeof__(Pointer), __builtin_assume_aligned(HEDLEY_CONST_CAST(void*, HEDLEY_REINTERPRET_CAST(const void*, Pointer)), Alignment))
#elif HEDLEY_INTEL_VERSION_CHECK(13,0,0)
  #define SIMDE_ALIGN_ASSUME_TO_UNCHECKED(Pointer, Alignment) (__extension__ ({ \
      __typeof__(v) simde_assume_aligned_t_ = (Pointer); \
      __assume_aligned(simde_assume_aligned_t_, Alignment); \
      simde_assume_aligned_t_; \
    }))
#elif defined(__cplusplus) && (__cplusplus > 201703L)
  #include <memory>
  #define SIMDE_ALIGN_ASSUME_TO_UNCHECKED(Pointer, Alignment) std::assume_aligned<Alignment>(Pointer)
#else
  #if defined(__cplusplus)
    template<typename T> HEDLEY_ALWAYS_INLINE static T* simde_align_assume_to_unchecked(T* ptr, const size_t alignment)
  #else
    HEDLEY_ALWAYS_INLINE static void* simde_align_assume_to_unchecked(void* ptr, const size_t alignment)
  #endif
  {
    HEDLEY_ASSUME((HEDLEY_REINTERPRET_CAST(size_t, (ptr)) % SIMDE_ALIGN_CAP(alignment)) == 0);
    return ptr;
  }
  #if defined(__cplusplus)
    #define SIMDE_ALIGN_ASSUME_TO_UNCHECKED(Pointer, Alignment) simde_align_assume_to_unchecked((Pointer), (Alignment))
  #else
    #define SIMDE_ALIGN_ASSUME_TO_UNCHECKED(Pointer, Alignment) simde_align_assume_to_unchecked(HEDLEY_CONST_CAST(void*, HEDLEY_REINTERPRET_CAST(const void*, Pointer)), (Alignment))
  #endif
#endif

#if !defined(SIMDE_ALIGN_DEBUG)
  #define SIMDE_ALIGN_ASSUME_TO(Pointer, Alignment) SIMDE_ALIGN_ASSUME_TO_UNCHECKED(Pointer, Alignment)
#else
  #include <stdio.h>
  #if defined(__cplusplus)
    template<typename T>
    static HEDLEY_ALWAYS_INLINE
    T*
    simde_align_assume_to_checked_uncapped(T* ptr, const size_t alignment, const char* file, int line, const char* ptrname)
  #else
    static HEDLEY_ALWAYS_INLINE
    void*
    simde_align_assume_to_checked_uncapped(void* ptr, const size_t alignment, const char* file, int line, const char* ptrname)
  #endif
  {
    if (HEDLEY_UNLIKELY((HEDLEY_REINTERPRET_CAST(SIMDE_ALIGN_INTPTR_T_, (ptr)) % HEDLEY_STATIC_CAST(SIMDE_ALIGN_INTPTR_T_, SIMDE_ALIGN_CAP(alignment))) != 0)) {
      fprintf(stderr, "%s:%d: alignment check failed for `%s' (%p %% %u == %u)\n",
        file, line, ptrname, HEDLEY_REINTERPRET_CAST(const void*, ptr),
        HEDLEY_STATIC_CAST(unsigned int, SIMDE_ALIGN_CAP(alignment)),
        HEDLEY_STATIC_CAST(unsigned int, HEDLEY_REINTERPRET_CAST(SIMDE_ALIGN_INTPTR_T_, (ptr)) % HEDLEY_STATIC_CAST(SIMDE_ALIGN_INTPTR_T_, SIMDE_ALIGN_CAP(alignment))));
    }

    return ptr;
  }

  #if defined(__cplusplus)
    #define SIMDE_ALIGN_ASSUME_TO(Pointer, Alignment) simde_align_assume_to_checked_uncapped((Pointer), (Alignment), __FILE__, __LINE__, #Pointer)
  #else
    #define SIMDE_ALIGN_ASSUME_TO(Pointer, Alignment) simde_align_assume_to_checked_uncapped(HEDLEY_CONST_CAST(void*, HEDLEY_REINTERPRET_CAST(const void*, Pointer)), (Alignment), __FILE__, __LINE__, #Pointer)
  #endif
#endif

/* SIMDE_ALIGN_LIKE(Type)
 * SIMDE_ALIGN_LIKE_#(Type)
 *
 * The SIMDE_ALIGN_LIKE macros are similar to the SIMDE_ALIGN_TO macros
 * except instead of an integer they take a type; basically, it's just
 * a more convenient way to do something like:
 *
 *   SIMDE_ALIGN_TO(SIMDE_ALIGN_OF(Type))
 *
 * The versions with a numeric suffix will fall back on using a numeric
 * value in the event we can't use SIMDE_ALIGN_OF(Type).  This is
 * mainly for MSVC, where __declspec(align()) can't handle anything
 * other than hard-coded numeric values.
 */
#if defined(SIMDE_ALIGN_OF) && defined(SIMDE_ALIGN_TO) && !defined(SIMDE_ALIGN_OF_UNUSABLE_FOR_LIKE)
  #define SIMDE_ALIGN_LIKE(Type) SIMDE_ALIGN_TO(SIMDE_ALIGN_OF(Type))
  #define SIMDE_ALIGN_LIKE_64(Type) SIMDE_ALIGN_LIKE(Type)
  #define SIMDE_ALIGN_LIKE_32(Type) SIMDE_ALIGN_LIKE(Type)
  #define SIMDE_ALIGN_LIKE_16(Type) SIMDE_ALIGN_LIKE(Type)
  #define SIMDE_ALIGN_LIKE_8(Type) SIMDE_ALIGN_LIKE(Type)
#else
  #define SIMDE_ALIGN_LIKE_64(Type) SIMDE_ALIGN_TO_64
  #define SIMDE_ALIGN_LIKE_32(Type) SIMDE_ALIGN_TO_32
  #define SIMDE_ALIGN_LIKE_16(Type) SIMDE_ALIGN_TO_16
  #define SIMDE_ALIGN_LIKE_8(Type) SIMDE_ALIGN_TO_8
#endif

/* SIMDE_ALIGN_ASSUME_LIKE(Pointer, Type)
 *
 * This is similar to SIMDE_ALIGN_ASSUME_TO, except that it takes a
 * type instead of a numeric value. */
#if defined(SIMDE_ALIGN_OF) && defined(SIMDE_ALIGN_ASSUME_TO)
  #define SIMDE_ALIGN_ASSUME_LIKE(Pointer, Type) SIMDE_ALIGN_ASSUME_TO(Pointer, SIMDE_ALIGN_OF(Type))
#endif

/* SIMDE_ALIGN_CAST(Type, Pointer)
 *
 * SIMDE_ALIGN_CAST is like C++'s reinterpret_cast, but it will try
 * to silence warnings that some compilers may produce if you try
 * to assign to a type with increased alignment requirements.
 *
 * Note that it does *not* actually attempt to tell the compiler that
 * the pointer is aligned like the destination should be; that's the
 * job of the next macro.  This macro is necessary for stupid APIs
 * like _mm_loadu_si128 where the input is a __m128i* but the function
 * is specifically for data which isn't necessarily aligned to
 * _Alignof(__m128i).
 */
#if HEDLEY_HAS_WARNING("-Wcast-align") || defined(__clang__) || HEDLEY_GCC_VERSION_CHECK(3,4,0)
  #define SIMDE_ALIGN_CAST(Type, Pointer) (__extension__({ \
      HEDLEY_DIAGNOSTIC_PUSH \
      _Pragma("GCC diagnostic ignored \"-Wcast-align\"") \
      Type simde_r_ = HEDLEY_REINTERPRET_CAST(Type, Pointer); \
      HEDLEY_DIAGNOSTIC_POP \
      simde_r_; \
    }))
#else
  #define SIMDE_ALIGN_CAST(Type, Pointer) HEDLEY_REINTERPRET_CAST(Type, Pointer)
#endif

/* SIMDE_ALIGN_ASSUME_CAST(Type, Pointer)
 *
 * This is sort of like a combination of a reinterpret_cast and a
 * SIMDE_ALIGN_ASSUME_LIKE.  It uses SIMDE_ALIGN_ASSUME_LIKE to tell
 * the compiler that the pointer is aligned like the specified type
 * and casts the pointer to the specified type while suppressing any
 * warnings from the compiler about casting to a type with greater
 * alignment requirements.
 */
#define SIMDE_ALIGN_ASSUME_CAST(Type, Pointer) SIMDE_ALIGN_ASSUME_LIKE(SIMDE_ALIGN_CAST(Type, Pointer), Type)

#endif /* !defined(SIMDE_ALIGN_H) */
/* :: End simde/simde-align.h :: */

/* In some situations, SIMDe has to make large performance sacrifices
 * for small increases in how faithfully it reproduces an API, but
 * only a relatively small number of users will actually need the API
 * to be completely accurate.  The SIMDE_FAST_* options can be used to
 * disable these trade-offs.
 *
 * They can be enabled by passing -DSIMDE_FAST_MATH to the compiler, or
 * the individual defines (e.g., -DSIMDE_FAST_NANS) if you only want to
 * enable some optimizations.  Using -ffast-math and/or
 * -ffinite-math-only will also enable the relevant options.  If you
 * don't want that you can pass -DSIMDE_NO_FAST_* to disable them. */

/* Most programs avoid NaNs by never passing values which can result in
 * a NaN; for example, if you only pass non-negative values to the sqrt
 * functions, it won't generate a NaN.  On some platforms, similar
 * functions handle NaNs differently; for example, the _mm_min_ps SSE
 * function will return 0.0 if you pass it (0.0, NaN), but the NEON
 * vminq_f32 function will return NaN.  Making them behave like one
 * another is expensive; it requires generating a mask of all lanes
 * with NaNs, then performing the operation (e.g., vminq_f32), then
 * blending together the result with another vector using the mask.
 *
 * If you don't want SIMDe to worry about the differences between how
 * NaNs are handled on the two platforms, define this (or pass
 * -ffinite-math-only) */
#if !defined(SIMDE_FAST_MATH) && !defined(SIMDE_NO_FAST_MATH) && defined(__FAST_MATH__)
  #define SIMDE_FAST_MATH
#endif

#if !defined(SIMDE_FAST_NANS) && !defined(SIMDE_NO_FAST_NANS)
  #if defined(SIMDE_FAST_MATH)
    #define SIMDE_FAST_NANS
  #elif defined(__FINITE_MATH_ONLY__)
    #if __FINITE_MATH_ONLY__
      #define SIMDE_FAST_NANS
    #endif
  #endif
#endif

/* Many functions are defined as using the current rounding mode
 * (i.e., the SIMD version of fegetround()) when converting to
 * an integer.  For example, _mm_cvtpd_epi32.  Unfortunately,
 * on some platforms (such as ARMv8+ where round-to-nearest is
 * always used, regardless of the FPSCR register) this means we
 * have to first query the current rounding mode, then choose
 * the proper function (rounnd
 , ceil, floor, etc.) */
#if !defined(SIMDE_FAST_ROUND_MODE) && !defined(SIMDE_NO_FAST_ROUND_MODE) && defined(SIMDE_FAST_MATH)
  #define SIMDE_FAST_ROUND_MODE
#endif

/* This controls how ties are rounded.  For example, does 10.5 round to
 * 10 or 11?  IEEE 754 specifies round-towards-even, but ARMv7 (for
 * example) doesn't support it and it must be emulated (which is rather
 * slow).  If you're okay with just using the default for whatever arch
 * you're on, you should definitely define this.
 *
 * Note that we don't use this macro to avoid correct implementations
 * in functions which are explicitly about rounding (such as vrnd* on
 * NEON, _mm_round_* on x86, etc.); it is only used for code where
 * rounding is a component in another function, and even then it isn't
 * usually a problem since such functions will use the current rounding
 * mode. */
#if !defined(SIMDE_FAST_ROUND_TIES) && !defined(SIMDE_NO_FAST_ROUND_TIES) && defined(SIMDE_FAST_MATH)
  #define SIMDE_FAST_ROUND_TIES
#endif

/* For functions which convert from one type to another (mostly from
 * floating point to integer types), sometimes we need to do a range
 * check and potentially return a different result if the value
 * falls outside that range.  Skipping this check can provide a
 * performance boost, at the expense of faithfulness to the API we're
 * emulating. */
#if !defined(SIMDE_FAST_CONVERSION_RANGE) && !defined(SIMDE_NO_FAST_CONVERSION_RANGE) && defined(SIMDE_FAST_MATH)
  #define SIMDE_FAST_CONVERSION_RANGE
#endif

/* Due to differences across platforms, sometimes it can be much
 * faster for us to allow spurious floating point exceptions,
 * or to no generate them when we should. */
#if !defined(SIMDE_FAST_EXCEPTIONS) && !defined(SIMDE_NO_FAST_EXCEPTIONS) && defined(SIMDE_FAST_MATH)
  #define SIMDE_FAST_EXCEPTIONS
#endif

#if \
    HEDLEY_HAS_BUILTIN(__builtin_constant_p) || \
    HEDLEY_GCC_VERSION_CHECK(3,4,0) || \
    HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
    HEDLEY_TINYC_VERSION_CHECK(0,9,19) || \
    HEDLEY_ARM_VERSION_CHECK(4,1,0) || \
    HEDLEY_IBM_VERSION_CHECK(13,1,0) || \
    HEDLEY_TI_CL6X_VERSION_CHECK(6,1,0) || \
    (HEDLEY_SUNPRO_VERSION_CHECK(5,10,0) && !defined(__cplusplus)) || \
    HEDLEY_CRAY_VERSION_CHECK(8,1,0) || \
    HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
  #define SIMDE_CHECK_CONSTANT_(expr) (__builtin_constant_p(expr))
#elif defined(__cplusplus) && (__cplusplus > 201703L)
  #include <type_traits>
  #define SIMDE_CHECK_CONSTANT_(expr) (std::is_constant_evaluated())
#endif

#if !defined(SIMDE_NO_CHECK_IMMEDIATE_CONSTANT)
  #if defined(SIMDE_CHECK_CONSTANT_) && \
      SIMDE_DETECT_CLANG_VERSION_CHECK(9,0,0) && \
      (!defined(__apple_build_version__) || ((__apple_build_version__ < 11000000) || (__apple_build_version__ >= 12000000)))
    #define SIMDE_REQUIRE_CONSTANT(arg) HEDLEY_REQUIRE_MSG(SIMDE_CHECK_CONSTANT_(arg), "`" #arg "' must be constant")
  #else
    #define SIMDE_REQUIRE_CONSTANT(arg)
  #endif
#else
  #define SIMDE_REQUIRE_CONSTANT(arg)
#endif

#define SIMDE_REQUIRE_RANGE(arg, min, max) \
  HEDLEY_REQUIRE_MSG((((arg) >= (min)) && ((arg) <= (max))), "'" #arg "' must be in [" #min ", " #max "]")

#define SIMDE_REQUIRE_CONSTANT_RANGE(arg, min, max) \
  SIMDE_REQUIRE_CONSTANT(arg) \
  SIMDE_REQUIRE_RANGE(arg, min, max)

/* A copy of HEDLEY_STATIC_ASSERT, except we don't define an empty
 * fallback if we can't find an implementation; instead we have to
 * check if SIMDE_STATIC_ASSERT is defined before using it. */
#if \
  !defined(__cplusplus) && ( \
      (defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)) || \
      HEDLEY_HAS_FEATURE(c_static_assert) || \
      HEDLEY_GCC_VERSION_CHECK(6,0,0) || \
      HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
      defined(_Static_assert) \
    )
  /* Sometimes _Static_assert is defined (in cdefs.h) using a symbol which
   * starts with a double-underscore. This is a system header so we have no
   * control over it, but since it's a macro it will emit a diagnostic which
   * prevents compilation with -Werror. */
  #if HEDLEY_HAS_WARNING("-Wreserved-identifier")
    #define SIMDE_STATIC_ASSERT(expr, message) (__extension__({ \
      HEDLEY_DIAGNOSTIC_PUSH \
      _Pragma("clang diagnostic ignored \"-Wreserved-identifier\"") \
      _Static_assert(expr, message); \
      HEDLEY_DIAGNOSTIC_POP \
    }))
  #else
    #define SIMDE_STATIC_ASSERT(expr, message) _Static_assert(expr, message)
  #endif
#elif \
  (defined(__cplusplus) && (__cplusplus >= 201103L)) || \
  HEDLEY_MSVC_VERSION_CHECK(16,0,0)
  #define SIMDE_STATIC_ASSERT(expr, message) HEDLEY_DIAGNOSTIC_DISABLE_CPP98_COMPAT_WRAP_(static_assert(expr, message))
#endif

/* Statement exprs */
#if \
    HEDLEY_GNUC_VERSION_CHECK(2,95,0) || \
    HEDLEY_TINYC_VERSION_CHECK(0,9,26) || \
    HEDLEY_INTEL_VERSION_CHECK(9,0,0) || \
    HEDLEY_PGI_VERSION_CHECK(18,10,0) || \
    HEDLEY_SUNPRO_VERSION_CHECK(5,12,0) || \
    HEDLEY_IBM_VERSION_CHECK(11,1,0) || \
    HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
  #define SIMDE_STATEMENT_EXPR_(expr) (__extension__ expr)
#endif

/* This is just a convenience macro to make it easy to call a single
 * function with a specific diagnostic disabled. */
#if defined(SIMDE_STATEMENT_EXPR_)
  #define SIMDE_DISABLE_DIAGNOSTIC_EXPR_(diagnostic, expr) \
    SIMDE_STATEMENT_EXPR_(({ \
      HEDLEY_DIAGNOSTIC_PUSH \
      diagnostic \
      (expr); \
      HEDLEY_DIAGNOSTIC_POP \
    }))
#endif

#if defined(SIMDE_CHECK_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define SIMDE_ASSERT_CONSTANT_(v) SIMDE_STATIC_ASSERT(SIMDE_CHECK_CONSTANT_(v), #v " must be constant.")
#endif

#if \
  (HEDLEY_HAS_ATTRIBUTE(may_alias) && !defined(HEDLEY_SUNPRO_VERSION)) || \
  HEDLEY_GCC_VERSION_CHECK(3,3,0) || \
  HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
  HEDLEY_IBM_VERSION_CHECK(13,1,0)
#  define SIMDE_MAY_ALIAS __attribute__((__may_alias__))
#else
#  define SIMDE_MAY_ALIAS
#endif

/*  Lots of compilers support GCC-style vector extensions, but many
    don't support all the features.  Define different macros depending
    on support for

    * SIMDE_VECTOR - Declaring a vector.
    * SIMDE_VECTOR_OPS - basic operations (binary and unary).
    * SIMDE_VECTOR_NEGATE - negating a vector
    * SIMDE_VECTOR_SCALAR - For binary operators, the second argument
        can be a scalar, in which case the result is as if that scalar
        had been broadcast to all lanes of a vector.
    * SIMDE_VECTOR_SUBSCRIPT - Supports array subscript notation for
        extracting/inserting a single element.=

    SIMDE_VECTOR can be assumed if any others are defined, the
    others are independent. */
#if !defined(SIMDE_NO_VECTOR)
#  if \
    HEDLEY_GCC_VERSION_CHECK(4,8,0)
#    define SIMDE_VECTOR(size) __attribute__((__vector_size__(size)))
#    define SIMDE_VECTOR_OPS
#    define SIMDE_VECTOR_NEGATE
#    define SIMDE_VECTOR_SCALAR
#    define SIMDE_VECTOR_SUBSCRIPT
#  elif HEDLEY_INTEL_VERSION_CHECK(16,0,0)
#    define SIMDE_VECTOR(size) __attribute__((__vector_size__(size)))
#    define SIMDE_VECTOR_OPS
#    define SIMDE_VECTOR_NEGATE
/* ICC only supports SIMDE_VECTOR_SCALAR for constants */
#    define SIMDE_VECTOR_SUBSCRIPT
#  elif \
    HEDLEY_GCC_VERSION_CHECK(4,1,0) || \
    HEDLEY_INTEL_VERSION_CHECK(13,0,0) || \
    HEDLEY_MCST_LCC_VERSION_CHECK(1,25,10)
#    define SIMDE_VECTOR(size) __attribute__((__vector_size__(size)))
#    define SIMDE_VECTOR_OPS
#  elif HEDLEY_SUNPRO_VERSION_CHECK(5,12,0)
#    define SIMDE_VECTOR(size) __attribute__((__vector_size__(size)))
#  elif HEDLEY_HAS_ATTRIBUTE(vector_size)
#    define SIMDE_VECTOR(size) __attribute__((__vector_size__(size)))
#    define SIMDE_VECTOR_OPS
#    define SIMDE_VECTOR_NEGATE
#    define SIMDE_VECTOR_SUBSCRIPT
#    if SIMDE_DETECT_CLANG_VERSION_CHECK(5,0,0)
#      define SIMDE_VECTOR_SCALAR
#    endif
#  endif

/* GCC and clang have built-in functions to handle shuffling and
   converting of vectors, but the implementations are slightly
   different.  This macro is just an abstraction over them.  Note that
   elem_size is in bits but vec_size is in bytes. */
#  if !defined(SIMDE_NO_SHUFFLE_VECTOR) && defined(SIMDE_VECTOR_SUBSCRIPT)
     HEDLEY_DIAGNOSTIC_PUSH
     /* We don't care about -Wvariadic-macros; all compilers that support
      * shufflevector/shuffle support them. */
#    if HEDLEY_HAS_WARNING("-Wc++98-compat-pedantic")
#      pragma clang diagnostic ignored "-Wc++98-compat-pedantic"
#    endif
#    if HEDLEY_HAS_WARNING("-Wvariadic-macros") || HEDLEY_GCC_VERSION_CHECK(4,0,0)
#      pragma GCC diagnostic ignored "-Wvariadic-macros"
#    endif

#    if HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
#      define SIMDE_SHUFFLE_VECTOR_(elem_size, vec_size, a, b, ...) __builtin_shufflevector(a, b, __VA_ARGS__)
#    elif HEDLEY_GCC_HAS_BUILTIN(__builtin_shuffle,4,7,0) && !defined(__INTEL_COMPILER)
#      define SIMDE_SHUFFLE_VECTOR_(elem_size, vec_size, a, b, ...) (__extension__ ({ \
         int##elem_size##_t SIMDE_VECTOR(vec_size) simde_shuffle_ = { __VA_ARGS__ }; \
           __builtin_shuffle(a, b, simde_shuffle_); \
         }))
#    endif
     HEDLEY_DIAGNOSTIC_POP
#  endif

/* TODO: this actually works on XL C/C++ without SIMDE_VECTOR_SUBSCRIPT
   but the code needs to be refactored a bit to take advantage. */
#  if !defined(SIMDE_NO_CONVERT_VECTOR) && defined(SIMDE_VECTOR_SUBSCRIPT)
#    if HEDLEY_HAS_BUILTIN(__builtin_convertvector) || HEDLEY_GCC_VERSION_CHECK(9,0,0)
#      if HEDLEY_GCC_VERSION_CHECK(9,0,0) && !HEDLEY_GCC_VERSION_CHECK(9,3,0)
         /* https://gcc.gnu.org/bugzilla/show_bug.cgi?id=93557 */
#        define SIMDE_CONVERT_VECTOR_(to, from) ((to) = (__extension__({ \
             __typeof__(from) from_ = (from); \
             ((void) from_); \
             __builtin_convertvector(from_, __typeof__(to)); \
           })))
#      else
#        define SIMDE_CONVERT_VECTOR_(to, from) ((to) = __builtin_convertvector((from), __typeof__(to)))
#      endif
#    endif
#  endif
#endif

/* Since we currently require SUBSCRIPT before using a vector in a
   union, we define these as dependencies of SUBSCRIPT.  They are
   likely to disappear in the future, once SIMDe learns how to make
   use of vectors without using the union members.  Do not use them
   in your code unless you're okay with it breaking when SIMDe
   changes. */
#if defined(SIMDE_VECTOR_SUBSCRIPT)
#  if defined(SIMDE_VECTOR_OPS)
#    define SIMDE_VECTOR_SUBSCRIPT_OPS
#  endif
#  if defined(SIMDE_VECTOR_SCALAR)
#    define SIMDE_VECTOR_SUBSCRIPT_SCALAR
#  endif
#endif

#if !defined(SIMDE_DISABLE_OPENMP)
  #if !defined(SIMDE_ENABLE_OPENMP) && ((defined(_OPENMP) && (_OPENMP >= 201307L)) || (defined(_OPENMP_SIMD) && (_OPENMP_SIMD >= 201307L))) || defined(HEDLEY_MCST_LCC_VERSION)
    #define SIMDE_ENABLE_OPENMP
  #endif
#endif

#if !defined(SIMDE_ENABLE_CILKPLUS) && (defined(__cilk) || defined(HEDLEY_INTEL_VERSION))
#  define SIMDE_ENABLE_CILKPLUS
#endif

#if defined(SIMDE_ENABLE_OPENMP)
#  define SIMDE_VECTORIZE HEDLEY_PRAGMA(omp simd)
#  define SIMDE_VECTORIZE_SAFELEN(l) HEDLEY_PRAGMA(omp simd safelen(l))
#  if defined(__clang__)
#    define SIMDE_VECTORIZE_REDUCTION(r) \
        HEDLEY_DIAGNOSTIC_PUSH \
        _Pragma("clang diagnostic ignored \"-Wsign-conversion\"") \
        HEDLEY_PRAGMA(omp simd reduction(r)) \
        HEDLEY_DIAGNOSTIC_POP
#  else
#    define SIMDE_VECTORIZE_REDUCTION(r) HEDLEY_PRAGMA(omp simd reduction(r))
#  endif
#  if !defined(HEDLEY_MCST_LCC_VERSION)
#    define SIMDE_VECTORIZE_ALIGNED(a) HEDLEY_PRAGMA(omp simd aligned(a))
#  else
#    define SIMDE_VECTORIZE_ALIGNED(a) HEDLEY_PRAGMA(omp simd)
#  endif
#elif defined(SIMDE_ENABLE_CILKPLUS)
#  define SIMDE_VECTORIZE HEDLEY_PRAGMA(simd)
#  define SIMDE_VECTORIZE_SAFELEN(l) HEDLEY_PRAGMA(simd vectorlength(l))
#  define SIMDE_VECTORIZE_REDUCTION(r) HEDLEY_PRAGMA(simd reduction(r))
#  define SIMDE_VECTORIZE_ALIGNED(a) HEDLEY_PRAGMA(simd aligned(a))
#elif defined(__clang__) && !defined(HEDLEY_IBM_VERSION)
#  define SIMDE_VECTORIZE HEDLEY_PRAGMA(clang loop vectorize(enable))
#  define SIMDE_VECTORIZE_SAFELEN(l) HEDLEY_PRAGMA(clang loop vectorize_width(l))
#  define SIMDE_VECTORIZE_REDUCTION(r) SIMDE_VECTORIZE
#  define SIMDE_VECTORIZE_ALIGNED(a)
#elif HEDLEY_GCC_VERSION_CHECK(4,9,0)
#  define SIMDE_VECTORIZE HEDLEY_PRAGMA(GCC ivdep)
#  define SIMDE_VECTORIZE_SAFELEN(l) SIMDE_VECTORIZE
#  define SIMDE_VECTORIZE_REDUCTION(r) SIMDE_VECTORIZE
#  define SIMDE_VECTORIZE_ALIGNED(a)
#elif HEDLEY_CRAY_VERSION_CHECK(5,0,0)
#  define SIMDE_VECTORIZE HEDLEY_PRAGMA(_CRI ivdep)
#  define SIMDE_VECTORIZE_SAFELEN(l) SIMDE_VECTORIZE
#  define SIMDE_VECTORIZE_REDUCTION(r) SIMDE_VECTORIZE
#  define SIMDE_VECTORIZE_ALIGNED(a)
#else
#  define SIMDE_VECTORIZE
#  define SIMDE_VECTORIZE_SAFELEN(l)
#  define SIMDE_VECTORIZE_REDUCTION(r)
#  define SIMDE_VECTORIZE_ALIGNED(a)
#endif

#define SIMDE_MASK_NZ_(v, mask) (((v) & (mask)) | !((v) & (mask)))

/* Intended for checking coverage, you should never use this in
   production. */
#if defined(SIMDE_NO_INLINE)
#  define SIMDE_FUNCTION_ATTRIBUTES HEDLEY_NEVER_INLINE static
#else
#  define SIMDE_FUNCTION_ATTRIBUTES HEDLEY_ALWAYS_INLINE static
#endif

#if defined(SIMDE_NO_INLINE)
#  define SIMDE_HUGE_FUNCTION_ATTRIBUTES HEDLEY_NEVER_INLINE static
#elif defined(SIMDE_CONSTRAINED_COMPILATION)
#  define SIMDE_HUGE_FUNCTION_ATTRIBUTES static
#else
#  define SIMDE_HUGE_FUNCTION_ATTRIBUTES HEDLEY_ALWAYS_INLINE static
#endif

#if \
    HEDLEY_HAS_ATTRIBUTE(unused) || \
    HEDLEY_GCC_VERSION_CHECK(2,95,0)
#  define SIMDE_FUNCTION_POSSIBLY_UNUSED_ __attribute__((__unused__))
#else
#  define SIMDE_FUNCTION_POSSIBLY_UNUSED_
#endif

HEDLEY_DIAGNOSTIC_PUSH
SIMDE_DIAGNOSTIC_DISABLE_USED_BUT_MARKED_UNUSED_

#if defined(_MSC_VER)
#  define SIMDE_BEGIN_DECLS_ HEDLEY_DIAGNOSTIC_PUSH __pragma(warning(disable:4996 4204)) HEDLEY_BEGIN_C_DECLS
#  define SIMDE_END_DECLS_ HEDLEY_DIAGNOSTIC_POP HEDLEY_END_C_DECLS
#else
#  define SIMDE_BEGIN_DECLS_ \
     HEDLEY_DIAGNOSTIC_PUSH \
     SIMDE_DIAGNOSTIC_DISABLE_USED_BUT_MARKED_UNUSED_ \
     HEDLEY_BEGIN_C_DECLS
#  define SIMDE_END_DECLS_ \
     HEDLEY_END_C_DECLS \
     HEDLEY_DIAGNOSTIC_POP
#endif

#if defined(__SIZEOF_INT128__)
#  define SIMDE_HAVE_INT128_
HEDLEY_DIAGNOSTIC_PUSH
SIMDE_DIAGNOSTIC_DISABLE_PEDANTIC_
typedef __int128 simde_int128;
typedef unsigned __int128 simde_uint128;
HEDLEY_DIAGNOSTIC_POP
#endif

#if !defined(SIMDE_ENDIAN_LITTLE)
#  define SIMDE_ENDIAN_LITTLE 1234
#endif
#if !defined(SIMDE_ENDIAN_BIG)
#  define SIMDE_ENDIAN_BIG 4321
#endif

#if !defined(SIMDE_ENDIAN_ORDER)
/* GCC (and compilers masquerading as GCC) define  __BYTE_ORDER__. */
#  if defined(__BYTE_ORDER__) && defined(__ORDER_LITTLE_ENDIAN__) && (__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__)
#    define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_LITTLE
#  elif defined(__BYTE_ORDER__) && defined(__ORDER_BIG_ENDIAN__) && (__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__)
#    define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_BIG
/* TI defines _BIG_ENDIAN or _LITTLE_ENDIAN */
#  elif defined(_BIG_ENDIAN)
#    define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_BIG
#  elif defined(_LITTLE_ENDIAN)
#    define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_LITTLE
/* We know the endianness of some common architectures.  Common
 * architectures not listed (ARM, POWER, MIPS, etc.) here are
 * bi-endian. */
#  elif defined(__amd64) || defined(_M_X64) || defined(__i386) || defined(_M_IX86)
#    define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_LITTLE
#  elif defined(__s390x__) || defined(__zarch__)
#    define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_BIG
/* Looks like we'll have to rely on the platform.  If we're missing a
 * platform, please let us know. */
#  elif defined(_WIN32)
#    define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_LITTLE
#  elif defined(sun) || defined(__sun) /* Solaris */
#    include <sys/byteorder.h>
#    if defined(_LITTLE_ENDIAN)
#      define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_LITTLE
#    elif defined(_BIG_ENDIAN)
#      define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_BIG
#    endif
#  elif defined(__APPLE__)
#    include <libkern/OSByteOrder.h>
#    if defined(__LITTLE_ENDIAN__)
#      define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_LITTLE
#    elif defined(__BIG_ENDIAN__)
#      define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_BIG
#    endif
#  elif defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__) || defined(__bsdi__) || defined(__DragonFly__) || defined(BSD)
#    include <machine/endian.h>
#    if defined(__BYTE_ORDER) && (__BYTE_ORDER == __LITTLE_ENDIAN)
#      define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_LITTLE
#    elif defined(__BYTE_ORDER) && (__BYTE_ORDER == __BIG_ENDIAN)
#      define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_BIG
#    endif
#  elif defined(__linux__) || defined(__linux) || defined(__gnu_linux__)
#    include <endian.h>
#    if defined(__BYTE_ORDER) && defined(__LITTLE_ENDIAN) && (__BYTE_ORDER == __LITTLE_ENDIAN)
#      define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_LITTLE
#    elif defined(__BYTE_ORDER) && defined(__BIG_ENDIAN) && (__BYTE_ORDER == __BIG_ENDIAN)
#      define SIMDE_ENDIAN_ORDER SIMDE_ENDIAN_BIG
#    endif
#  endif
#endif

#if \
    HEDLEY_HAS_BUILTIN(__builtin_bswap64) || \
    HEDLEY_GCC_VERSION_CHECK(4,3,0) || \
    HEDLEY_IBM_VERSION_CHECK(13,1,0) || \
    HEDLEY_INTEL_VERSION_CHECK(13,0,0)
  #define simde_bswap64(v) __builtin_bswap64(v)
#elif HEDLEY_MSVC_VERSION_CHECK(13,10,0)
  #define simde_bswap64(v) _byteswap_uint64(v)
#else
  SIMDE_FUNCTION_ATTRIBUTES
  uint64_t
  simde_bswap64(uint64_t v) {
    return
      ((v & (((uint64_t) 0xff) << 56)) >> 56) |
      ((v & (((uint64_t) 0xff) << 48)) >> 40) |
      ((v & (((uint64_t) 0xff) << 40)) >> 24) |
      ((v & (((uint64_t) 0xff) << 32)) >>  8) |
      ((v & (((uint64_t) 0xff) << 24)) <<  8) |
      ((v & (((uint64_t) 0xff) << 16)) << 24) |
      ((v & (((uint64_t) 0xff) <<  8)) << 40) |
      ((v & (((uint64_t) 0xff)      )) << 56);
  }
#endif

#if !defined(SIMDE_ENDIAN_ORDER)
#  error Unknown byte order; please file a bug
#else
#  if SIMDE_ENDIAN_ORDER == SIMDE_ENDIAN_LITTLE
#    define simde_endian_bswap64_be(value) simde_bswap64(value)
#    define simde_endian_bswap64_le(value) (value)
#  elif SIMDE_ENDIAN_ORDER == SIMDE_ENDIAN_BIG
#    define simde_endian_bswap64_be(value) (value)
#    define simde_endian_bswap64_le(value) simde_bswap64(value)
#  endif
#endif

/* TODO: we should at least make an attempt to detect the correct
   types for simde_float32/float64 instead of just assuming float and
   double. */

#if !defined(SIMDE_FLOAT32_TYPE)
#  define SIMDE_FLOAT32_TYPE float
#  define SIMDE_FLOAT32_C(value) value##f
#else
#  define SIMDE_FLOAT32_C(value) ((SIMDE_FLOAT32_TYPE) value)
#endif
typedef SIMDE_FLOAT32_TYPE simde_float32;

#if !defined(SIMDE_FLOAT64_TYPE)
#  define SIMDE_FLOAT64_TYPE double
#  define SIMDE_FLOAT64_C(value) value
#else
#  define SIMDE_FLOAT64_C(value) ((SIMDE_FLOAT64_TYPE) value)
#endif
typedef SIMDE_FLOAT64_TYPE simde_float64;

#if defined(SIMDE_POLY8_TYPE)
#  undef SIMDE_POLY8_TYPE
#endif
#if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
#  define SIMDE_POLY8_TYPE poly8_t
#  define SIMDE_POLY8_C(value) (HEDLEY_STATIC_CAST(poly8_t, value))
#else
#  define SIMDE_POLY8_TYPE uint8_t
#  define SIMDE_POLY8_C(value) (HEDLEY_STATIC_CAST(uint8_t, value))
#endif
typedef SIMDE_POLY8_TYPE simde_poly8;

#if defined(SIMDE_POLY16_TYPE)
#  undef SIMDE_POLY16_TYPE
#endif
#if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
#  define SIMDE_POLY16_TYPE poly16_t
#  define SIMDE_POLY16_C(value) (HEDLEY_STATIC_CAST(poly16_t, value))
#else
#  define SIMDE_POLY16_TYPE uint16_t
#  define SIMDE_POLY16_C(value) (HEDLEY_STATIC_CAST(uint16_t, value))
#endif
typedef SIMDE_POLY16_TYPE simde_poly16;

#if defined(SIMDE_POLY64_TYPE)
#  undef SIMDE_POLY64_TYPE
#endif
#if defined(SIMDE_ARM_NEON_A32V8_NATIVE)
#  define SIMDE_POLY64_TYPE poly64_t
#  define SIMDE_POLY64_C(value) (HEDLEY_STATIC_CAST(poly64_t, value ## ull))
#else
#  define SIMDE_POLY64_TYPE uint64_t
#  define SIMDE_POLY64_C(value) value ## ull
#endif
typedef SIMDE_POLY64_TYPE simde_poly64;

#if defined(SIMDE_POLY128_TYPE)
#  undef SIMDE_POLY128_TYPE
#endif
#if defined(SIMDE_ARM_NEON_A32V8_NATIVE) && defined(SIMDE_ARCH_ARM_CRYPTO)
#  define SIMDE_POLY128_TYPE poly128_t
#  define SIMDE_POLY128_C(value) value
#elif defined(__SIZEOF_INT128__)
#  define SIMDE_POLY128_TYPE __int128
#  define SIMDE_POLY128_C(value) (HEDLEY_STATIC_CAST(__int128, value))
#else
#  define SIMDE_POLY128_TYPE uint64_t
#  define SIMDE_TARGET_NOT_SUPPORT_INT128_TYPE 1
#endif
typedef SIMDE_POLY128_TYPE simde_poly128;

#if defined(__cplusplus)
  typedef bool simde_bool;
#elif defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L)
  typedef _Bool simde_bool;
#elif defined(bool)
  typedef bool simde_bool;
#else
  #include <stdbool.h>
  typedef bool simde_bool;
#endif

#if HEDLEY_HAS_WARNING("-Wbad-function-cast")
#  define SIMDE_CONVERT_FTOI(T,v) \
    HEDLEY_DIAGNOSTIC_PUSH \
    _Pragma("clang diagnostic ignored \"-Wbad-function-cast\"") \
    HEDLEY_STATIC_CAST(T, (v)) \
    HEDLEY_DIAGNOSTIC_POP
#else
#  define SIMDE_CONVERT_FTOI(T,v) ((T) (v))
#endif

/* TODO: detect compilers which support this outside of C11 mode */
#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
  #define SIMDE_CHECKED_REINTERPRET_CAST(to, from, value) _Generic((value), to: (value), default: (_Generic((value), from: ((to) (value)))))
  #define SIMDE_CHECKED_STATIC_CAST(to, from, value) _Generic((value), to: (value), default: (_Generic((value), from: ((to) (value)))))
#else
  #define SIMDE_CHECKED_REINTERPRET_CAST(to, from, value) HEDLEY_REINTERPRET_CAST(to, value)
  #define SIMDE_CHECKED_STATIC_CAST(to, from, value) HEDLEY_STATIC_CAST(to, value)
#endif

#if HEDLEY_HAS_WARNING("-Wfloat-equal")
#  define SIMDE_DIAGNOSTIC_DISABLE_FLOAT_EQUAL _Pragma("clang diagnostic ignored \"-Wfloat-equal\"")
#elif HEDLEY_GCC_VERSION_CHECK(3,0,0)
#  define SIMDE_DIAGNOSTIC_DISABLE_FLOAT_EQUAL _Pragma("GCC diagnostic ignored \"-Wfloat-equal\"")
#else
#  define SIMDE_DIAGNOSTIC_DISABLE_FLOAT_EQUAL
#endif

/* Some functions can trade accuracy for speed.  For those functions
   you can control the trade-off using this macro.  Possible values:

   0: prefer speed
   1: reasonable trade-offs
   2: prefer accuracy */
#if !defined(SIMDE_ACCURACY_PREFERENCE)
#  define SIMDE_ACCURACY_PREFERENCE 1
#endif

#if defined(__STDC_HOSTED__)
#  define SIMDE_STDC_HOSTED __STDC_HOSTED__
#else
#  if \
     defined(HEDLEY_PGI_VERSION) || \
     defined(HEDLEY_MSVC_VERSION)
#    define SIMDE_STDC_HOSTED 1
#  else
#    define SIMDE_STDC_HOSTED 0
#  endif
#endif

/* Try to deal with environments without a standard library. */
#if !defined(simde_memcpy)
  #if HEDLEY_HAS_BUILTIN(__builtin_memcpy)
    #define simde_memcpy(dest, src, n) __builtin_memcpy(dest, src, n)
  #endif
#endif
#if !defined(simde_memset)
  #if HEDLEY_HAS_BUILTIN(__builtin_memset)
    #define simde_memset(s, c, n) __builtin_memset(s, c, n)
  #endif
#endif
#if !defined(simde_memcmp)
  #if HEDLEY_HAS_BUILTIN(__builtin_memcmp)
    #define simde_memcmp(s1, s2, n) __builtin_memcmp(s1, s2, n)
  #endif
#endif

#if !defined(simde_memcpy) || !defined(simde_memset) || !defined(simde_memcmp)
  #if !defined(SIMDE_NO_STRING_H)
    #if defined(__has_include)
      #if !__has_include(<string.h>)
        #define SIMDE_NO_STRING_H
      #endif
    #elif (SIMDE_STDC_HOSTED == 0)
      #define SIMDE_NO_STRING_H
    #endif
  #endif

  #if !defined(SIMDE_NO_STRING_H)
    #include <string.h>
    #if !defined(simde_memcpy)
      #define simde_memcpy(dest, src, n) memcpy(dest, src, n)
    #endif
    #if !defined(simde_memset)
      #define simde_memset(s, c, n) memset(s, c, n)
    #endif
    #if !defined(simde_memcmp)
      #define simde_memcmp(s1, s2, n) memcmp(s1, s2, n)
    #endif
  #else
    /* These are meant to be portable, not fast.  If you're hitting them you
     * should think about providing your own (by defining the simde_memcpy
     * macro prior to including any SIMDe files) or submitting a patch to
     * SIMDe so we can detect your system-provided memcpy/memset, like by
     * adding your compiler to the checks for __builtin_memcpy and/or
     * __builtin_memset. */
    #if !defined(simde_memcpy)
      SIMDE_FUNCTION_ATTRIBUTES
      void
      simde_memcpy_(void* dest, const void* src, size_t len) {
        char* dest_ = HEDLEY_STATIC_CAST(char*, dest);
        char* src_ = HEDLEY_STATIC_CAST(const char*, src);
        for (size_t i = 0 ; i < len ; i++) {
          dest_[i] = src_[i];
        }
      }
      #define simde_memcpy(dest, src, n) simde_memcpy_(dest, src, n)
    #endif

    #if !defined(simde_memset)
      SIMDE_FUNCTION_ATTRIBUTES
      void
      simde_memset_(void* s, int c, size_t len) {
        char* s_ = HEDLEY_STATIC_CAST(char*, s);
        char c_ = HEDLEY_STATIC_CAST(char, c);
        for (size_t i = 0 ; i < len ; i++) {
          s_[i] = c_[i];
        }
      }
      #define simde_memset(s, c, n) simde_memset_(s, c, n)
    #endif

    #if !defined(simde_memcmp)
      SIMDE_FUCTION_ATTRIBUTES
      int
      simde_memcmp_(const void *s1, const void *s2, size_t n) {
        unsigned char* s1_ = HEDLEY_STATIC_CAST(unsigned char*, s1);
        unsigned char* s2_ = HEDLEY_STATIC_CAST(unsigned char*, s2);
        for (size_t i = 0 ; i < len ; i++) {
          if (s1_[i] != s2_[i]) {
            return (int) (s1_[i] - s2_[i]);
          }
        }
        return 0;
      }
    #define simde_memcmp(s1, s2, n) simde_memcmp_(s1, s2, n)
    #endif
  #endif
#endif

/*** Functions that quiet a signaling NaN ***/

static HEDLEY_INLINE
double
simde_math_quiet(double x) {
  uint64_t tmp, mask;
  if (!simde_math_isnan(x)) {
    return x;
  }
  simde_memcpy(&tmp, &x, 8);
  mask = 0x7ff80000;
  mask <<= 32;
  tmp |= mask;
  simde_memcpy(&x, &tmp, 8);
  return x;
}

static HEDLEY_INLINE
float
simde_math_quietf(float x) {
  uint32_t tmp;
  if (!simde_math_isnanf(x)) {
    return x;
  }
  simde_memcpy(&tmp, &x, 4);
  tmp |= 0x7fc00000lu;
  simde_memcpy(&x, &tmp, 4);
  return x;
}

#if defined(FE_ALL_EXCEPT)
  #define SIMDE_HAVE_FENV_H
#elif defined(__has_include)
  #if __has_include(<fenv.h>)
    #include <fenv.h>
    #define SIMDE_HAVE_FENV_H
  #endif
#elif SIMDE_STDC_HOSTED == 1
  #include <fenv.h>
  #define SIMDE_HAVE_FENV_H
#endif

#if defined(EXIT_FAILURE)
  #define SIMDE_HAVE_STDLIB_H
#elif defined(__has_include)
  #if __has_include(<stdlib.h>)
    #include <stdlib.h>
    #define SIMDE_HAVE_STDLIB_H
  #endif
#elif SIMDE_STDC_HOSTED == 1
  #include <stdlib.h>
  #define SIMDE_HAVE_STDLIB_H
#endif

#if defined(__has_include)
#  if defined(__cplusplus) && (__cplusplus >= 201103L) && __has_include(<cfenv>)
#    include <cfenv>
#  elif __has_include(<fenv.h>)
#    include <fenv.h>
#  endif
#  if __has_include(<stdlib.h>)
#    include <stdlib.h>
#  endif
#elif SIMDE_STDC_HOSTED == 1
#  include <stdlib.h>
#  include <fenv.h>
#endif

#define SIMDE_DEFINE_CONVERSION_FUNCTION_(Name, T_To, T_From) \
  static HEDLEY_ALWAYS_INLINE HEDLEY_CONST SIMDE_FUNCTION_POSSIBLY_UNUSED_ \
  T_To \
  Name (T_From value) { \
    T_To r; \
    simde_memcpy(&r, &value, sizeof(r)); \
    return r; \
  }

SIMDE_DEFINE_CONVERSION_FUNCTION_(simde_float32_as_uint32,      uint32_t, simde_float32)
SIMDE_DEFINE_CONVERSION_FUNCTION_(simde_uint32_as_float32, simde_float32, uint32_t)
SIMDE_DEFINE_CONVERSION_FUNCTION_(simde_float64_as_uint64,      uint64_t, simde_float64)
SIMDE_DEFINE_CONVERSION_FUNCTION_(simde_uint64_as_float64, simde_float64, uint64_t)

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/check.h :: */
/* Check (assertions)
 * Portable Snippets - https://github.com/nemequ/portable-snippets
 * Created by Evan Nemerson <evan@nemerson.com>
 *
 *   To the extent possible under law, the authors have waived all
 *   copyright and related or neighboring rights to this code.  For
 *   details, see the Creative Commons Zero 1.0 Universal license at
 *   https://creativecommons.org/publicdomain/zero/1.0/
 *
 * SPDX-License-Identifier: CC0-1.0
 */

#if !defined(SIMDE_CHECK_H)
#define SIMDE_CHECK_H

#if !defined(SIMDE_NDEBUG) && !defined(SIMDE_DEBUG)
#  define SIMDE_NDEBUG 1
#endif

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
#include <stdint.h>

#if !defined(_WIN32)
#  define SIMDE_SIZE_MODIFIER "z"
#  define SIMDE_CHAR_MODIFIER "hh"
#  define SIMDE_SHORT_MODIFIER "h"
#else
#  if defined(_M_X64) || defined(__amd64__)
#    define SIMDE_SIZE_MODIFIER "I64"
#  else
#    define SIMDE_SIZE_MODIFIER ""
#  endif
#  define SIMDE_CHAR_MODIFIER ""
#  define SIMDE_SHORT_MODIFIER ""
#endif

#if defined(_MSC_VER) &&  (_MSC_VER >= 1500)
#  define SIMDE_PUSH_DISABLE_MSVC_C4127_ __pragma(warning(push)) __pragma(warning(disable:4127))
#  define SIMDE_POP_DISABLE_MSVC_C4127_ __pragma(warning(pop))
#else
#  define SIMDE_PUSH_DISABLE_MSVC_C4127_
#  define SIMDE_POP_DISABLE_MSVC_C4127_
#endif

#if !defined(simde_errorf)
#  if defined(__has_include)
#    if __has_include(<stdio.h>)
#      include <stdio.h>
#    endif
#  elif defined(SIMDE_STDC_HOSTED)
#    if SIMDE_STDC_HOSTED == 1
#      include <stdio.h>
#    endif
#  elif defined(__STDC_HOSTED__)
#    if __STDC_HOSTETD__ == 1
#      include <stdio.h>
#    endif
#  endif

/* AUTOMATICALLY GENERATED FILE, DO NOT MODIFY */
/* 71fd833d9666141edcd1d3c109a80e228303d8d7 */
/* :: Begin simde/debug-trap.h :: */
/* Debugging assertions and traps
 * Portable Snippets - https://github.com/nemequ/portable-snippets
 * Created by Evan Nemerson <evan@nemerson.com>
 *
 *   To the extent possible under law, the authors have waived all
 *   copyright and related or neighboring rights to this code.  For
 *   details, see the Creative Commons Zero 1.0 Universal license at
 *   https://creativecommons.org/publicdomain/zero/1.0/
 *
 * SPDX-License-Identifier: CC0-1.0
 */

#if !defined(SIMDE_DEBUG_TRAP_H)
#define SIMDE_DEBUG_TRAP_H

#if !defined(SIMDE_NDEBUG) && defined(NDEBUG) && !defined(SIMDE_DEBUG)
#  define SIMDE_NDEBUG 1
#endif

#if defined(__has_builtin) && !defined(__ibmxl__)
#  if __has_builtin(__builtin_debugtrap)
#    define simde_trap() __builtin_debugtrap()
#  elif __has_builtin(__debugbreak)
#    define simde_trap() __debugbreak()
#  endif
#endif
#if !defined(simde_trap)
#  if defined(_MSC_VER) || defined(__INTEL_COMPILER)
#    define simde_trap() __debugbreak()
#  elif defined(__ARMCC_VERSION)
#    define simde_trap() __breakpoint(42)
#  elif defined(__ibmxl__) || defined(__xlC__)
#    include <builtins.h>
#    define simde_trap() __trap(42)
#  elif defined(__DMC__) && defined(_M_IX86)
     static inline void simde_trap(void) { __asm int 3h; }
#  elif defined(__i386__) || defined(__x86_64__)
     static inline void simde_trap(void) { __asm__ __volatile__("int $03"); }
#  elif defined(__thumb__)
     static inline void simde_trap(void) { __asm__ __volatile__(".inst 0xde01"); }
#  elif defined(__aarch64__)
     static inline void simde_trap(void) { __asm__ __volatile__(".inst 0xd4200000"); }
#  elif defined(__arm__)
     static inline void simde_trap(void) { __asm__ __volatile__(".inst 0xe7f001f0"); }
#  elif defined (__alpha__) && !defined(__osf__)
     static inline void simde_trap(void) { __asm__ __volatile__("bpt"); }
#  elif defined(_54_)
     static inline void simde_trap(void) { __asm__ __volatile__("ESTOP"); }
#  elif defined(_55_)
     static inline void simde_trap(void) { __asm__ __volatile__(";\n .if (.MNEMONIC)\n ESTOP_1\n .else\n ESTOP_1()\n .endif\n NOP"); }
#  elif defined(_64P_)
     static inline void simde_trap(void) { __asm__ __volatile__("SWBP 0"); }
#  elif defined(_6x_)
     static inline void simde_trap(void) { __asm__ __volatile__("NOP\n .word 0x10000000"); }
#  elif defined(__STDC_HOSTED__) && (__STDC_HOSTED__ == 0) && defined(__GNUC__)
#    define simde_trap() __builtin_trap()
#  else
#    include <signal.h>
#    if defined(SIGTRAP)
#      define simde_trap() raise(SIGTRAP)
#    else
#      define simde_trap() raise(SIGABRT)
#    endif
#  endif
#endif

#if defined(HEDLEY_LIKELY)
#  define SIMDE_DBG_LIKELY(expr) HEDLEY_LIKELY(expr)
#elif defined(__GNUC__) && (__GNUC__ >= 3)
#  define SIMDE_DBG_LIKELY(expr) __builtin_expect(!!(expr), 1)
#else
#  define SIMDE_DBG_LIKELY(expr) (!!(expr))
#endif

#if !defined(SIMDE_NDEBUG) || (SIMDE_NDEBUG == 0)
#  define simde_dbg_assert(expr) do { \
    if (!SIMDE_DBG_LIKELY(expr)) { \
      simde_trap(); \
    } \
  } while (0)
#else
#  define simde_dbg_assert(expr)
#endif

#endif /* !defined(SIMDE_DEBUG_TRAP_H) */
/* :: End simde/debug-trap.h :: */

   HEDLEY_DIAGNOSTIC_PUSH
   SIMDE_DIAGNOSTIC_DISABLE_VARIADIC_MACROS_
#  if defined(EOF)
#    define simde_errorf(format, ...) (fprintf(stderr, format, __VA_ARGS__), abort())
#  else
#    define simde_errorf(format, ...) (simde_trap())
#  endif
   HEDLEY_DIAGNOSTIC_POP
#endif

#define simde_error(msg) simde_errorf("%s", msg)

#if defined(SIMDE_NDEBUG) || \
    (defined(__cplusplus) && (__cplusplus < 201103L)) || \
    (defined(__STDC__) && (__STDC__ < 199901L))
#  if defined(SIMDE_CHECK_FAIL_DEFINED)
#    define simde_assert(expr)
#  else
#    if defined(HEDLEY_ASSUME)
#      define simde_assert(expr) HEDLEY_ASSUME(expr)
#    elif HEDLEY_GCC_VERSION_CHECK(4,5,0)
#      define simde_assert(expr) ((void) (!!(expr) ? 1 : (__builtin_unreachable(), 1)))
#    elif HEDLEY_MSVC_VERSION_CHECK(13,10,0)
#      define simde_assert(expr) __assume(expr)
#    else
#      define simde_assert(expr)
#    endif
#  endif
#  define simde_assert_true(expr) simde_assert(expr)
#  define simde_assert_false(expr) simde_assert(!(expr))
#  define simde_assert_type_full(prefix, suffix, T, fmt, a, op, b) simde_assert(((a) op (b)))
#  define simde_assert_double_equal(a, b, precision)
#  define simde_assert_string_equal(a, b)
#  define simde_assert_string_not_equal(a, b)
#  define simde_assert_memory_equal(size, a, b)
#  define simde_assert_memory_not_equal(size, a, b)
#else
#  define simde_assert(expr) \
    do { \
      if (!HEDLEY_LIKELY(expr)) { \
        simde_error("assertion failed: " #expr "\n"); \
      } \
      SIMDE_PUSH_DISABLE_MSVC_C4127_ \
    } while (0) \
    SIMDE_POP_DISABLE_MSVC_C4127_

#  define simde_assert_true(expr) \
    do { \
      if (!HEDLEY_LIKELY(expr)) { \
        simde_error("assertion failed: " #expr " is not true\n"); \
      } \
      SIMDE_PUSH_DISABLE_MSVC_C4127_ \
    } while (0) \
    SIMDE_POP_DISABLE_MSVC_C4127_

#  define simde_assert_false(expr) \
    do { \
      if (!HEDLEY_LIKELY(!(expr))) { \
        simde_error("assertion failed: " #expr " is not false\n"); \
      } \
      SIMDE_PUSH_DISABLE_MSVC_C4127_ \
    } while (0) \
    SIMDE_POP_DISABLE_MSVC_C4127_

#  define simde_assert_type_full(prefix, suffix, T, fmt, a, op, b)   \
    do { \
      T simde_tmp_a_ = (a); \
      T simde_tmp_b_ = (b); \
      if (!(simde_tmp_a_ op simde_tmp_b_)) { \
        simde_errorf("assertion failed: %s %s %s (" prefix "%" fmt suffix " %s " prefix "%" fmt suffix ")\n", \
                     #a, #op, #b, simde_tmp_a_, #op, simde_tmp_b_); \
      } \
      SIMDE_PUSH_DISABLE_MSVC_C4127_ \
    } while (0) \
    SIMDE_POP_DISABLE_MSVC_C4127_

#  define simde_assert_double_equal(a, b, precision) \
    do { \
      const double simde_tmp_a_ = (a); \
      const double simde_tmp_b_ = (b); \
      const double simde_tmp_diff_ = ((simde_tmp_a_ - simde_tmp_b_) < 0) ? \
        -(simde_tmp_a_ - simde_tmp_b_) : \
        (simde_tmp_a_ - simde_tmp_b_); \
      if (HEDLEY_UNLIKELY(simde_tmp_diff_ > 1e-##precision)) { \
        simde_errorf("assertion failed: %s == %s (%0." #precision "g == %0." #precision "g)\n", \
                     #a, #b, simde_tmp_a_, simde_tmp_b_); \
      } \
      SIMDE_PUSH_DISABLE_MSVC_C4127_ \
    } while (0) \
    SIMDE_POP_DISABLE_MSVC_C4127_

#  include <string.h>
#  define simde_assert_string_equal(a, b) \
    do { \
      const char* simde_tmp_a_ = a; \
      const char* simde_tmp_b_ = b; \
      if (HEDLEY_UNLIKELY(strcmp(simde_tmp_a_, simde_tmp_b_) != 0)) { \
        simde_errorf("assertion failed: string %s == %s (\"%s\" == \"%s\")\n", \
                     #a, #b, simde_tmp_a_, simde_tmp_b_); \
      } \
      SIMDE_PUSH_DISABLE_MSVC_C4127_ \
    } while (0) \
    SIMDE_POP_DISABLE_MSVC_C4127_

#  define simde_assert_string_not_equal(a, b) \
    do { \
      const char* simde_tmp_a_ = a; \
      const char* simde_tmp_b_ = b; \
      if (HEDLEY_UNLIKELY(strcmp(simde_tmp_a_, simde_tmp_b_) == 0)) { \
        simde_errorf("assertion failed: string %s != %s (\"%s\" == \"%s\")\n", \
                     #a, #b, simde_tmp_a_, simde_tmp_b_); \
      } \
      SIMDE_PUSH_DISABLE_MSVC_C4127_ \
    } while (0) \
    SIMDE_POP_DISABLE_MSVC_C4127_

#  define simde_assert_memory_equal(size, a, b) \
    do { \
      const unsigned char* simde_tmp_a_ = (const unsigned char*) (a); \
      const unsigned char* simde_tmp_b_ = (const unsigned char*) (b); \
      const size_t simde_tmp_size_ = (size); \
      if (HEDLEY_UNLIKELY(memcmp(simde_tmp_a_, simde_tmp_b_, simde_tmp_size_)) != 0) { \
        size_t simde_tmp_pos_; \
        for (simde_tmp_pos_ = 0 ; simde_tmp_pos_ < simde_tmp_size_ ; simde_tmp_pos_++) { \
          if (simde_tmp_a_[simde_tmp_pos_] != simde_tmp_b_[simde_tmp_pos_]) { \
            simde_errorf("assertion failed: memory %s == %s, at offset %" SIMDE_SIZE_MODIFIER "u\n", \
                         #a, #b, simde_tmp_pos_); \
            break; \
          } \
        } \
      } \
      SIMDE_PUSH_DISABLE_MSVC_C4127_ \
    } while (0) \
    SIMDE_POP_DISABLE_MSVC_C4127_

#  define simde_assert_memory_not_equal(size, a, b) \
    do { \
      const unsigned char* simde_tmp_a_ = (const unsigned char*) (a); \
      const unsigned char* simde_tmp_b_ = (const unsigned char*) (b); \
      const size_t simde_tmp_size_ = (size); \
      if (HEDLEY_UNLIKELY(memcmp(simde_tmp_a_, simde_tmp_b_, simde_tmp_size_)) == 0) { \
        simde_errorf("assertion failed: memory %s != %s (%" SIMDE_SIZE_MODIFIER "u bytes)\n", \
                     #a, #b, simde_tmp_size_); \
      } \
      SIMDE_PUSH_DISABLE_MSVC_C4127_ \
    } while (0) \
    SIMDE_POP_DISABLE_MSVC_C4127_
#endif

#define simde_assert_type(T, fmt, a, op, b) \
  simde_assert_type_full("", "", T, fmt, a, op, b)

#define simde_assert_char(a, op, b) \
  simde_assert_type_full("'\\x", "'", char, "02" SIMDE_CHAR_MODIFIER "x", a, op, b)
#define simde_assert_uchar(a, op, b) \
  simde_assert_type_full("'\\x", "'", unsigned char, "02" SIMDE_CHAR_MODIFIER "x", a, op, b)
#define simde_assert_short(a, op, b) \
  simde_assert_type(short, SIMDE_SHORT_MODIFIER "d", a, op, b)
#define simde_assert_ushort(a, op, b) \
  simde_assert_type(unsigned short, SIMDE_SHORT_MODIFIER "u", a, op, b)
#define simde_assert_int(a, op, b) \
  simde_assert_type(int, "d", a, op, b)
#define simde_assert_uint(a, op, b) \
  simde_assert_type(unsigned int, "u", a, op, b)
#define simde_assert_long(a, op, b) \
  simde_assert_type(long int, "ld", a, op, b)
#define simde_assert_ulong(a, op, b) \
  simde_assert_type(unsigned long int, "lu", a, op, b)
#define simde_assert_llong(a, op, b) \
  simde_assert_type(long long int, "lld", a, op, b)
#define simde_assert_ullong(a, op, b) \
  simde_assert_type(unsigned long long int, "llu", a, op, b)

#define simde_assert_size(a, op, b) \
  simde_assert_type(size_t, SIMDE_SIZE_MODIFIER "u", a, op, b)

#define simde_assert_float(a, op, b) \
  simde_assert_type(float, "f", a, op, b)
#define simde_assert_double(a, op, b) \
  simde_assert_type(double, "g", a, op, b)
#define simde_assert_ptr(a, op, b) \
  simde_assert_type(const void*, "p", a, op, b)

#define simde_assert_int8(a, op, b) \
  simde_assert_type(int8_t, PRIi8, a, op, b)
#define simde_assert_uint8(a, op, b) \
  simde_assert_type(uint8_t, PRIu8, a, op, b)
#define simde_assert_int16(a, op, b) \
  simde_assert_type(int16_t, PRIi16, a, op, b)
#define simde_assert_uint16(a, op, b) \
  simde_assert_type(uint16_t, PRIu16, a, op, b)
#define simde_assert_int32(a, op, b) \
  simde_assert_type(int32_t, PRIi32, a, op, b)
#define simde_assert_uint32(a, op, b) \
  simde_assert_type(uint32_t, PRIu32, a, op, b)
#define simde_assert_int64(a, op, b) \
  simde_assert_type(int64_t, PRIi64, a, op, b)
#define simde_assert_uint64(a, op, b) \
  simde_assert_type(uint64_t, PRIu64, a, op, b)

#define simde_assert_ptr_equal(a, b) \
  simde_assert_ptr(a, ==, b)
#define simde_assert_ptr_not_equal(a, b) \
  simde_assert_ptr(a, !=, b)
#define simde_assert_null(ptr) \
  simde_assert_ptr(ptr, ==, NULL)
#define simde_assert_not_null(ptr) \
  simde_assert_ptr(ptr, !=, NULL)
#define simde_assert_ptr_null(ptr) \
  simde_assert_ptr(ptr, ==, NULL)
#define simde_assert_ptr_not_null(ptr) \
  simde_assert_ptr(ptr, !=, NULL)

#endif /* !defined(SIMDE_CHECK_H) */
/* :: End simde/check.h :: */

/* GCC/clang have a bunch of functionality in builtins which we would
 * like to access, but the suffixes indicate whether the operate on
 * int, long, or long long, not fixed width types (e.g., int32_t).
 * we use these macros to attempt to map from fixed-width to the
 * names GCC uses.  Note that you should still cast the input(s) and
 * return values (to/from SIMDE_BUILTIN_TYPE_*_) since often even if
 * types are the same size they may not be compatible according to the
 * compiler.  For example, on x86 long and long lonsg are generally
 * both 64 bits, but platforms vary on whether an int64_t is mapped
 * to a long or long long. */

#include <limits.h>

HEDLEY_DIAGNOSTIC_PUSH
SIMDE_DIAGNOSTIC_DISABLE_CPP98_COMPAT_PEDANTIC_

#if (INT8_MAX == INT_MAX) && (INT8_MIN == INT_MIN)
  #define SIMDE_BUILTIN_SUFFIX_8_
  #define SIMDE_BUILTIN_TYPE_8_ int
#elif (INT8_MAX == LONG_MAX) && (INT8_MIN == LONG_MIN)
  #define SIMDE_BUILTIN_SUFFIX_8_ l
  #define SIMDE_BUILTIN_TYPE_8_ long
#elif (INT8_MAX == LLONG_MAX) && (INT8_MIN == LLONG_MIN)
  #define SIMDE_BUILTIN_SUFFIX_8_ ll
  #define SIMDE_BUILTIN_TYPE_8_ long long
#endif

#if (INT16_MAX == INT_MAX) && (INT16_MIN == INT_MIN)
  #define SIMDE_BUILTIN_SUFFIX_16_
  #define SIMDE_BUILTIN_TYPE_16_ int
#elif (INT16_MAX == LONG_MAX) && (INT16_MIN == LONG_MIN)
  #define SIMDE_BUILTIN_SUFFIX_16_ l
  #define SIMDE_BUILTIN_TYPE_16_ long
#elif (INT16_MAX == LLONG_MAX) && (INT16_MIN == LLONG_MIN)
  #define SIMDE_BUILTIN_SUFFIX_16_ ll
  #define SIMDE_BUILTIN_TYPE_16_ long long
#endif

#if (INT32_MAX == INT_MAX) && (INT32_MIN == INT_MIN)
  #define SIMDE_BUILTIN_SUFFIX_32_
  #define SIMDE_BUILTIN_TYPE_32_ int
#elif (INT32_MAX == LONG_MAX) && (INT32_MIN == LONG_MIN)
  #define SIMDE_BUILTIN_SUFFIX_32_ l
  #define SIMDE_BUILTIN_TYPE_32_ long
#elif (INT32_MAX == LLONG_MAX) && (INT32_MIN == LLONG_MIN)
  #define SIMDE_BUILTIN_SUFFIX_32_ ll
  #define SIMDE_BUILTIN_TYPE_32_ long long
#endif

#if (INT64_MAX == INT_MAX) && (INT64_MIN == INT_MIN)
  #define SIMDE_BUILTIN_SUFFIX_64_
  #define SIMDE_BUILTIN_TYPE_64_ int
#elif (INT64_MAX == LONG_MAX) && (INT64_MIN == LONG_MIN)
  #define SIMDE_BUILTIN_SUFFIX_64_ l
  #define SIMDE_BUILTIN_TYPE_64_ long
#elif (INT64_MAX == LLONG_MAX) && (INT64_MIN == LLONG_MIN)
  #define SIMDE_BUILTIN_SUFFIX_64_ ll
  #define SIMDE_BUILTIN_TYPE_64_ long long
#endif

/* SIMDE_DIAGNOSTIC_DISABLE_CPP98_COMPAT_PEDANTIC_ */
HEDLEY_DIAGNOSTIC_POP

#if defined(SIMDE_BUILTIN_SUFFIX_8_)
  #define SIMDE_BUILTIN_8_(name) HEDLEY_CONCAT3(__builtin_, name, SIMDE_BUILTIN_SUFFIX_8_)
  #define SIMDE_BUILTIN_HAS_8_(name) HEDLEY_HAS_BUILTIN(HEDLEY_CONCAT3(__builtin_, name, SIMDE_BUILTIN_SUFFIX_8_))
#else
  #define SIMDE_BUILTIN_HAS_8_(name) 0
#endif
#if defined(SIMDE_BUILTIN_SUFFIX_16_)
  #define SIMDE_BUILTIN_16_(name) HEDLEY_CONCAT3(__builtin_, name, SIMDE_BUILTIN_SUFFIX_16_)
  #define SIMDE_BUILTIN_HAS_16_(name) HEDLEY_HAS_BUILTIN(HEDLEY_CONCAT3(__builtin_, name, SIMDE_BUILTIN_SUFFIX_16_))
#else
  #define SIMDE_BUILTIN_HAS_16_(name) 0
#endif
#if defined(SIMDE_BUILTIN_SUFFIX_32_)
  #define SIMDE_BUILTIN_32_(name) HEDLEY_CONCAT3(__builtin_, name, SIMDE_BUILTIN_SUFFIX_32_)
  #define SIMDE_BUILTIN_HAS_32_(name) HEDLEY_HAS_BUILTIN(HEDLEY_CONCAT3(__builtin_, name, SIMDE_BUILTIN_SUFFIX_32_))
#else
  #define SIMDE_BUILTIN_HAS_32_(name) 0
#endif
#if defined(SIMDE_BUILTIN_SUFFIX_64_)
  #define SIMDE_BUILTIN_64_(name) HEDLEY_CONCAT3(__builtin_, name, SIMDE_BUILTIN_SUFFIX_64_)
  #define SIMDE_BUILTIN_HAS_64_(name) HEDLEY_HAS_BUILTIN(HEDLEY_CONCAT3(__builtin_, name, SIMDE_BUILTIN_SUFFIX_64_))
#else
  #define SIMDE_BUILTIN_HAS_64_(name) 0
#endif

#if !defined(__cplusplus)
  #if defined(__clang__)
    #if HEDLEY_HAS_WARNING("-Wc11-extensions")
      #define SIMDE_GENERIC_(...) (__extension__ ({ \
          HEDLEY_DIAGNOSTIC_PUSH \
          _Pragma("clang diagnostic ignored \"-Wc11-extensions\"") \
          _Generic(__VA_ARGS__); \
          HEDLEY_DIAGNOSTIC_POP \
        }))
    #elif HEDLEY_HAS_WARNING("-Wc1x-extensions")
      #define SIMDE_GENERIC_(...) (__extension__ ({ \
          HEDLEY_DIAGNOSTIC_PUSH \
          _Pragma("clang diagnostic ignored \"-Wc1x-extensions\"") \
          _Generic(__VA_ARGS__); \
          HEDLEY_DIAGNOSTIC_POP \
        }))
    #endif
  #elif \
      defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L) || \
      HEDLEY_HAS_EXTENSION(c_generic_selections) || \
      HEDLEY_GCC_VERSION_CHECK(4,9,0) || \
      HEDLEY_INTEL_VERSION_CHECK(17,0,0) || \
      HEDLEY_IBM_VERSION_CHECK(12,1,0) || \
      HEDLEY_ARM_VERSION_CHECK(5,3,0)
    #define SIMDE_GENERIC_(...) _Generic(__VA_ARGS__)
  #endif
#endif

/* Sometimes we run into problems with specific versions of compilers
   which make the native versions unusable for us.  Often this is due
   to missing functions, sometimes buggy implementations, etc.  These
   macros are how we check for specific bugs.  As they are fixed we'll
   start only defining them for problematic compiler versions. */

#if !defined(SIMDE_IGNORE_COMPILER_BUGS)
#  if defined(HEDLEY_GCC_VERSION)
#    if !HEDLEY_GCC_VERSION_CHECK(4,9,0)
#      define SIMDE_BUG_GCC_REV_208793
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(5,0,0)
#      define SIMDE_BUG_GCC_BAD_MM_SRA_EPI32 /* TODO: find relevant bug or commit */
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(6,0,0)
#      define SIMDE_BUG_GCC_SIZEOF_IMMEDIATE
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(4,6,0)
#      define SIMDE_BUG_GCC_BAD_MM_EXTRACT_EPI8 /* TODO: find relevant bug or commit */
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(7,4,0) || (HEDLEY_GCC_VERSION_CHECK(8,0,0) && !HEDLEY_GCC_VERSION_CHECK(8,3,0))
#      define SIMDE_BUG_GCC_87467
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(8,0,0)
#      define SIMDE_BUG_GCC_REV_247851
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(10,0,0)
#      define SIMDE_BUG_GCC_REV_274313
#      define SIMDE_BUG_GCC_91341
#      define SIMDE_BUG_GCC_92035
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(9,0,0) && defined(SIMDE_ARCH_AARCH64)
#      define SIMDE_BUG_GCC_ARM_SHIFT_SCALAR
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(9,0,0) && defined(SIMDE_ARCH_AARCH64)
#      define SIMDE_BUG_GCC_BAD_VEXT_REV32
#    endif
#    if !(HEDLEY_GCC_VERSION_CHECK(9,4,0) \
          || (HEDLEY_GCC_VERSION_CHECK(8,5,0) && !HEDLEY_GCC_VERSION_CHECK(9,0,0)) \
         ) && defined(SIMDE_ARCH_X86) && !defined(SIMDE_ARCH_AMD64)
#      define SIMDE_BUG_GCC_94482
#    endif
#    if (defined(SIMDE_ARCH_X86) && !defined(SIMDE_ARCH_AMD64)) || defined(SIMDE_ARCH_ZARCH)
#      define SIMDE_BUG_GCC_53784
#    endif
#    if defined(SIMDE_ARCH_X86) || defined(SIMDE_ARCH_AMD64)
#      if HEDLEY_GCC_VERSION_CHECK(4,3,0) /* -Wsign-conversion */
#        define SIMDE_BUG_GCC_95144
#      endif
#      if !HEDLEY_GCC_VERSION_CHECK(11,2,0)
#        define SIMDE_BUG_GCC_95483
#      endif
#      if defined(__OPTIMIZE__)
#        define SIMDE_BUG_GCC_100927
#      endif
#      if !(HEDLEY_GCC_VERSION_CHECK(10,3,0))
#        define SIMDE_BUG_GCC_98521
#      endif
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(9,4,0) && defined(SIMDE_ARCH_AARCH64)
#      define SIMDE_BUG_GCC_94488
#    endif
#    if !HEDLEY_GCC_VERSION_CHECK(9,1,0) && defined(SIMDE_ARCH_AARCH64)
#      define SIMDE_BUG_GCC_REV_264019
#    endif
#    if (!HEDLEY_GCC_VERSION_CHECK(9,0,0) && !defined(SIMDE_ARCH_AARCH64)) || (!defined(SIMDE_ARCH_AARCH64) && defined(SIMDE_ARCH_ARM))
#      define SIMDE_BUG_GCC_REV_260989
#    endif
#    if defined(SIMDE_ARCH_ARM) && !defined(SIMDE_ARCH_AARCH64)
#      define SIMDE_BUG_GCC_95399
#      define SIMDE_BUG_GCC_95471
#      define SIMDE_BUG_GCC_111609
#      if SIMDE_ARCH_ARM_CHECK(8,0)
#        define SIMDE_BUG_GCC_113065
#      endif
#    endif
#    if defined(SIMDE_ARCH_POWER)
#      define SIMDE_BUG_GCC_95227
#      define SIMDE_BUG_GCC_95782
#      if !HEDLEY_GCC_VERSION_CHECK(12,0,0)
#        define SIMDE_BUG_VEC_CPSGN_REVERSED_ARGS
#      endif
#    endif
#    if defined(SIMDE_ARCH_X86) || defined(SIMDE_ARCH_AMD64)
#      if !HEDLEY_GCC_VERSION_CHECK(10,2,0) && !defined(__OPTIMIZE__)
#        define SIMDE_BUG_GCC_96174
#      endif
#    endif
#    if defined(SIMDE_ARCH_ZARCH)
#      define SIMDE_BUG_GCC_95782
#      if HEDLEY_GCC_VERSION_CHECK(10,0,0)
#        define SIMDE_BUG_GCC_101614
#      endif
#    endif
#    if defined(SIMDE_ARCH_MIPS_MSA)
#      define SIMDE_BUG_GCC_97248
#      if !HEDLEY_GCC_VERSION_CHECK(12,1,0)
#        define SIMDE_BUG_GCC_100760
#        define SIMDE_BUG_GCC_100761
#        define SIMDE_BUG_GCC_100762
#      endif
#    endif
#    if !defined(__OPTIMIZE__) && !(\
       HEDLEY_GCC_VERSION_CHECK(11,4,0) \
       || (HEDLEY_GCC_VERSION_CHECK(10,4,0) && !(HEDLEY_GCC_VERSION_CHECK(11,0,0))) \
       || (HEDLEY_GCC_VERSION_CHECK(9,5,0) && !(HEDLEY_GCC_VERSION_CHECK(10,0,0))))
#      define SIMDE_BUG_GCC_105339
#    endif
#  elif defined(__clang__)
#    if defined(SIMDE_ARCH_AARCH64)
#      define SIMDE_BUG_CLANG_48257  // https://github.com/llvm/llvm-project/issues/47601
#      define SIMDE_BUG_CLANG_71362  // https://github.com/llvm/llvm-project/issues/71362
#      define SIMDE_BUG_CLANG_71365  // https://github.com/llvm/llvm-project/issues/71365
#      define SIMDE_BUG_CLANG_71751  // https://github.com/llvm/llvm-project/issues/71751
#      if !SIMDE_DETECT_CLANG_VERSION_CHECK(15,0,0)
#        define SIMDE_BUG_CLANG_45541
#      endif
#      if !SIMDE_DETECT_CLANG_VERSION_CHECK(12,0,0)
#        define SIMDE_BUG_CLANG_46840
#        define SIMDE_BUG_CLANG_46844
#      endif
#      if SIMDE_DETECT_CLANG_VERSION_CHECK(10,0,0) && SIMDE_DETECT_CLANG_VERSION_NOT(11,0,0)
#        define SIMDE_BUG_CLANG_BAD_VI64_OPS
#      endif
#      if SIMDE_DETECT_CLANG_VERSION_NOT(9,0,0)
#        define SIMDE_BUG_CLANG_GIT_4EC445B8
#        define SIMDE_BUG_CLANG_REV_365298 /* 0464e07c8f6e3310c28eb210a4513bc2243c2a7e */
#      endif
#    endif
#    if defined(SIMDE_ARCH_ARM)
#      if !SIMDE_DETECT_CLANG_VERSION_CHECK(11,0,0)
#        define SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES
#      endif
#      if defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_ARM_NEON_A32V8_NATIVE)
#        define SIMDE_BUG_CLANG_71763  // https://github.com/llvm/llvm-project/issues/71763
#      endif
#    endif
#    if defined(SIMDE_ARCH_POWER) && !SIMDE_DETECT_CLANG_VERSION_CHECK(12,0,0)
#      define SIMDE_BUG_CLANG_46770
#    endif
#    if defined(SIMDE_ARCH_POWER) && (SIMDE_ARCH_POWER == 700) && (SIMDE_DETECT_CLANG_VERSION_CHECK(11,0,0))
#      if !SIMDE_DETECT_CLANG_VERSION_CHECK(13,0,0)
#        define SIMDE_BUG_CLANG_50893
#        define SIMDE_BUG_CLANG_50901
#      endif
#    endif
#    if defined(_ARCH_PWR9) && !SIMDE_DETECT_CLANG_VERSION_CHECK(12,0,0) && !defined(__OPTIMIZE__)
#      define SIMDE_BUG_CLANG_POWER9_16x4_BAD_SHIFT
#    endif
#    if defined(SIMDE_ARCH_POWER)
#      if !SIMDE_DETECT_CLANG_VERSION_CHECK(14,0,0)
#        define SIMDE_BUG_CLANG_50932
#      endif
#      if !SIMDE_DETECT_CLANG_VERSION_CHECK(12,0,0)
#        define SIMDE_BUG_VEC_CPSGN_REVERSED_ARGS
#      endif
#    endif
#    if defined(SIMDE_ARCH_X86) || defined(SIMDE_ARCH_AMD64)
#      if SIMDE_DETECT_CLANG_VERSION_NOT(5,0,0)
#        define SIMDE_BUG_CLANG_REV_298042 /* 6afc436a7817a52e78ae7bcdc3faafd460124cac */
#      endif
#      if SIMDE_DETECT_CLANG_VERSION_NOT(3,7,0)
#        define SIMDE_BUG_CLANG_REV_234560 /* b929ad7b1726a32650a8051f69a747fb6836c540 */
#      endif
#      if SIMDE_DETECT_CLANG_VERSION_CHECK(3,8,0) && SIMDE_DETECT_CLANG_VERSION_NOT(5,0,0)
#        define SIMDE_BUG_CLANG_BAD_MADD
#      endif
#      if SIMDE_DETECT_CLANG_VERSION_CHECK(4,0,0) && SIMDE_DETECT_CLANG_VERSION_NOT(5,0,0)
#        define SIMDE_BUG_CLANG_REV_299346 /* ac9959eb533a58482ea4da6c4db1e635a98de384 */
#      endif
#      if SIMDE_DETECT_CLANG_VERSION_NOT(8,0,0)
#        define SIMDE_BUG_CLANG_REV_344862 /* eae26bf73715994c2bd145f9b6dc3836aa4ffd4f */
#      endif
#      if HEDLEY_HAS_WARNING("-Wsign-conversion") && SIMDE_DETECT_CLANG_VERSION_NOT(11,0,0)
#        define SIMDE_BUG_CLANG_45931
#      endif
#      if HEDLEY_HAS_WARNING("-Wvector-conversion") && SIMDE_DETECT_CLANG_VERSION_NOT(11,0,0)
#        define SIMDE_BUG_CLANG_44589
#      endif
#      define SIMDE_BUG_CLANG_48673  // https://github.com/llvm/llvm-project/issues/48017
#    endif
#    define SIMDE_BUG_CLANG_45959  // https://github.com/llvm/llvm-project/issues/45304
#    if defined(SIMDE_ARCH_WASM_SIMD128) && !SIMDE_DETECT_CLANG_VERSION_CHECK(17,0,0)
#      define SIMDE_BUG_CLANG_60655
#    endif
#  elif defined(HEDLEY_MSVC_VERSION)
#    if defined(SIMDE_ARCH_X86)
#      define SIMDE_BUG_MSVC_ROUND_EXTRACT
#    endif
#  elif defined(HEDLEY_INTEL_VERSION)
#    define SIMDE_BUG_INTEL_857088
#  elif defined(HEDLEY_MCST_LCC_VERSION)
#    define SIMDE_BUG_MCST_LCC_MISSING_AVX_LOAD_STORE_M128_FUNCS
#    define SIMDE_BUG_MCST_LCC_MISSING_CMOV_M256
#    define SIMDE_BUG_MCST_LCC_FMA_WRONG_RESULT
#  elif defined(HEDLEY_PGI_VERSION)
#    define SIMDE_BUG_PGI_30104
#    define SIMDE_BUG_PGI_30107
#    define SIMDE_BUG_PGI_30106
#  endif
#endif

/* GCC and Clang both have the same issue:
 * https://gcc.gnu.org/bugzilla/show_bug.cgi?id=95144
 * https://bugs.llvm.org/show_bug.cgi?id=45931
 * This is just an easy way to work around it.
 */
#if \
    (HEDLEY_HAS_WARNING("-Wsign-conversion") && SIMDE_DETECT_CLANG_VERSION_NOT(11,0,0)) || \
    HEDLEY_GCC_VERSION_CHECK(4,3,0)
#  define SIMDE_BUG_IGNORE_SIGN_CONVERSION(expr) (__extension__ ({ \
       HEDLEY_DIAGNOSTIC_PUSH  \
       _Pragma("GCC diagnostic ignored \"-Wsign-conversion\"") \
       __typeof__(expr) simde_bug_ignore_sign_conversion_v_= (expr); \
       HEDLEY_DIAGNOSTIC_POP  \
       simde_bug_ignore_sign_conversion_v_; \
     }))
#else
#  define SIMDE_BUG_IGNORE_SIGN_CONVERSION(expr) (expr)
#endif

/* Usually the shift count is signed (for example, NEON or SSE).
 * OTOH, unsigned is good for PPC (vec_srl uses unsigned), and the only option for E2K.
 * Further info: https://github.com/simd-everywhere/simde/pull/700
 */
#if defined(SIMDE_ARCH_E2K) || defined(SIMDE_ARCH_POWER)
  #define SIMDE_CAST_VECTOR_SHIFT_COUNT(width, value) HEDLEY_STATIC_CAST(uint##width##_t, (value))
#else
  #define SIMDE_CAST_VECTOR_SHIFT_COUNT(width, value) HEDLEY_STATIC_CAST(int##width##_t, (value))
#endif

/* Initial support for RISCV V extensions based on ZVE64D. */
#if defined(SIMDE_ARCH_RISCV_ZVE64D) && SIMDE_NATURAL_VECTOR_SIZE >= 64
  #define RVV_FIXED_TYPE_DEF(name, lmul) \
    typedef vint8##name##_t  fixed_vint8##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul))); \
    typedef vint16##name##_t fixed_vint16##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul))); \
    typedef vint32##name##_t fixed_vint32##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul))); \
    typedef vuint8##name##_t fixed_vuint8##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul))); \
    typedef vuint16##name##_t fixed_vuint16##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul))); \
    typedef vuint32##name##_t fixed_vuint32##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul))); \
    typedef vfloat32##name##_t fixed_vfloat32##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul)));
    RVV_FIXED_TYPE_DEF(mf2, 1/2);
    RVV_FIXED_TYPE_DEF(m1, 1);
    RVV_FIXED_TYPE_DEF(m2, 2);
  #define RVV_FIXED_TYPE_DEF_64B(name, lmul) \
    typedef vint64##name##_t fixed_vint64##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul))); \
    typedef vuint64##name##_t fixed_vuint64##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul))); \
    typedef vfloat64##name##_t fixed_vfloat64##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul)));
    RVV_FIXED_TYPE_DEF_64B(m1, 1);
    RVV_FIXED_TYPE_DEF_64B(m2, 2);
  #if defined(SIMDE_ARCH_RISCV_ZVFH)
    #define RVV_FIXED_TYPE_DEF_16F(name, lmul) \
      typedef vfloat16##name##_t fixed_vfloat16##name##_t __attribute__((riscv_rvv_vector_bits(__riscv_v_fixed_vlen * lmul)));
    RVV_FIXED_TYPE_DEF_16F(mf2, 1/2);
    RVV_FIXED_TYPE_DEF_16F(m1, 1);
    RVV_FIXED_TYPE_DEF_16F(m2, 2);
  #endif
#endif

/* SIMDE_DIAGNOSTIC_DISABLE_USED_BUT_MARKED_UNUSED_ */
HEDLEY_DIAGNOSTIC_POP

#endif /* !defined(SIMDE_COMMON_H) */
/* :: End simde/simde-common.h :: */

HEDLEY_DIAGNOSTIC_PUSH
SIMDE_DISABLE_UNWANTED_DIAGNOSTICS
SIMDE_BEGIN_DECLS_

typedef union {
  #if defined(SIMDE_VECTOR_SUBSCRIPT)
    SIMDE_ALIGN_TO_16 int8_t          i8 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 int16_t        i16 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 int32_t        i32 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 int64_t        i64 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 uint8_t         u8 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 uint16_t       u16 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 uint32_t       u32 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 uint64_t       u64 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    #if defined(SIMDE_HAVE_INT128_)
    SIMDE_ALIGN_TO_16 simde_int128  i128 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 simde_uint128 u128 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    #endif
    SIMDE_ALIGN_TO_16 simde_float32  f32 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 simde_float64  f64 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 int_fast32_t  i32f SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
    SIMDE_ALIGN_TO_16 uint_fast32_t u32f SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
  #else
    SIMDE_ALIGN_TO_16 int8_t         i8[16];
    SIMDE_ALIGN_TO_16 int16_t        i16[8];
    SIMDE_ALIGN_TO_16 int32_t        i32[4];
    SIMDE_ALIGN_TO_16 int64_t        i64[2];
    SIMDE_ALIGN_TO_16 uint8_t        u8[16];
    SIMDE_ALIGN_TO_16 uint16_t       u16[8];
    SIMDE_ALIGN_TO_16 uint32_t       u32[4];
    SIMDE_ALIGN_TO_16 uint64_t       u64[2];
    #if defined(SIMDE_HAVE_INT128_)
    SIMDE_ALIGN_TO_16 simde_int128  i128[1];
    SIMDE_ALIGN_TO_16 simde_uint128 u128[1];
    #endif
    SIMDE_ALIGN_TO_16 simde_float32  f32[4];
    SIMDE_ALIGN_TO_16 simde_float64  f64[2];
    SIMDE_ALIGN_TO_16 int_fast32_t  i32f[16 / sizeof(int_fast32_t)];
    SIMDE_ALIGN_TO_16 uint_fast32_t u32f[16 / sizeof(uint_fast32_t)];
  #endif

  #if defined(SIMDE_X86_SSE_NATIVE)
    SIMDE_ALIGN_TO_16 __m128         sse_m128;
    #if defined(SIMDE_X86_SSE2_NATIVE)
      SIMDE_ALIGN_TO_16 __m128i      sse_m128i;
      SIMDE_ALIGN_TO_16 __m128d      sse_m128d;
    #endif
  #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
    SIMDE_ALIGN_TO_16 int8x16_t      neon_i8;
    SIMDE_ALIGN_TO_16 int16x8_t      neon_i16;
    SIMDE_ALIGN_TO_16 int32x4_t      neon_i32;
    SIMDE_ALIGN_TO_16 int64x2_t      neon_i64;
    SIMDE_ALIGN_TO_16 uint8x16_t     neon_u8;
    SIMDE_ALIGN_TO_16 uint16x8_t     neon_u16;
    SIMDE_ALIGN_TO_16 uint32x4_t     neon_u32;
    SIMDE_ALIGN_TO_16 uint64x2_t     neon_u64;
    SIMDE_ALIGN_TO_16 float32x4_t    neon_f32;
    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      SIMDE_ALIGN_TO_16 float64x2_t    neon_f64;
    #endif
  #elif defined(SIMDE_WASM_SIMD128_NATIVE)
    SIMDE_ALIGN_TO_16 v128_t         wasm_v128;
  #elif defined(SIMDE_MIPS_MSA_NATIVE)
    SIMDE_ALIGN_TO_16 v16i8          msa_v16i8;
    SIMDE_ALIGN_TO_16 v8i16          msa_v8i16;
    SIMDE_ALIGN_TO_16 v4i32          msa_v4i32;
    SIMDE_ALIGN_TO_16 v2i64          msa_v2i64;
    SIMDE_ALIGN_TO_16 v16u8          msa_v16u8;
    SIMDE_ALIGN_TO_16 v8u16          msa_v8u16;
    SIMDE_ALIGN_TO_16 v4u32          msa_v4u32;
    SIMDE_ALIGN_TO_16 v2u64          msa_v2u64;
    SIMDE_ALIGN_TO_16 v4f32          msa_v4f32;
    SIMDE_ALIGN_TO_16 v2f64          msa_v2f64;
  #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
    SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(unsigned char)      altivec_u8;
    SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(unsigned short)     altivec_u16;
    SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(unsigned int)       altivec_u32;
    SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(signed char)        altivec_i8;
    SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(signed short)       altivec_i16;
    SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(signed int)         altivec_i32;
    SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(float)              altivec_f32;
    #if defined(SIMDE_POWER_ALTIVEC_P7_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(unsigned long long) altivec_u64;
      SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(signed long long)   altivec_i64;
      SIMDE_ALIGN_TO_16 SIMDE_POWER_ALTIVEC_VECTOR(double)             altivec_f64;
    #endif
  #endif
} simde_v128_private;

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  typedef v128_t simde_v128_t;
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
  typedef int32x4_t simde_v128_t;
#elif defined(SIMDE_X86_SSE2_NATIVE)
  typedef __m128i simde_v128_t;
#elif defined(SIMDE_X86_SSE_NATIVE)
  typedef __m128 simde_v128_t;
#elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
  typedef SIMDE_POWER_ALTIVEC_VECTOR(signed int) simde_v128_t;
#elif defined(SIMDE_MIPS_MSA_NATIVE)
  typedef v4i32 simde_v128_t;
#elif defined(SIMDE_VECTOR_SUBSCRIPT)
  typedef int32_t simde_v128_t SIMDE_ALIGN_TO_16 SIMDE_VECTOR(16) SIMDE_MAY_ALIAS;
#else
  typedef simde_v128_private simde_v128_t;
#endif

#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  typedef simde_v128_t v128_t;
#endif

HEDLEY_STATIC_ASSERT(16 == sizeof(simde_v128_t), "simde_v128_t size incorrect");
HEDLEY_STATIC_ASSERT(16 == sizeof(simde_v128_private), "simde_v128_private size incorrect");
#if defined(SIMDE_CHECK_ALIGNMENT) && defined(SIMDE_ALIGN_OF)
HEDLEY_STATIC_ASSERT(SIMDE_ALIGN_OF(simde_v128_t) == 16, "simde_v128_t is not 16-byte aligned");
HEDLEY_STATIC_ASSERT(SIMDE_ALIGN_OF(simde_v128_private) == 16, "simde_v128_private is not 16-byte aligned");
#endif

#define SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(Other_Type, SIMDe_Type, To_Name, From_Name) \
  SIMDE_FUNCTION_ATTRIBUTES \
  Other_Type To_Name(SIMDe_Type v) { \
    Other_Type r; \
    simde_memcpy(&r, &v, sizeof(r)); \
    return r; \
  } \
  \
  SIMDE_FUNCTION_ATTRIBUTES \
  SIMDe_Type From_Name(Other_Type v) { \
    SIMDe_Type r; \
    simde_memcpy(&r, &v, sizeof(r)); \
    return r; \
  }

SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(simde_v128_private, simde_v128_t, simde_v128_to_private, simde_v128_from_private)

#define SIMDE_WASM_SIMD128_FMIN(x, y)                                  \
  (simde_math_isnan(x)          ? SIMDE_MATH_NAN                       \
   : simde_math_isnan(y)        ? SIMDE_MATH_NAN                       \
   : (((x) == 0) && ((y) == 0)) ? (simde_math_signbit(x) ? (x) : (y))  \
                                : ((x) < (y) ? (x) : (y)))

#define SIMDE_WASM_SIMD128_FMAX(x, y)                                  \
  (simde_math_isnan(x)          ? SIMDE_MATH_NAN                       \
   : simde_math_isnan(y)        ? SIMDE_MATH_NAN                       \
   : (((x) == 0) && ((y) == 0)) ? (simde_math_signbit(x) ? (y) : (x))  \
                                : ((x) > (y) ? (x) : (y)))

#define SIMDE_WASM_SIMD128_FMINF(x, y)                                  \
  (simde_math_isnanf(x)          ? SIMDE_MATH_NANF                      \
   : simde_math_isnanf(y)        ? SIMDE_MATH_NANF                      \
   : (((x) == 0) && ((y) == 0)) ? (simde_math_signbit(x) ? (x) : (y))  \
                                : ((x) < (y) ? (x) : (y)))

#define SIMDE_WASM_SIMD128_FMAXF(x, y)                                  \
  (simde_math_isnanf(x)          ? SIMDE_MATH_NANF                      \
   : simde_math_isnanf(y)        ? SIMDE_MATH_NANF                      \
   : (((x) == 0) && ((y) == 0)) ? (simde_math_signbit(x) ? (y) : (x))  \
                                : ((x) > (y) ? (x) : (y)))

#if defined(SIMDE_X86_SSE_NATIVE)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(__m128 , simde_v128_t, simde_v128_to_m128 , simde_v128_from_m128 )
#endif
#if defined(SIMDE_X86_SSE2_NATIVE)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(__m128i, simde_v128_t, simde_v128_to_m128i, simde_v128_from_m128i)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(__m128d, simde_v128_t, simde_v128_to_m128d, simde_v128_from_m128d)
#endif

#if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(  int8x16_t, simde_v128_t, simde_v128_to_neon_i8 , simde_v128_from_neon_i8 )
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(  int16x8_t, simde_v128_t, simde_v128_to_neon_i16, simde_v128_from_neon_i16)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(  int32x4_t, simde_v128_t, simde_v128_to_neon_i32, simde_v128_from_neon_i32)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(  int64x2_t, simde_v128_t, simde_v128_to_neon_i64, simde_v128_from_neon_i64)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS( uint8x16_t, simde_v128_t, simde_v128_to_neon_u8 , simde_v128_from_neon_u8 )
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS( uint16x8_t, simde_v128_t, simde_v128_to_neon_u16, simde_v128_from_neon_u16)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS( uint32x4_t, simde_v128_t, simde_v128_to_neon_u32, simde_v128_from_neon_u32)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS( uint64x2_t, simde_v128_t, simde_v128_to_neon_u64, simde_v128_from_neon_u64)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(float32x4_t, simde_v128_t, simde_v128_to_neon_f32, simde_v128_from_neon_f32)
  #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
    SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(float64x2_t, simde_v128_t, simde_v128_to_neon_f64, simde_v128_from_neon_f64)
  #endif
#endif /* defined(SIMDE_ARM_NEON_A32V7_NATIVE) */

#if defined(SIMDE_MIPS_MSA_NATIVE)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v16i8, simde_v128_t, simde_v128_to_msa_v16i8, simde_v128_from_msa_v16i8)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v8i16, simde_v128_t, simde_v128_to_msa_v8i16, simde_v128_from_msa_v8i16)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v4i32, simde_v128_t, simde_v128_to_msa_v4i32, simde_v128_from_msa_v4i32)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v2i64, simde_v128_t, simde_v128_to_msa_v2i64, simde_v128_from_msa_v2i64)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v16u8, simde_v128_t, simde_v128_to_msa_v16u8, simde_v128_from_msa_v16u8)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v8u16, simde_v128_t, simde_v128_to_msa_v8u16, simde_v128_from_msa_v8u16)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v4u32, simde_v128_t, simde_v128_to_msa_v4u32, simde_v128_from_msa_v4u32)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v2u64, simde_v128_t, simde_v128_to_msa_v2u64, simde_v128_from_msa_v2u64)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v4f32, simde_v128_t, simde_v128_to_msa_v4f32, simde_v128_from_msa_v4f32)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(v2f64, simde_v128_t, simde_v128_to_msa_v2f64, simde_v128_from_msa_v2f64)
#endif

#if defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(SIMDE_POWER_ALTIVEC_VECTOR(  signed  char), simde_v128_t, simde_v128_to_altivec_i8 , simde_v128_from_altivec_i8 )
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(SIMDE_POWER_ALTIVEC_VECTOR(  signed short), simde_v128_t, simde_v128_to_altivec_i16, simde_v128_from_altivec_i16)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(SIMDE_POWER_ALTIVEC_VECTOR(  signed   int), simde_v128_t, simde_v128_to_altivec_i32, simde_v128_from_altivec_i32)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(SIMDE_POWER_ALTIVEC_VECTOR(unsigned  char), simde_v128_t, simde_v128_to_altivec_u8 , simde_v128_from_altivec_u8 )
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(SIMDE_POWER_ALTIVEC_VECTOR(unsigned short), simde_v128_t, simde_v128_to_altivec_u16, simde_v128_from_altivec_u16)
  SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(SIMDE_POWER_ALTIVEC_VECTOR(unsigned   int), simde_v128_t, simde_v128_to_altivec_u32, simde_v128_from_altivec_u32)
  #if defined(SIMDE_POWER_ALTIVEC_P7_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
    SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(SIMDE_POWER_ALTIVEC_VECTOR(  signed  long long), simde_v128_t, simde_v128_to_altivec_i64, simde_v128_from_altivec_i64)
    SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(SIMDE_POWER_ALTIVEC_VECTOR(unsigned  long long), simde_v128_t, simde_v128_to_altivec_u64, simde_v128_from_altivec_u64)
  #endif

  #if defined(SIMDE_BUG_GCC_95782)
    SIMDE_FUNCTION_ATTRIBUTES
    SIMDE_POWER_ALTIVEC_VECTOR(float)
    simde_v128_to_altivec_f32(simde_v128_t value) {
      simde_v128_private r_ = simde_v128_to_private(value);
      return r_.altivec_f32;
    }

    SIMDE_FUNCTION_ATTRIBUTES
    simde_v128_t
    simde_v128_from_altivec_f32(SIMDE_POWER_ALTIVEC_VECTOR(float) value) {
      simde_v128_private r_;
      r_.altivec_f32 = value;
      return simde_v128_from_private(r_);
    }
  #else
    SIMDE_WASM_SIMD128_GENERATE_CONVERSION_FUNCTIONS(SIMDE_POWER_ALTIVEC_VECTOR(float), simde_v128_t, simde_v128_to_altivec_f32, simde_v128_from_altivec_f32)
  #endif
#endif /* defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) */

/*
 * Begin function implementations
 */

/* load */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_load(mem);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    return _mm_loadu_si128(HEDLEY_REINTERPRET_CAST(const __m128i*, mem));
  #else
    simde_v128_t r;
    simde_memcpy(&r, mem, sizeof(r));
    return r;
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load(mem) simde_wasm_v128_load((mem))
#endif

/* store */

SIMDE_FUNCTION_ATTRIBUTES
void
simde_wasm_v128_store (void * mem, simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    wasm_v128_store(mem, a);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    _mm_storeu_si128(HEDLEY_REINTERPRET_CAST(__m128i*, mem), a);
  #else
    simde_memcpy(mem, &a, sizeof(a));
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_store(mem, a) simde_wasm_v128_store((mem), (a))
#endif

/* make */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_make (
    int8_t c0, int8_t c1, int8_t  c2, int8_t  c3, int8_t  c4, int8_t  c5, int8_t  c6, int8_t  c7,
    int8_t c8, int8_t c9, int8_t c10, int8_t c11, int8_t c12, int8_t c13, int8_t c14, int8_t c15) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return
      wasm_i8x16_make(
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7,
        c8, c9, c10, c11, c12, c13, c14, c15);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    return
      _mm_setr_epi8(
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7,
        c8, c9, c10, c11, c12, c13, c14, c15);
  #else
    simde_v128_private r_;

    r_.i8[ 0] =  c0;
    r_.i8[ 1] =  c1;
    r_.i8[ 2] =  c2;
    r_.i8[ 3] =  c3;
    r_.i8[ 4] =  c4;
    r_.i8[ 5] =  c5;
    r_.i8[ 6] =  c6;
    r_.i8[ 7] =  c7;
    r_.i8[ 8] =  c8;
    r_.i8[ 9] =  c9;
    r_.i8[10] = c10;
    r_.i8[11] = c11;
    r_.i8[12] = c12;
    r_.i8[13] = c13;
    r_.i8[14] = c14;
    r_.i8[15] = c15;

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i8x16_make( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
      simde_wasm_i8x16_make( \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7), \
          (c8), (c9), (c10), (c11), (c12), (c13), (c14), (c15))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_make (
    uint8_t c0, uint8_t c1, uint8_t  c2, uint8_t  c3, uint8_t  c4, uint8_t  c5, uint8_t  c6, uint8_t  c7,
    uint8_t c8, uint8_t c9, uint8_t c10, uint8_t c11, uint8_t c12, uint8_t c13, uint8_t c14, uint8_t c15) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return
      wasm_u8x16_make(
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7,
        c8, c9, c10, c11, c12, c13, c14, c15);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    return _mm_set_epi8(
      HEDLEY_STATIC_CAST(char, c15), HEDLEY_STATIC_CAST(char, c14), HEDLEY_STATIC_CAST(char, c13), HEDLEY_STATIC_CAST(char, c12),
      HEDLEY_STATIC_CAST(char, c11), HEDLEY_STATIC_CAST(char, c10), HEDLEY_STATIC_CAST(char,  c9), HEDLEY_STATIC_CAST(char,  c8),
      HEDLEY_STATIC_CAST(char,  c7), HEDLEY_STATIC_CAST(char,  c6), HEDLEY_STATIC_CAST(char,  c5), HEDLEY_STATIC_CAST(char,  c4),
      HEDLEY_STATIC_CAST(char,  c3), HEDLEY_STATIC_CAST(char,  c2), HEDLEY_STATIC_CAST(char,  c1), HEDLEY_STATIC_CAST(char,  c0));
  #else
    simde_v128_private r_;

    r_.u8[ 0] =  c0;
    r_.u8[ 1] =  c1;
    r_.u8[ 2] =  c2;
    r_.u8[ 3] =  c3;
    r_.u8[ 4] =  c4;
    r_.u8[ 5] =  c5;
    r_.u8[ 6] =  c6;
    r_.u8[ 7] =  c7;
    r_.u8[ 8] =  c8;
    r_.u8[ 9] =  c9;
    r_.u8[10] = c10;
    r_.u8[11] = c11;
    r_.u8[12] = c12;
    r_.u8[13] = c13;
    r_.u8[14] = c14;
    r_.u8[15] = c15;

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_u8x16_make( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
      simde_wasm_u8x16_make( \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7), \
          (c8), (c9), (c10), (c11), (c12), (c13), (c14), (c15))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_make (
    int16_t c0, int16_t c1, int16_t  c2, int16_t  c3, int16_t  c4, int16_t  c5, int16_t  c6, int16_t  c7) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_make(c0, c1, c2, c3, c4, c5, c6, c7);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    return _mm_setr_epi16(c0, c1, c2, c3, c4, c5, c6, c7);
  #else
    simde_v128_private r_;

    r_.i16[0] = c0;
    r_.i16[1] = c1;
    r_.i16[2] = c2;
    r_.i16[3] = c3;
    r_.i16[4] = c4;
    r_.i16[5] = c5;
    r_.i16[6] = c6;
    r_.i16[7] = c7;

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i16x8_make(c0, c1,  c2,  c3,  c4,  c5,  c6,  c7) \
      simde_wasm_i16x8_make((c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_make (
    uint16_t c0, uint16_t c1, uint16_t  c2, uint16_t  c3, uint16_t  c4, uint16_t  c5, uint16_t  c6, uint16_t  c7) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_make(c0, c1, c2, c3, c4, c5, c6, c7);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    return _mm_set_epi16(
      HEDLEY_STATIC_CAST(short,  c7), HEDLEY_STATIC_CAST(short,  c6), HEDLEY_STATIC_CAST(short,  c5), HEDLEY_STATIC_CAST(short,  c4),
      HEDLEY_STATIC_CAST(short,  c3), HEDLEY_STATIC_CAST(short,  c2), HEDLEY_STATIC_CAST(short,  c1), HEDLEY_STATIC_CAST(short,  c0));
  #else
    simde_v128_private r_;

    r_.u16[0] = c0;
    r_.u16[1] = c1;
    r_.u16[2] = c2;
    r_.u16[3] = c3;
    r_.u16[4] = c4;
    r_.u16[5] = c5;
    r_.u16[6] = c6;
    r_.u16[7] = c7;

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_u16x8_make(c0, c1,  c2,  c3,  c4,  c5,  c6,  c7) \
      simde_wasm_u16x8_make((c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_make (int32_t c0, int32_t c1, int32_t  c2, int32_t  c3) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_make(c0, c1, c2, c3);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    return _mm_setr_epi32(c0, c1, c2, c3);
  #else
    simde_v128_private r_;

    r_.i32[0] = c0;
    r_.i32[1] = c1;
    r_.i32[2] = c2;
    r_.i32[3] = c3;

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_make(c0, c1,  c2,  c3) simde_wasm_i32x4_make((c0), (c1),  (c2),  (c3))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_make (uint32_t c0, uint32_t c1, uint32_t  c2, uint32_t  c3) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_make(c0, c1, c2, c3);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    return _mm_set_epi32(
      HEDLEY_STATIC_CAST(int,  c3), HEDLEY_STATIC_CAST(int,  c2), HEDLEY_STATIC_CAST(int,  c1), HEDLEY_STATIC_CAST(int,  c0));
  #else
    simde_v128_private r_;

    r_.u32[0] = c0;
    r_.u32[1] = c1;
    r_.u32[2] = c2;
    r_.u32[3] = c3;

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_make(c0, c1,  c2,  c3) simde_wasm_u32x4_make((c0), (c1),  (c2),  (c3))
#endif


SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_make (int64_t c0, int64_t c1) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_make(c0, c1);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    return _mm_set_epi64x(c1, c0);
  #else
    simde_v128_private r_;

    r_.i64[0] = c0;
    r_.i64[1] = c1;

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_make(c0, c1) simde_wasm_i64x2_make((c0), (c1))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u64x2_make (uint64_t c0, uint64_t c1) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u64x2_make(c0, c1);
  #elif defined(SIMDE_X86_SSE2_NATIVE)
    return _mm_set_epi64x(HEDLEY_STATIC_CAST(int64_t,  c1), HEDLEY_STATIC_CAST(int64_t,  c0));
  #else
    simde_v128_private r_;

    r_.u64[0] = c0;
    r_.u64[1] = c1;

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u64x2_make(c0, c1) simde_wasm_u64x2_make((c0), (c1))
#endif


SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_make (simde_float32 c0, simde_float32 c1, simde_float32  c2, simde_float32  c3) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_make(c0, c1, c2, c3);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_setr_ps(c0, c1, c2, c3);
    #else
      r_.f32[0] = c0;
      r_.f32[1] = c1;
      r_.f32[2] = c2;
      r_.f32[3] = c3;
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_make(c0, c1,  c2,  c3) simde_wasm_f32x4_make((c0), (c1),  (c2),  (c3))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_make (simde_float64 c0, simde_float64 c1) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_make(c0, c1);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_set_pd(c1, c0);
    #else
      r_.f64[ 0] = c0;
      r_.f64[ 1] = c1;
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_make(c0, c1) simde_wasm_f64x2_make((c0), (c1))
#endif

/* const */

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_i8x16_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
      wasm_i8x16_const( \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7), \
          (c8), (c9), (c10), (c11), (c12), (c13), (c14), (c15))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_i8x16_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      SIMDE_ASSERT_CONSTANT_(c2); \
      SIMDE_ASSERT_CONSTANT_(c3); \
      SIMDE_ASSERT_CONSTANT_(c4); \
      SIMDE_ASSERT_CONSTANT_(c5); \
      SIMDE_ASSERT_CONSTANT_(c6); \
      SIMDE_ASSERT_CONSTANT_(c7); \
      SIMDE_ASSERT_CONSTANT_(c8); \
      SIMDE_ASSERT_CONSTANT_(c9); \
      SIMDE_ASSERT_CONSTANT_(c10); \
      SIMDE_ASSERT_CONSTANT_(c11); \
      SIMDE_ASSERT_CONSTANT_(c12); \
      SIMDE_ASSERT_CONSTANT_(c13); \
      SIMDE_ASSERT_CONSTANT_(c13); \
      SIMDE_ASSERT_CONSTANT_(c15); \
      \
      simde_wasm_i8x16_make( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_i8x16_const (
      int8_t c0, int8_t c1, int8_t  c2, int8_t  c3, int8_t  c4, int8_t  c5, int8_t  c6, int8_t  c7,
      int8_t c8, int8_t c9, int8_t c10, int8_t c11, int8_t c12, int8_t c13, int8_t c14, int8_t c15) {
    return simde_wasm_i8x16_make(
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7,
        c8, c9, c10, c11, c12, c13, c14, c15);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i8x16_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
      simde_wasm_i8x16_const( \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7), \
          (c8), (c9), (c10), (c11), (c12), (c13), (c14), (c15))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_u8x16_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
      wasm_u8x16_const( \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7), \
          (c8), (c9), (c10), (c11), (c12), (c13), (c14), (c15))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_u8x16_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      SIMDE_ASSERT_CONSTANT_(c2); \
      SIMDE_ASSERT_CONSTANT_(c3); \
      SIMDE_ASSERT_CONSTANT_(c4); \
      SIMDE_ASSERT_CONSTANT_(c5); \
      SIMDE_ASSERT_CONSTANT_(c6); \
      SIMDE_ASSERT_CONSTANT_(c7); \
      SIMDE_ASSERT_CONSTANT_(c8); \
      SIMDE_ASSERT_CONSTANT_(c9); \
      SIMDE_ASSERT_CONSTANT_(c10); \
      SIMDE_ASSERT_CONSTANT_(c11); \
      SIMDE_ASSERT_CONSTANT_(c12); \
      SIMDE_ASSERT_CONSTANT_(c13); \
      SIMDE_ASSERT_CONSTANT_(c13); \
      SIMDE_ASSERT_CONSTANT_(c15); \
      \
      simde_wasm_u8x16_make( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_u8x16_const (
      uint8_t c0, uint8_t c1, uint8_t  c2, uint8_t  c3, uint8_t  c4, uint8_t  c5, uint8_t  c6, uint8_t  c7,
      uint8_t c8, uint8_t c9, uint8_t c10, uint8_t c11, uint8_t c12, uint8_t c13, uint8_t c14, uint8_t c15) {
    return simde_wasm_u8x16_make(
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7,
        c8, c9, c10, c11, c12, c13, c14, c15);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_u8x16_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
      simde_wasm_u8x16_const( \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7), \
          (c8), (c9), (c10), (c11), (c12), (c13), (c14), (c15))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_i16x8_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7) \
      wasm_i16x8_const( \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_i16x8_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      SIMDE_ASSERT_CONSTANT_(c2); \
      SIMDE_ASSERT_CONSTANT_(c3); \
      SIMDE_ASSERT_CONSTANT_(c4); \
      SIMDE_ASSERT_CONSTANT_(c5); \
      SIMDE_ASSERT_CONSTANT_(c6); \
      SIMDE_ASSERT_CONSTANT_(c7); \
      \
      simde_wasm_i16x8_make( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_i16x8_const (
      int16_t c0, int16_t c1, int16_t  c2, int16_t  c3, int16_t  c4, int16_t  c5, int16_t  c6, int16_t  c7) {
    return simde_wasm_i16x8_make(
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i16x8_const( \
        c0, c1, c2, c3, c4, c5, c6, c7) \
      simde_wasm_i16x8_const( \
          (c0), (c1), (c2), (c3), (c4), (c5), (c6), (c7))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_u16x8_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7) \
      wasm_u16x8_const( \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_u16x8_const( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      SIMDE_ASSERT_CONSTANT_(c2); \
      SIMDE_ASSERT_CONSTANT_(c3); \
      SIMDE_ASSERT_CONSTANT_(c4); \
      SIMDE_ASSERT_CONSTANT_(c5); \
      SIMDE_ASSERT_CONSTANT_(c6); \
      SIMDE_ASSERT_CONSTANT_(c7); \
      \
      simde_wasm_u16x8_make( \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_u16x8_const (
      uint16_t c0, uint16_t c1, uint16_t  c2, uint16_t  c3, uint16_t  c4, uint16_t  c5, uint16_t  c6, uint16_t  c7) {
    return simde_wasm_u16x8_make(
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_u16x8_const( \
        c0, c1, c2, c3, c4, c5, c6, c7) \
      simde_wasm_u16x8_const( \
          (c0), (c1), (c2), (c3), (c4), (c5), (c6), (c7))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_i32x4_const( \
        c0, c1,  c2,  c3) \
      wasm_i32x4_const( \
          (c0), (c1),  (c2),  (c3))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_i32x4_const( \
        c0, c1,  c2,  c3) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      SIMDE_ASSERT_CONSTANT_(c2); \
      SIMDE_ASSERT_CONSTANT_(c3); \
      \
      simde_wasm_i32x4_make( \
        c0, c1,  c2,  c3); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_i32x4_const (
      int32_t c0, int32_t c1, int32_t  c2, int32_t  c3) {
    return simde_wasm_i32x4_make(
        c0, c1,  c2,  c3);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i32x4_const( \
        c0, c1,  c2,  c3) \
      simde_wasm_i32x4_const( \
          (c0), (c1),  (c2),  (c3))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_u32x4_const( \
        c0, c1,  c2,  c3) \
      wasm_u32x4_const( \
          (c0), (c1),  (c2),  (c3))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_u32x4_const( \
        c0, c1,  c2,  c3) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      SIMDE_ASSERT_CONSTANT_(c2); \
      SIMDE_ASSERT_CONSTANT_(c3); \
      \
      simde_wasm_u32x4_make( \
        c0, c1,  c2,  c3); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_u32x4_const (
      uint32_t c0, uint32_t c1, uint32_t  c2, uint32_t  c3) {
    return simde_wasm_u32x4_make(
        c0, c1,  c2,  c3);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_u32x4_const( \
        c0, c1,  c2,  c3) \
      simde_wasm_u32x4_const( \
          (c0), (c1),  (c2),  (c3))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_i64x2_const( \
        c0, c1) \
      wasm_i64x2_const( \
          (c0), (c1))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_i64x2_const( \
        c0, c1) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      \
      simde_wasm_i64x2_make( \
        c0, c1); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_i64x2_const (
      int64_t c0, int64_t c1) {
    return simde_wasm_i64x2_make(
        c0, c1);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i64x2_const( \
        c0, c1) \
      simde_wasm_i64x2_const( \
          (c0), (c1))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_u64x2_const( \
        c0, c1) \
      wasm_u64x2_const( \
          (c0), (c1))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_u64x2_const( \
        c0, c1) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      \
      simde_wasm_u64x2_make( \
        c0, c1); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_u64x2_const (
      uint64_t c0, uint64_t c1) {
    return simde_wasm_u64x2_make(
        c0, c1);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_u64x2_const( \
        c0, c1) \
      simde_wasm_u64x2_const( \
          (c0), (c1))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_f32x4_const( \
        c0, c1,  c2,  c3) \
      wasm_f32x4_const( \
          (c0), (c1),  (c2),  (c3))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_f32x4_const( \
        c0, c1,  c2,  c3) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      SIMDE_ASSERT_CONSTANT_(c2); \
      SIMDE_ASSERT_CONSTANT_(c3); \
      \
      simde_wasm_f32x4_make( \
        c0, c1,  c2,  c3); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_f32x4_const (
      simde_float32 c0, simde_float32 c1, simde_float32  c2, simde_float32  c3) {
    return simde_wasm_f32x4_make(
        c0, c1,  c2,  c3);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_f32x4_const( \
        c0, c1,  c2,  c3) \
      simde_wasm_f32x4_const( \
          (c0), (c1),  (c2),  (c3))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_f64x2_const( \
        c0, c1) \
      wasm_f64x2_const( \
          (c0), (c1))
#elif defined(SIMDE_STATEMENT_EXPR_) && defined(SIMDE_ASSERT_CONSTANT_) && defined(SIMDE_STATIC_ASSERT)
  #define \
    simde_wasm_f64x2_const( \
        c0, c1) \
    SIMDE_STATEMENT_EXPR_(({ \
      SIMDE_ASSERT_CONSTANT_(c0); \
      SIMDE_ASSERT_CONSTANT_(c1); \
      \
      simde_wasm_f64x2_make( \
        c0, c1); \
    }))
#else
  SIMDE_FUNCTION_ATTRIBUTES
  simde_v128_t
  simde_wasm_f64x2_const (
      simde_float64 c0, simde_float64 c1) {
    return simde_wasm_f64x2_make(
        c0, c1);
  }
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_const(c0, c1) simde_wasm_f64x2_const((c0), (c1))
#endif

/* splat */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_splat (int8_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_set1_epi8(a);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vdupq_n_s8(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_i8 = vec_splats(a);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_splat(a) simde_wasm_i8x16_splat((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_splat (uint8_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_set1_epi8(HEDLEY_STATIC_CAST(int8_t, a));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vdupq_n_u8(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_u8 = vec_splats(HEDLEY_STATIC_CAST(unsigned char, a));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_splat(a) simde_wasm_u8x16_splat((a))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i8x16_const_splat(a) wasm_i8x16_const_splat((a))
#else
  #define simde_wasm_i8x16_const_splat(a) simde_wasm_i8x16_splat(a);
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_const_splat(a) simde_wasm_i8x16_const_splat((a))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_u8x16_const_splat(a) wasm_u8x16_const_splat((a))
#else
  #define simde_wasm_u8x16_const_splat(a) simde_wasm_u8x16_splat(a);
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_const_splat(a) simde_wasm_u8x16_const_splat((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_splat (int16_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_set1_epi16(a);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vdupq_n_s16(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_i16 = vec_splats(a);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_splat(a) simde_wasm_i16x8_splat((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_splat (uint16_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_set1_epi16(HEDLEY_STATIC_CAST(int16_t, a));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vdupq_n_u16(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_u16 = vec_splats(HEDLEY_STATIC_CAST(unsigned short, a));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_splat(a) simde_wasm_u16x8_splat((a))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i16x8_const_splat(a) wasm_i16x8_const_splat((a))
#else
  #define simde_wasm_i16x8_const_splat(a) simde_wasm_i16x8_splat(a);
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_const_splat(a) simde_wasm_i16x8_const_splat((a))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_u16x8_const_splat(a) wasm_u16x8_const_splat((a))
#else
  #define simde_wasm_u16x8_const_splat(a) simde_wasm_u16x8_splat(a);
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_const_splat(a) simde_wasm_u16x8_const_splat((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_splat (int32_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_set1_epi32(a);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vdupq_n_s32(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_i32 = vec_splats(a);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_splat(a) simde_wasm_i32x4_splat((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_splat (uint32_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_set1_epi32(HEDLEY_STATIC_CAST(int32_t, a));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vdupq_n_u32(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_u32 = vec_splats(a);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        r_.u32[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_splat(a) simde_wasm_u32x4_splat((a))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i32x4_const_splat(a) wasm_i32x4_const_splat((a))
#else
  #define simde_wasm_i32x4_const_splat(a) simde_wasm_i32x4_splat(a);
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_const_splat(a) simde_wasm_i32x4_const_splat((a))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_u32x4_const_splat(a) wasm_u32x4_const_splat((a))
#else
  #define simde_wasm_u32x4_const_splat(a) simde_wasm_u32x4_splat(a);
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_const_splat(a) simde_wasm_u32x4_const_splat((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_splat (int64_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE) && (!defined(HEDLEY_MSVC_VERSION) || HEDLEY_MSVC_VERSION_CHECK(19,0,0))
      r_.sse_m128i = _mm_set1_epi64x(a);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i64 = vdupq_n_s64(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_i64 = vec_splats(HEDLEY_STATIC_CAST(signed long long, a));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_splat(a) simde_wasm_i64x2_splat((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u64x2_splat (uint64_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u64x2_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE) && (!defined(HEDLEY_MSVC_VERSION) || HEDLEY_MSVC_VERSION_CHECK(19,0,0))
      r_.sse_m128i = _mm_set1_epi64x(HEDLEY_STATIC_CAST(int64_t, a));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u64 = vdupq_n_u64(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_u64 = vec_splats(HEDLEY_STATIC_CAST(unsigned long long, a));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u64) / sizeof(r_.u64[0])) ; i++) {
        r_.u64[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u64x2_splat(a) simde_wasm_u64x2_splat((a))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i64x2_const_splat(a) wasm_i64x2_const_splat((a))
#else
  #define simde_wasm_i64x2_const_splat(a) simde_wasm_i64x2_splat(a);
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_const_splat(a) simde_wasm_i64x2_const_splat((a))
#endif

#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_u64x2_const_splat(a) wasm_u64x2_const_splat((a))
#else
  #define simde_wasm_u64x2_const_splat(a) simde_wasm_u64x2_splat(a);
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_const_splat(a) simde_wasm_i64x2_const_splat((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_splat (simde_float32 a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_set1_ps(a);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_f32 = vdupq_n_f32(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_14_NATIVE)
      r_.altivec_f32 = vec_splats(a);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_splat(a) simde_wasm_f32x4_splat((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_splat (simde_float64 a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_splat(a);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_set1_pd(a);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f64 = vdupq_n_f64(a);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_f64 = vec_splats(a);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = a;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_splat(a) simde_wasm_f64x2_splat((a))
#endif

/* load_splat */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load8_splat (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_load8_splat(mem);
  #else
    int8_t v;
    simde_memcpy(&v, mem, sizeof(v));
    return simde_wasm_i8x16_splat(v);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load8_splat(mem) simde_wasm_v128_load8_splat((mem))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load16_splat (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_load16_splat(mem);
  #else
    int16_t v;
    simde_memcpy(&v, mem, sizeof(v));
    return simde_wasm_i16x8_splat(v);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load16_splat(mem) simde_wasm_v128_load16_splat((mem))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load32_splat (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_load32_splat(mem);
  #else
    int32_t v;
    simde_memcpy(&v, mem, sizeof(v));
    return simde_wasm_i32x4_splat(v);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load32_splat(mem) simde_wasm_v128_load32_splat((mem))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load64_splat (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_load64_splat(mem);
  #else
    int64_t v;
    simde_memcpy(&v, mem, sizeof(v));
    return simde_wasm_i64x2_splat(v);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load64_splat(mem) simde_wasm_v128_load64_splat((mem))
#endif

/* extract_lane
 *
 * Note that, unlike normal WASM SIMD128 we return intN_t instead of
 * int for sizeof(X) <= sizeof(int).  This is done for portability;
 * the regular API doesn't have to worry about things like int being
 * 16 bits (like on AVR).
 *
 * This does mean that code which works in SIMDe may not work without
 * changes on WASM, but luckily the necessary changes (i.e., casting
 * the return values to smaller type when assigning to the smaller
 * type) mean the code will work in *both* SIMDe and a native
 * implementation.  If you use the simde_* prefixed functions it will
 * always work. */

SIMDE_FUNCTION_ATTRIBUTES
int8_t
simde_wasm_i8x16_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.i8[lane & 15];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i8x16_extract_lane(a, lane) HEDLEY_STATIC_CAST(int8_t, wasm_i8x16_extract_lane((a), (lane)))
#elif defined(SIMDE_X86_SSE4_1_NATIVE)
  #define simde_wasm_i8x16_extract_lane(a, lane) HEDLEY_STATIC_CAST(int8_t, _mm_extract_epi8(simde_v128_to_m128i(a), (lane) & 15))
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
  #define simde_wasm_i8x16_extract_lane(a, lane) vgetq_lane_s8(simde_v128_to_neon_i8(a), (lane) & 15)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_extract_lane(a, lane) simde_wasm_i8x16_extract_lane((a), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
int16_t
simde_wasm_i16x8_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.i16[lane & 7];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i16x8_extract_lane(a, lane) HEDLEY_STATIC_CAST(int16_t, wasm_i16x8_extract_lane((a), (lane)))
#elif defined(SIMDE_X86_SSE2_NATIVE)
  #define simde_wasm_i16x8_extract_lane(a, lane) HEDLEY_STATIC_CAST(int16_t, _mm_extract_epi16((a), (lane) & 7))
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_i16x8_extract_lane(a, lane) vgetq_lane_s16(simde_v128_to_neon_i16(a), (lane) & 7)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_extract_lane(a, lane) simde_wasm_i16x8_extract_lane((a), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
int32_t
simde_wasm_i32x4_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.i32[lane & 3];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i32x4_extract_lane(a, lane) HEDLEY_STATIC_CAST(int32_t, wasm_i32x4_extract_lane((a), (lane)))
#elif defined(SIMDE_X86_SSE4_1_NATIVE)
  #define simde_wasm_i32x4_extract_lane(a, lane) HEDLEY_STATIC_CAST(int32_t, _mm_extract_epi32((a), (lane) & 3))
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_i32x4_extract_lane(a, lane) vgetq_lane_s32(simde_v128_to_neon_i32(a), (lane) & 3)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_extract_lane(a, lane) simde_wasm_i32x4_extract_lane((a), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
int64_t
simde_wasm_i64x2_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.i64[lane & 1];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i64x2_extract_lane(a, lane) HEDLEY_STATIC_CAST(int64_t, wasm_i64x2_extract_lane((a), (lane)))
#elif defined(SIMDE_X86_SSE4_1_NATIVE) && defined(SIMDE_ARCH_AMD64)
  #define simde_wasm_i64x2_extract_lane(a, lane) HEDLEY_STATIC_CAST(int64_t, _mm_extract_epi64((a), (lane) & 1))
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_i64x2_extract_lane(a, lane) vgetq_lane_s64(simde_v128_to_neon_i64(a), (lane) & 1)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_extract_lane(a, lane) simde_wasm_i64x2_extract_lane((a), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
uint8_t
simde_wasm_u8x16_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.u8[lane & 15];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_u8x16_extract_lane(a, lane) HEDLEY_STATIC_CAST(uint8_t, wasm_u8x16_extract_lane((a), (lane)))
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
  #define simde_wasm_u8x16_extract_lane(a, lane) vgetq_lane_u8(simde_v128_to_neon_u8(a), (lane) & 15)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_extract_lane(a, lane) simde_wasm_u8x16_extract_lane((a), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
uint16_t
simde_wasm_u16x8_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.u16[lane & 7];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_u16x8_extract_lane(a, lane) HEDLEY_STATIC_CAST(uint16_t, wasm_u16x8_extract_lane((a), (lane)))
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_u16x8_extract_lane(a, lane) vgetq_lane_u16(simde_v128_to_neon_u16(a), (lane) & 7)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_extract_lane(a, lane) simde_wasm_u16x8_extract_lane((a), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
uint32_t
simde_wasm_u32x4_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.u32[lane & 3];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_u32x4_extract_lane(a, lane) HEDLEY_STATIC_CAST(uint32_t, wasm_u32x4_extract_lane((a), (lane)))
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_u32x4_extract_lane(a, lane) vgetq_lane_u32(simde_v128_to_neon_u32(a), (lane) & 3)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_extract_lane(a, lane) simde_wasm_u32x4_extract_lane((a), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
uint64_t
simde_wasm_u64x2_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.u64[lane & 1];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_u64x2_extract_lane(a, lane) HEDLEY_STATIC_CAST(uint64_t, wasm_u64x2_extract_lane((a), (lane)))
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_u64x2_extract_lane(a, lane) vgetq_lane_u64(simde_v128_to_neon_u64(a), (lane) & 1)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u64x2_extract_lane(a, lane) simde_wasm_u64x2_extract_lane((a), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_float32
simde_wasm_f32x4_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.f32[lane & 3];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_f32x4_extract_lane(a, lane) wasm_f32x4_extract_lane((a), (lane))
#elif defined(SIMDE_X86_SSE4_1_NATIVE)
  #define simde_wasm_f32x4(a, lane) _mm_extract_ps(simde_v128_to_m128(a), (lane) & 3)
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_f32x4_extract_lane(a, lane) vgetq_lane_f32(simde_v128_to_neon_f32(a), (lane) & 3)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_extract_lane(a, lane) simde_wasm_f32x4_extract_lane((a), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_float64
simde_wasm_f64x2_extract_lane (simde_v128_t a, const int lane) {
  simde_v128_private a_ = simde_v128_to_private(a);
  return a_.f64[lane & 1];
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_f64x2_extract_lane(a, lane) wasm_f64x2_extract_lane((a), (lane))
#elif defined(SIMDE_ARM_NEON_A64V8_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_f64x2_extract_lane(a, lane) vgetq_lane_f64(simde_v128_to_neon_f64(a), (lane) & 1)
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_extract_lane(a, lane) simde_wasm_f64x2_extract_lane((a), (lane))
#endif

/* replace_lane */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_replace_lane (simde_v128_t a, const int lane, int8_t value) {
  simde_v128_private a_ = simde_v128_to_private(a);
  a_.i8[lane & 15] = value;
  return simde_v128_from_private(a_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i8x16_replace_lane(a, lane, value) wasm_i8x16_replace_lane((a), (lane), (value))
#elif defined(SIMDE_X86_SSE4_1_NATIVE)
  #if defined(__clang__) && !SIMDE_DETECT_CLANG_VERSION_CHECK(7,0,0)
    #define simde_wasm_i8x16_replace_lane(a, lane, value) HEDLEY_REINTERPRET_CAST(simde_v128_t, _mm_insert_epi8((a), (value), (lane) & 15))
  #else
    #define simde_wasm_i8x16_replace_lane(a, lane, value) _mm_insert_epi8((a), (value), (lane) & 15)
  #endif
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
  #define simde_wasm_i8x16_replace_lane(a, lane, value) simde_v128_from_neon_i8(vsetq_lane_s8((value), simde_v128_to_neon_i8(a), (lane) & 15))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_replace_lane(a, lane, value) simde_wasm_i8x16_replace_lane((a), (lane), (value))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_replace_lane (simde_v128_t a, const int lane, int16_t value) {
  simde_v128_private a_ = simde_v128_to_private(a);
  a_.i16[lane & 7] = value;
  return simde_v128_from_private(a_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i16x8_replace_lane(a, lane, value) wasm_i16x8_replace_lane((a), (lane), (value))
#elif defined(SIMDE_X86_SSE2_NATIVE)
  #define simde_wasm_i16x8_replace_lane(a, lane, value) _mm_insert_epi16((a), (value), (lane) & 7)
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_i16x8_replace_lane(a, lane, value) simde_v128_from_neon_i16(vsetq_lane_s16((value), simde_v128_to_neon_i16(a), (lane) & 7))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_replace_lane(a, lane, value) simde_wasm_i16x8_replace_lane((a), (lane), (value))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_replace_lane (simde_v128_t a, const int lane, int32_t value) {
  simde_v128_private a_ = simde_v128_to_private(a);
  a_.i32[lane & 3] = value;
  return simde_v128_from_private(a_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i32x4_replace_lane(a, lane, value) wasm_i32x4_replace_lane((a), (lane), (value))
#elif defined(SIMDE_X86_SSE4_1_NATIVE)
  #if defined(__clang__) && !SIMDE_DETECT_CLANG_VERSION_CHECK(7,0,0)
    #define simde_wasm_i32x4_replace_lane(a, lane, value) HEDLEY_REINTERPRET_CAST(simde_v128_t, _mm_insert_epi32((a), (value), (lane) & 3))
  #else
    #define simde_wasm_i32x4_replace_lane(a, lane, value) _mm_insert_epi32((a), (value), (lane) & 3)
  #endif
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_i32x4_replace_lane(a, lane, value) simde_v128_from_neon_i32(vsetq_lane_s32((value), simde_v128_to_neon_i32(a), (lane) & 3))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_replace_lane(a, lane, value) simde_wasm_i32x4_replace_lane((a), (lane), (value))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_replace_lane (simde_v128_t a, const int lane, int64_t value) {
  simde_v128_private a_ = simde_v128_to_private(a);
  a_.i64[lane & 1] = value;
  return simde_v128_from_private(a_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_i64x2_replace_lane(a, lane, value) wasm_i64x2_replace_lane((a), (lane), (value))
#elif defined(SIMDE_X86_SSE4_1_NATIVE) && defined(SIMDE_ARCH_AMD64)
  #define simde_wasm_i64x2_replace_lane(a, lane, value) _mm_insert_epi64((a), (value), (lane) & 1)
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_i64x2_replace_lane(a, lane, value) simde_v128_from_neon_i64(vsetq_lane_s64((value), simde_v128_to_neon_i64(a), (lane) & 1))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_replace_lane(a, lane, value) simde_wasm_i64x2_replace_lane((a), (lane), (value))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_replace_lane (simde_v128_t a, const int lane, simde_float32 value) {
  simde_v128_private a_ = simde_v128_to_private(a);
  a_.f32[lane & 3] = value;
  return simde_v128_from_private(a_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_f32x4_replace_lane(a, lane, value) wasm_f32x4_replace_lane((a), (lane), (value))
#elif defined(SIMDE_ARM_NEON_A32V7_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_f32x4_replace_lane(a, lane, value) simde_v128_from_neon_f32(vsetq_lane_f32((value), simde_v128_to_neon_f32(a), (lane) & 3))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_replace_lane(a, lane, value) simde_wasm_f32x4_replace_lane((a), (lane), (value))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_replace_lane (simde_v128_t a, const int lane, simde_float64 value) {
  simde_v128_private a_ = simde_v128_to_private(a);
  a_.f64[lane & 1] = value;
  return simde_v128_from_private(a_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_f64x2_replace_lane(a, lane, value) wasm_f64x2_replace_lane((a), (lane), (value))
#elif defined(SIMDE_ARM_NEON_A64V8_NATIVE) && !defined(SIMDE_BUG_CLANG_BAD_VGET_SET_LANE_TYPES)
  #define simde_wasm_f64x2_replace_lane(a, lane, value) simde_v128_from_neon_f64(vsetq_lane_f64((value), simde_v128_to_neon_f64(a), (lane) & 1))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_replace_lane(a, lane, value) simde_wasm_f64x2_replace_lane((a), (lane), (value))
#endif

/* eq */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_eq (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_eq(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vceqq_s8(a_.neon_i8, b_.neon_i8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i8 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i8), a_.i8 == b_.i8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = (a_.i8[i] == b_.i8[i]) ? ~INT8_C(0) : INT8_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_eq(a, b) simde_wasm_i8x16_eq((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_eq (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_eq(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vceqq_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i16 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i16), a_.i16 == b_.i16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = (a_.i16[i] == b_.i16[i]) ? ~INT16_C(0) : INT16_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_eq(a, b) simde_wasm_i16x8_eq((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_eq (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_eq(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vceqq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.i32 == b_.i32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = (a_.i32[i] == b_.i32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_eq(a, b) simde_wasm_i32x4_eq((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_eq (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_eq(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi64(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vceqq_s64(a_.neon_i64, b_.neon_i64);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i64), a_.i64 == b_.i64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = (a_.i64[i] == b_.i64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_eq(a, b) simde_wasm_i64x2_eq((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_eq (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_eq(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_cmpeq_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vceqq_f32(a_.neon_f32, b_.neon_f32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f32 == b_.f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.i32[i] = (a_.f32[i] == b_.f32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_eq(a, b) simde_wasm_f32x4_eq((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_eq (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_eq(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_cmpeq_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vceqq_f64(a_.neon_f64, b_.neon_f64);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f64 == b_.f64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.i64[i] = (a_.f64[i] == b_.f64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_eq(a, b) simde_wasm_f64x2_eq((a), (b))
#endif

/* ne */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_ne (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_ne(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vmvnq_u8(vceqq_s8(a_.neon_i8, b_.neon_i8));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i8 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i8), a_.i8 != b_.i8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = (a_.i8[i] != b_.i8[i]) ? ~INT8_C(0) : INT8_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_ne(a, b) simde_wasm_i8x16_ne((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_ne (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_ne(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vmvnq_u16(vceqq_s16(a_.neon_i16, b_.neon_i16));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i16 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i16), a_.i16 != b_.i16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = (a_.i16[i] != b_.i16[i]) ? ~INT16_C(0) : INT16_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_ne(a, b) simde_wasm_i16x8_ne((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_ne (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_ne(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vmvnq_u32(vceqq_s32(a_.neon_i32, b_.neon_i32));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.i32 != b_.i32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = (a_.i32[i] != b_.i32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_ne(a, b) simde_wasm_i32x4_ne((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_ne (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_ne(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u32 = vmvnq_u32(vreinterpretq_u32_u64(vceqq_s64(a_.neon_i64, b_.neon_i64)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i64), a_.i64 != b_.i64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = (a_.i64[i] != b_.i64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_ne(a, b) simde_wasm_i64x2_ne((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_ne (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_ne(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_cmpneq_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vmvnq_u32(vceqq_f32(a_.neon_f32, b_.neon_f32));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f32 != b_.f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.i32[i] = (a_.f32[i] != b_.f32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_ne(a, b) simde_wasm_f32x4_ne((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_ne (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_ne(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_cmpneq_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u32 = vmvnq_u32(vreinterpretq_u32_u64(vceqq_f64(a_.neon_f64, b_.neon_f64)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f64 != b_.f64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.i64[i] = (a_.f64[i] != b_.f64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_ne(a, b) simde_wasm_f64x2_ne((a), (b))
#endif

/* lt */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_lt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_lt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_cmplt_epi8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vcltq_s8(a_.neon_i8, b_.neon_i8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed char), vec_cmplt(a_.altivec_i8, b_.altivec_i8));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i8 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i8), a_.i8 < b_.i8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = (a_.i8[i] < b_.i8[i]) ? ~INT8_C(0) : INT8_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_lt(a, b) simde_wasm_i8x16_lt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_lt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_lt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_cmplt_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vcltq_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed short), vec_cmplt(a_.altivec_i16, b_.altivec_i16));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i16 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i16), a_.i16 < b_.i16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = (a_.i16[i] < b_.i16[i]) ? ~INT16_C(0) : INT16_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_lt(a, b) simde_wasm_i16x8_lt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_lt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_lt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_cmplt_epi32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcltq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), vec_cmplt(a_.altivec_i32, b_.altivec_i32));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.i32 < b_.i32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = (a_.i32[i] < b_.i32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_lt(a, b) simde_wasm_i32x4_lt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_lt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_lt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vcltq_s64(a_.neon_i64, b_.neon_i64);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      int32x4_t tmp = vorrq_s32(
        vandq_s32(
          vreinterpretq_s32_u32(vceqq_s32(b_.neon_i32, a_.neon_i32)),
          vsubq_s32(a_.neon_i32, b_.neon_i32)
        ),
        vreinterpretq_s32_u32(vcgtq_s32(b_.neon_i32, a_.neon_i32))
      );
      int32x4x2_t trn = vtrnq_s32(tmp, tmp);
      r_.neon_i32 = trn.val[1];
    #elif defined(SIMDE_X86_SSE4_2_NATIVE)
      r_.sse_m128i = _mm_cmpgt_epi64(b_.sse_m128i, a_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      /* https://stackoverflow.com/a/65175746 */
      r_.sse_m128i =
        _mm_shuffle_epi32(
          _mm_or_si128(
            _mm_and_si128(
              _mm_cmpeq_epi32(b_.sse_m128i, a_.sse_m128i),
              _mm_sub_epi64(a_.sse_m128i, b_.sse_m128i)
            ),
            _mm_cmpgt_epi32(
              b_.sse_m128i,
              a_.sse_m128i
            )
          ),
          _MM_SHUFFLE(3, 3, 1, 1)
        );
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(signed int) tmp =
        vec_or(
          vec_and(
            HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), vec_cmpeq(b_.altivec_i32, a_.altivec_i32)),
            HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), vec_sub(
              HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed long long), a_.altivec_i32),
              HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed long long), b_.altivec_i32)
            ))
          ),
          vec_cmpgt(b_.altivec_i32, a_.altivec_i32)
        );
        r_.altivec_i32 = vec_mergeo(tmp, tmp);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i64), a_.i64 < b_.i64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = (a_.i64[i] < b_.i64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_lt(a, b) simde_wasm_i64x2_lt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_lt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_lt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vcltq_u8(a_.neon_u8, b_.neon_u8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u8 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned char), vec_cmplt(a_.altivec_u8, b_.altivec_u8));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      __m128i tmp = _mm_subs_epu8(b_.sse_m128i, a_.sse_m128i);
      r_.sse_m128i = _mm_adds_epu8(tmp, _mm_sub_epi8(_mm_setzero_si128(), tmp));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.u8 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u8), a_.u8 < b_.u8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = (a_.u8[i] < b_.u8[i]) ? ~UINT8_C(0) : UINT8_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_lt(a, b) simde_wasm_u8x16_lt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_lt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_lt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vcltq_u16(a_.neon_u16, b_.neon_u16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u16 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned short), vec_cmplt(a_.altivec_u16, b_.altivec_u16));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      __m128i tmp = _mm_subs_epu16(b_.sse_m128i, a_.sse_m128i);
      r_.sse_m128i = _mm_adds_epu16(tmp, _mm_sub_epi16(_mm_setzero_si128(), tmp));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.u16 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u16), a_.u16 < b_.u16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = (a_.u16[i] < b_.u16[i]) ? ~UINT16_C(0) : UINT16_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_lt(a, b) simde_wasm_u16x8_lt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_lt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_lt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcltq_u32(a_.neon_u32, b_.neon_u32);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_xor_si128(
          _mm_cmpgt_epi32(b_.sse_m128i, a_.sse_m128i),
          _mm_srai_epi32(_mm_xor_si128(b_.sse_m128i, a_.sse_m128i), 31)
        );
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u32 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned int), vec_cmplt(a_.altivec_u32, b_.altivec_u32));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.u32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u32), a_.u32 < b_.u32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        r_.u32[i] = (a_.u32[i] < b_.u32[i]) ? ~UINT32_C(0) : UINT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_lt(a, b) simde_wasm_u32x4_lt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_lt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_lt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_cmplt_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcltq_f32(a_.neon_f32, b_.neon_f32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_f32 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(float), vec_cmplt(a_.altivec_f32, b_.altivec_f32));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f32 < b_.f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.i32[i] = (a_.f32[i] < b_.f32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_lt(a, b) simde_wasm_f32x4_lt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_lt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_lt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_cmplt_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vcltq_f64(a_.neon_f64, b_.neon_f64);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f64 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(double), vec_cmplt(a_.altivec_f64, b_.altivec_f64));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f64 < b_.f64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.i64[i] = (a_.f64[i] < b_.f64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_lt(a, b) simde_wasm_f64x2_lt((a), (b))
#endif

/* gt */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_gt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_gt(a, b);
  #else
    return simde_wasm_i8x16_lt(b, a);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_gt(a, b) simde_wasm_i8x16_gt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_gt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_gt(a, b);
  #else
    return simde_wasm_i16x8_lt(b, a);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_gt(a, b) simde_wasm_i16x8_gt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_gt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_gt(a, b);
  #else
    return simde_wasm_i32x4_lt(b, a);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_gt(a, b) simde_wasm_i32x4_gt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_gt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_gt(a, b);
  #else
    return simde_wasm_i64x2_lt(b, a);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_gt(a, b) simde_wasm_i64x2_gt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_gt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_gt(a, b);
  #else
    return simde_wasm_u8x16_lt(b, a);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_gt(a, b) simde_wasm_u8x16_gt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_gt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_gt(a, b);
  #else
    return simde_wasm_u16x8_lt(b, a);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_gt(a, b) simde_wasm_u16x8_gt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_gt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_gt(a, b);
  #else
    return simde_wasm_u32x4_lt(b, a);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_gt(a, b) simde_wasm_u32x4_gt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_gt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_gt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_cmpgt_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcgtq_f32(a_.neon_f32, b_.neon_f32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_f32 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(float), vec_cmpgt(a_.altivec_f32, b_.altivec_f32));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f32 > b_.f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.i32[i] = (a_.f32[i] > b_.f32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_gt(a, b) simde_wasm_f32x4_gt((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_gt (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_gt(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_cmpgt_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vcgtq_f64(a_.neon_f64, b_.neon_f64);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f64 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(double), vec_cmpgt(a_.altivec_f64, b_.altivec_f64));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i64), a_.f64 > b_.f64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.i64[i] = (a_.f64[i] > b_.f64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_gt(a, b) simde_wasm_f64x2_gt((a), (b))
#endif

/* le */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_le (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_le(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi8(a_.sse_m128i, _mm_min_epi8(a_.sse_m128i, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vcleq_s8(a_.neon_i8, b_.neon_i8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i8 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i8), a_.i8 <= b_.i8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = (a_.i8[i] <= b_.i8[i]) ? ~INT8_C(0) : INT8_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_le(a, b) simde_wasm_i8x16_le((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_le (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_le(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi16(a_.sse_m128i, _mm_min_epi16(a_.sse_m128i, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vcleq_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i16 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i16), a_.i16 <= b_.i16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = (a_.i16[i] <= b_.i16[i]) ? ~INT16_C(0) : INT16_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_le(a, b) simde_wasm_i16x8_le((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_le (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_le(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi32(a_.sse_m128i, _mm_min_epi32(a_.sse_m128i, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcleq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.i32 <= b_.i32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = (a_.i32[i] <= b_.i32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_le(a, b) simde_wasm_i32x4_le((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_le (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_le(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_AVX512VL_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi64(a_.sse_m128i, _mm_min_epi64(a_.sse_m128i, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vcleq_s64(a_.neon_i64, b_.neon_i64);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i64), a_.i64 <= b_.i64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = (a_.i64[i] <= b_.i64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_le(a, b) simde_wasm_i64x2_le((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_le (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_le(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vcleq_u8(a_.neon_u8, b_.neon_u8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.u8 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u8), a_.u8 <= b_.u8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = (a_.u8[i] <= b_.u8[i]) ? ~UINT8_C(0) : UINT8_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_le(a, b) simde_wasm_u8x16_le((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_le (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_le(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vcleq_u16(a_.neon_u16, b_.neon_u16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.u16 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u16), a_.u16 <= b_.u16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = (a_.u16[i] <= b_.u16[i]) ? ~UINT16_C(0) : UINT16_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_le(a, b) simde_wasm_u16x8_le((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_le (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_le(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcleq_u32(a_.neon_u32, b_.neon_u32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.u32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u32), a_.u32 <= b_.u32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        r_.u32[i] = (a_.u32[i] <= b_.u32[i]) ? ~UINT32_C(0) : UINT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_le(a, b) simde_wasm_u32x4_le((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_le (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_le(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_cmple_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcleq_f32(a_.neon_f32, b_.neon_f32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f32 <= b_.f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.i32[i] = (a_.f32[i] <= b_.f32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_le(a, b) simde_wasm_f32x4_le((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_le (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_le(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_cmple_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vcleq_f64(a_.neon_f64, b_.neon_f64);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f64 <= b_.f64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.i64[i] = (a_.f64[i] <= b_.f64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_le(a, b) simde_wasm_f64x2_le((a), (b))
#endif

/* ge */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_ge (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_ge(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi8(_mm_min_epi8(a_.sse_m128i, b_.sse_m128i), b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vcgeq_s8(a_.neon_i8, b_.neon_i8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i8 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i8), a_.i8 >= b_.i8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = (a_.i8[i] >= b_.i8[i]) ? ~INT8_C(0) : INT8_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_ge(a, b) simde_wasm_i8x16_ge((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_ge (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_ge(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi16(_mm_min_epi16(a_.sse_m128i, b_.sse_m128i), b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vcgeq_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i16 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i16), a_.i16 >= b_.i16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = (a_.i16[i] >= b_.i16[i]) ? ~INT16_C(0) : INT16_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_ge(a, b) simde_wasm_i16x8_ge((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_ge (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_ge(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi32(_mm_min_epi32(a_.sse_m128i, b_.sse_m128i), b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcgeq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.i32 >= b_.i32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = (a_.i32[i] >= b_.i32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_ge(a, b) simde_wasm_i32x4_ge((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_ge (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_ge(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_AVX512VL_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi64(_mm_min_epi64(a_.sse_m128i, b_.sse_m128i), b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vcgeq_s64(a_.neon_i64, b_.neon_i64);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i64), a_.i64 >= b_.i64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = (a_.i64[i] >= b_.i64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_ge(a, b) simde_wasm_i64x2_ge((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_ge (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_ge(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi8(_mm_min_epu8(a_.sse_m128i, b_.sse_m128i), b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vcgeq_u8(a_.neon_u8, b_.neon_u8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.u8 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u8), a_.u8 >= b_.u8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = (a_.u8[i] >= b_.u8[i]) ? ~UINT8_C(0) : UINT8_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_ge(a, b) simde_wasm_u8x16_ge((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_ge (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_ge(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi16(_mm_min_epu16(a_.sse_m128i, b_.sse_m128i), b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vcgeq_u16(a_.neon_u16, b_.neon_u16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.u16 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u16), a_.u16 >= b_.u16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = (a_.u16[i] >= b_.u16[i]) ? ~UINT16_C(0) : UINT16_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_ge(a, b) simde_wasm_u16x8_ge((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_ge (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_ge(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cmpeq_epi32(_mm_min_epu32(a_.sse_m128i, b_.sse_m128i), b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcgeq_u32(a_.neon_u32, b_.neon_u32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.u32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u32), a_.u32 >= b_.u32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        r_.u32[i] = (a_.u32[i] >= b_.u32[i]) ? ~UINT32_C(0) : UINT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_ge(a, b) simde_wasm_u32x4_ge((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_ge (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_ge(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_cmpge_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcgeq_f32(a_.neon_f32, b_.neon_f32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f32 >= b_.f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.i32[i] = (a_.f32[i] >= b_.f32[i]) ? ~INT32_C(0) : INT32_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_ge(a, b) simde_wasm_f32x4_ge((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_ge (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_ge(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_cmpge_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vcgeq_f64(a_.neon_f64, b_.neon_f64);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f64 >= b_.f64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.i64[i] = (a_.f64[i] >= b_.f64[i]) ? ~INT64_C(0) : INT64_C(0);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_ge(a, b) simde_wasm_f64x2_ge((a), (b))
#endif

/* not */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_not (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_not(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_xor_si128(a_.sse_m128i, _mm_set1_epi32(~INT32_C(0)));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vmvnq_s32(a_.neon_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32f = ~a_.i32f;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32f) / sizeof(r_.i32f[0])) ; i++) {
        r_.i32f[i] = ~(a_.i32f[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_not(a) simde_wasm_v128_not((a))
#endif

/* and */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_and (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_and(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_and_si128(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vandq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32f = a_.i32f & b_.i32f;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32f) / sizeof(r_.i32f[0])) ; i++) {
        r_.i32f[i] = a_.i32f[i] & b_.i32f[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_and(a, b) simde_wasm_v128_and((a), (b))
#endif

/* or */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_or (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_or(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_or_si128(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vorrq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32f = a_.i32f | b_.i32f;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32f) / sizeof(r_.i32f[0])) ; i++) {
        r_.i32f[i] = a_.i32f[i] | b_.i32f[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_or(a, b) simde_wasm_v128_or((a), (b))
#endif

/* xor */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_xor (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_xor(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_xor_si128(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = veorq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32f = a_.i32f ^ b_.i32f;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32f) / sizeof(r_.i32f[0])) ; i++) {
        r_.i32f[i] = a_.i32f[i] ^ b_.i32f[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_xor(a, b) simde_wasm_v128_xor((a), (b))
#endif

/* andnot */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_andnot (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_andnot(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_andnot_si128(b_.sse_m128i, a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vbicq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32f = a_.i32f & ~b_.i32f;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32f) / sizeof(r_.i32f[0])) ; i++) {
        r_.i32f[i] = a_.i32f[i] & ~b_.i32f[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_andnot(a, b) simde_wasm_v128_andnot((a), (b))
#endif

/* bitselect */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_bitselect (simde_v128_t a, simde_v128_t b, simde_v128_t mask) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_bitselect(a, b, mask);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      mask_ = simde_v128_to_private(mask),
      r_;

    #if defined(SIMDE_X86_AVX512VL_NATIVE)
      r_.sse_m128i = _mm_ternarylogic_epi32(mask_.sse_m128i, a_.sse_m128i, b_.sse_m128i, 0xca);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_or_si128(
          _mm_and_si128   (mask_.sse_m128i, a_.sse_m128i),
          _mm_andnot_si128(mask_.sse_m128i, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vbslq_s32(mask_.neon_u32, a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_i32 = vec_sel(b_.altivec_i32, a_.altivec_i32, mask_.altivec_u32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32f = (a_.i32f & mask_.i32f) | (b_.i32f & ~mask_.i32f);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32f) / sizeof(r_.i32f[0])) ; i++) {
        r_.i32f[i] = (a_.i32f[i] & mask_.i32f[i]) | (b_.i32f[i] & ~mask_.i32f[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_bitselect(a, b, c) simde_wasm_v128_bitselect((a), (b), (c))
#endif

/* bitmask */

SIMDE_FUNCTION_ATTRIBUTES
uint32_t
simde_wasm_i8x16_bitmask (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_bitmask(a);
  #else
    simde_v128_private a_ = simde_v128_to_private(a);
    uint32_t r = 0;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r = HEDLEY_STATIC_CAST(uint32_t, _mm_movemask_epi8(a_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      /* https://github.com/WebAssembly/simd/pull/201#issue-380682845 */
      static const uint8_t md[16] = {
        1 << 0, 1 << 1, 1 << 2, 1 << 3,
        1 << 4, 1 << 5, 1 << 6, 1 << 7,
        1 << 0, 1 << 1, 1 << 2, 1 << 3,
        1 << 4, 1 << 5, 1 << 6, 1 << 7,
      };

      /* Extend sign bit over entire lane */
      uint8x16_t extended = vreinterpretq_u8_s8(vshrq_n_s8(a_.neon_i8, 7));
      /* Clear all but the bit we're interested in. */
      uint8x16_t masked = vandq_u8(vld1q_u8(md), extended);
      /* Alternate bytes from low half and high half */
      uint8x8x2_t tmp = vzip_u8(vget_low_u8(masked), vget_high_u8(masked));
      uint16x8_t x = vreinterpretq_u16_u8(vcombine_u8(tmp.val[0], tmp.val[1]));
      #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
        r = vaddvq_u16(x);
      #else
        uint64x2_t t64 = vpaddlq_u32(vpaddlq_u16(x));
        r =
          HEDLEY_STATIC_CAST(uint32_t, vgetq_lane_u64(t64, 0)) +
          HEDLEY_STATIC_CAST(uint32_t, vgetq_lane_u64(t64, 1));
      #endif
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE) && defined(SIMDE_BUG_CLANG_50932)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) idx = { 120, 112, 104, 96, 88, 80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0 };
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) res = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned char), vec_bperm(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned __int128), a_.altivec_u64), idx));
      r = HEDLEY_STATIC_CAST(uint32_t, vec_extract(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), res), 2));
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) idx = { 120, 112, 104, 96, 88, 80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0 };
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) res = vec_bperm(a_.altivec_u8, idx);
      r = HEDLEY_STATIC_CAST(uint32_t, vec_extract(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), res), 2));
    #else
      SIMDE_VECTORIZE_REDUCTION(|:r)
      for (size_t i = 0 ; i < (sizeof(a_.i8) / sizeof(a_.i8[0])) ; i++) {
        r |= HEDLEY_STATIC_CAST(uint32_t, (a_.i8[i] < 0) << i);
      }
    #endif

    return r;
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_bitmask(a) simde_wasm_i8x16_bitmask((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
uint32_t
simde_wasm_i16x8_bitmask (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_bitmask(a);
  #else
    simde_v128_private a_ = simde_v128_to_private(a);
    uint32_t r = 0;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r = HEDLEY_STATIC_CAST(uint32_t, _mm_movemask_epi8(_mm_packs_epi16(a_.sse_m128i, _mm_setzero_si128())));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      static const uint16_t md[8] = {
        1 << 0, 1 << 1, 1 << 2, 1 << 3,
        1 << 4, 1 << 5, 1 << 6, 1 << 7,
      };

      uint16x8_t extended = vreinterpretq_u16_s16(vshrq_n_s16(a_.neon_i16, 15));
      uint16x8_t masked = vandq_u16(vld1q_u16(md), extended);
      #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
        r = vaddvq_u16(masked);
      #else
        uint64x2_t t64 = vpaddlq_u32(vpaddlq_u16(masked));
        r =
          HEDLEY_STATIC_CAST(uint32_t, vgetq_lane_u64(t64, 0)) +
          HEDLEY_STATIC_CAST(uint32_t, vgetq_lane_u64(t64, 1));
      #endif
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE) && defined(SIMDE_BUG_CLANG_50932)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) idx = { 112, 96, 80, 64, 48, 32, 16, 0, 128, 128, 128, 128, 128, 128, 128, 128 };
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) res = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned char), vec_bperm(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned __int128), a_.altivec_u64), idx));
      r = HEDLEY_STATIC_CAST(uint32_t, vec_extract(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), res), 2));
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) idx = { 112, 96, 80, 64, 48, 32, 16, 0, 128, 128, 128, 128, 128, 128, 128, 128 };
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) res = vec_bperm(a_.altivec_u8, idx);
      r = HEDLEY_STATIC_CAST(uint32_t, vec_extract(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), res), 2));
    #else
      SIMDE_VECTORIZE_REDUCTION(|:r)
      for (size_t i = 0 ; i < (sizeof(a_.i16) / sizeof(a_.i16[0])) ; i++) {
        r |= HEDLEY_STATIC_CAST(uint32_t, (a_.i16[i] < 0) << i);
      }
    #endif

    return r;
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_bitmask(a) simde_wasm_i16x8_bitmask((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
uint32_t
simde_wasm_i32x4_bitmask (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_bitmask(a);
  #else
    simde_v128_private a_ = simde_v128_to_private(a);
    uint32_t r = 0;

    #if defined(SIMDE_X86_SSE_NATIVE)
      r = HEDLEY_STATIC_CAST(uint32_t, _mm_movemask_ps(a_.sse_m128));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      static const uint32_t md[4] = {
        1 << 0, 1 << 1, 1 << 2, 1 << 3
      };

      uint32x4_t extended = vreinterpretq_u32_s32(vshrq_n_s32(a_.neon_i32, 31));
      uint32x4_t masked = vandq_u32(vld1q_u32(md), extended);
      #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
        r = HEDLEY_STATIC_CAST(uint32_t, vaddvq_u32(masked));
      #else
        uint64x2_t t64 = vpaddlq_u32(masked);
        r =
          HEDLEY_STATIC_CAST(uint32_t, vgetq_lane_u64(t64, 0)) +
          HEDLEY_STATIC_CAST(uint32_t, vgetq_lane_u64(t64, 1));
      #endif
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE) && defined(SIMDE_BUG_CLANG_50932)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) idx = { 96, 64, 32, 0, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128 };
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) res = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned char), vec_bperm(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned __int128), a_.altivec_u64), idx));
      r = HEDLEY_STATIC_CAST(uint32_t, vec_extract(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), res), 2));
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) idx = { 96, 64, 32, 0, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128 };
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) res = vec_bperm(a_.altivec_u8, idx);
      r = HEDLEY_STATIC_CAST(uint32_t, vec_extract(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), res), 2));
    #else
      SIMDE_VECTORIZE_REDUCTION(|:r)
      for (size_t i = 0 ; i < (sizeof(a_.i32) / sizeof(a_.i32[0])) ; i++) {
        r |= HEDLEY_STATIC_CAST(uint32_t, (a_.i32[i] < 0) << i);
      }
    #endif

    return r;
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_bitmask(a) simde_wasm_i32x4_bitmask((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
uint32_t
simde_wasm_i64x2_bitmask (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_bitmask(a);
  #else
    simde_v128_private a_ = simde_v128_to_private(a);
    uint32_t r = 0;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r = HEDLEY_STATIC_CAST(uint32_t, _mm_movemask_pd(a_.sse_m128d));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      HEDLEY_DIAGNOSTIC_PUSH
      SIMDE_DIAGNOSTIC_DISABLE_VECTOR_CONVERSION_
      uint64x2_t shifted = vshrq_n_u64(a_.neon_u64, 63);
      r =
        HEDLEY_STATIC_CAST(uint32_t, vgetq_lane_u64(shifted, 0)) +
        (HEDLEY_STATIC_CAST(uint32_t, vgetq_lane_u64(shifted, 1)) << 1);
      HEDLEY_DIAGNOSTIC_POP
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE) && defined(SIMDE_BUG_CLANG_50932)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) idx = { 64, 0, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128 };
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) res = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned char), vec_bperm(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned __int128), a_.altivec_u64), idx));
      r = HEDLEY_STATIC_CAST(uint32_t, vec_extract(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), res), 2));
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) idx = { 64, 0, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128 };
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) res = vec_bperm(a_.altivec_u8, idx);
      r = HEDLEY_STATIC_CAST(uint32_t, vec_extract(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed int), res), 2));
    #else
      SIMDE_VECTORIZE_REDUCTION(|:r)
      for (size_t i = 0 ; i < (sizeof(a_.i64) / sizeof(a_.i64[0])) ; i++) {
        r |= HEDLEY_STATIC_CAST(uint32_t, (a_.i64[i] < 0) << i);
      }
    #endif

    return r;
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_bitmask(a) simde_wasm_i64x2_bitmask((a))
#endif

/* abs */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_abs (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_abs(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_abs_epi8(a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vabsq_s8(a_.neon_i8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_abs(a_.altivec_i8);
    #elif defined(SIMDE_VECTOR_SCALAR)
      __typeof__(r_.i8) mask = HEDLEY_REINTERPRET_CAST(__typeof__(mask), a_.i8 < 0);
      r_.i8 = (-a_.i8 & mask) | (a_.i8 & ~mask);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = (a_.i8[i] < INT8_C(0)) ? -a_.i8[i] : a_.i8[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_abs(a) simde_wasm_i8x16_abs((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_abs (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_abs(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_abs_epi16(a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vabsq_s16(a_.neon_i16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = vec_abs(a_.altivec_i16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = (a_.i16[i] < INT8_C(0)) ? -a_.i16[i] : a_.i16[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_abs(a) simde_wasm_i16x8_abs((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_abs (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_abs(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_abs_epi32(a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_i32 = vabsq_s32(a_.neon_i32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 = vec_abs(a_.altivec_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      __typeof__(r_.i32) z = { 0, };
      __typeof__(r_.i32) m = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.i32 < z);
      r_.i32 = (-a_.i32 & m) | (a_.i32 & ~m);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = (a_.i32[i] < INT32_C(0)) ? -a_.i32[i] : a_.i32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_abs(a) simde_wasm_i32x4_abs((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_abs (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_abs(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_AVX512VL_NATIVE)
      r_.sse_m128i = _mm_abs_epi64(a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_i64 = vabsq_s64(a_.neon_i64);
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_i64 = vec_abs(a_.altivec_i64);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      __typeof__(r_.i64) z = { 0, };
      __typeof__(r_.i64) m = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i64), a_.i64 < z);
      r_.i64 = (-a_.i64 & m) | (a_.i64 & ~m);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = (a_.i64[i] < INT64_C(0)) ? -a_.i64[i] : a_.i64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_abs(a) simde_wasm_i64x2_abs((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_abs (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_abs(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_andnot_si128(_mm_set1_epi32(HEDLEY_STATIC_CAST(int32_t, UINT32_C(1) << 31)), a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_f32 = vabsq_f32(a_.neon_f32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_f32 = vec_abs(a_.altivec_f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = simde_math_signbit(a_.f32[i]) ? -a_.f32[i] : a_.f32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_abs(a) simde_wasm_f32x4_abs((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_abs (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_abs(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_andnot_si128(_mm_set1_epi64x(HEDLEY_STATIC_CAST(int64_t, UINT64_C(1) << 63)), a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f64 = vabsq_f64(a_.neon_f64);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f64 = vec_abs(a_.altivec_f64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = simde_math_signbit(a_.f64[i]) ? -a_.f64[i] : a_.f64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_abs(a) simde_wasm_f64x2_abs((a))
#endif

/* neg */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_neg (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_neg(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_sub_epi8(_mm_setzero_si128(), a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vnegq_s8(a_.neon_i8);
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE) && (!defined(HEDLEY_GCC_VERSION) || HEDLEY_GCC_VERSION_CHECK(8,1,0))
      r_.altivec_i8 = vec_neg(a_.altivec_i8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i8 = -a_.i8;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = -a_.i8[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_neg(a) simde_wasm_i8x16_neg((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_neg (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_neg(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_sub_epi16(_mm_setzero_si128(), a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vnegq_s16(a_.neon_i16);
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_i16 = vec_neg(a_.altivec_i16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i16 = -a_.i16;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = -a_.i16[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_neg(a) simde_wasm_i16x8_neg((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_neg (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_neg(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_sub_epi32(_mm_setzero_si128(), a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vnegq_s32(a_.neon_i32);
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_i32 = vec_neg(a_.altivec_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = -a_.i32;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = -a_.i32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_neg(a) simde_wasm_i32x4_neg((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_neg (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_neg(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_sub_epi64(_mm_setzero_si128(), a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_i64 = vnegq_s64(a_.neon_i64);
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_i64 = vec_neg(a_.altivec_i64);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = -a_.i64;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = -a_.i64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_neg(a) simde_wasm_i64x2_neg((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_neg (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_neg(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_xor_si128(_mm_set1_epi32(HEDLEY_STATIC_CAST(int32_t, UINT32_C(1) << 31)), a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_f32 = vnegq_f32(a_.neon_f32);
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_f32 = vec_neg(a_.altivec_f32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f32 = -a_.f32;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = -a_.f32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_neg(a) simde_wasm_f32x4_neg((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_neg (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_neg(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_xor_si128(_mm_set1_epi64x(HEDLEY_STATIC_CAST(int64_t, UINT64_C(1) << 63)), a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f64 = vnegq_f64(a_.neon_f64);
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_f64 = vec_neg(a_.altivec_f64);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f64 = -a_.f64;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = -a_.f64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_neg(a) simde_wasm_f64x2_neg((a))
#endif

/* any_true */

SIMDE_FUNCTION_ATTRIBUTES
simde_bool
simde_wasm_v128_any_true (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_any_true(a);
  #else
    simde_v128_private a_ = simde_v128_to_private(a);
    simde_bool r = 0;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r = !_mm_test_all_zeros(a_.sse_m128i, _mm_set1_epi32(~INT32_C(0)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r = _mm_movemask_epi8(_mm_cmpeq_epi8(a_.sse_m128i, _mm_setzero_si128())) != 0xffff;
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r = !!vmaxvq_u32(a_.neon_u32);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      uint32x2_t tmp = vpmax_u32(vget_low_u32(a_.u32), vget_high_u32(a_.u32));
      r  = vget_lane_u32(tmp, 0);
      r |= vget_lane_u32(tmp, 1);
      r = !!r;
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r = HEDLEY_STATIC_CAST(simde_bool, vec_any_ne(a_.altivec_i32, vec_splats(0)));
    #else
      int_fast32_t ri = 0;
      SIMDE_VECTORIZE_REDUCTION(|:ri)
      for (size_t i = 0 ; i < (sizeof(a_.i32f) / sizeof(a_.i32f[0])) ; i++) {
        ri |= (a_.i32f[i]);
      }
      r = !!ri;
    #endif

    return r;
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_any_true(a) simde_wasm_v128_any_true((a))
#endif

/* all_true */

SIMDE_FUNCTION_ATTRIBUTES
simde_bool
simde_wasm_i8x16_all_true (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_all_true(a);
  #else
    simde_v128_private a_ = simde_v128_to_private(a);

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      return _mm_test_all_zeros(_mm_cmpeq_epi8(a_.sse_m128i, _mm_set1_epi8(INT8_C(0))), _mm_set1_epi8(~INT8_C(0)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      return _mm_movemask_epi8(_mm_cmpeq_epi8(a_.sse_m128i, _mm_setzero_si128())) == 0;
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      return !vmaxvq_u8(vceqzq_u8(a_.neon_u8));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      uint8x16_t zeroes = vdupq_n_u8(0);
      uint8x16_t false_set = vceqq_u8(a_.neon_u8, vdupq_n_u8(0));
      uint32x4_t d_all_true = vceqq_u32(vreinterpretq_u32_u8(false_set), vreinterpretq_u32_u8(zeroes));
      uint32x2_t q_all_true = vpmin_u32(vget_low_u32(d_all_true), vget_high_u32(d_all_true));

      return !!(
        vget_lane_u32(q_all_true, 0) &
        vget_lane_u32(q_all_true, 1));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      return HEDLEY_STATIC_CAST(simde_bool, vec_all_ne(a_.altivec_i8, vec_splats(HEDLEY_STATIC_CAST(signed char, 0))));
    #else
      int8_t r = !INT8_C(0);

      SIMDE_VECTORIZE_REDUCTION(&:r)
      for (size_t i = 0 ; i < (sizeof(a_.i8) / sizeof(a_.i8[0])) ; i++) {
        r &= !!(a_.i8[i]);
      }

      return r;
    #endif
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_all_true(a) simde_wasm_i8x16_all_true((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_bool
simde_wasm_i16x8_all_true (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_all_true(a);
  #else
    simde_v128_private a_ = simde_v128_to_private(a);

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      return _mm_test_all_zeros(_mm_cmpeq_epi16(a_.sse_m128i, _mm_setzero_si128()), _mm_set1_epi16(~INT16_C(0)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      return _mm_movemask_epi8(_mm_cmpeq_epi16(a_.sse_m128i, _mm_setzero_si128())) == 0;
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      return !vmaxvq_u16(vceqzq_u16(a_.neon_u16));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      uint16x8_t zeroes = vdupq_n_u16(0);
      uint16x8_t false_set = vceqq_u16(a_.neon_u16, vdupq_n_u16(0));
      uint32x4_t d_all_true = vceqq_u32(vreinterpretq_u32_u16(false_set), vreinterpretq_u32_u16(zeroes));
      uint32x2_t q_all_true = vpmin_u32(vget_low_u32(d_all_true), vget_high_u32(d_all_true));

      return !!(
        vget_lane_u32(q_all_true, 0) &
        vget_lane_u32(q_all_true, 1));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      return HEDLEY_STATIC_CAST(simde_bool, vec_all_ne(a_.altivec_i16, vec_splats(HEDLEY_STATIC_CAST(signed short, 0))));
    #else
      int16_t r = !INT16_C(0);

      SIMDE_VECTORIZE_REDUCTION(&:r)
      for (size_t i = 0 ; i < (sizeof(a_.i16) / sizeof(a_.i16[0])) ; i++) {
        r &= !!(a_.i16[i]);
      }

      return r;
    #endif
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_all_true(a) simde_wasm_i16x8_all_true((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_bool
simde_wasm_i32x4_all_true (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_all_true(a);
  #else
    simde_v128_private a_ = simde_v128_to_private(a);

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      return _mm_test_all_zeros(_mm_cmpeq_epi32(a_.sse_m128i, _mm_setzero_si128()), _mm_set1_epi32(~INT32_C(0)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      return _mm_movemask_ps(_mm_castsi128_ps(_mm_cmpeq_epi32(a_.sse_m128i, _mm_setzero_si128()))) == 0;
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      return !vmaxvq_u32(vceqzq_u32(a_.neon_u32));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      uint32x4_t d_all_true = vmvnq_u32(vceqq_u32(a_.neon_u32, vdupq_n_u32(0)));
      uint32x2_t q_all_true = vpmin_u32(vget_low_u32(d_all_true), vget_high_u32(d_all_true));

      return !!(
        vget_lane_u32(q_all_true, 0) &
        vget_lane_u32(q_all_true, 1));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      return HEDLEY_STATIC_CAST(simde_bool, vec_all_ne(a_.altivec_i32, vec_splats(HEDLEY_STATIC_CAST(signed int, 0))));
    #else
      int32_t r = !INT32_C(0);

      SIMDE_VECTORIZE_REDUCTION(&:r)
      for (size_t i = 0 ; i < (sizeof(a_.i32) / sizeof(a_.i32[0])) ; i++) {
        r &= !!(a_.i32[i]);
      }

      return r;
    #endif
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_all_true(a) simde_wasm_i32x4_all_true((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_bool
simde_wasm_i64x2_all_true (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE) && defined(__wasm_unimplemented_simd128__)
    return wasm_i64x2_all_true(a);
  #else
    simde_v128_private a_ = simde_v128_to_private(a);

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      return _mm_test_all_zeros(_mm_cmpeq_epi64(a_.sse_m128i, _mm_setzero_si128()), _mm_set1_epi32(~INT32_C(0)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      return _mm_movemask_pd(_mm_cmpeq_pd(a_.sse_m128d, _mm_setzero_pd())) == 0;
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      return HEDLEY_STATIC_CAST(simde_bool, vec_all_ne(a_.altivec_i64, HEDLEY_REINTERPRET_CAST(__typeof__(a_.altivec_i64), vec_splats(0))));
    #else
      int64_t r = !INT32_C(0);

      SIMDE_VECTORIZE_REDUCTION(&:r)
      for (size_t i = 0 ; i < (sizeof(a_.i64) / sizeof(a_.i64[0])) ; i++) {
        r &= !!(a_.i64[i]);
      }

      return r;
    #endif
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES) || (defined(SIMDE_ENABLE_NATIVE_ALIASES) && !defined(__wasm_unimplemented_simd128__))
  #define wasm_i64x2_all_true(a) simde_wasm_i64x2_all_true((a))
#endif

/* shl */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_shl (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_shl(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vshlq_s8(a_.neon_i8, vdupq_n_s8(HEDLEY_STATIC_CAST(int8_t, count & 7)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_sl(a_.altivec_i8, vec_splats(HEDLEY_STATIC_CAST(unsigned char, count & 7)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.i8 = a_.i8 << (count & 7);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = HEDLEY_STATIC_CAST(int8_t, a_.i8[i] << (count & 7));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_shl(a, count) simde_wasm_i8x16_shl((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_shl (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_shl(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      return _mm_sll_epi16(a_.sse_m128i, _mm_cvtsi32_si128(count & 15));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vshlq_s16(a_.neon_i16, vdupq_n_s16(HEDLEY_STATIC_CAST(int16_t, count & 15)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = vec_sl(a_.altivec_i16, vec_splats(HEDLEY_STATIC_CAST(unsigned short, count & 15)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.i16 = a_.i16 << (count & 15);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(int16_t, a_.i16[i] << (count & 15));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_shl(a, count) simde_wasm_i16x8_shl((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_shl (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_shl(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      return _mm_sll_epi32(a_.sse_m128i, _mm_cvtsi32_si128(count & 31));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vshlq_s32(a_.neon_i32, vdupq_n_s32(HEDLEY_STATIC_CAST(int32_t, count & 31)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 = vec_sl(a_.altivec_i32, vec_splats(HEDLEY_STATIC_CAST(unsigned int, count & 31)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.i32 = a_.i32 << (count & 31);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.i32[i] << (count & 31));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_shl(a, count) simde_wasm_i32x4_shl((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_shl (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    #if defined(SIMDE_BUG_CLANG_60655)
      count = count & 63;
    #endif
    return wasm_i64x2_shl(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      return _mm_sll_epi64(a_.sse_m128i, _mm_cvtsi32_si128(count & 63));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i64 = vshlq_s64(a_.neon_i64, vdupq_n_s64(HEDLEY_STATIC_CAST(int64_t, count & 63)));
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_i64 = vec_sl(a_.altivec_i64, vec_splats(HEDLEY_STATIC_CAST(unsigned long long, count & 63)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.i64 = a_.i64 << (count & 63);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = HEDLEY_STATIC_CAST(int64_t, a_.i64[i] << (count & 63));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_shl(a, count) simde_wasm_i64x2_shl((a), (count))
#endif

/* shr */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_shr (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_shr(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vshlq_s8(a_.neon_i8, vdupq_n_s8(-HEDLEY_STATIC_CAST(int8_t, count & 7)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_sra(a_.altivec_i8, vec_splats(HEDLEY_STATIC_CAST(unsigned char, count & 7)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.i8 = a_.i8 >> (count & 7);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = HEDLEY_STATIC_CAST(int8_t, a_.i8[i] >> (count & 7));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_shr(a, count) simde_wasm_i8x16_shr((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_shr (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_shr(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      return _mm_sra_epi16(a_.sse_m128i, _mm_cvtsi32_si128(count & 15));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vshlq_s16(a_.neon_i16, vdupq_n_s16(-HEDLEY_STATIC_CAST(int16_t, count & 15)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = vec_sra(a_.altivec_i16, vec_splats(HEDLEY_STATIC_CAST(unsigned short, count & 15)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.i16 = a_.i16 >> (count & 15);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(int16_t, a_.i16[i] >> (count & 15));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_shr(a, count) simde_wasm_i16x8_shr((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_shr (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_shr(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      return _mm_sra_epi32(a_.sse_m128i, _mm_cvtsi32_si128(count & 31));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vshlq_s32(a_.neon_i32, vdupq_n_s32(-HEDLEY_STATIC_CAST(int32_t, count & 31)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 = vec_sra(a_.altivec_i32, vec_splats(HEDLEY_STATIC_CAST(unsigned int, count & 31)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.i32 = a_.i32 >> (count & 31);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.i32[i] >> (count & 31));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_shr(a, count) simde_wasm_i32x4_shr((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_shr (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    #if defined(SIMDE_BUG_CLANG_60655)
      count = count & 63;
    #endif
    return wasm_i64x2_shr(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_AVX512VL_NATIVE)
      return _mm_sra_epi64(a_.sse_m128i, _mm_cvtsi32_si128(count & 63));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i64 = vshlq_s64(a_.neon_i64, vdupq_n_s64(-HEDLEY_STATIC_CAST(int64_t, count & 63)));
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_i64 = vec_sra(a_.altivec_i64, vec_splats(HEDLEY_STATIC_CAST(unsigned long long, count & 63)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.i64 = a_.i64 >> (count & 63);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = HEDLEY_STATIC_CAST(int64_t, a_.i64[i] >> (count & 63));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_shr(a, count) simde_wasm_i64x2_shr((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_shr (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_shr(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vshlq_u8(a_.neon_u8, vdupq_n_s8(-HEDLEY_STATIC_CAST(int8_t, count & 7)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u8 = vec_sr(a_.altivec_u8, vec_splats(HEDLEY_STATIC_CAST(unsigned char, count & 7)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.u8 = a_.u8 >> (count & 7);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = HEDLEY_STATIC_CAST(uint8_t, a_.u8[i] >> (count & 7));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_shr(a, count) simde_wasm_u8x16_shr((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_shr (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_shr(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      return _mm_srl_epi16(a_.sse_m128i, _mm_cvtsi32_si128(count & 15));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vshlq_u16(a_.neon_u16, vdupq_n_s16(-HEDLEY_STATIC_CAST(int16_t, count & 15)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u16 = vec_sr(a_.altivec_u16, vec_splats(HEDLEY_STATIC_CAST(unsigned short, count & 15)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.u16 = a_.u16 >> (count & 15);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = HEDLEY_STATIC_CAST(uint16_t, a_.u16[i] >> (count & 15));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_shr(a, count) simde_wasm_u16x8_shr((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_shr (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_shr(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      return _mm_srl_epi32(a_.sse_m128i, _mm_cvtsi32_si128(count & 31));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vshlq_u32(a_.neon_u32, vdupq_n_s32(-HEDLEY_STATIC_CAST(int32_t, count & 31)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u32 = vec_sr(a_.altivec_u32, vec_splats(HEDLEY_STATIC_CAST(unsigned int, count & 31)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.u32 = a_.u32 >> (count & 31);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        r_.u32[i] = HEDLEY_STATIC_CAST(uint32_t, a_.u32[i] >> (count & 31));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_shr(a, count) simde_wasm_u32x4_shr((a), (count))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u64x2_shr (simde_v128_t a, uint32_t count) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    #if defined(SIMDE_BUG_CLANG_60655)
      count = count & 63;
    #endif
    return wasm_u64x2_shr(a, count);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      return _mm_srl_epi64(a_.sse_m128i, _mm_cvtsi32_si128(count & 63));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u64 = vshlq_u64(a_.neon_u64, vdupq_n_s64(-HEDLEY_STATIC_CAST(int64_t, count & 63)));
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_u64 = vec_sr(a_.altivec_u64, vec_splats(HEDLEY_STATIC_CAST(unsigned long long, count & 63)));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT) && defined(SIMDE_VECTOR_SCALAR)
      r_.u64 = a_.u64 >> (count & 63);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u64) / sizeof(r_.u64[0])) ; i++) {
        r_.u64[i] = HEDLEY_STATIC_CAST(uint64_t, a_.u64[i] >> (count & 63));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u64x2_shr(a, count) simde_wasm_u64x2_shr((a), (count))
#endif

/* add */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_add (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_add(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_add_epi8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i8 = a_.i8 + b_.i8;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = a_.i8[i] + b_.i8[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_add(a, b) simde_wasm_i8x16_add((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_add (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_add(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_add_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i16 = a_.i16 + b_.i16;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = a_.i16[i] + b_.i16[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_add(a, b) simde_wasm_i16x8_add((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_add (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_add(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_add_epi32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = a_.i32 + b_.i32;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = a_.i32[i] + b_.i32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_add(a, b) simde_wasm_i32x4_add((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_add (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_add(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_add_epi64(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = a_.i64 + b_.i64;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = a_.i64[i] + b_.i64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_add(a, b) simde_wasm_i64x2_add((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_add (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_add(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_add_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f32 = a_.f32 + b_.f32;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = a_.f32[i] + b_.f32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_add(a, b) simde_wasm_f32x4_add((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_add (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_add(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_add_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f64 = a_.f64 + b_.f64;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = a_.f64[i] + b_.f64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_add(a, b) simde_wasm_f64x2_add((a), (b))
#endif

/* sub */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_sub (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_sub(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_sub_epi8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i8 = a_.i8 - b_.i8;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = a_.i8[i] - b_.i8[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_sub(a, b) simde_wasm_i8x16_sub((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_sub (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_sub(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_sub_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i16 = a_.i16 - b_.i16;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = a_.i16[i] - b_.i16[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_sub(a, b) simde_wasm_i16x8_sub((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_sub (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_sub(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_sub_epi32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = a_.i32 - b_.i32;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = a_.i32[i] - b_.i32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_sub(a, b) simde_wasm_i32x4_sub((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_sub (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_sub(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_sub_epi64(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = a_.i64 - b_.i64;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = a_.i64[i] - b_.i64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_sub(a, b) simde_wasm_i64x2_sub((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_sub (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_sub(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_sub_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f32 = a_.f32 - b_.f32;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = a_.f32[i] - b_.f32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_sub(a, b) simde_wasm_f32x4_sub((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_sub (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_sub(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_sub_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f64 = a_.f64 - b_.f64;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = a_.f64[i] - b_.f64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_sub(a, b) simde_wasm_f64x2_sub((a), (b))
#endif

/* mul */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_mul (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_mul(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_mullo_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vmulq_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i16 = a_.i16 * b_.i16;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = a_.i16[i] * b_.i16[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_mul(a, b) simde_wasm_i16x8_mul((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_mul (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_mul(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_mullo_epi32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i32 = a_.i32 * b_.i32;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = a_.i32[i] * b_.i32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_mul(a, b) simde_wasm_i32x4_mul((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_mul (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_mul(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_AVX512VL_NATIVE) && defined(SIMDE_X86_AVX512DQ_NATIVE)
      r_.sse_m128i = _mm_mullo_epi64(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.i64 = a_.i64 * b_.i64;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = a_.i64[i] * b_.i64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_mul(a, b) simde_wasm_i64x2_mul((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_mul (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_mul(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_mul_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f32 = a_.f32 * b_.f32;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = a_.f32[i] * b_.f32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_mul(a, b) simde_wasm_f32x4_mul((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_mul (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_mul(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_mul_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f64 = a_.f64 * b_.f64;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = a_.f64[i] * b_.f64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_mul(a, b) simde_wasm_f64x2_mul((a), (b))
#endif

/* q15mulr_sat */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_q15mulr_sat (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_q15mulr_sat(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    /* https://github.com/WebAssembly/simd/pull/365 */
    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vqrdmulhq_s16(a_.neon_i16, b_.neon_i16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        int32_t tmp = HEDLEY_STATIC_CAST(int32_t, a_.i16[i]) * HEDLEY_STATIC_CAST(int32_t, b_.i16[i]);
        tmp += UINT32_C(0x4000);
        tmp >>= 15;
        r_.i16[i] = (tmp < INT16_MIN) ? INT16_MIN : ((tmp > INT16_MAX) ? (INT16_MAX) : HEDLEY_STATIC_CAST(int16_t, tmp));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_q15mulr_sat(a, b) simde_wasm_i16x8_q15mulr_sat((a), (b))
#endif

/* min */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_min (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_min(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_min_epi8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      __m128i m = _mm_cmplt_epi8(a_.sse_m128i, b_.sse_m128i);
      r_.sse_m128i =
        _mm_or_si128(
          _mm_and_si128(m, a_.sse_m128i),
          _mm_andnot_si128(m, b_.sse_m128i)
        );
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vminq_s8(a_.neon_i8, b_.neon_i8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_min(a_.altivec_i8, b_.altivec_i8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = (a_.i8[i] < b_.i8[i]) ? a_.i8[i] : b_.i8[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_min(a, b) simde_wasm_i8x16_min((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_min (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_min(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_min_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vminq_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = vec_min(a_.altivec_i16, b_.altivec_i16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = (a_.i16[i] < b_.i16[i]) ? a_.i16[i] : b_.i16[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_min(a, b) simde_wasm_i16x8_min((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_min (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_min(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_min_epi32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      __m128i m = _mm_cmplt_epi32(a_.sse_m128i, b_.sse_m128i);
      r_.sse_m128i =
        _mm_or_si128(
          _mm_and_si128(m, a_.sse_m128i),
          _mm_andnot_si128(m, b_.sse_m128i)
        );
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vminq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 = vec_min(a_.altivec_i32, b_.altivec_i32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = (a_.i32[i] < b_.i32[i]) ? a_.i32[i] : b_.i32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_min(a, b) simde_wasm_i32x4_min((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_min (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_min(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_min_epu8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vminq_u8(a_.neon_u8, b_.neon_u8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u8 = vec_min(a_.altivec_u8, b_.altivec_u8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = (a_.u8[i] < b_.u8[i]) ? a_.u8[i] : b_.u8[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_min(a, b) simde_wasm_u8x16_min((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_min (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_min(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_min_epu16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      /* https://github.com/simd-everywhere/simde/issues/855#issuecomment-881656284 */
      r_.sse_m128i = _mm_sub_epi16(a, _mm_subs_epu16(a_.sse_m128i, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vminq_u16(a_.neon_u16, b_.neon_u16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u16 = vec_min(a_.altivec_u16, b_.altivec_u16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = (a_.u16[i] < b_.u16[i]) ? a_.u16[i] : b_.u16[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_min(a, b) simde_wasm_u16x8_min((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_min (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_min(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_min_epu32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      const __m128i i32_min = _mm_set1_epi32(INT32_MIN);
      const __m128i difference = _mm_sub_epi32(a_.sse_m128i, b_.sse_m128i);
      __m128i m =
        _mm_cmpeq_epi32(
          /* _mm_subs_epu32(a_.sse_m128i, b_.sse_m128i) */
          _mm_and_si128(
            difference,
            _mm_xor_si128(
              _mm_cmpgt_epi32(
                _mm_xor_si128(difference, i32_min),
                _mm_xor_si128(a_.sse_m128i, i32_min)
              ),
              _mm_set1_epi32(~INT32_C(0))
            )
          ),
          _mm_setzero_si128()
        );
      r_.sse_m128i =
        _mm_or_si128(
          _mm_and_si128(m, a_.sse_m128i),
          _mm_andnot_si128(m, b_.sse_m128i)
        );
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vminq_u32(a_.neon_u32, b_.neon_u32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_u32 = vec_min(a_.altivec_u32, b_.altivec_u32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.u32[i] = (a_.u32[i] < b_.u32[i]) ? a_.u32[i] : b_.u32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_min(a, b) simde_wasm_u32x4_min((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_min (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_min(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE) && (!defined(HEDLEY_GCC_VERSION) || HEDLEY_GCC_VERSION_CHECK(6,0,0))
        // Inspired by https://github.com/v8/v8/blob/c750b6c85bd1ad1d27f7acc1812165f465515144/src/codegen/shared-ia32-x64/macro-assembler-shared-ia32-x64.cc#L202
        simde_v128_private scratch;
        scratch.sse_m128 = a_.sse_m128;
        scratch.sse_m128 = _mm_min_ps(scratch.sse_m128, b_.sse_m128);
        r_.sse_m128 = b_.sse_m128;
        r_.sse_m128 = _mm_min_ps(r_.sse_m128, a_.sse_m128);
        scratch.sse_m128 = _mm_or_ps(scratch.sse_m128, r_.sse_m128);
        r_.sse_m128 = _mm_cmpunord_ps(r_.sse_m128, scratch.sse_m128);
        scratch.sse_m128 = _mm_or_ps(scratch.sse_m128, r_.sse_m128);
        r_.sse_m128i = _mm_srli_epi32(r_.sse_m128i, 10);
        r_.sse_m128 = _mm_andnot_ps(r_.sse_m128, scratch.sse_m128);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = SIMDE_WASM_SIMD128_FMINF(a_.f32[i], b_.f32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_min(a, b) simde_wasm_f32x4_min((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_min (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_min(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE) && (!defined(HEDLEY_GCC_VERSION) || HEDLEY_GCC_VERSION_CHECK(6,0,0))
        // Inspired by https://github.com/v8/v8/blob/c750b6c85bd1ad1d27f7acc1812165f465515144/src/codegen/shared-ia32-x64/macro-assembler-shared-ia32-x64.cc#L263
        simde_v128_private scratch;
        scratch.sse_m128d = a_.sse_m128d;
        scratch.sse_m128d = _mm_min_pd(scratch.sse_m128d, b_.sse_m128d);
        r_.sse_m128d = b_.sse_m128d;
        r_.sse_m128d = _mm_min_pd(r_.sse_m128d, a_.sse_m128d);
        scratch.sse_m128d = _mm_or_pd(scratch.sse_m128d, r_.sse_m128d);
        r_.sse_m128d = _mm_cmpunord_pd(r_.sse_m128d, scratch.sse_m128d);
        scratch.sse_m128d = _mm_or_pd(scratch.sse_m128d, r_.sse_m128d);
        r_.sse_m128i = _mm_srli_epi64(r_.sse_m128i, 13);
        r_.sse_m128d = _mm_andnot_pd(r_.sse_m128d, scratch.sse_m128d);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = SIMDE_WASM_SIMD128_FMIN(a_.f64[i], b_.f64[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_min(a, b) simde_wasm_f64x2_min((a), (b))
#endif

/* max */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_max (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_max(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_max_epi8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      __m128i m = _mm_cmpgt_epi8(a_.sse_m128i, b_.sse_m128i);
      r_.sse_m128i = _mm_or_si128(_mm_and_si128(m, a_.sse_m128i), _mm_andnot_si128(m, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vmaxq_s8(a_.neon_i8, b_.neon_i8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_i8 = vec_max(a_.altivec_i8, b_.altivec_i8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      __typeof__(r_.i8) m = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i8), a_.i8 > b_.i8);
      r_.i8 = (m & a_.i8) | (~m & b_.i8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = (a_.i8[i] > b_.i8[i]) ? a_.i8[i] : b_.i8[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_max(a, b) simde_wasm_i8x16_max((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_max (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_max(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_max_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vmaxq_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_i16 = vec_max(a_.altivec_i16, b_.altivec_i16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      __typeof__(r_.i16) m = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i16), a_.i16 > b_.i16);
      r_.i16 = (m & a_.i16) | (~m & b_.i16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = (a_.i16[i] > b_.i16[i]) ? a_.i16[i] : b_.i16[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_max(a, b) simde_wasm_i16x8_max((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_max (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_max(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_max_epi32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      __m128i m = _mm_cmpgt_epi32(a_.sse_m128i, b_.sse_m128i);
      r_.sse_m128i = _mm_or_si128(_mm_and_si128(m, a_.sse_m128i), _mm_andnot_si128(m, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vmaxq_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_i32 = vec_max(a_.altivec_i32, b_.altivec_i32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      __typeof__(r_.i32) m = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.i32 > b_.i32);
      r_.i32 = (m & a_.i32) | (~m & b_.i32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = (a_.i32[i] > b_.i32[i]) ? a_.i32[i] : b_.i32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_max(a, b) simde_wasm_i32x4_max((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_max (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_max(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_max_epu8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vmaxq_u8(a_.neon_u8, b_.neon_u8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_u8 = vec_max(a_.altivec_u8, b_.altivec_u8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      __typeof__(r_.u8) m = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u8), a_.u8 > b_.u8);
      r_.u8 = (m & a_.u8) | (~m & b_.u8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = (a_.u8[i] > b_.u8[i]) ? a_.u8[i] : b_.u8[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_max(a, b) simde_wasm_u8x16_max((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_max (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_max(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_max_epu16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      /* https://github.com/simd-everywhere/simde/issues/855#issuecomment-881656284 */
      r_.sse_m128i = _mm_add_epi16(b, _mm_subs_epu16(a_.sse_m128i, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vmaxq_u16(a_.neon_u16, b_.neon_u16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_u16 = vec_max(a_.altivec_u16, b_.altivec_u16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      __typeof__(r_.u16) m = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u16), a_.u16 > b_.u16);
      r_.u16 = (m & a_.u16) | (~m & b_.u16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = (a_.u16[i] > b_.u16[i]) ? a_.u16[i] : b_.u16[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_max(a, b) simde_wasm_u16x8_max((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_max (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_max(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_max_epu32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      /* https://github.com/simd-everywhere/simde/issues/855#issuecomment-886057227 */
      __m128i m =
        _mm_xor_si128(
          _mm_cmpgt_epi32(a_.sse_m128i, b_.sse_m128i),
          _mm_srai_epi32(_mm_xor_si128(a_.sse_m128i, b_.sse_m128i), 31)
        );
      r_.sse_m128i = _mm_or_si128(_mm_and_si128(m, a_.sse_m128i), _mm_andnot_si128(m, b_.sse_m128i));
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vmaxq_u32(a_.neon_u32, b_.neon_u32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_u32 = vec_max(a_.altivec_u32, b_.altivec_u32);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      __typeof__(r_.u32) m = HEDLEY_REINTERPRET_CAST(__typeof__(r_.u32), a_.u32 > b_.u32);
      r_.u32 = (m & a_.u32) | (~m & b_.u32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.u32[i] = (a_.u32[i] > b_.u32[i]) ? a_.u32[i] : b_.u32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_max(a, b) simde_wasm_u32x4_max((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_max (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_max(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE) && (!defined(HEDLEY_GCC_VERSION) || HEDLEY_GCC_VERSION_CHECK(6,0,0))
        // Inspired by https://github.com/v8/v8/blob/c750b6c85bd1ad1d27f7acc1812165f465515144/src/codegen/shared-ia32-x64/macro-assembler-shared-ia32-x64.cc#L231
        simde_v128_private scratch;
        scratch.sse_m128 = a_.sse_m128;
        scratch.sse_m128 = _mm_max_ps(scratch.sse_m128, b_.sse_m128);
        r_.sse_m128 = b_.sse_m128;
        r_.sse_m128 = _mm_max_ps(r_.sse_m128, a_.sse_m128);
        r_.sse_m128 = _mm_xor_ps(r_.sse_m128, scratch.sse_m128);
        scratch.sse_m128 = _mm_or_ps(scratch.sse_m128, r_.sse_m128);
        scratch.sse_m128 = _mm_sub_ps(scratch.sse_m128, r_.sse_m128);
        r_.sse_m128 = _mm_cmpunord_ps(r_.sse_m128, scratch.sse_m128);
        r_.sse_m128i = _mm_srli_epi32(r_.sse_m128i, 10);
        r_.sse_m128 = _mm_andnot_ps(r_.sse_m128, scratch.sse_m128);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = SIMDE_WASM_SIMD128_FMAXF(a_.f32[i], b_.f32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_max(a, b) simde_wasm_f32x4_max((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_max (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_max(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE) && (!defined(HEDLEY_GCC_VERSION) || HEDLEY_GCC_VERSION_CHECK(6,0,0))
        // Inspired by https://github.com/v8/v8/blob/c750b6c85bd1ad1d27f7acc1812165f465515144/src/codegen/shared-ia32-x64/macro-assembler-shared-ia32-x64.cc#L301
        simde_v128_private scratch;
        scratch.sse_m128d = a_.sse_m128d;
        scratch.sse_m128d = _mm_max_pd(scratch.sse_m128d, b_.sse_m128d);
        r_.sse_m128d = b_.sse_m128d;
        r_.sse_m128d = _mm_max_pd(r_.sse_m128d, a_.sse_m128d);
        r_.sse_m128d = _mm_xor_pd(r_.sse_m128d, scratch.sse_m128d);
        scratch.sse_m128d = _mm_or_pd(scratch.sse_m128d, r_.sse_m128d);
        scratch.sse_m128d = _mm_sub_pd(scratch.sse_m128d, r_.sse_m128d);
        r_.sse_m128d = _mm_cmpunord_pd(r_.sse_m128d, scratch.sse_m128d);
        r_.sse_m128i = _mm_srli_epi64(r_.sse_m128i, 13);
        r_.sse_m128d = _mm_andnot_pd(r_.sse_m128d, scratch.sse_m128d);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = SIMDE_WASM_SIMD128_FMAX(a_.f64[i], b_.f64[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_max(a, b) simde_wasm_f64x2_max((a), (b))
#endif

/* add_sat */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_add_sat (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_add_sat(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_adds_epi8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vqaddq_s8(a_.neon_i8, b_.neon_i8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_adds(a_.altivec_i8, b_.altivec_i8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      __typeof__(a_.u8) r1, r2, m;
      r1 = a_.u8 + b_.u8;
      r2 = (a_.u8 >> 7) + INT8_MAX;
      m = HEDLEY_REINTERPRET_CAST(__typeof__(m), HEDLEY_REINTERPRET_CAST(__typeof__(r_.i8), (r2 ^ b_.u8) | ~(b_.u8 ^ r1)) < 0);
      r_.i8 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i8), (r1 & m) | (r2 & ~m));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = simde_math_adds_i8(a_.i8[i], b_.i8[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_add_sat(a, b) simde_wasm_i8x16_add_sat((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_add_sat (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_add_sat(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_adds_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vqaddq_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = vec_adds(a_.altivec_i16, b_.altivec_i16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      __typeof__(a_.u16) r1, r2, m;
      r1 = a_.u16 + b_.u16;
      r2 = (a_.u16 >> 15) + INT16_MAX;
      m = HEDLEY_REINTERPRET_CAST(__typeof__(m), HEDLEY_REINTERPRET_CAST(__typeof__(r_.i16), (r2 ^ b_.u16) | ~(b_.u16 ^ r1)) < 0);
      r_.i16 = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i16), (r1 & m) | (r2 & ~m));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = simde_math_adds_i16(a_.i16[i], b_.i16[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_add_sat(a, b) simde_wasm_i16x8_add_sat((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_add_sat (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_add_sat(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_adds_epu8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vqaddq_u8(a_.neon_u8, b_.neon_u8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u8 = vec_adds(a_.altivec_u8, b_.altivec_u8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      r_.u8 = a_.u8 + b_.u8;
      r_.u8 |= HEDLEY_REINTERPRET_CAST(__typeof__(r_.u8), r_.u8 < a_.u8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = simde_math_adds_u8(a_.u8[i], b_.u8[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_add_sat(a, b) simde_wasm_u8x16_add_sat((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_add_sat (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_add_sat(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_adds_epu16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vqaddq_u16(a_.neon_u16, b_.neon_u16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u16 = vec_adds(a_.altivec_u16, b_.altivec_u16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      r_.u16 = a_.u16 + b_.u16;
      r_.u16 |= HEDLEY_REINTERPRET_CAST(__typeof__(r_.u16), r_.u16 < a_.u16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = simde_math_adds_u16(a_.u16[i], b_.u16[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_add_sat(a, b) simde_wasm_u16x8_add_sat((a), (b))
#endif

/* avgr */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_avgr (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_avgr(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_avg_epu8(a_.sse_m128i, b_.sse_m128i);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = (a_.u8[i] + b_.u8[i] + 1) >> 1;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_avgr(a, b) simde_wasm_u8x16_avgr((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_avgr (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_avgr(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_avg_epu16(a_.sse_m128i, b_.sse_m128i);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = (a_.u16[i] + b_.u16[i] + 1) >> 1;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_avgr(a, b) simde_wasm_u16x8_avgr((a), (b))
#endif

/* sub_sat */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_sub_sat (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_sub_sat(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_subs_epi8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vqsubq_s8(a_.neon_i8, b_.neon_i8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_subs(a_.altivec_i8, b_.altivec_i8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      const __typeof__(r_.i8) diff_sat = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i8), (b_.i8 > a_.i8) ^ INT8_MAX);
      const __typeof__(r_.i8) diff = a_.i8 - b_.i8;
      const __typeof__(r_.i8) saturate = diff_sat ^ diff;
      const __typeof__(r_.i8) m = saturate >> 7;
      r_.i8 = (diff_sat & m) | (diff & ~m);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = simde_math_subs_i8(a_.i8[i], b_.i8[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_sub_sat(a, b) simde_wasm_i8x16_sub_sat((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_sub_sat (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_sub_sat(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_subs_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vqsubq_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = vec_subs(a_.altivec_i16, b_.altivec_i16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      const __typeof__(r_.i16) diff_sat = HEDLEY_REINTERPRET_CAST(__typeof__(r_.i16), (b_.i16 > a_.i16) ^ INT16_MAX);
      const __typeof__(r_.i16) diff = a_.i16 - b_.i16;
      const __typeof__(r_.i16) saturate = diff_sat ^ diff;
      const __typeof__(r_.i16) m = saturate >> 15;
      r_.i16 = (diff_sat & m) | (diff & ~m);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = simde_math_subs_i16(a_.i16[i], b_.i16[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_sub_sat(a, b) simde_wasm_i16x8_sub_sat((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_sub_sat (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_sub_sat(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_subs_epu8(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 = vqsubq_u8(a_.neon_u8, b_.neon_u8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u8 = vec_subs(a_.altivec_u8, b_.altivec_u8);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      r_.u8  = a_.u8 - b_.u8;
      r_.u8 &= HEDLEY_REINTERPRET_CAST(__typeof__(r_.u8), r_.u8 <= a_.u8);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        r_.u8[i] = simde_math_subs_u8(a_.u8[i], b_.u8[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_sub_sat(a, b) simde_wasm_u8x16_sub_sat((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_sub_sat (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_sub_sat(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_subs_epu16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vqsubq_u16(a_.neon_u16, b_.neon_u16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u16 = vec_subs(a_.altivec_u16, b_.altivec_u16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      r_.u16  = a_.u16 - b_.u16;
      r_.u16 &= HEDLEY_REINTERPRET_CAST(__typeof__(r_.u16), r_.u16 <= a_.u16);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = simde_math_subs_u16(a_.u16[i], b_.u16[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_sub_sat(a, b) simde_wasm_u16x8_sub_sat((a), (b))
#endif

/* pmin */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_pmin (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_pmin(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_min_ps(b_.sse_m128, a_.sse_m128);
    #elif defined(SIMDE_FAST_NANS) && defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_f32 = vminq_f32(a_.neon_f32, b_.neon_f32);
    #elif defined(SIMDE_FAST_NANS) && defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_f32 = vec_min(a_.altivec_f32, b_.altivec_f32);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_f32 =
        vbslq_f32(
          vcltq_f32(b_.neon_f32, a_.neon_f32),
          b_.neon_f32,
          a_.neon_f32
        );
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_f32 =
        vec_sel(
          a_.altivec_f32,
          b_.altivec_f32,
          vec_cmpgt(a_.altivec_f32, b_.altivec_f32)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = (b_.f32[i] < a_.f32[i]) ? b_.f32[i] : a_.f32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_pmin(a, b) simde_wasm_f32x4_pmin((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_pmin (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_pmin(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_min_pd(b_.sse_m128d, a_.sse_m128d);
    #elif defined(SIMDE_FAST_NANS) && defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f32 = vminq_f64(a_.neon_f64, b_.neon_f64);
    #elif defined(SIMDE_FAST_NANS) && defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f64 = vec_min(a_.altivec_f64, b_.altivec_f64);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f64 =
        vbslq_f64(
          vcltq_f64(b_.neon_f64, a_.neon_f64),
          b_.neon_f64,
          a_.neon_f64
        );
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f64 =
        vec_sel(
          a_.altivec_f64,
          b_.altivec_f64,
          vec_cmpgt(a_.altivec_f64, b_.altivec_f64)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = (b_.f64[i] < a_.f64[i]) ? b_.f64[i] : a_.f64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_pmin(a, b) simde_wasm_f64x2_pmin((a), (b))
#endif

/* pmax */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_pmax (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_pmax(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE_NATIVE)
      r_.sse_m128 = _mm_max_ps(b_.sse_m128, a_.sse_m128);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_f32 = vbslq_f32(vcltq_f32(a_.neon_f32, b_.neon_f32), b_.neon_f32, a_.neon_f32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_14_NATIVE)
      r_.altivec_f32 = vec_sel(a_.altivec_f32, b_.altivec_f32, vec_cmplt(a_.altivec_f32, b_.altivec_f32));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      int32_t SIMDE_VECTOR(16) m = HEDLEY_REINTERPRET_CAST(__typeof__(m), a_.f32 < b_.f32);
      r_.f32 =
        HEDLEY_REINTERPRET_CAST(
          __typeof__(r_.f32),
          (
            ( m & HEDLEY_REINTERPRET_CAST(__typeof__(m), b_.f32)) |
            (~m & HEDLEY_REINTERPRET_CAST(__typeof__(m), a_.f32))
          )
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = (a_.f32[i] < b_.f32[i]) ? b_.f32[i] : a_.f32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_pmax(a, b) simde_wasm_f32x4_pmax((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_pmax (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_pmax(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_max_pd(b_.sse_m128d, a_.sse_m128d);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f64 = vbslq_f64(vcltq_f64(a_.neon_f64, b_.neon_f64), b_.neon_f64, a_.neon_f64);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_f64 = vec_sel(a_.altivec_f64, b_.altivec_f64, vec_cmplt(a_.altivec_f64, b_.altivec_f64));
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS)
      int64_t SIMDE_VECTOR(16) m = HEDLEY_REINTERPRET_CAST(__typeof__(m), a_.f64 < b_.f64);
      r_.f64 =
        HEDLEY_REINTERPRET_CAST(
          __typeof__(r_.f64),
          (
            ( m & HEDLEY_REINTERPRET_CAST(__typeof__(m), b_.f64)) |
            (~m & HEDLEY_REINTERPRET_CAST(__typeof__(m), a_.f64))
          )
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = (a_.f64[i] < b_.f64[i]) ? b_.f64[i] : a_.f64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_pmax(a, b) simde_wasm_f64x2_pmax((a), (b))
#endif

/* div */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_div (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_div(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_div_ps(a_.sse_m128, b_.sse_m128);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f32 = a_.f32 / b_.f32;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = a_.f32[i] / b_.f32[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_div(a, b) simde_wasm_f32x4_div((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_div (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_div(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_div_pd(a_.sse_m128d, b_.sse_m128d);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT)
      r_.f64 = a_.f64 / b_.f64;
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = a_.f64[i] / b_.f64[i];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_div(a, b) simde_wasm_f64x2_div((a), (b))
#endif

/* shuffle */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_shuffle (
    simde_v128_t a, simde_v128_t b,
    const int c0, const int c1, const int  c2, const int  c3, const int  c4, const int  c5, const int  c6, const int  c7,
    const int c8, const int c9, const int c10, const int c11, const int c12, const int c13, const int c14, const int c15) {
  simde_v128_private
    a_ = simde_v128_to_private(a),
    b_ = simde_v128_to_private(b),
    r_;

  r_.i8[ 0] = ( c0 < 16) ? a_.i8[ c0] : b_.i8[ c0 & 15];
  r_.i8[ 1] = ( c1 < 16) ? a_.i8[ c1] : b_.i8[ c1 & 15];
  r_.i8[ 2] = ( c2 < 16) ? a_.i8[ c2] : b_.i8[ c2 & 15];
  r_.i8[ 3] = ( c3 < 16) ? a_.i8[ c3] : b_.i8[ c3 & 15];
  r_.i8[ 4] = ( c4 < 16) ? a_.i8[ c4] : b_.i8[ c4 & 15];
  r_.i8[ 5] = ( c5 < 16) ? a_.i8[ c5] : b_.i8[ c5 & 15];
  r_.i8[ 6] = ( c6 < 16) ? a_.i8[ c6] : b_.i8[ c6 & 15];
  r_.i8[ 7] = ( c7 < 16) ? a_.i8[ c7] : b_.i8[ c7 & 15];
  r_.i8[ 8] = ( c8 < 16) ? a_.i8[ c8] : b_.i8[ c8 & 15];
  r_.i8[ 9] = ( c9 < 16) ? a_.i8[ c9] : b_.i8[ c9 & 15];
  r_.i8[10] = (c10 < 16) ? a_.i8[c10] : b_.i8[c10 & 15];
  r_.i8[11] = (c11 < 16) ? a_.i8[c11] : b_.i8[c11 & 15];
  r_.i8[12] = (c12 < 16) ? a_.i8[c12] : b_.i8[c12 & 15];
  r_.i8[13] = (c13 < 16) ? a_.i8[c13] : b_.i8[c13 & 15];
  r_.i8[14] = (c14 < 16) ? a_.i8[c14] : b_.i8[c14 & 15];
  r_.i8[15] = (c15 < 16) ? a_.i8[c15] : b_.i8[c15 & 15];

  return simde_v128_from_private(r_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_i8x16_shuffle( \
        a, b, \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
    wasm_i8x16_shuffle( \
        a, b, \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15)
#elif defined(SIMDE_SHUFFLE_VECTOR_)
  #define \
    simde_wasm_i8x16_shuffle( \
        a, b, \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
    (__extension__ ({ \
      HEDLEY_REINTERPRET_CAST(simde_v128_t, SIMDE_SHUFFLE_VECTOR_(8, 16, \
          HEDLEY_REINTERPRET_CAST(int8_t SIMDE_VECTOR(16), a), \
          HEDLEY_REINTERPRET_CAST(int8_t SIMDE_VECTOR(16), b), \
          c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
          c8, c9, c10, c11, c12, c13, c14, c15)); \
    }))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i8x16_shuffle(a, b, \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7, \
        c8, c9, c10, c11, c12, c13, c14, c15) \
      simde_wasm_i8x16_shuffle((a), (b), \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7), \
          (c8), (c9), (c10), (c11), (c12), (c13), (c14), (c15))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_shuffle (
    simde_v128_t a, simde_v128_t b,
    const int c0, const int c1, const int  c2, const int  c3, const int  c4, const int  c5, const int  c6, const int  c7) {
  simde_v128_private
    a_ = simde_v128_to_private(a),
    b_ = simde_v128_to_private(b),
    r_;

  r_.i16[ 0] = (c0 < 8) ? a_.i16[ c0] : b_.i16[ c0 & 7];
  r_.i16[ 1] = (c1 < 8) ? a_.i16[ c1] : b_.i16[ c1 & 7];
  r_.i16[ 2] = (c2 < 8) ? a_.i16[ c2] : b_.i16[ c2 & 7];
  r_.i16[ 3] = (c3 < 8) ? a_.i16[ c3] : b_.i16[ c3 & 7];
  r_.i16[ 4] = (c4 < 8) ? a_.i16[ c4] : b_.i16[ c4 & 7];
  r_.i16[ 5] = (c5 < 8) ? a_.i16[ c5] : b_.i16[ c5 & 7];
  r_.i16[ 6] = (c6 < 8) ? a_.i16[ c6] : b_.i16[ c6 & 7];
  r_.i16[ 7] = (c7 < 8) ? a_.i16[ c7] : b_.i16[ c7 & 7];

  return simde_v128_from_private(r_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_i16x8_shuffle( \
        a, b, \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7) \
    wasm_i16x8_shuffle( \
        a, b, \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7)
#elif defined(SIMDE_SHUFFLE_VECTOR_)
  #define \
    simde_wasm_i16x8_shuffle( \
        a, b, \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7) \
    (__extension__ ({ \
      HEDLEY_REINTERPRET_CAST(simde_v128_t, SIMDE_SHUFFLE_VECTOR_(16, 16, \
          HEDLEY_REINTERPRET_CAST(int16_t SIMDE_VECTOR(16), a), \
          HEDLEY_REINTERPRET_CAST(int16_t SIMDE_VECTOR(16), b), \
          c0, c1,  c2,  c3,  c4,  c5,  c6,  c7)); \
    }))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i16x8_shuffle(a, b, \
        c0, c1,  c2,  c3,  c4,  c5,  c6,  c7) \
      simde_wasm_i16x8_shuffle((a), (b), \
          (c0), (c1),  (c2),  (c3),  (c4),  (c5),  (c6),  (c7))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_shuffle (
    simde_v128_t a, simde_v128_t b,
    const int c0, const int c1, const int  c2, const int  c3) {
  simde_v128_private
    a_ = simde_v128_to_private(a),
    b_ = simde_v128_to_private(b),
    r_;

  r_.i32[ 0] = (c0 < 4) ? a_.i32[ c0] : b_.i32[ c0 & 3];
  r_.i32[ 1] = (c1 < 4) ? a_.i32[ c1] : b_.i32[ c1 & 3];
  r_.i32[ 2] = (c2 < 4) ? a_.i32[ c2] : b_.i32[ c2 & 3];
  r_.i32[ 3] = (c3 < 4) ? a_.i32[ c3] : b_.i32[ c3 & 3];

  return simde_v128_from_private(r_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_i32x4_shuffle( \
        a, b, \
        c0, c1,  c2,  c3) \
    wasm_i32x4_shuffle( \
        a, b, \
        c0, c1,  c2,  c3)
#elif defined(SIMDE_SHUFFLE_VECTOR_)
  #define \
    simde_wasm_i32x4_shuffle( \
        a, b, \
        c0, c1,  c2,  c3) \
    (__extension__ ({ \
      HEDLEY_REINTERPRET_CAST(simde_v128_t, SIMDE_SHUFFLE_VECTOR_(32, 16, \
          HEDLEY_REINTERPRET_CAST(int32_t SIMDE_VECTOR(16), a), \
          HEDLEY_REINTERPRET_CAST(int32_t SIMDE_VECTOR(16), b), \
          c0, c1,  c2,  c3)); \
    }))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i32x4_shuffle(a, b, \
        c0, c1,  c2,  c3) \
      simde_wasm_i32x4_shuffle((a), (b), \
          (c0), (c1),  (c2),  (c3))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_shuffle (
    simde_v128_t a, simde_v128_t b,
    const int c0, const int c1) {
  simde_v128_private
    a_ = simde_v128_to_private(a),
    b_ = simde_v128_to_private(b),
    r_;

  r_.i64[ 0] = (c0 < 2) ? a_.i64[ c0] : b_.i64[ c0 & 1];
  r_.i64[ 1] = (c1 < 2) ? a_.i64[ c1] : b_.i64[ c1 & 1];

  return simde_v128_from_private(r_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define \
    simde_wasm_i64x2_shuffle( \
        a, b, \
        c0, c1) \
    wasm_i64x2_shuffle( \
        a, b, \
        c0, c1)
#elif defined(SIMDE_SHUFFLE_VECTOR_)
  #define \
    simde_wasm_i64x2_shuffle( \
        a, b, \
        c0, c1) \
    (__extension__ ({ \
      HEDLEY_REINTERPRET_CAST(simde_v128_t, SIMDE_SHUFFLE_VECTOR_(64, 16, \
          HEDLEY_REINTERPRET_CAST(int64_t SIMDE_VECTOR(16), a), \
          HEDLEY_REINTERPRET_CAST(int64_t SIMDE_VECTOR(16), b), \
          c0, c1)); \
    }))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define \
    wasm_i64x2_shuffle(a, b, \
        c0, c1) \
      simde_wasm_i64x2_shuffle((a), (b), \
          (c0), (c1))
#endif

/* swizzle */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_swizzle (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_swizzle(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      int8x8x2_t tmp = { { vget_low_s8(a_.neon_i8), vget_high_s8(a_.neon_i8) } };
      r_.neon_i8 = vcombine_s8(
        vtbl2_s8(tmp, vget_low_s8(b_.neon_i8)),
        vtbl2_s8(tmp, vget_high_s8(b_.neon_i8))
      );
    #elif defined(SIMDE_X86_SSSE3_NATIVE)
      /* https://github.com/WebAssembly/simd/issues/68#issuecomment-470825324 */
      r_.sse_m128i =
        _mm_shuffle_epi8(
          a_.sse_m128i,
          _mm_adds_epu8(
            _mm_set1_epi8(0x70),
            b_.sse_m128i));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_perm(
        a_.altivec_i8,
        a_.altivec_i8,
        b_.altivec_u8
      );
      r_.altivec_i8 = vec_and(r_.altivec_i8, vec_cmple(b_.altivec_u8, vec_splat_u8(15)));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        r_.i8[i] = (b_.u8[i] > 15) ? INT8_C(0) : a_.i8[b_.u8[i]];
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_swizzle(a, b) simde_wasm_i8x16_swizzle((a), (b))
#endif

/* narrow */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_narrow_i16x8 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_narrow_i16x8(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_i8 = vqmovn_high_s16(vqmovn_s16(a_.neon_i16), b_.neon_i16);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vcombine_s8(vqmovn_s16(a_.neon_i16), vqmovn_s16(b_.neon_i16));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_packs(a_.altivec_i16, b_.altivec_i16);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_packs_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_CONVERT_VECTOR_) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      int16_t SIMDE_VECTOR(32) v = SIMDE_SHUFFLE_VECTOR_(16, 32, a_.i16, b_.i16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
      const int16_t SIMDE_VECTOR(32) min = { INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN, INT8_MIN };
      const int16_t SIMDE_VECTOR(32) max = { INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX, INT8_MAX };

      int16_t m SIMDE_VECTOR(32);
      m = HEDLEY_REINTERPRET_CAST(__typeof__(m), v < min);
      v = (v & ~m) | (min & m);

      m = v > max;
      v = (v & ~m) | (max & m);

      SIMDE_CONVERT_VECTOR_(r_.i8, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        int16_t v = (i < (sizeof(a_.i16) / sizeof(a_.i16[0]))) ? a_.i16[i] : b_.i16[i & 7];
        r_.i8[i] = (v < INT8_MIN) ? INT8_MIN : ((v > INT8_MAX) ? INT8_MAX : HEDLEY_STATIC_CAST(int8_t, v));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_narrow_i16x8(a, b) simde_wasm_i8x16_narrow_i16x8((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_narrow_i32x4 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_narrow_i32x4(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_i16 = vqmovn_high_s32(vqmovn_s32(a_.neon_i32), b_.neon_i32);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vcombine_s16(vqmovn_s32(a_.neon_i32), vqmovn_s32(b_.neon_i32));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = vec_packs(a_.altivec_i32, b_.altivec_i32);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_packs_epi32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_CONVERT_VECTOR_) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      int32_t SIMDE_VECTOR(32) v = SIMDE_SHUFFLE_VECTOR_(32, 32, a_.i32, b_.i32, 0, 1, 2, 3, 4, 5, 6, 7);
      const int32_t SIMDE_VECTOR(32) min = { INT16_MIN, INT16_MIN, INT16_MIN, INT16_MIN, INT16_MIN, INT16_MIN, INT16_MIN, INT16_MIN };
      const int32_t SIMDE_VECTOR(32) max = { INT16_MAX, INT16_MAX, INT16_MAX, INT16_MAX, INT16_MAX, INT16_MAX, INT16_MAX, INT16_MAX };

      int32_t m SIMDE_VECTOR(32);
      m = HEDLEY_REINTERPRET_CAST(__typeof__(m), v < min);
      v = (v & ~m) | (min & m);

      m = HEDLEY_REINTERPRET_CAST(__typeof__(m), v > max);
      v = (v & ~m) | (max & m);

      SIMDE_CONVERT_VECTOR_(r_.i16, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        int32_t v = (i < (sizeof(a_.i32) / sizeof(a_.i32[0]))) ? a_.i32[i] : b_.i32[i & 3];
        r_.i16[i] = (v < INT16_MIN) ? INT16_MIN : ((v > INT16_MAX) ? INT16_MAX : HEDLEY_STATIC_CAST(int16_t, v));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_narrow_i32x4(a, b) simde_wasm_i16x8_narrow_i32x4((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u8x16_narrow_i16x8 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u8x16_narrow_i16x8(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      #if defined(SIMDE_BUG_CLANG_46840)
        r_.neon_u8 = vqmovun_high_s16(vreinterpret_s8_u8(vqmovun_s16(a_.neon_i16)), b_.neon_i16);
      #else
        r_.neon_u8 = vqmovun_high_s16(vqmovun_s16(a_.neon_i16), b_.neon_i16);
      #endif
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u8 =
        vcombine_u8(
          vqmovun_s16(a_.neon_i16),
          vqmovun_s16(b_.neon_i16)
        );
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_packus_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u8 = vec_packsu(a_.altivec_i16, b_.altivec_i16);
    #elif defined(SIMDE_CONVERT_VECTOR_) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector) && defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      int16_t v SIMDE_VECTOR(32) = SIMDE_SHUFFLE_VECTOR_(16, 32, a_.i16, b_.i16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);

      v &= ~(v >> 15);
      v |= HEDLEY_REINTERPRET_CAST(__typeof__(v), v > UINT8_MAX);

      SIMDE_CONVERT_VECTOR_(r_.i8, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i8) / sizeof(r_.i8[0])) ; i++) {
        int16_t v = (i < (sizeof(a_.i16) / sizeof(a_.i16[0]))) ? a_.i16[i] : b_.i16[i & 7];
        r_.u8[i] = (v < 0) ? UINT8_C(0) : ((v > UINT8_MAX) ? UINT8_MAX : HEDLEY_STATIC_CAST(uint8_t, v));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u8x16_narrow_i16x8(a, b) simde_wasm_u8x16_narrow_i16x8((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_narrow_i32x4 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_narrow_i32x4(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      #if defined(SIMDE_BUG_CLANG_46840)
        r_.neon_u16 = vqmovun_high_s32(vreinterpret_s16_u16(vqmovun_s32(a_.neon_i32)), b_.neon_i32);
      #else
        r_.neon_u16 = vqmovun_high_s32(vqmovun_s32(a_.neon_i32), b_.neon_i32);
      #endif
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 =
        vcombine_u16(
          vqmovun_s32(a_.neon_i32),
          vqmovun_s32(b_.neon_i32)
        );
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_packus_epi32(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      const __m128i max = _mm_set1_epi32(UINT16_MAX);
      const __m128i tmpa = _mm_andnot_si128(_mm_srai_epi32(a_.sse_m128i, 31), a_.sse_m128i);
      const __m128i tmpb = _mm_andnot_si128(_mm_srai_epi32(b_.sse_m128i, 31), b_.sse_m128i);
      r_.sse_m128i =
        _mm_packs_epi32(
          _mm_srai_epi32(_mm_slli_epi32(_mm_or_si128(tmpa, _mm_cmpgt_epi32(tmpa, max)), 16), 16),
          _mm_srai_epi32(_mm_slli_epi32(_mm_or_si128(tmpb, _mm_cmpgt_epi32(tmpb, max)), 16), 16)
        );
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u16 = vec_packsu(a_.altivec_i32, b_.altivec_i32);
    #elif defined(SIMDE_CONVERT_VECTOR_) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector) && defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      int32_t v SIMDE_VECTOR(32) = SIMDE_SHUFFLE_VECTOR_(32, 32, a_.i32, b_.i32, 0, 1, 2, 3, 4, 5, 6, 7);

      v &= ~(v >> 31);
      v |= HEDLEY_REINTERPRET_CAST(__typeof__(v), v > UINT16_MAX);

      SIMDE_CONVERT_VECTOR_(r_.i16, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        int32_t v = (i < (sizeof(a_.i32) / sizeof(a_.i32[0]))) ? a_.i32[i] : b_.i32[i & 3];
        r_.u16[i] = (v < 0) ? UINT16_C(0) : ((v > UINT16_MAX) ? UINT16_MAX : HEDLEY_STATIC_CAST(uint16_t, v));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_narrow_i32x4(a, b) simde_wasm_u16x8_narrow_i32x4((a), (b))
#endif

/* demote */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_demote_f64x2_zero (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_demote_f64x2_zero(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_cvtpd_ps(a_.sse_m128d);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f32 = vcombine_f32(vcvt_f32_f64(a_.neon_f64), vdup_n_f32(0.0f));
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f32 = vec_floate(a_.altivec_f64);
      #if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
        r_.altivec_f32 =
          HEDLEY_REINTERPRET_CAST(
            SIMDE_POWER_ALTIVEC_VECTOR(float),
            vec_pack(
              HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(long long), r_.altivec_f32),
              HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(long long), vec_splat_s32(0))
            )
          );
      #else
        const SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) perm = {
          0x00, 0x01, 0x02, 0x03, /* 0 */
          0x08, 0x09, 0x0a, 0x0b, /* 2 */
          0x10, 0x11, 0x12, 0x13, /* 4 */
          0x18, 0x19, 0x1a, 0x1b  /* 6 */
        };
        r_.altivec_f32 = vec_perm(r_.altivec_f32, HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(float), vec_splat_s32(0)), perm);
      #endif
    #elif HEDLEY_HAS_BUILTIN(__builtin_shufflevector) && HEDLEY_HAS_BUILTIN(__builtin_convertvector)
      float __attribute__((__vector_size__(8))) z = { 0.0f, 0.0f };
      r_.f32 = __builtin_shufflevector(__builtin_convertvector(a_.f64, __typeof__(z)), z, 0, 1, 2, 3);
    #else
      r_.f32[0] = HEDLEY_STATIC_CAST(simde_float32, a_.f64[0]);
      r_.f32[1] = HEDLEY_STATIC_CAST(simde_float32, a_.f64[1]);
      r_.f32[2] = SIMDE_FLOAT32_C(0.0);
      r_.f32[3] = SIMDE_FLOAT32_C(0.0);
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_demote_f64x2_zero(a) simde_wasm_f32x4_demote_f64x2_zero((a))
#endif

/* extend_low */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_extend_low_i8x16 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_extend_low_i8x16(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vmovl_s8(vget_low_s8(a_.neon_i8));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepi8_epi16(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_srai_epi16(_mm_unpacklo_epi8(a_.sse_m128i, a_.sse_m128i), 8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 =
        vec_sra(
          HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(short), vec_mergeh(a_.altivec_i8, a_.altivec_i8)),
          vec_splats(HEDLEY_STATIC_CAST(unsigned short, 8)
        )
      );
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const int8_t v SIMDE_VECTOR(8) = {
        a_.i8[0], a_.i8[1], a_.i8[2], a_.i8[3],
        a_.i8[4], a_.i8[5], a_.i8[6], a_.i8[7]
      };

      SIMDE_CONVERT_VECTOR_(r_.i16, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(int16_t, a_.i8[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_extend_low_i8x16(a) simde_wasm_i16x8_extend_low_i8x16((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_extend_low_i16x8 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_extend_low_i16x8(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vmovl_s16(vget_low_s16(a_.neon_i16));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepi16_epi32(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_srai_epi32(_mm_unpacklo_epi16(a_.sse_m128i, a_.sse_m128i), 16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 =
        vec_sra(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(int), vec_mergeh(a_.altivec_i16, a_.altivec_i16)),
        vec_splats(HEDLEY_STATIC_CAST(unsigned int, 16))
      );
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const int16_t v SIMDE_VECTOR(8) = { a_.i16[0], a_.i16[1], a_.i16[2], a_.i16[3] };

      SIMDE_CONVERT_VECTOR_(r_.i32, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.i16[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_extend_low_i16x8(a) simde_wasm_i32x4_extend_low_i16x8((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_extend_low_i32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_extend_low_i32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i64 = vmovl_s32(vget_low_s32(a_.neon_i32));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepi32_epi64(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_unpacklo_epi32(a_.sse_m128i, _mm_cmpgt_epi32(_mm_setzero_si128(), a_.sse_m128i));
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_i64 =
        vec_sra(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(long long), vec_mergeh(a_.altivec_i32, a_.altivec_i32)),
        vec_splats(HEDLEY_STATIC_CAST(unsigned long long, 32))
      );
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 =
        vec_mergeh(
          a_.altivec_i32,
          HEDLEY_REINTERPRET_CAST(
            SIMDE_POWER_ALTIVEC_VECTOR(int),
            vec_cmpgt(vec_splat_s32(0), a_.altivec_i32)
          )
        );
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const int32_t v SIMDE_VECTOR(8) = { a_.i32[0], a_.i32[1] };

      SIMDE_CONVERT_VECTOR_(r_.i64, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = HEDLEY_STATIC_CAST(int64_t, a_.i32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_extend_low_i32x4(a) simde_wasm_i64x2_extend_low_i32x4((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_extend_low_u8x16 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_extend_low_u8x16(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vmovl_u8(vget_low_u8(a_.neon_u8));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepu8_epi16(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_srli_epi16(_mm_unpacklo_epi8(a_.sse_m128i, a_.sse_m128i), 8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_mergeh(a_.altivec_i8, vec_splat_s8(0));
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const uint8_t v SIMDE_VECTOR(8) = {
        a_.u8[0], a_.u8[1], a_.u8[2], a_.u8[3],
        a_.u8[4], a_.u8[5], a_.u8[6], a_.u8[7]
      };

      SIMDE_CONVERT_VECTOR_(r_.i16, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(int16_t, a_.u8[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_extend_low_u8x16(a) simde_wasm_u16x8_extend_low_u8x16((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_extend_low_u16x8 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_extend_low_u16x8(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vmovl_u16(vget_low_u16(a_.neon_u16));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepu16_epi32(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_srli_epi32(_mm_unpacklo_epi16(a_.sse_m128i, a_.sse_m128i), 16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = vec_mergeh(a_.altivec_i16, vec_splat_s16(0));
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const uint16_t v SIMDE_VECTOR(8) = { a_.u16[0], a_.u16[1], a_.u16[2], a_.u16[3] };

      SIMDE_CONVERT_VECTOR_(r_.i32, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.u16[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_extend_low_u16x8(a) simde_wasm_u32x4_extend_low_u16x8((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u64x2_extend_low_u32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u64x2_extend_low_u32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u64 = vmovl_u32(vget_low_u32(a_.neon_u32));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepu32_epi64(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =_mm_unpacklo_epi32(a_.sse_m128i, _mm_setzero_si128());
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 = vec_mergeh(a_.altivec_i32, vec_splat_s32(0));
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const uint32_t v SIMDE_VECTOR(8) = { a_.u32[0], a_.u32[1] };

      SIMDE_CONVERT_VECTOR_(r_.u64, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u64) / sizeof(r_.u64[0])) ; i++) {
        r_.u64[i] = HEDLEY_STATIC_CAST(int64_t, a_.u32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u64x2_extend_low_u32x4(a) simde_wasm_u64x2_extend_low_u32x4((a))
#endif

/* promote */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_promote_low_f32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_promote_low_f32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_cvtps_pd(a_.sse_m128);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f64 = vcvt_f64_f32(vget_low_f32(a_.neon_f32));
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f64 = vec_unpackh(a_.altivec_f32);
    #elif HEDLEY_HAS_BUILTIN(__builtin_shufflevector) && HEDLEY_HAS_BUILTIN(__builtin_convertvector)
      r_.f64 = __builtin_convertvector(__builtin_shufflevector(a_.f32, a_.f32, 0, 1), __typeof__(r_.f64));
    #else
      r_.f64[0] = HEDLEY_STATIC_CAST(simde_float64, a_.f32[0]);
      r_.f64[1] = HEDLEY_STATIC_CAST(simde_float64, a_.f32[1]);
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_promote_low_f32x4(a) simde_wasm_f64x2_promote_low_f32x4((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_extend_high_i8x16 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_extend_high_i8x16(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vmovl_s8(vget_high_s8(a_.neon_i8));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepi8_epi16(_mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(3, 2, 3, 2)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_srai_epi16(_mm_unpackhi_epi8(a_.sse_m128i, a_.sse_m128i), 8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 =
        vec_sra(
          HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(short), vec_mergel(a_.altivec_i8, a_.altivec_i8)),
          vec_splats(HEDLEY_STATIC_CAST(unsigned short, 8)
        )
      );
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const int8_t v SIMDE_VECTOR(8) = {
        a_.i8[ 8], a_.i8[ 9], a_.i8[10], a_.i8[11],
        a_.i8[12], a_.i8[13], a_.i8[14], a_.i8[15]
      };

      SIMDE_CONVERT_VECTOR_(r_.i16, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(int16_t, a_.i8[i + 8]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_extend_high_i8x16(a) simde_wasm_i16x8_extend_high_i8x16((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_extend_high_i16x8 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_extend_high_i16x8(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vmovl_s16(vget_high_s16(a_.neon_i16));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepi16_epi32(_mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(3, 2, 3, 2)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_srai_epi32(_mm_unpackhi_epi16(a_.sse_m128i, a_.sse_m128i), 16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 =
        vec_sra(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(int), vec_mergel(a_.altivec_i16, a_.altivec_i16)),
        vec_splats(HEDLEY_STATIC_CAST(unsigned int, 16))
      );
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const int16_t v SIMDE_VECTOR(8) = { a_.i16[4], a_.i16[5], a_.i16[6], a_.i16[7] };

      SIMDE_CONVERT_VECTOR_(r_.i32, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.i16[i + 4]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_extend_high_i16x8(a) simde_wasm_i32x4_extend_high_i16x8((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_extend_high_i32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_extend_high_i32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i64 = vmovl_s32(vget_high_s32(a_.neon_i32));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepi32_epi64(_mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(3, 2, 3, 2)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_unpackhi_epi32(a_.sse_m128i, _mm_cmpgt_epi32(_mm_setzero_si128(), a_.sse_m128i));
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_i64 =
        vec_sra(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(long long), vec_mergel(a_.altivec_i32, a_.altivec_i32)),
        vec_splats(HEDLEY_STATIC_CAST(unsigned long long, 32))
      );
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 =
        vec_mergel(
          a_.altivec_i32,
          HEDLEY_REINTERPRET_CAST(
            SIMDE_POWER_ALTIVEC_VECTOR(int),
            vec_cmpgt(vec_splat_s32(0), a_.altivec_i32)
          )
        );
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const int32_t v SIMDE_VECTOR(8) = { a_.i32[2], a_.i32[3] };

      SIMDE_CONVERT_VECTOR_(r_.i64, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = HEDLEY_STATIC_CAST(int64_t, a_.i32[i + 2]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_extend_high_i32x4(a) simde_wasm_i64x2_extend_high_i32x4((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_extend_high_u8x16 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_extend_high_u8x16(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vmovl_u8(vget_high_u8(a_.neon_u8));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepu8_epi16(_mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(3, 2, 3, 2)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_srli_epi16(_mm_unpackhi_epi8(a_.sse_m128i, a_.sse_m128i), 8);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i8 = vec_mergel(a_.altivec_i8, vec_splat_s8(0));
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const uint8_t v SIMDE_VECTOR(8) = {
        a_.u8[ 8], a_.u8[ 9], a_.u8[10], a_.u8[11],
        a_.u8[12], a_.u8[13], a_.u8[14], a_.u8[15]
      };

      SIMDE_CONVERT_VECTOR_(r_.u16, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(uint16_t, a_.u8[i + 8]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_extend_high_u8x16(a) simde_wasm_u16x8_extend_high_u8x16((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_extend_high_u16x8 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_extend_high_u16x8(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vmovl_u16(vget_high_u16(a_.neon_u16));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepu16_epi32(_mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(3, 2, 3, 2)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_srli_epi32(_mm_unpackhi_epi16(a_.sse_m128i, a_.sse_m128i), 16);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 = vec_mergel(a_.altivec_i16, vec_splat_s16(0));
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const uint16_t v SIMDE_VECTOR(8) = { a_.u16[4], a_.u16[5], a_.u16[6], a_.u16[7] };

      SIMDE_CONVERT_VECTOR_(r_.u32, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(uint32_t, a_.u16[i + 4]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_extend_high_u16x8(a) simde_wasm_u32x4_extend_high_u16x8((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u64x2_extend_high_u32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u64x2_extend_high_u32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u64 = vmovl_u32(vget_high_u32(a_.neon_u32));
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i = _mm_cvtepu32_epi64(_mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(3, 2, 3, 2)));
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =_mm_unpackhi_epi32(a_.sse_m128i, _mm_setzero_si128());
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 = vec_mergel(a_.altivec_i32, vec_splat_s32(0));
    #elif defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      const uint32_t v SIMDE_VECTOR(8) = { a_.u32[2], a_.u32[3] };

      SIMDE_CONVERT_VECTOR_(r_.u64, v);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = HEDLEY_STATIC_CAST(uint32_t, a_.u32[i + 2]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u64x2_extend_high_u32x4(a) simde_wasm_u64x2_extend_high_u32x4((a))
#endif

/* extmul_low */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_extmul_low_i8x16 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_extmul_low_i8x16(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vmull_s8(vget_low_s8(a_.neon_i8), vget_low_s8(b_.neon_i8));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(signed char) ashuf;
      SIMDE_POWER_ALTIVEC_VECTOR(signed char) bshuf;

      #if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
        ashuf = vec_mergeh(a_.altivec_i8, a_.altivec_i8);
        bshuf = vec_mergeh(b_.altivec_i8, b_.altivec_i8);
      #else
        SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) perm = {
          0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7
        };
        ashuf = vec_perm(a_.altivec_i8, a_.altivec_i8, perm);
        bshuf = vec_perm(b_.altivec_i8, b_.altivec_i8, perm);
      #endif

      r_.altivec_i16 = vec_mule(ashuf, bshuf);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_mullo_epi16(
          _mm_srai_epi16(_mm_unpacklo_epi8(a_.sse_m128i, a_.sse_m128i), 8),
          _mm_srai_epi16(_mm_unpacklo_epi8(b_.sse_m128i, b_.sse_m128i), 8)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.i16 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.i8, a_.i8, 0, 1, 2, 3, 4, 5, 6, 7),
          __typeof__(r_.i16)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.i8, b_.i8, 0, 1, 2, 3, 4, 5, 6, 7),
          __typeof__(r_.i16)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(int16_t, a_.i8[i]) * HEDLEY_STATIC_CAST(int16_t, b_.i8[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_extmul_low_i8x16(a, b) simde_wasm_i16x8_extmul_low_i8x16((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_extmul_low_i16x8 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_extmul_low_i16x8(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vmull_s16(vget_low_s16(a_.neon_i16), vget_low_s16(b_.neon_i16));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(signed short) ashuf;
      SIMDE_POWER_ALTIVEC_VECTOR(signed short) bshuf;

      #if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
        ashuf = vec_mergeh(a_.altivec_i16, a_.altivec_i16);
        bshuf = vec_mergeh(b_.altivec_i16, b_.altivec_i16);
      #else
        SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) perm = {
          0, 1, 0, 1,
          2, 3, 2, 3,
          4, 5, 4, 5,
          6, 7, 6, 7
        };
        ashuf = vec_perm(a_.altivec_i16, a_.altivec_i16, perm);
        bshuf = vec_perm(b_.altivec_i16, b_.altivec_i16, perm);
      #endif

      r_.altivec_i32 = vec_mule(ashuf, bshuf);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_unpacklo_epi16(
          _mm_mullo_epi16(a_.sse_m128i, b_.sse_m128i),
          _mm_mulhi_epi16(a_.sse_m128i, b_.sse_m128i)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.i32 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.i16, a_.i16, 0, 1, 2, 3),
          __typeof__(r_.i32)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.i16, b_.i16, 0, 1, 2, 3),
          __typeof__(r_.i32)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.i16[i]) * HEDLEY_STATIC_CAST(int32_t, b_.i16[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_extmul_low_i16x8(a, b) simde_wasm_i32x4_extmul_low_i16x8((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_extmul_low_i32x4 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_extmul_low_i32x4(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i64 = vmull_s32(vget_low_s32(a_.neon_i32), vget_low_s32(b_.neon_i32));
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(signed int) ashuf;
      SIMDE_POWER_ALTIVEC_VECTOR(signed int) bshuf;

      #if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
        ashuf = vec_mergeh(a_.altivec_i32, a_.altivec_i32);
        bshuf = vec_mergeh(b_.altivec_i32, b_.altivec_i32);
      #else
        SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) perm = {
          0, 1, 2, 3, 0, 1, 2, 3,
          4, 5, 6, 7, 4, 5, 6, 7
        };
        ashuf = vec_perm(a_.altivec_i32, a_.altivec_i32, perm);
        bshuf = vec_perm(b_.altivec_i32, b_.altivec_i32, perm);
      #endif

      r_.altivec_i64 = vec_mule(ashuf, bshuf);
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i =
        _mm_mul_epi32(
          _mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(1, 1, 0, 0)),
          _mm_shuffle_epi32(b_.sse_m128i, _MM_SHUFFLE(1, 1, 0, 0))
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.i64 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.i32, a_.i32, 0, 1),
          __typeof__(r_.i64)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.i32, b_.i32, 0, 1),
          __typeof__(r_.i64)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = HEDLEY_STATIC_CAST(int64_t, a_.i32[i]) * HEDLEY_STATIC_CAST(int64_t, b_.i32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_extmul_low_i32x4(a, b) simde_wasm_i64x2_extmul_low_i32x4((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_extmul_low_u8x16 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_extmul_low_u8x16(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vmull_u8(vget_low_u8(a_.neon_u8), vget_low_u8(b_.neon_u8));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) ashuf;
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) bshuf;

      #if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
        ashuf = vec_mergeh(a_.altivec_u8, a_.altivec_u8);
        bshuf = vec_mergeh(b_.altivec_u8, b_.altivec_u8);
      #else
        SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) perm = {
          0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7
        };
        ashuf = vec_perm(a_.altivec_u8, a_.altivec_u8, perm);
        bshuf = vec_perm(b_.altivec_u8, b_.altivec_u8, perm);
      #endif

      r_.altivec_u16 = vec_mule(ashuf, bshuf);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.u16 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.u8, a_.u8, 0, 1, 2, 3, 4, 5, 6, 7),
          __typeof__(r_.u16)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.u8, b_.u8, 0, 1, 2, 3, 4, 5, 6, 7),
          __typeof__(r_.u16)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = HEDLEY_STATIC_CAST(uint16_t, a_.u8[i]) * HEDLEY_STATIC_CAST(uint16_t, b_.u8[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_extmul_low_u8x16(a, b) simde_wasm_u16x8_extmul_low_u8x16((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_extmul_low_u16x8 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_extmul_low_u16x8(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vmull_u16(vget_low_u16(a_.neon_u16), vget_low_u16(b_.neon_u16));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned short) ashuf;
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned short) bshuf;

      #if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
        ashuf = vec_mergeh(a_.altivec_u16, a_.altivec_u16);
        bshuf = vec_mergeh(b_.altivec_u16, b_.altivec_u16);
      #else
        SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) perm = {
          0, 1, 0, 1,
          2, 3, 2, 3,
          4, 5, 4, 5,
          6, 7, 6, 7
        };
        ashuf = vec_perm(a_.altivec_u16, a_.altivec_u16, perm);
        bshuf = vec_perm(b_.altivec_u16, b_.altivec_u16, perm);
      #endif

      r_.altivec_u32 = vec_mule(ashuf, bshuf);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_unpacklo_epi16(
          _mm_mullo_epi16(a_.sse_m128i, b_.sse_m128i),
          _mm_mulhi_epu16(a_.sse_m128i, b_.sse_m128i)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.u32 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.u16, a_.u16, 0, 1, 2, 3),
          __typeof__(r_.u32)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.u16, b_.u16, 0, 1, 2, 3),
          __typeof__(r_.u32)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        r_.u32[i] = HEDLEY_STATIC_CAST(uint32_t, a_.u16[i]) * HEDLEY_STATIC_CAST(uint32_t, b_.u16[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_extmul_low_u16x8(a, b) simde_wasm_u32x4_extmul_low_u16x8((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u64x2_extmul_low_u32x4 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u64x2_extmul_low_u32x4(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u64 = vmull_u32(vget_low_u32(a_.neon_u32), vget_low_u32(b_.neon_u32));
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned int) ashuf;
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned int) bshuf;

      #if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
        ashuf = vec_mergeh(a_.altivec_u32, a_.altivec_u32);
        bshuf = vec_mergeh(b_.altivec_u32, b_.altivec_u32);
      #else
        SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) perm = {
          0, 1, 2, 3, 0, 1, 2, 3,
          4, 5, 6, 7, 4, 5, 6, 7
        };
        ashuf = vec_perm(a_.altivec_u32, a_.altivec_u32, perm);
        bshuf = vec_perm(b_.altivec_u32, b_.altivec_u32, perm);
      #endif

      r_.altivec_u64 = vec_mule(ashuf, bshuf);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_mul_epu32(
          _mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(1, 1, 0, 0)),
          _mm_shuffle_epi32(b_.sse_m128i, _MM_SHUFFLE(1, 1, 0, 0))
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.u64 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.u32, a_.u32, 0, 1),
          __typeof__(r_.u64)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.u32, b_.u32, 0, 1),
          __typeof__(r_.u64)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.u64[i] = HEDLEY_STATIC_CAST(uint64_t, a_.u32[i]) * HEDLEY_STATIC_CAST(uint64_t, b_.u32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u64x2_extmul_low_u32x4(a, b) simde_wasm_u64x2_extmul_low_u32x4((a), (b))
#endif

/* extmul_high */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_extmul_high_i8x16 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_extmul_high_i8x16(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_i16 = vmull_high_s8(a_.neon_i8, b_.neon_i8);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vmull_s8(vget_high_s8(a_.neon_i8), vget_high_s8(b_.neon_i8));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i16 =
        vec_mule(
          vec_mergel(a_.altivec_i8, a_.altivec_i8),
          vec_mergel(b_.altivec_i8, b_.altivec_i8)
        );
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_mullo_epi16(
          _mm_srai_epi16(_mm_unpackhi_epi8(a_.sse_m128i, a_.sse_m128i), 8),
          _mm_srai_epi16(_mm_unpackhi_epi8(b_.sse_m128i, b_.sse_m128i), 8)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.i16 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.i8, a_.i8, 8, 9, 10, 11, 12, 13, 14, 15),
          __typeof__(r_.i16)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.i8, b_.i8, 8, 9, 10, 11, 12, 13, 14, 15),
          __typeof__(r_.i16)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(int16_t, a_.i8[i + 8]) * HEDLEY_STATIC_CAST(int16_t, b_.i8[i + 8]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_extmul_high_i8x16(a, b) simde_wasm_i16x8_extmul_high_i8x16((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_extmul_high_i16x8 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_extmul_high_i16x8(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_i32 = vmull_high_s16(a_.neon_i16, b_.neon_i16);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vmull_s16(vget_high_s16(a_.neon_i16), vget_high_s16(b_.neon_i16));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 =
        vec_mule(
          vec_mergel(a_.altivec_i16, a_.altivec_i16),
          vec_mergel(b_.altivec_i16, b_.altivec_i16)
        );
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_unpackhi_epi16(
          _mm_mullo_epi16(a_.sse_m128i, b_.sse_m128i),
          _mm_mulhi_epi16(a_.sse_m128i, b_.sse_m128i)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.i32 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.i16, a_.i16, 4, 5, 6, 7),
          __typeof__(r_.i32)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.i16, b_.i16, 4, 5, 6, 7),
          __typeof__(r_.i32)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.i16[i + 4]) * HEDLEY_STATIC_CAST(int32_t, b_.i16[i + 4]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_extmul_high_i16x8(a, b) simde_wasm_i32x4_extmul_high_i16x8((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_extmul_high_i32x4 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_extmul_high_i32x4(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_i64 = vmull_high_s32(a_.neon_i32, b_.neon_i32);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i64 = vmull_s32(vget_high_s32(a_.neon_i32), vget_high_s32(b_.neon_i32));
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(signed int) ashuf;
      SIMDE_POWER_ALTIVEC_VECTOR(signed int) bshuf;

      #if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
        ashuf = vec_mergel(a_.altivec_i32, a_.altivec_i32);
        bshuf = vec_mergel(b_.altivec_i32, b_.altivec_i32);
      #else
        SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) perm = {
           8,  9, 10, 11,  8,  9, 10, 11,
          12, 13, 14, 15, 12, 13, 14, 15
        };
        ashuf = vec_perm(a_.altivec_i32, a_.altivec_i32, perm);
        bshuf = vec_perm(b_.altivec_i32, b_.altivec_i32, perm);
      #endif

      r_.altivec_i64 = vec_mule(ashuf, bshuf);
    #elif defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128i =
        _mm_mul_epi32(
          _mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(3, 3, 2, 2)),
          _mm_shuffle_epi32(b_.sse_m128i, _MM_SHUFFLE(3, 3, 2, 2))
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.i64 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.i32, a_.i32, 2, 3),
          __typeof__(r_.i64)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.i32, b_.i32, 2, 3),
          __typeof__(r_.i64)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = HEDLEY_STATIC_CAST(int64_t, a_.i32[i + 2]) * HEDLEY_STATIC_CAST(int64_t, b_.i32[i + 2]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_extmul_high_i32x4(a, b) simde_wasm_i64x2_extmul_high_i32x4((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_extmul_high_u8x16 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_extmul_high_u8x16(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u16 = vmull_high_u8(a_.neon_u8, b_.neon_u8);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vmull_u8(vget_high_u8(a_.neon_u8), vget_high_u8(b_.neon_u8));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u16 =
        vec_mule(
          vec_mergel(a_.altivec_u8, a_.altivec_u8),
          vec_mergel(b_.altivec_u8, b_.altivec_u8)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.u16 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.u8, a_.u8, 8, 9, 10, 11, 12, 13, 14, 15),
          __typeof__(r_.u16)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.u8, b_.u8, 8, 9, 10, 11, 12, 13, 14, 15),
          __typeof__(r_.u16)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = HEDLEY_STATIC_CAST(uint16_t, a_.u8[i + 8]) * HEDLEY_STATIC_CAST(uint16_t, b_.u8[i + 8]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_extmul_high_u8x16(a, b) simde_wasm_u16x8_extmul_high_u8x16((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_extmul_high_u16x8 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_extmul_high_u16x8(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u32 = vmull_high_u16(a_.neon_u16, b_.neon_u16);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vmull_u16(vget_high_u16(a_.neon_u16), vget_high_u16(b_.neon_u16));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_u32 =
        vec_mule(
          vec_mergel(a_.altivec_u16, a_.altivec_u16),
          vec_mergel(b_.altivec_u16, b_.altivec_u16)
        );
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_unpackhi_epi16(
          _mm_mullo_epi16(a_.sse_m128i, b_.sse_m128i),
          _mm_mulhi_epu16(a_.sse_m128i, b_.sse_m128i)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.u32 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.u16, a_.u16, 4, 5, 6, 7),
          __typeof__(r_.u32)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.u16, b_.u16, 4, 5, 6, 7),
          __typeof__(r_.u32)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        r_.u32[i] = HEDLEY_STATIC_CAST(uint32_t, a_.u16[i + 4]) * HEDLEY_STATIC_CAST(uint32_t, b_.u16[i + 4]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_extmul_high_u16x8(a, b) simde_wasm_u32x4_extmul_high_u16x8((a), (b))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u64x2_extmul_high_u32x4 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u64x2_extmul_high_u32x4(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u64 = vmull_high_u32(a_.neon_u32, b_.neon_u32);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u64 = vmull_u32(vget_high_u32(a_.neon_u32), vget_high_u32(b_.neon_u32));
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_u64 =
        vec_mule(
          vec_mergel(a_.altivec_u32, a_.altivec_u32),
          vec_mergel(b_.altivec_u32, b_.altivec_u32)
        );
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_mul_epu32(
          _mm_shuffle_epi32(a_.sse_m128i, _MM_SHUFFLE(3, 3, 2, 2)),
          _mm_shuffle_epi32(b_.sse_m128i, _MM_SHUFFLE(3, 3, 2, 2))
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      r_.u64 =
        __builtin_convertvector(
          __builtin_shufflevector(a_.u32, a_.u32, 2, 3),
          __typeof__(r_.u64)
        )
        *
        __builtin_convertvector(
          __builtin_shufflevector(b_.u32, b_.u32, 2, 3),
          __typeof__(r_.u64)
        );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u64) / sizeof(r_.u64[0])) ; i++) {
        r_.u64[i] = HEDLEY_STATIC_CAST(uint64_t, a_.u32[i + 2]) * HEDLEY_STATIC_CAST(uint64_t, b_.u32[i + 2]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u64x2_extmul_high_u32x4(a, b) simde_wasm_u64x2_extmul_high_u32x4((a), (b))
#endif

/* extadd_pairwise */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_extadd_pairwise_i8x16 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_extadd_pairwise_i8x16(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i16 = vpaddlq_s8(a_.neon_i8);
    #elif defined(SIMDE_X86_XOP_NATIVE)
      r_.sse_m128i = _mm_haddw_epi8(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSSE3_NATIVE)
      r_.sse_m128i = _mm_maddubs_epi16(_mm_set1_epi8(INT8_C(1)), a_.sse_m128i);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(signed char) one = vec_splat_s8(1);
      r_.altivec_i16 =
        vec_add(
          vec_mule(a_.altivec_i8, one),
          vec_mulo(a_.altivec_i8, one)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      r_.i16 =
        ((a_.i16 << 8) >> 8) +
        ((a_.i16 >> 8)     );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(int16_t, a_.i8[(i * 2)]) + HEDLEY_STATIC_CAST(int16_t, a_.i8[(i * 2) + 1]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_extadd_pairwise_i8x16(a) simde_wasm_i16x8_extadd_pairwise_i8x16((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_extadd_pairwise_i16x8 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_extadd_pairwise_i16x8(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vpaddlq_s16(a_.neon_i16);
    #elif defined(SIMDE_X86_XOP_NATIVE)
      r_.sse_m128i = _mm_haddd_epi16(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_madd_epi16(a_.sse_m128i, _mm_set1_epi16(INT8_C(1)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(signed short) one = vec_splat_s16(1);
      r_.altivec_i32 =
        vec_add(
          vec_mule(a_.altivec_i16, one),
          vec_mulo(a_.altivec_i16, one)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      r_.i32 =
        ((a_.i32 << 16) >> 16) +
        ((a_.i32 >> 16)      );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.i16[(i * 2)]) + HEDLEY_STATIC_CAST(int32_t, a_.i16[(i * 2) + 1]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_extadd_pairwise_i16x8(a) simde_wasm_i32x4_extadd_pairwise_i16x8((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_extadd_pairwise_u8x16 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_extadd_pairwise_u8x16(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u16 = vpaddlq_u8(a_.neon_u8);
    #elif defined(SIMDE_X86_XOP_NATIVE)
      r_.sse_m128i = _mm_haddw_epu8(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSSE3_NATIVE)
      r_.sse_m128i = _mm_maddubs_epi16(a_.sse_m128i, _mm_set1_epi8(INT8_C(1)));
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) one = vec_splat_u8(1);
      r_.altivec_u16 =
        vec_add(
          vec_mule(a_.altivec_u8, one),
          vec_mulo(a_.altivec_u8, one)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      r_.u16 =
        ((a_.u16 << 8) >> 8) +
        ((a_.u16 >> 8)     );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = HEDLEY_STATIC_CAST(uint16_t, a_.u8[(i * 2)]) + HEDLEY_STATIC_CAST(uint16_t, a_.u8[(i * 2) + 1]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_extadd_pairwise_u8x16(a) simde_wasm_u16x8_extadd_pairwise_u8x16((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_extadd_pairwise_u16x8 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_extadd_pairwise_u16x8(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vpaddlq_u16(a_.neon_u16);
    #elif defined(SIMDE_X86_XOP_NATIVE)
      r_.sse_m128i = _mm_haddd_epu16(a_.sse_m128i);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i =
        _mm_add_epi32(
          _mm_srli_epi32(a_.sse_m128i, 16),
          _mm_and_si128(a_.sse_m128i, _mm_set1_epi32(INT32_C(0x0000ffff)))
        );
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(unsigned short) one = vec_splat_u16(1);
      r_.altivec_u32 =
        vec_add(
          vec_mule(a_.altivec_u16, one),
          vec_mulo(a_.altivec_u16, one)
        );
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_SCALAR)
      r_.u32 =
        ((a_.u32 << 16) >> 16) +
        ((a_.u32 >> 16)      );
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        r_.u32[i] = HEDLEY_STATIC_CAST(uint32_t, a_.u16[(i * 2)]) + HEDLEY_STATIC_CAST(uint32_t, a_.u16[(i * 2) + 1]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_extadd_pairwise_u16x8(a) simde_wasm_u32x4_extadd_pairwise_u16x8((a))
#endif

/* X_load_Y */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i16x8_load8x8 (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i16x8_load8x8(mem);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      int8_t v SIMDE_VECTOR(8);
      simde_memcpy(&v, mem, sizeof(v));
      SIMDE_CONVERT_VECTOR_(r_.i16, v);
    #else
      SIMDE_ALIGN_TO_16 int8_t v[8];
      simde_memcpy(v, mem, sizeof(v));

      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i16) / sizeof(r_.i16[0])) ; i++) {
        r_.i16[i] = HEDLEY_STATIC_CAST(int16_t, v[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i16x8_load8x8(mem) simde_wasm_i16x8_load8x8((mem))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_load16x4 (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_load16x4(mem);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      int16_t v SIMDE_VECTOR(8);
      simde_memcpy(&v, mem, sizeof(v));
      SIMDE_CONVERT_VECTOR_(r_.i32, v);
    #else
      SIMDE_ALIGN_TO_16 int16_t v[4];
      simde_memcpy(v, mem, sizeof(v));

      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, v[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_load16x4(mem) simde_wasm_i32x4_load16x4((mem))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i64x2_load32x2 (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i64x2_load32x2(mem);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762) && !defined(SIMDE_BUG_CLANG_50893)
      int32_t v SIMDE_VECTOR(8);
      simde_memcpy(&v, mem, sizeof(v));
      SIMDE_CONVERT_VECTOR_(r_.i64, v);
    #else
      SIMDE_ALIGN_TO_16 int32_t v[2];
      simde_memcpy(v, mem, sizeof(v));

      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i64) / sizeof(r_.i64[0])) ; i++) {
        r_.i64[i] = HEDLEY_STATIC_CAST(int64_t, v[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i64x2_load32x2(mem) simde_wasm_i64x2_load32x2((mem))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u16x8_load8x8 (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u16x8_load8x8(mem);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      uint8_t v SIMDE_VECTOR(8);
      simde_memcpy(&v, mem, sizeof(v));
      SIMDE_CONVERT_VECTOR_(r_.u16, v);
    #else
      SIMDE_ALIGN_TO_16 uint8_t v[8];
      simde_memcpy(v, mem, sizeof(v));

      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u16) / sizeof(r_.u16[0])) ; i++) {
        r_.u16[i] = HEDLEY_STATIC_CAST(uint16_t, v[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u16x8_load8x8(mem) simde_wasm_u16x8_load8x8((mem))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_load16x4 (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_load16x4(mem);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      uint16_t v SIMDE_VECTOR(8);
      simde_memcpy(&v, mem, sizeof(v));
      SIMDE_CONVERT_VECTOR_(r_.u32, v);
    #else
      SIMDE_ALIGN_TO_16 uint16_t v[4];
      simde_memcpy(v, mem, sizeof(v));

      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        r_.u32[i] = HEDLEY_STATIC_CAST(uint32_t, v[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_load16x4(mem) simde_wasm_u32x4_load16x4((mem))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u64x2_load32x2 (const void * mem) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u64x2_load32x2(mem);
  #else
    simde_v128_private r_;

    #if defined(SIMDE_CONVERT_VECTOR_) && !defined(SIMDE_BUG_GCC_100762)
      uint32_t v SIMDE_VECTOR(8);
      simde_memcpy(&v, mem, sizeof(v));
      SIMDE_CONVERT_VECTOR_(r_.u64, v);
    #else
      SIMDE_ALIGN_TO_16 uint32_t v[2];
      simde_memcpy(v, mem, sizeof(v));

      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u64) / sizeof(r_.u64[0])) ; i++) {
        r_.u64[i] = HEDLEY_STATIC_CAST(uint64_t, v[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u64x2_load32x2(mem) simde_wasm_u64x2_load32x2((mem))
#endif

/* load*_zero */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load32_zero (const void * a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_load32_zero(a);
  #else
    simde_v128_private r_;

    int32_t a_;
    simde_memcpy(&a_, a, sizeof(a_));

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_cvtsi32_si128(a_);
    #else
      r_.i32[0] = a_;
      r_.i32[1] = 0;
      r_.i32[2] = 0;
      r_.i32[3] = 0;
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load32_zero(a) simde_wasm_v128_load32_zero((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load64_zero (const void * a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_v128_load64_zero(a);
  #else
    simde_v128_private r_;

    int64_t a_;
    simde_memcpy(&a_, a, sizeof(a_));

    #if defined(SIMDE_X86_SSE2_NATIVE) && defined(SIMDE_ARCH_AMD64)
      r_.sse_m128i = _mm_cvtsi64_si128(a_);
    #else
      r_.i64[0] = a_;
      r_.i64[1] = 0;
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load64_zero(a) simde_wasm_v128_load64_zero((a))
#endif

/* load*_lane */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load8_lane (const void * a, simde_v128_t vec, const int lane)
    SIMDE_REQUIRE_CONSTANT_RANGE(lane, 0, 15) {
  simde_v128_private
    a_ = simde_v128_to_private(vec);

  #if defined(SIMDE_BUG_CLANG_50901)
    simde_v128_private r_ = simde_v128_to_private(vec);
    r_.altivec_i8 = vec_insert(*HEDLEY_REINTERPRET_CAST(const signed char *, a), a_.altivec_i8, lane);
    return simde_v128_from_private(r_);
  #else
    a_.i8[lane] = *HEDLEY_REINTERPRET_CAST(const int8_t *, a);
    return simde_v128_from_private(a_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_v128_load8_lane(a, vec, lane) wasm_v128_load8_lane(HEDLEY_CONST_CAST(int8_t *, (a)), (vec), (lane))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load8_lane(a, vec, lane) simde_wasm_v128_load8_lane((a), (vec), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load16_lane (const void * a, simde_v128_t vec, const int lane)
    SIMDE_REQUIRE_CONSTANT_RANGE(lane, 0, 7) {
  simde_v128_private
    a_ = simde_v128_to_private(vec);

  int16_t tmp = 0;
  simde_memcpy(&tmp, a, sizeof(int16_t));
  a_.i16[lane] = tmp;

  return simde_v128_from_private(a_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_v128_load16_lane(a, vec, lane) wasm_v128_load16_lane(HEDLEY_CONST_CAST(int16_t *, (a)), (vec), (lane))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load16_lane(a, vec, lane) simde_wasm_v128_load16_lane((a), (vec), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load32_lane (const void * a, simde_v128_t vec, const int lane)
    SIMDE_REQUIRE_CONSTANT_RANGE(lane, 0, 3) {
  simde_v128_private
    a_ = simde_v128_to_private(vec);

  int32_t tmp = 0;
  simde_memcpy(&tmp, a, sizeof(int32_t));
  a_.i32[lane] = tmp;

  return simde_v128_from_private(a_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_v128_load32_lane(a, vec, lane) wasm_v128_load32_lane(HEDLEY_CONST_CAST(int32_t *, (a)), (vec), (lane))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load32_lane(a, vec, lane) simde_wasm_v128_load32_lane((a), (vec), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_v128_load64_lane (const void * a, simde_v128_t vec, const int lane)
    SIMDE_REQUIRE_CONSTANT_RANGE(lane, 0, 1) {
  simde_v128_private
    a_ = simde_v128_to_private(vec);

  int64_t tmp = 0;
  simde_memcpy(&tmp, a, sizeof(int64_t));
  a_.i64[lane] = tmp;

  return simde_v128_from_private(a_);
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_v128_load64_lane(a, vec, lane) wasm_v128_load64_lane(HEDLEY_CONST_CAST(int64_t *, (a)), (vec), (lane))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_load64_lane(a, vec, lane) simde_wasm_v128_load64_lane((a), (vec), (lane))
#endif

/* store*_lane */

SIMDE_FUNCTION_ATTRIBUTES
void
simde_wasm_v128_store8_lane (void * a, simde_v128_t vec, const int lane)
    SIMDE_REQUIRE_CONSTANT_RANGE(lane, 0, 15) {
  simde_v128_private
    vec_ = simde_v128_to_private(vec);

  int8_t tmp = vec_.i8[lane];
  simde_memcpy(a, &tmp, sizeof(tmp));
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_v128_store8_lane(a, vec, lane) wasm_v128_store8_lane((a), (vec), (lane))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_store8_lane(a, vec, lane) simde_wasm_v128_store8_lane((a), (vec), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
void
simde_wasm_v128_store16_lane (void * a, simde_v128_t vec, const int lane)
    SIMDE_REQUIRE_CONSTANT_RANGE(lane, 0, 7) {
  simde_v128_private
    vec_ = simde_v128_to_private(vec);

  int16_t tmp = vec_.i16[lane];
  simde_memcpy(a, &tmp, sizeof(tmp));
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_v128_store16_lane(a, vec, lane) wasm_v128_store16_lane((a), (vec), (lane))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_store16_lane(a, vec, lane) simde_wasm_v128_store16_lane((a), (vec), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
void
simde_wasm_v128_store32_lane (void * a, simde_v128_t vec, const int lane)
    SIMDE_REQUIRE_CONSTANT_RANGE(lane, 0, 3) {
  simde_v128_private
    vec_ = simde_v128_to_private(vec);

  int32_t tmp = vec_.i32[lane];
  simde_memcpy(a, &tmp, sizeof(tmp));
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_v128_store32_lane(a, vec, lane) wasm_v128_store32_lane((a), (vec), (lane))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_store32_lane(a, vec, lane) simde_wasm_v128_store32_lane((a), (vec), (lane))
#endif

SIMDE_FUNCTION_ATTRIBUTES
void
simde_wasm_v128_store64_lane (void * a, simde_v128_t vec, const int lane)
    SIMDE_REQUIRE_CONSTANT_RANGE(lane, 0, 1) {
  simde_v128_private
    vec_ = simde_v128_to_private(vec);

  int64_t tmp = vec_.i64[lane];
  simde_memcpy(a, &tmp, sizeof(tmp));
}
#if defined(SIMDE_WASM_SIMD128_NATIVE)
  #define simde_wasm_v128_store64_lane(a, vec, lane) wasm_v128_store64_lane((a), (vec), (lane))
#endif
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_v128_store64_lane(a, vec, lane) simde_wasm_v128_store64_lane((a), (vec), (lane))
#endif

/* convert */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_convert_i32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_convert_i32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128 = _mm_cvtepi32_ps(a_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A32V7)
      r_.neon_f32 = vcvtq_f32_s32(a_.neon_i32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      HEDLEY_DIAGNOSTIC_PUSH
      #if HEDLEY_HAS_WARNING("-Wc11-extensions")
        #pragma clang diagnostic ignored "-Wc11-extensions"
      #endif
      r_.altivec_f32 = vec_ctf(a_.altivec_i32, 0);
      HEDLEY_DIAGNOSTIC_POP
    #elif defined(SIMDE_CONVERT_VECTOR_)
      SIMDE_CONVERT_VECTOR_(r_.f32, a_.i32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = HEDLEY_STATIC_CAST(simde_float32, a_.i32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_convert_i32x4(a) simde_wasm_f32x4_convert_i32x4((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_convert_u32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_convert_u32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_CONVERT_VECTOR_)
      SIMDE_CONVERT_VECTOR_(r_.f32, a_.u32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = HEDLEY_STATIC_CAST(simde_float32, a_.u32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_convert_u32x4(a) simde_wasm_f32x4_convert_u32x4((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_convert_low_i32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_convert_low_i32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if HEDLEY_HAS_BUILTIN(__builtin_shufflevector) && HEDLEY_HAS_BUILTIN(__builtin_convertvector)
      r_.f64 = __builtin_convertvector(__builtin_shufflevector(a_.i32, a_.i32, 0, 1), __typeof__(r_.f64));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = HEDLEY_STATIC_CAST(simde_float64, a_.i32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_convert_low_i32x4(a) simde_wasm_f64x2_convert_low_i32x4((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_convert_low_u32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_convert_low_u32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if HEDLEY_HAS_BUILTIN(__builtin_shufflevector) && HEDLEY_HAS_BUILTIN(__builtin_convertvector)
      r_.f64 = __builtin_convertvector(__builtin_shufflevector(a_.u32, a_.u32, 0, 1), __typeof__(r_.f64));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = HEDLEY_STATIC_CAST(simde_float64, a_.u32[i]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_convert_low_u32x4(a) simde_wasm_f64x2_convert_low_u32x4((a))
#endif

/* trunc_sat */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_trunc_sat_f32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_trunc_sat_f32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i32 = vcvtq_s32_f32(a_.neon_f32);
    #elif defined(SIMDE_CONVERT_VECTOR_) && defined(SIMDE_FAST_CONVERSION_RANGE)
      SIMDE_CONVERT_VECTOR_(r_.i32, a_.f32);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      const __m128i i32_max_mask = _mm_castps_si128(_mm_cmpgt_ps(a_.sse_m128, _mm_set1_ps(SIMDE_FLOAT32_C(2147483520.0))));
      const __m128 clamped = _mm_max_ps(a_.sse_m128, _mm_set1_ps(HEDLEY_STATIC_CAST(simde_float32, INT32_MIN)));
      r_.sse_m128i = _mm_cvttps_epi32(clamped);
      #if defined(SIMDE_X86_SSE4_1_NATIVE)
        r_.sse_m128i =
          _mm_castps_si128(
            _mm_blendv_ps(
              _mm_castsi128_ps(r_.sse_m128i),
              _mm_castsi128_ps(_mm_set1_epi32(INT32_MAX)),
              _mm_castsi128_ps(i32_max_mask)
            )
          );
      #else
        r_.sse_m128i =
          _mm_or_si128(
            _mm_and_si128(i32_max_mask, _mm_set1_epi32(INT32_MAX)),
            _mm_andnot_si128(i32_max_mask, r_.sse_m128i)
          );
      #endif
      r_.sse_m128i = _mm_and_si128(r_.sse_m128i, _mm_castps_si128(_mm_cmpord_ps(a_.sse_m128, a_.sse_m128)));
    #elif defined(SIMDE_CONVERT_VECTOR_) && defined(SIMDE_IEEE754_STORAGE) && !defined(SIMDE_ARCH_POWER)
      SIMDE_CONVERT_VECTOR_(r_.i32, a_.f32);

      const __typeof__(a_.f32) max_representable = { SIMDE_FLOAT32_C(2147483520.0), SIMDE_FLOAT32_C(2147483520.0), SIMDE_FLOAT32_C(2147483520.0), SIMDE_FLOAT32_C(2147483520.0) };
      __typeof__(r_.i32) max_mask = HEDLEY_REINTERPRET_CAST(__typeof__(max_mask), a_.f32 > max_representable);
      __typeof__(r_.i32) max_i32 = { INT32_MAX, INT32_MAX, INT32_MAX, INT32_MAX };
      r_.i32  = (max_i32 & max_mask) | (r_.i32 & ~max_mask);

      const __typeof__(a_.f32) min_representable = { HEDLEY_STATIC_CAST(simde_float32, INT32_MIN), HEDLEY_STATIC_CAST(simde_float32, INT32_MIN), HEDLEY_STATIC_CAST(simde_float32, INT32_MIN), HEDLEY_STATIC_CAST(simde_float32, INT32_MIN) };
      __typeof__(r_.i32) min_mask = HEDLEY_REINTERPRET_CAST(__typeof__(min_mask), a_.f32 < min_representable);
      __typeof__(r_.i32) min_i32 = { INT32_MIN, INT32_MIN, INT32_MIN, INT32_MIN };
      r_.i32  = (min_i32 & min_mask) | (r_.i32 & ~min_mask);

      r_.i32 &= HEDLEY_REINTERPRET_CAST(__typeof__(r_.i32), a_.f32 == a_.f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.i32) / sizeof(r_.i32[0])) ; i++) {
        if (simde_math_isnanf(a_.f32[i])) {
          r_.i32[i] = INT32_C(0);
        } else if (a_.f32[i] < HEDLEY_STATIC_CAST(simde_float32, INT32_MIN)) {
          r_.i32[i] = INT32_MIN;
        } else if (a_.f32[i] > HEDLEY_STATIC_CAST(simde_float32, INT32_MAX)) {
          r_.i32[i] = INT32_MAX;
        } else {
          r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.f32[i]);
        }
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_trunc_sat_f32x4(a) simde_wasm_i32x4_trunc_sat_f32x4((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_trunc_sat_f32x4 (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_trunc_sat_f32x4(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_u32 = vcvtq_u32_f32(a_.neon_f32);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      #if defined(SIMDE_X86_AVX512VL_NATIVE)
        r_.sse_m128i = _mm_cvttps_epu32(a_.sse_m128);
      #else
        __m128 first_oob_high = _mm_set1_ps(SIMDE_FLOAT32_C(4294967296.0));
        __m128 neg_zero_if_too_high =
          _mm_castsi128_ps(
            _mm_slli_epi32(
              _mm_castps_si128(_mm_cmple_ps(first_oob_high, a_.sse_m128)),
              31
            )
          );
        r_.sse_m128i =
          _mm_xor_si128(
            _mm_cvttps_epi32(
              _mm_sub_ps(a_.sse_m128, _mm_and_ps(neg_zero_if_too_high, first_oob_high))
            ),
            _mm_castps_si128(neg_zero_if_too_high)
          );
      #endif

      #if !defined(SIMDE_FAST_CONVERSION_RANGE)
        r_.sse_m128i = _mm_and_si128(r_.sse_m128i, _mm_castps_si128(_mm_cmpgt_ps(a_.sse_m128, _mm_set1_ps(SIMDE_FLOAT32_C(0.0)))));
        r_.sse_m128i = _mm_or_si128 (r_.sse_m128i, _mm_castps_si128(_mm_cmpge_ps(a_.sse_m128, _mm_set1_ps(SIMDE_FLOAT32_C(4294967296.0)))));
      #endif

      #if !defined(SIMDE_FAST_NANS)
        r_.sse_m128i = _mm_and_si128(r_.sse_m128i, _mm_castps_si128(_mm_cmpord_ps(a_.sse_m128, a_.sse_m128)));
      #endif
    #elif defined(SIMDE_CONVERT_VECTOR_) && defined(SIMDE_IEEE754_STORAGE)
      SIMDE_CONVERT_VECTOR_(r_.u32, a_.f32);

      const __typeof__(a_.f32) max_representable = { SIMDE_FLOAT32_C(4294967040.0), SIMDE_FLOAT32_C(4294967040.0), SIMDE_FLOAT32_C(4294967040.0), SIMDE_FLOAT32_C(4294967040.0) };
      r_.u32 |= HEDLEY_REINTERPRET_CAST(__typeof__(r_.u32), a_.f32 > max_representable);

      const __typeof__(a_.f32) min_representable = { SIMDE_FLOAT32_C(0.0), };
      r_.u32 &= HEDLEY_REINTERPRET_CAST(__typeof__(r_.u32), a_.f32 > min_representable);

      r_.u32 &= HEDLEY_REINTERPRET_CAST(__typeof__(r_.u32), a_.f32 == a_.f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u32) / sizeof(r_.u32[0])) ; i++) {
        if (simde_math_isnan(a_.f32[i]) ||
            a_.f32[i] < SIMDE_FLOAT32_C(0.0)) {
          r_.u32[i] = UINT32_C(0);
        } else if (a_.f32[i] > HEDLEY_STATIC_CAST(simde_float32, UINT32_MAX)) {
          r_.u32[i] = UINT32_MAX;
        } else {
          r_.u32[i] = HEDLEY_STATIC_CAST(uint32_t, a_.f32[i]);
        }
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_trunc_sat_f32x4(a) simde_wasm_u32x4_trunc_sat_f32x4((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_trunc_sat_f64x2_zero (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_trunc_sat_f64x2_zero(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_i32 = vcombine_s32(vqmovn_s64(vcvtq_s64_f64(a_.neon_f64)), vdup_n_s32(INT32_C(0)));
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      SIMDE_POWER_ALTIVEC_VECTOR(double) in_not_nan =
        vec_and(a_.altivec_f64, vec_cmpeq(a_.altivec_f64, a_.altivec_f64));
      r_.altivec_i32 = vec_signede(in_not_nan);
      #if defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
        r_.altivec_i32 =
          vec_pack(
            HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(long long), r_.altivec_i32),
            HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(long long), vec_splat_s32(0))
          );
      #else
        SIMDE_POWER_ALTIVEC_VECTOR(unsigned char) perm = {
           0,  1,  2,  3,  4,  5,  6,  7,
          16, 17, 18, 19, 20, 21, 22, 23
        };
        r_.altivec_i32 =
          HEDLEY_REINTERPRET_CAST(
            SIMDE_POWER_ALTIVEC_VECTOR(signed int),
            vec_perm(
              HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed char), r_.altivec_i32),
              vec_splat_s8(0),
              perm
            )
          );
      #endif
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(a_.f64) / sizeof(a_.f64[0])) ; i++) {
        if (simde_math_isnan(a_.f64[i])) {
          r_.i32[i] = INT32_C(0);
        } else if (a_.f64[i] < HEDLEY_STATIC_CAST(simde_float64, INT32_MIN)) {
          r_.i32[i] = INT32_MIN;
        } else if (a_.f64[i] > HEDLEY_STATIC_CAST(simde_float64, INT32_MAX)) {
          r_.i32[i] = INT32_MAX;
        } else {
          r_.i32[i] = HEDLEY_STATIC_CAST(int32_t, a_.f64[i]);
        }
      }
      r_.i32[2] = 0;
      r_.i32[3] = 0;
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_trunc_sat_f64x2_zero(a) simde_wasm_i32x4_trunc_sat_f64x2_zero((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_u32x4_trunc_sat_f64x2_zero (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_u32x4_trunc_sat_f64x2_zero(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_u32 = vcombine_u32(vqmovn_u64(vcvtq_u64_f64(a_.neon_f64)), vdup_n_u32(UINT32_C(0)));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(a_.f64) / sizeof(a_.f64[0])) ; i++) {
        if (simde_math_isnanf(a_.f64[i]) ||
            a_.f64[i] < SIMDE_FLOAT64_C(0.0)) {
          r_.u32[i] = UINT32_C(0);
        } else if (a_.f64[i] > HEDLEY_STATIC_CAST(simde_float64, UINT32_MAX)) {
          r_.u32[i] = UINT32_MAX;
        } else {
          r_.u32[i] = HEDLEY_STATIC_CAST(uint32_t, a_.f64[i]);
        }
      }
      r_.u32[2] = 0;
      r_.u32[3] = 0;
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_u32x4_trunc_sat_f64x2_zero(a) simde_wasm_u32x4_trunc_sat_f64x2_zero((a))
#endif

/* popcnt */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i8x16_popcnt (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i8x16_popcnt(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      r_.neon_i8 = vcntq_s8(a_.neon_i8);
    #elif defined(SIMDE_X86_AVX512VL_NATIVE) && defined(SIMDE_X86_AVX512BITALG_NATIVE)
      r_.sse_m128i = _mm_popcnt_epi8(a_.sse_m128i);
    #elif defined(SIMDE_X86_AVX2_NATIVE)
      __m128i tmp0 = _mm_set1_epi8(0x0f);
      __m128i tmp1 = _mm_andnot_si128(tmp0, a_.sse_m128i);
      __m128i y = _mm_and_si128(tmp0, a_.sse_m128i);
      tmp0 = _mm_set_epi8(4, 3, 3, 2, 3, 2, 2, 1, 3, 2, 2, 1, 2, 1, 1, 0);
      tmp1 = _mm_srli_epi16(tmp1, 4);
      y = _mm_shuffle_epi8(tmp0, y);
      tmp1 = _mm_shuffle_epi8(tmp0, tmp1);
      return _mm_add_epi8(y, tmp1);
    #elif defined(SIMDE_X86_SSSE3_NATIVE)
      __m128i tmp0 = _mm_set1_epi8(0x0f);
      __m128i tmp1 = _mm_and_si128(a_.sse_m128i, tmp0);
      tmp0 = _mm_andnot_si128(tmp0, a_.sse_m128i);
      __m128i y = _mm_set_epi8(4, 3, 3, 2, 3, 2, 2, 1, 3, 2, 2, 1, 2, 1, 1, 0);
      tmp0 = _mm_srli_epi16(tmp0, 4);
      y = _mm_shuffle_epi8(y, tmp1);
      tmp1 = _mm_set_epi8(4, 3, 3, 2, 3, 2, 2, 1, 3, 2, 2, 1, 2, 1, 1, 0);
      tmp1 = _mm_shuffle_epi8(tmp1, tmp0);
      return _mm_add_epi8(y, tmp1);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      __m128i tmp0 = _mm_and_si128(_mm_srli_epi16(a_.sse_m128i, 1), _mm_set1_epi8(0x55));
      __m128i tmp1 = _mm_sub_epi8(a_.sse_m128i, tmp0);
      tmp0 = tmp1;
      tmp1 = _mm_and_si128(tmp1, _mm_set1_epi8(0x33));
      tmp0 = _mm_and_si128(_mm_srli_epi16(tmp0, 2), _mm_set1_epi8(0x33));
      tmp1 = _mm_add_epi8(tmp1, tmp0);
      tmp0 = _mm_srli_epi16(tmp1, 4);
      tmp1 = _mm_add_epi8(tmp1, tmp0);
      r_.sse_m128i = _mm_and_si128(tmp1, _mm_set1_epi8(0x0f));
    #elif defined(SIMDE_POWER_ALTIVEC_P8_NATIVE)
      r_.altivec_i8 = HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(signed char), vec_popcnt(HEDLEY_REINTERPRET_CAST(SIMDE_POWER_ALTIVEC_VECTOR(unsigned char), a_.altivec_i8)));
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.u8) / sizeof(r_.u8[0])) ; i++) {
        uint8_t v = HEDLEY_STATIC_CAST(uint8_t, a_.u8[i]);
        v = v - ((v >> 1) & (85));
        v = (v & (51)) + ((v >> (2)) & (51));
        v = (v + (v >> (4))) & (15);
        r_.u8[i] = v >> (sizeof(uint8_t) - 1) * CHAR_BIT;
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i8x16_popcnt(a) simde_wasm_i8x16_popcnt((a))
#endif

/* dot */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_i32x4_dot_i16x8 (simde_v128_t a, simde_v128_t b) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_i32x4_dot_i16x8(a, b);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      b_ = simde_v128_to_private(b),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128i = _mm_madd_epi16(a_.sse_m128i, b_.sse_m128i);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      int32x4_t pl = vmull_s16(vget_low_s16(a_.neon_i16),  vget_low_s16(b_.neon_i16));
      int32x4_t ph = vmull_high_s16(a_.neon_i16, b_.neon_i16);
      r_.neon_i32 = vpaddq_s32(pl, ph);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      int32x4_t pl = vmull_s16(vget_low_s16(a_.neon_i16),  vget_low_s16(b_.neon_i16));
      int32x4_t ph = vmull_s16(vget_high_s16(a_.neon_i16), vget_high_s16(b_.neon_i16));
      int32x2_t rl = vpadd_s32(vget_low_s32(pl), vget_high_s32(pl));
      int32x2_t rh = vpadd_s32(vget_low_s32(ph), vget_high_s32(ph));
      r_.neon_i32 = vcombine_s32(rl, rh);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_i32 = vec_msum(a_.altivec_i16, b_.altivec_i16, vec_splats(0));
    #elif defined(SIMDE_ZARCH_ZVECTOR_13_NATIVE)
      r_.altivec_i32 = vec_mule(a_.altivec_i16, b_.altivec_i16) + vec_mulo(a_.altivec_i16, b_.altivec_i16);
    #elif defined(SIMDE_VECTOR_SUBSCRIPT_OPS) && defined(SIMDE_CONVERT_VECTOR_) && HEDLEY_HAS_BUILTIN(__builtin_shufflevector)
      int32_t SIMDE_VECTOR(32) a32, b32, p32;
      SIMDE_CONVERT_VECTOR_(a32, a_.i16);
      SIMDE_CONVERT_VECTOR_(b32, b_.i16);
      p32 = a32 * b32;
      r_.i32 =
        __builtin_shufflevector(p32, p32, 0, 2, 4, 6) +
        __builtin_shufflevector(p32, p32, 1, 3, 5, 7);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_) / sizeof(r_.i16[0])) ; i += 2) {
        r_.i32[i / 2] = (a_.i16[i] * b_.i16[i]) + (a_.i16[i + 1] * b_.i16[i + 1]);
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_i32x4_dot_i16x8(a, b) simde_wasm_i32x4_dot_i16x8((a), (b))
#endif

/* ceil */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_ceil (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_ceil(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128 = _mm_round_ps(a_.sse_m128, _MM_FROUND_TO_POS_INF | _MM_FROUND_NO_EXC);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      /* https://github.com/WebAssembly/simd/pull/232 */
      const __m128i input_as_i32 = _mm_cvttps_epi32(a_.sse_m128);
      const __m128i i32_min = _mm_set1_epi32(INT32_MIN);
      const __m128i input_is_out_of_range = _mm_or_si128(_mm_cmpeq_epi32(input_as_i32, i32_min), i32_min);
      const __m128 truncated =
        _mm_or_ps(
          _mm_andnot_ps(
            _mm_castsi128_ps(input_is_out_of_range),
            _mm_cvtepi32_ps(input_as_i32)
          ),
          _mm_castsi128_ps(
            _mm_castps_si128(
              _mm_and_ps(
                _mm_castsi128_ps(input_is_out_of_range),
                a_.sse_m128
              )
            )
          )
        );

      const __m128 trunc_is_ge_input =
        _mm_or_ps(
          _mm_cmple_ps(a_.sse_m128, truncated),
          _mm_castsi128_ps(i32_min)
        );
      r_.sse_m128 =
        _mm_or_ps(
          _mm_andnot_ps(
            trunc_is_ge_input,
            _mm_add_ps(truncated, _mm_set1_ps(SIMDE_FLOAT32_C(1.0)))
          ),
          _mm_and_ps(trunc_is_ge_input, truncated)
        );
    #elif defined(SIMDE_ARM_NEON_A32V8_NATIVE)
      r_.neon_f32 = vrndpq_f32(a_.neon_f32);
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE)
      r_.altivec_f32 = vec_ceil(a_.altivec_f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = simde_math_quietf(simde_math_ceilf(a_.f32[i]));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_ceil(a) simde_wasm_f32x4_ceil((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_ceil (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_ceil(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128d = _mm_round_pd(a_.sse_m128d, _MM_FROUND_TO_POS_INF | _MM_FROUND_NO_EXC);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f64 = vrndpq_f64(a_.neon_f64);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f64 = vec_ceil(a_.altivec_f64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = simde_math_quiet(simde_math_ceil(a_.f64[i]));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_ceil(a) simde_wasm_f64x2_ceil((a))
#endif

/* floor */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_floor (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_floor(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE4_1_NATIVE)
      r_.sse_m128 = _mm_floor_ps(a_.sse_m128);
    #elif defined(SIMDE_X86_SSE2_NATIVE)
      const __m128i vint_min = _mm_set1_epi32(INT_MIN);
      const __m128i input_as_int = _mm_cvttps_epi32(a_.sse_m128);
      const __m128 input_truncated = _mm_cvtepi32_ps(input_as_int);
      const __m128i oor_all_or_neg = _mm_or_si128(_mm_cmpeq_epi32(input_as_int, vint_min), vint_min);
      const __m128 tmp =
        _mm_castsi128_ps(
          _mm_or_si128(
            _mm_andnot_si128(
              oor_all_or_neg,
              _mm_castps_si128(input_truncated)
            ),
            _mm_and_si128(
              oor_all_or_neg,
              _mm_castps_si128(a_.sse_m128)
            )
          )
        );
      r_.sse_m128 =
        _mm_sub_ps(
          tmp,
          _mm_and_ps(
            _mm_cmplt_ps(
              a_.sse_m128,
              tmp
            ),
            _mm_set1_ps(SIMDE_FLOAT32_C(1.0))
          )
        );
    #elif defined(SIMDE_ARM_NEON_A32V8_NATIVE)
      r_.neon_f32 = vrndmq_f32(a_.neon_f32);
    #elif defined(SIMDE_ARM_NEON_A32V7_NATIVE)
      const int32x4_t input_as_int = vcvtq_s32_f32(a_.f32);
      const float32x4_t input_truncated = vcvtq_f32_s32(input_as_int);
      const float32x4_t tmp =
        vbslq_f32(
          vbicq_u32(
            vcagtq_f32(
              vreinterpretq_f32_u32(vdupq_n_u32(UINT32_C(0x4B000000))),
              a_.f32
            ),
            vdupq_n_u32(UINT32_C(0x80000000))
          ),
          input_truncated,
          a_.f32);
      r_.neon_f32 =
        vsubq_f32(
          tmp,
          vreinterpretq_f32_u32(
            vandq_u32(
              vcgtq_f32(
                tmp,
                a_.f32
              ),
              vdupq_n_u32(UINT32_C(0x3F800000))
            )
          )
        );
    #elif defined(SIMDE_POWER_ALTIVEC_P6_NATIVE) || defined(SIMDE_ZARCH_ZVECTOR_14_NATIVE)
      r_.altivec_f32 = vec_floor(a_.altivec_f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = simde_math_quietf(simde_math_floorf(a_.f32[i]));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_floor(a) simde_wasm_f32x4_floor((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_floor (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_floor(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    SIMDE_VECTORIZE
    for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
      r_.f64[i] = simde_math_quiet(simde_math_floor(a_.f64[i]));
    }

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_floor(a) simde_wasm_f64x2_floor((a))
#endif

/* trunc */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_trunc (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_trunc(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    SIMDE_VECTORIZE
    for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
      r_.f32[i] = simde_math_quietf(simde_math_truncf(a_.f32[i]));
    }

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_trunc(a) simde_wasm_f32x4_trunc((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_trunc (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_trunc(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    SIMDE_VECTORIZE
    for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
      r_.f64[i] = simde_math_quiet(simde_math_trunc(a_.f64[i]));
    }

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_trunc(a) simde_wasm_f64x2_trunc((a))
#endif

/* nearest */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_nearest (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_nearest(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    SIMDE_VECTORIZE
    for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
      r_.f32[i] = simde_math_quietf(simde_math_nearbyintf(a_.f32[i]));
    }

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_nearest(a) simde_wasm_f32x4_nearest((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_nearest (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_nearest(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    SIMDE_VECTORIZE
    for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
      r_.f64[i] = simde_math_quiet(simde_math_nearbyint(a_.f64[i]));
    }

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_nearest(a) simde_wasm_f64x2_nearest((a))
#endif

/* sqrt */

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f32x4_sqrt (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f32x4_sqrt(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE_NATIVE)
      r_.sse_m128 = _mm_sqrt_ps(a_.sse_m128);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f32 = vsqrtq_f32(a_.neon_f32);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f32 = vec_sqrt(a_.altivec_f32);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f32) / sizeof(r_.f32[0])) ; i++) {
        r_.f32[i] = simde_math_quietf(simde_math_sqrtf(a_.f32[i]));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f32x4_sqrt(a) simde_wasm_f32x4_sqrt((a))
#endif

SIMDE_FUNCTION_ATTRIBUTES
simde_v128_t
simde_wasm_f64x2_sqrt (simde_v128_t a) {
  #if defined(SIMDE_WASM_SIMD128_NATIVE)
    return wasm_f64x2_sqrt(a);
  #else
    simde_v128_private
      a_ = simde_v128_to_private(a),
      r_;

    #if defined(SIMDE_X86_SSE2_NATIVE)
      r_.sse_m128d = _mm_sqrt_pd(a_.sse_m128d);
    #elif defined(SIMDE_ARM_NEON_A64V8_NATIVE)
      r_.neon_f64 = vsqrtq_f64(a_.neon_f64);
    #elif defined(SIMDE_POWER_ALTIVEC_P7_NATIVE)
      r_.altivec_f64 = vec_sqrt(a_.altivec_f64);
    #else
      SIMDE_VECTORIZE
      for (size_t i = 0 ; i < (sizeof(r_.f64) / sizeof(r_.f64[0])) ; i++) {
        r_.f64[i] = simde_math_quiet(simde_math_sqrt(a_.f64[i]));
      }
    #endif

    return simde_v128_from_private(r_);
  #endif
}
#if defined(SIMDE_WASM_SIMD128_ENABLE_NATIVE_ALIASES)
  #define wasm_f64x2_sqrt(a) simde_wasm_f64x2_sqrt((a))
#endif

SIMDE_END_DECLS_

HEDLEY_DIAGNOSTIC_POP

#endif /* !defined(SIMDE_WASM_SIMD128_H) */
/* :: End simde/wasm/simd128.h :: */
