; Custom NSIS macros for Cursor Dot.
; Installs/removes Cursor hooks around the app lifecycle.

!macro customInstall
  DetailPrint "Installing Cursor Dot hooks..."
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-hooks'
  Pop $0
  DetailPrint "Hook install exit code: $0"
!macroend

!macro customUnInstall
  DetailPrint "Removing Cursor Dot hooks..."
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-hooks'
  Pop $0
  DetailPrint "Hook uninstall exit code: $0"
!macroend
