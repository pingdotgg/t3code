Pod::Spec.new do |s|
  s.name           = 'T3WebSocket'
  s.version        = '1.0.0'
  s.summary        = 'URLSession-backed WebSocket for T3 Code mobile.'
  s.description    = 'WebSocket client backed by URLSessionWebSocketTask so iOS negotiates permessage-deflate, which SocketRocket (React Native default) cannot.'
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
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
