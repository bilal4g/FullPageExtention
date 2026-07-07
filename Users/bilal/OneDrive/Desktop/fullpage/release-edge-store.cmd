@echo off
setlocal
REM ==========================================================
REM  FullPage - Microsoft Edge Add-ons one-command release
REM ==========================================================
REM  Usage:
REM    release-edge-store.cmd            (bump patch, package, publish)
REM    release-edge-store.cmd --minor    (bump minor)
REM    release-edge-store.cmd --major    (bump major)
REM    release-edge-store.cmd --set 2.1.0
REM    release-edge-store.cmd --no-publish   (build + package only)
REM    release-edge-store.cmd --dry-run      (show actions, change nothing)
REM
REM  Secrets are read from environment variables ONLY:
REM    EDGE_CLIENT_ID, EDGE_API_KEY, EDGE_PRODUCT_ID
REM  See README.md for setup instructions.
REM ==========================================================
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node "scripts\edge-publish.mjs" %*
exit /b %errorlevel%
:nonode
echo [ERROR] Node.js 18+ is required but was not found on PATH.
echo Download and install it from https://nodejs.org/ then run this script again.
exit /b 1
