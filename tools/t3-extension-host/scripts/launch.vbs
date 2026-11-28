' Starts T3 Extension Host hidden. Finds Node.js on every launch, so a Node update or move doesn't break startup.
Option Explicit

Dim shell, fso, root, main, node, logFile
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
main = root & "\src\main.js"

Function Env(name)
  Env = shell.ExpandEnvironmentStrings("%" & name & "%")
  If Env = "%" & name & "%" Then Env = ""
End Function

Function Candidate(path)
  Candidate = ""
  If path <> "" Then
    If fso.FileExists(path) Then Candidate = path
  End If
End Function

Function FindNode()
  Dim dir, found
  found = Candidate(Env("T3_EXTENSION_HOST_NODE"))
  If found = "" Then
    For Each dir In Split(Env("PATH"), ";")
      If found = "" And Trim(dir) <> "" Then found = Candidate(fso.BuildPath(Trim(dir), "node.exe"))
    Next
  End If
  If found = "" Then found = Candidate(Env("ProgramFiles") & "\nodejs\node.exe")
  If found = "" Then found = Candidate(Env("NVM_SYMLINK") & "\node.exe")
  If found = "" Then found = Candidate(Env("LOCALAPPDATA") & "\Volta\bin\node.exe")
  If found = "" Then found = Candidate(Env("LOCALAPPDATA") & "\Programs\nodejs\node.exe")
  If found = "" Then found = Candidate(Env("ProgramFiles(x86)") & "\nodejs\node.exe")
  FindNode = found
End Function

node = FindNode()
If node = "" Then
  logFile = Env("APPDATA") & "\t3-extension-host\logs\host.log"
  If Not fso.FolderExists(fso.GetParentFolderName(logFile)) Then shell.Run "cmd /c mkdir """ & fso.GetParentFolderName(logFile) & """", 0, True
  With fso.OpenTextFile(logFile, 8, True)
    .WriteLine Now & " ERROR [launcher] Node.js 22.15 or newer was not found; install it from https://nodejs.org or set T3_EXTENSION_HOST_NODE"
    .Close
  End With
  WScript.Quit 1
End If

shell.Run """" & node & """ --no-warnings """ & main & """", 0, False
