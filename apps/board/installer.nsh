; electron-builder copies the uninstaller out of the installer stub on Linux, without the CRC that
; NSIS appends itself, so the uninstaller must skip its CRC check. The installer keeps its own.
!macro customHeader
  !ifdef BUILD_UNINSTALLER
    CRCCheck off
  !endif
!macroend
