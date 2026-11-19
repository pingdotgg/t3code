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

# T3's patched electron-updater adds --t3-direct-spawn only when the app starts this installer
# itself, and a one-click per-user installer never elevates itself, so then its token is the app's.
# Keep it when elevated (TokenElevation); the elevate.exe retry, manual runs and older apps relaunch
# through Explorer as before.
!ifdef ONE_CLICK
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !macro customStartApp
      Push $R0
      Push $R1
      Push $R2
      StrCpy $R2 0
      ${If} ${isUpdated}
        ${StdUtils.TestParameter} $R1 "t3-direct-spawn"
        ${If} $R1 == "true"
          System::Call 'advapi32::OpenProcessToken(p -1, i 0x0008, *p .R0) i .R1'
          ${If} $R1 <> 0
            System::Call 'advapi32::GetTokenInformation(p R0, i 20, *i .R2, i 4, *i 0) i .R1'
            ${If} $R1 = 0
              StrCpy $R2 0
            ${EndIf}
            System::Call 'kernel32::CloseHandle(p R0)'
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${If} $R2 <> 0
        # electron-updater's detached spawn starts this installer ignoring Ctrl+C; the app (and its
        # terminals) would inherit that as our child, so restore normal Ctrl+C handling first.
        System::Call 'kernel32::SetConsoleCtrlHandler(p 0, i 0)'
        ClearErrors
        ExecShell "open" "$launchLink" "$startAppArgs"
        ${If} ${Errors}
          StrCpy $R2 0
        ${EndIf}
      ${EndIf}
      ${If} $R2 = 0
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$startAppArgs"
      ${EndIf}
      Pop $R2
      Pop $R1
      Pop $R0
    !macroend
  !endif
!endif
