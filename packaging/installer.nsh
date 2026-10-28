!include "LogicLib.nsh"

!macro customUnInstall
  ${IfNot} ${Silent}
    MessageBox MB_ICONQUESTION|MB_YESNO "Remove Pulsar Codex Deck's Codex hooks too? Other integrations will be preserved and the previous hook file will be backed up." IDNO pulsar_hooks_done
    IfFileExists "$INSTDIR\resources\backend\PulsarBackend.exe" 0 pulsar_hooks_done
    nsExec::ExecToLog '"$INSTDIR\resources\backend\PulsarBackend.exe" uninstall-hooks --apply'
    Pop $0
    pulsar_hooks_done:
  ${EndIf}
!macroend
