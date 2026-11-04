require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'T3HighlightsNative'
  s.version = package['version']
  s.summary = 'Native @pierre/highlights syntax highlighter for T3 Code mobile.'
  s.description = 'Runs the @pierre/highlights lexers, compiled from WebAssembly to C with wasm2c.'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'T3 Tools' => 'hello@t3tools.com' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.swift', 'cpp/**/*.{c,h,inc}', 'Vendor/**/*.{c,h,inc}'
  # Swift sees only the wrapper; the generated and runtime headers stay private.
  s.public_header_files = 'cpp/t3_highlights.h'
  # Debug builds compile at -O0 by default, which makes the lexers several times
  # slower. They are generated code, so optimize them in every configuration.
  s.compiler_flags = '-O2'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Plain malloc memory with explicit bounds checks: no guard-page signal
    # handlers competing with the app's crash reporting.
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) WASM_RT_USE_MMAP=0 WASM_RT_MEMCHECK_BOUNDS_CHECK=1 WASM_RT_SKIP_SIGNAL_RECOVERY=1',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/Vendor" "${PODS_TARGET_SRCROOT}/Vendor/highlights" "${PODS_TARGET_SRCROOT}/Vendor/wasm2c"',
  }
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
