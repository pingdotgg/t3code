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

; electron-builder deletes the installed app before extracting and ignores extraction errors, so a
; full disk left an app that cannot start. Extract and verify beside $INSTDIR while the old version
; is still installed, then move the files in after it is removed (same volume, no new space).
!macro customStageAppPackage
  Var /GLOBAL packageArch
  Var /GLOBAL t3StagingDir
  Push $0
  Push $1
  Push $2
  Push $3

  StrCpy $t3StagingDir "$INSTDIR.update"
  SetOutPath "$PLUGINSDIR"
  RMDir /r "$t3StagingDir"
  CreateDirectory "$t3StagingDir"

  !ifdef COMPRESS
    SetCompress off
  !endif
  !insertmacro identify_package
  !insertmacro compute_files_for_current_arch
  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif
  SetOutPath "$t3StagingDir"
  Nsis7z::Extract "$PLUGINSDIR\app-$packageArch.${COMPRESSION_METHOD}"
  SetOutPath "$PLUGINSDIR"
  Delete "$PLUGINSDIR\app-$packageArch.${COMPRESSION_METHOD}"

  StrCpy $0 0
  ${If} $packageArch == "ARM64"
    !ifdef APP_ARM64_UNPACKED_SIZE
      StrCpy $0 ${APP_ARM64_UNPACKED_SIZE}
    !endif
  ${Else}
    !ifdef APP_64_UNPACKED_SIZE
      StrCpy $0 ${APP_64_UNPACKED_SIZE}
    !endif
  ${EndIf}
  ; The build rounds the unpacked size up to KiB; GetSize rounds the extracted size down.
  ClearErrors
  ${GetSize} "$t3StagingDir" "/S=0K" $1 $2 $3
  IntOp $1 $1 + 1
  ${If} ${Errors}
  ${OrIf} $1 < $0
    RMDir /r "$t3StagingDir"
    MessageBox MB_OK|MB_ICONSTOP "${PRODUCT_NAME} could not be installed because its files could not be extracted. Make sure there is enough free disk space and try again.$\r$\n$\r$\nThe installed version has not been changed."
    SetErrorLevel 2
    Quit
  ${EndIf}

  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customInstallStagedAppPackage
  Push $0
  Push $1
  CreateDirectory "$INSTDIR"
  t3NextStagedEntry:
    FindFirst $0 $1 "$t3StagingDir\*"
  t3SkipDotEntries:
    StrCmp $1 "." +2
    StrCmp $1 ".." 0 +3
      FindNext $0 $1
      Goto t3SkipDotEntries
    FindClose $0
    StrCmp $1 "" t3StagedEntriesMoved
    RMDir /r "$INSTDIR\$1"
    Delete "$INSTDIR\$1"
    ClearErrors
    Rename "$t3StagingDir\$1" "$INSTDIR\$1"
    IfErrors 0 t3NextStagedEntry
      MessageBox MB_OK|MB_ICONSTOP "${PRODUCT_NAME} could not finish installing because $1 could not be moved into $INSTDIR. Close any program using it and run the installer again."
      SetErrorLevel 2
      Quit
  t3StagedEntriesMoved:
  RMDir /r "$t3StagingDir"
  SetOutPath "$INSTDIR"
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
