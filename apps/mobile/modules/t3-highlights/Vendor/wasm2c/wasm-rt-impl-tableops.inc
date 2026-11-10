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

// This file is used as a template to generate code for table operations for
// funcref or externref. For this, the file must be included after defining
// either WASM_RT_TABLE_OPS_FUNCREF or WASM_RT_TABLE_OPS_EXTERNREF

#if defined(WASM_RT_TABLE_OPS_FUNCREF) +       \
        defined(WASM_RT_TABLE_OPS_EXTERNREF) + \
        defined(WASM_RT_TABLE_OPS_EXNREF) >    \
    1
#error \
    "Expected only one of { WASM_RT_TABLE_OPS_FUNCREF, WASM_RT_TABLE_OPS_EXTERNREF, WASM_RT_TABLE_OPS_EXNREF } to be defined"
#elif defined(WASM_RT_TABLE_OPS_FUNCREF) +     \
        defined(WASM_RT_TABLE_OPS_EXTERNREF) + \
        defined(WASM_RT_TABLE_OPS_EXNREF) <    \
    1
#error \
    "Expected one of { WASM_RT_TABLE_OPS_FUNCREF, WASM_RT_TABLE_OPS_EXTERNREF, WASM_RT_TABLE_OPS_EXNREF } to be defined"
#endif

#if defined(WASM_RT_TABLE_OPS_FUNCREF)
#define WASM_RT_TABLE_TYPE wasm_rt_funcref_table_t
#define WASM_RT_TABLE_ELEMENT_TYPE wasm_rt_funcref_t
#define WASM_RT_TABLE_APINAME(name) name##_funcref_table
#elif defined(WASM_RT_TABLE_OPS_EXTERNREF)
#define WASM_RT_TABLE_TYPE wasm_rt_externref_table_t
#define WASM_RT_TABLE_ELEMENT_TYPE wasm_rt_externref_t
#define WASM_RT_TABLE_APINAME(name) name##_externref_table
#elif defined(WASM_RT_TABLE_OPS_EXNREF)
#define WASM_RT_TABLE_TYPE wasm_rt_exnref_table_t
#define WASM_RT_TABLE_ELEMENT_TYPE wasm_rt_exnref_t
#define WASM_RT_TABLE_APINAME(name) name##_exnref_table
#endif

void WASM_RT_TABLE_APINAME(wasm_rt_allocate)(WASM_RT_TABLE_TYPE* table,
                                             uint32_t elements,
                                             uint32_t max_elements) {
  table->size = elements;
  table->max_size = max_elements;
  table->data = calloc(table->size, sizeof(WASM_RT_TABLE_ELEMENT_TYPE));
}

void WASM_RT_TABLE_APINAME(wasm_rt_free)(WASM_RT_TABLE_TYPE* table) {
  free(table->data);
}

uint32_t WASM_RT_TABLE_APINAME(wasm_rt_grow)(WASM_RT_TABLE_TYPE* table,
                                             uint32_t delta,
                                             WASM_RT_TABLE_ELEMENT_TYPE init) {
  uint32_t old_elems = table->size;
  uint64_t new_elems = (uint64_t)table->size + delta;
  if (new_elems == 0) {
    return 0;
  }
  if ((new_elems < old_elems) || (new_elems > table->max_size)) {
    return (uint32_t)-1;
  }
  if (new_elems > SIZE_MAX / sizeof(WASM_RT_TABLE_ELEMENT_TYPE)) {
    return (uint32_t)-1;
  }
  void* new_data =
      realloc(table->data, new_elems * sizeof(WASM_RT_TABLE_ELEMENT_TYPE));
  if (!new_data) {
    return (uint32_t)-1;
  }
  table->data = new_data;
  table->size = new_elems;
  for (uint32_t i = old_elems; i < new_elems; i++) {
    table->data[i] = init;
  }
  return old_elems;
}

#undef WASM_RT_TABLE_APINAME
#undef WASM_RT_TABLE_ELEMENT_TYPE
#undef WASM_RT_TABLE_TYPE
