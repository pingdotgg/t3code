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
  s.platforms = { :ios => min_ios_version_supported }
  s.source = { :path => '.' }
  s.source_files = 'cpp/**/*.{c,cpp,h,hpp,inc}', 'Vendor/**/*.{c,h,inc}'
  s.public_header_files = []
  # Debug builds compile at -O0 by default, which makes the lexers several times
  # slower. They are generated code, so optimize them in every configuration.
  s.compiler_flags = '-O2'
  s.pod_target_xcconfig = {
    # Under C11, wasm2c makes its stack depth counter thread-local, so every lexer
    # function entry calls _tlv_get_addr (2–9% of lexing time on an iPhone 12).
    # Callers already serialize the lexer (t3_highlights.h), so a plain global is safe.
    'GCC_C_LANGUAGE_STANDARD' => 'gnu99',
    # Plain malloc memory with explicit bounds checks: no guard-page signal
    # handlers competing with the app's crash reporting.
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) WASM_RT_USE_MMAP=0 WASM_RT_MEMCHECK_BOUNDS_CHECK=1 WASM_RT_SKIP_SIGNAL_RECOVERY=1',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/cpp" "${PODS_TARGET_SRCROOT}/Vendor" "${PODS_TARGET_SRCROOT}/Vendor/highlights" "${PODS_TARGET_SRCROOT}/Vendor/wasm2c"',
  }

  load 'nitrogen/generated/ios/T3HighlightsNative+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
