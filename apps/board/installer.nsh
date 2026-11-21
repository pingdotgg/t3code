; The Linux build copies the uninstaller out of the installer stub without the CRC that NSIS appends
; when it writes one itself, so the uninstaller's own integrity check always fails.
!macro customHeader
  CRCCheck off
!macroend
