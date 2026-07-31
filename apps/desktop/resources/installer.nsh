!include "getProcessInfo.nsh"

Var pid

!macro setInstallerPhaseText TEXT
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${Silent}
      FindWindow $0 "#32770" "" $hwndparent
      FindWindow $0 "#32770" "" $hwndparent $0
      GetDlgItem $0 $0 1000
      SendMessage $0 ${WM_SETTEXT} 0 "STR:${TEXT}"
    ${EndIf}
  !endif
!macroend

# electron-builder calls this immediately before checking for and removing the
# installed version. Keep its standard app-running check, then make the long
# silent-uninstaller phase explicit in the one-click installer banner.
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !insertmacro setInstallerPhaseText "Removing the previous version..."
!macroend

# electron-builder delegates these hooks the old uninstaller result handling.
# Preserve its standard failure behavior before advancing the phase text.
!macro handleOldUninstallerResult NEXT_TEXT
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return

  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${EndIf}

  !insertmacro setInstallerPhaseText "${NEXT_TEXT}"
!macroend

!macro customUnInstallCheck
  # An all-users installation can also remove a per-user installation next.
  # Keep showing the removal phase until both checks have completed.
  ${If} $installMode == "all"
    !insertmacro handleOldUninstallerResult "Removing the previous version..."
  ${Else}
    !insertmacro handleOldUninstallerResult "Installing the new version..."
  ${EndIf}
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro handleOldUninstallerResult "Installing the new version..."
!macroend
