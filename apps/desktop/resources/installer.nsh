!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    # Auto-updates (--updated) must preserve shortcuts the user deleted; manual installs repair them.
    ${IfNot} ${isUpdated}
    ${AndIfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend
