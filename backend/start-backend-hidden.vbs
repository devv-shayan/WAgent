' Launches start-backend.bat with no visible console window.
' Target of the Startup-folder shortcut created by install-autostart.ps1.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
batPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-backend.bat")
sh.Run """" & batPath & """", 0, False
