!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    RMDir /r "$APPDATA\framekit"
    RMDir /r "$LOCALAPPDATA\framekit"
    RMDir /r "$LOCALAPPDATA\framekit-updater"

    StrCpy $R0 "CDEFGHIJKLMNOPQRSTUVWXYZ"
    StrCpy $R1 0
    framekit_data_loop:
      StrCpy $R2 $R0 1 $R1
      StrCmp $R2 "" framekit_data_done
      IfFileExists "$R2:\FrameKitData\.framekit-data" 0 framekit_data_next
        RMDir /r "$R2:\FrameKitData"
      framekit_data_next:
      IntOp $R1 $R1 + 1
      Goto framekit_data_loop
    framekit_data_done:
  ${endif}
!macroend
