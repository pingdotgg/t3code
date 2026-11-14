!include "StrFunc.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
  !define T3StrRep '${UnStrRep}'
!else
  ${StrRep}
  !define T3StrRep '${StrRep}'
!endif

!macro customAppRunningMessages
  Push $0
  Push $1
  ${If} $IsPowerShellAvailable == 0
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", t "$INSTDIR")'
    nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and [IO.Path]::GetDirectoryName($$_.ExecutablePath) -eq $$env:T3CODE_INSTALL_DIR } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($$_.ExecutablePath) } | Where-Object { $$_ -in 'T3 Code (Alpha)', 'T3 Code (Beta)', 'T3 Code (Nightly)' } | Select-Object -First 1 | ForEach-Object { [Console]::Write($$_) }"`
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", p 0)'
    ${If} $0 == 0
      ${If} $1 == "T3 Code (Alpha)"
      ${OrIf} $1 == "T3 Code (Beta)"
      ${OrIf} $1 == "T3 Code (Nightly)"
        ${T3StrRep} $appRunningMessage $appRunningMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appClosingMessage $appClosingMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appCannotBeClosedMessage $appCannotBeClosedMessage "${PRODUCT_NAME}" $1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

; The install section removes the old app before extracting, and electron-builder ignores 7z
; extraction errors, so running out of space leaves an app that cannot start. Refuse up front.
!macro customInit
  !ifdef APP_64_UNPACKED_SIZE | APP_ARM64_UNPACKED_SIZE
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6

    !ifdef APP_ARM64_UNPACKED_SIZE
      StrCpy $R0 ${APP_ARM64_UNPACKED_SIZE}
    !endif
    !ifdef APP_64_UNPACKED_SIZE
      !ifdef APP_ARM64_UNPACKED_SIZE
        ${IfNot} ${IsNativeARM64}
          StrCpy $R0 ${APP_64_UNPACKED_SIZE}
        ${EndIf}
      !else
        StrCpy $R0 ${APP_64_UNPACKED_SIZE}
      !endif
    !endif
    System::Int64Op $R0 * 1024
    Pop $R0

    ; The embedded app package is written to $PLUGINSDIR in full before extraction.
    StrCpy $R1 0
    ClearErrors
    FileOpen $R2 "$EXEPATH" r
    ${IfNot} ${Errors}
      FileSeek $R2 0 END $R1
      FileClose $R2
    ${EndIf}

    ; The old install is deleted before extraction, so its space counts as free.
    StrCpy $R2 0
    ${If} ${FileExists} "$INSTDIR\*.*"
      ClearErrors
      ${GetSize} "$INSTDIR" "/S=0K" $R2 $R3 $R4
      ${If} ${Errors}
        StrCpy $R2 0
      ${EndIf}
      System::Int64Op $R2 * 1024
      Pop $R2
    ${EndIf}

    ; $PLUGINSDIR (under $TEMP) holds the package plus a full extraction; $INSTDIR holds the app.
    ${GetRoot} "$TEMP" $R3
    ${GetRoot} "$INSTDIR" $R4
    System::Int64Op $R1 + $R0
    Pop $R5
    ${If} $R3 == $R4
      System::Int64Op $R5 - $R2
      Pop $R5
    ${Else}
      System::Int64Op $R0 - $R2
      Pop $R6
      !insertmacro t3RequireFreeSpace $R4 $R6
    ${EndIf}
    !insertmacro t3RequireFreeSpace $R3 $R5

    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  !endif
!macroend

; Shows a dialog even with /S (no /SD) so a silent in-app update cannot fail unnoticed.
!macro t3RequireFreeSpace ROOT REQUIRED_BYTES
  Push $0
  Push $1
  StrCpy $0 "${ROOT}\"
  System::Call 'kernel32::GetDiskFreeSpaceEx(t r0, *l .r1, *l, *l) i .r0'
  ${If} $0 != 0
    System::Int64Op $1 < ${REQUIRED_BYTES}
    Pop $0
    ${If} $0 == 1
      System::Int64Op ${REQUIRED_BYTES} - $1
      Pop $0
      System::Int64Op $0 / 1048576
      Pop $0
      IntOp $0 $0 + 1
      MessageBox MB_OK|MB_ICONSTOP "There is not enough free disk space to install ${PRODUCT_NAME}.$\r$\n$\r$\nFree up at least $0 MB on ${ROOT}\ and try again. The installed version has not been changed."
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend
