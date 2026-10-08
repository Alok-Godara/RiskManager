' Runs a .cmd launcher with NO window at all (window style 0), unlike
' "powershell -WindowStyle Hidden", which still flashes a console. Used by the
' scheduled tasks registered in install-background-services.ps1.
'   wscript.exe //B //Nologo hidden-launch.vbs "C:\path\to\launcher.cmd"
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd.exe /c """ & WScript.Arguments(0) & """", 0, True
