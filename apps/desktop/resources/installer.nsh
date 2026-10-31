; The stock check starts PowerShell three times per installer and uninstaller run, about 2s each
; under x86 emulation on ARM or Defender scanning on x64. A running exe can't be opened for
; writing, so if every exe in the install folder can be, nothing here needs stopping.
!include "LogicLib.nsh"
!include "getProcessInfo.nsh"
!include "FileFunc.nsh"
Var pid
Var appFileInUse

!ifdef BUILD_UNINSTALLER
  !define CHECK_APP_FILE un.checkAppFile
!else
  !define CHECK_APP_FILE checkAppFile
!endif

Function ${CHECK_APP_FILE}
  ClearErrors
  FileOpen $R0 "$R9" a
  ${If} ${Errors}
    StrCpy $appFileInUse 1
    Push "StopLocate"
  ${Else}
    FileClose $R0
    Push ""
  ${EndIf}
FunctionEnd

!macro customCheckAppRunning
  StrCpy $R1 0
  ${Do}
    StrCpy $appFileInUse 0
    ${Locate} "$INSTDIR" "/L=F /M=*.exe" "${CHECK_APP_FILE}"
    ${If} $appFileInUse == 0
    ${OrIfNot} ${isUpdated}
      ${ExitDo}
    ${EndIf}
    ; The app may still be quitting when the updater starts the installer.
    Sleep 300
    IntOp $R1 $R1 + 1
  ${LoopUntil} $R1 >= 10
  ${If} $appFileInUse != 0
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  ${EndIf}
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
