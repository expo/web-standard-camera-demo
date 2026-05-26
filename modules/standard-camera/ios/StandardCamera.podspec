Pod::Spec.new do |s|
  s.name           = 'StandardCamera'
  s.version        = '0.1.0'
  s.summary        = 'W3C Media Capture and Streams subset for Expo (iOS)'
  s.description    = 'Implements a subset of navigator.mediaDevices.getUserMedia(), MediaStream, MediaStreamTrack, and HTMLMediaElement.srcObject on iOS via AVFoundation.'
  s.author         = { 'James Ide' => 'ide@expo.io' }
  s.homepage       = 'https://github.com/ide/standard-camera-app'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ide/standard-camera-app.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'ARKit', 'AVFoundation', 'CoreImage', 'CoreMedia', 'CoreVideo'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
