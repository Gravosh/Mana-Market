@echo off
setlocal
set "MANA_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%MANA_NODE%" (
  set "MANA_NODE="
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined MANA_NODE set "MANA_NODE=%%N"
)
if not defined MANA_NODE (
  echo Mana Market could not find Node.js on this computer.
  echo Please open this folder from Codex and try again.
  pause
  exit /b 1
)
start "Mana Market live helper" /min "%MANA_NODE%" "%~dp0server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"
endlocal

