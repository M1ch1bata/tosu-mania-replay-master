' Mania Replay Master - hidden helper launcher (used by start-helper.bat)
' The osu! folder is auto-detected by the helper; pass it as an argument to override:
'   wscript start-helper.vbs "E:\osu!"
Option Explicit

Dim fso, sh, dir, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

dir = fso.GetParentFolderName(WScript.ScriptFullName)

cmd = "node """ & dir & "\mrm-helper.mjs"""
If WScript.Arguments.Count >= 1 Then
    cmd = cmd & " --osu """ & WScript.Arguments(0) & """"
End If
cmd = cmd & " --exit-idle 600 --watch-process ""osu!,tosu"""

sh.Run cmd, 0, False
