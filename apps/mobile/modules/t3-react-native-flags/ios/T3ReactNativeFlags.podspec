Pod::Spec.new do |s|
  s.name           = 'T3ReactNativeFlags'
  s.version        = '1.0.0'
  s.summary        = 'React Native feature flag overrides for T3 Code mobile.'
  s.description    = 'Enables React Native feature flags that the prebuilt core leaves off.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,mm,swift}'

  install_modules_dependencies(s)
end
