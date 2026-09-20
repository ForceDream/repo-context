@echo off
rem repoctx entry: resolve node, then forward args.
rem Prefers node on PATH; falls back to common install locations so it also works
rem where node is not on PATH.
setlocal
set "NODE=node"
where node >nul 2>nul && goto :run
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe" && goto :run
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe" && goto :run
if defined NODE_HOME if exist "%NODE_HOME%\node.exe" set "NODE=%NODE_HOME%\node.exe" && goto :run
:run
"%NODE%" "%~dp0repoctx.mjs" %*
exit /b %ERRORLEVEL%
