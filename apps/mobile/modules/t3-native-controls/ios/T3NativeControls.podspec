Pod::Spec.new do |s|
  s.name           = 'T3NativeControls'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for T3 Code mobile.'
  s.description    = 'UIKit-backed controls that match native iOS navigation chrome.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Realtime voice audio device: typed WebRTCModuleOptions injection and RTCAudioDevice.
  s.dependency 'react-native-webrtc', '155.0.1'
  s.dependency 'JitsiWebRTC', '~> 155.0.0'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.resource_bundles = { 'T3NativeControlIcons' => ['Resources/Icons/pull-request*.png', 'Resources/Icons/issue*.png'] }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
  # Host-only test harnesses. '**' alone does not recurse in CocoaPods' FNM_PATHNAME globs.
  s.exclude_files = 'Tests/**/*'
end
