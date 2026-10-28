@echo off
setlocal
rem Claude Fleet Manager installer for Windows. Press Enter at the prompt to install.
set "NAME=ClaudeFleetManager"
set "APP_DIR=%LOCALAPPDATA%\%NAME%"
set "DATA_DIR=%APPDATA%\claude-fleet-manager"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Claude Fleet Manager.lnk"
set "MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Claude Fleet Manager.lnk"

set "CHOICE="
set /p "CHOICE=Install or Uninstall? [I/u]: "
if /i "%CHOICE:~0,1%"=="u" goto uninstall

:install
taskkill /f /im electron.exe >nul 2>&1
if exist "%APP_DIR%" rmdir /s /q "%APP_DIR%"
mkdir "%APP_DIR%" || exit /b 1
set "TMPD=%TEMP%\cfm-%RANDOM%"
mkdir "%TMPD%"
rem Cut the payload (everything after the marker line) out of this file, then unpack it.
powershell -NoProfile -Command "$m=[Text.Encoding]::ASCII.GetBytes(\"`r`n__PAY\"+\"LOAD__`r`n\"); $b=[IO.File]::ReadAllBytes('%~f0'); for($i=0;$i -lt $b.Length-$m.Length;$i++){ $ok=$true; for($j=0;$j -lt $m.Length;$j++){ if($b[$i+$j] -ne $m[$j]){$ok=$false;break} }; if($ok){break} }; [IO.File]::WriteAllBytes('%TMPD%\payload.tgz', $b[($i+$m.Length)..($b.Length-1)])" || goto fail
tar -xzf "%TMPD%\payload.tgz" -C "%TMPD%" || goto fail
if not exist "%TMPD%\runtimes\win32-x64.zip" (echo This installer has no Windows runtime. & goto fail)
powershell -NoProfile -Command "Expand-Archive -Force '%TMPD%\runtimes\win32-x64.zip' '%APP_DIR%\electron'" || goto fail
xcopy /e /i /q /y "%TMPD%\app" "%APP_DIR%\app" >nul || goto fail
rem Save the Claude Desktop / CLI logins already on this machine as accounts (never fails the install).
set "ELECTRON_RUN_AS_NODE=1"
"%APP_DIR%\electron\electron.exe" "%APP_DIR%\app\src\main\detect-cli.js" 2>nul || echo Could not detect signed-in accounts. Use Add account from the tray menu.
set "ELECTRON_RUN_AS_NODE="
powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell; foreach($p in '%STARTUP%','%MENU%'){ $l=$s.CreateShortcut($p); $l.TargetPath='%APP_DIR%\electron\electron.exe'; $l.Arguments='\"%APP_DIR%\app\"'; $l.WorkingDirectory='%APP_DIR%'; $l.Save() }"
rmdir /s /q "%TMPD%"
start "" "%APP_DIR%\electron\electron.exe" "%APP_DIR%\app"
echo Installed. The Claude Fleet Manager icon is in your system tray (check the ^ overflow).
pause
exit /b 0

:uninstall
taskkill /f /im electron.exe >nul 2>&1
del /q "%STARTUP%" "%MENU%" >nul 2>&1
if exist "%APP_DIR%" rmdir /s /q "%APP_DIR%"
set "PURGE="
set /p "PURGE=Also delete saved accounts? [y/N]: "
if /i "%PURGE:~0,1%"=="y" (if exist "%DATA_DIR%" rmdir /s /q "%DATA_DIR%")
echo Uninstalled.
pause
exit /b 0

:fail
echo Install failed.
if exist "%TMPD%" rmdir /s /q "%TMPD%"
pause
exit /b 1
