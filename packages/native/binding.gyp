{
  "targets": [
    {
      "target_name": "native",
      "sources": [
        "src/native/native.cpp"
      ],
      "conditions": [
        [ "OS==\"mac\"", {
          "sources": [
            "src/native/platforms/darwin.mm"
          ]
        }],
        [ "OS==\"linux\"", {
          "sources": [
            "src/native/platforms/linux.cpp"
          ]
        }],
        [ "OS==\"win\"", {
          "sources": [
            "src/native/platforms/win32.cpp"
          ]
        }]
      ],
      "defines": [
        "NODE_ADDON_API_CPP_EXCEPTIONS"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-fexceptions" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    }
  ]
}