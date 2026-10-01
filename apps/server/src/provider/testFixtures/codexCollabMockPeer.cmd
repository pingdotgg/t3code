@echo off
rem Wrapper so CodexSessionRuntime can spawn the mock peer on Windows: the
rem runtime always passes "app-server" as the first argument; drop it and
rem run the .mjs peer with node. "shift /1" leaves %0 alone so %~dp0 still
rem names this file's directory.
shift /1
node "%~dp0codexCollabMockPeer.mjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
