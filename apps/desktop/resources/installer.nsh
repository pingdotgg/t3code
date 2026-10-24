!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    # With $keepShortcuts, electron-builder only moves an existing shortcut and never recreates
    # a missing one. Repair it on a user-run install, but not on auto-updates (--updated): the
    # user may have deleted it on purpose.
    ${IfNot} ${isUpdated}
    ${AndIfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend
