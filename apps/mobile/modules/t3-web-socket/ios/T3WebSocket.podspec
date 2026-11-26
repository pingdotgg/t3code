Pod::Spec.new do |s|
  s.name = 'T3WebSocket'
  s.version = '1.0.0'
  s.summary = 'WebSocket client with permessage-deflate for Hyakki mobile.'
  s.description = 'React Native ships SocketRocket on iOS, which never negotiates compression. This module dials the Hyakki server through URLSessionWebSocketTask, which offers permessage-deflate on its own.'
  s.author = 'T3 Tools'
  s.homepage = 'https://github.com/Ryoku-dev/hyakki'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
