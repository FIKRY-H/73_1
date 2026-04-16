@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 936 >nul

echo ========================================
echo        源码交付打包脚本
echo ========================================
echo.

REM 1) 获取日期（不使用时分秒）
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd'"`) do set "shortdate=%%i"

set "currentDir=%cd%"
set "outputDir=%currentDir%\packages\source"
set "zipName=WebBattery_source_%shortdate%.zip"
set "zipPath=%outputDir%\%zipName%"
set "tempDir=%TEMP%\source_pack_%shortdate%_%RANDOM%"

if not exist "%outputDir%" mkdir "%outputDir%"

echo [1/5] 复制当前工程到临时目录...
echo       临时目录路径: %tempDir%
mkdir "%tempDir%"

REM 复制所有文件到临时目录，同时排除常见大目录/产物目录（含 packages 历史打包目录）
robocopy "%currentDir%" "%tempDir%" /E /XD node_modules dist build out bin final-exe packages .git /XF package_source.bat WebBattery_source_*.zip /NP /NFL /NDL >nul
REM robocopy 返回值: 0-7 视为成功, >=8 视为失败
if %ERRORLEVEL% GEQ 8 (
    echo [错误] 复制文件到临时目录失败，退出码: %ERRORLEVEL%
    goto :error
)

echo [2/5] 从临时目录删除不需要的内容...
pushd "%tempDir%"

for /d /r %%D in (node_modules dist build out bin final-exe packages) do (
    if exist "%%D" rd /s /q "%%D" >nul 2>&1
)

if exist "webbattery_server\single-exe-dist" rd /s /q "webbattery_server\single-exe-dist" >nul 2>&1
if exist "webbattery_server\data" rd /s /q "webbattery_server\data" >nul 2>&1

del /s /q *.log *.db *.sqlite *.sqlite3 >nul 2>&1

popd

echo [3/5] 校验核心源码目录...
if not exist "%tempDir%\webbattery_client\src\" (
    echo [错误] 校验失败: 缺少 webbattery_client\src 目录，请在工程根目录运行此脚本。
    goto :error
)
if not exist "%tempDir%\webbattery_server\src\" (
    echo [错误] 校验失败: 缺少 webbattery_server\src 目录，请在工程根目录运行此脚本。
    goto :error
)
echo       校验通过: client 和 server 源码目录存在。

echo [4/5] 正在压缩 zip 文件: %zipName%
if exist "%zipPath%" del "%zipPath%"
powershell -NoProfile -Command "Compress-Archive -Path '%tempDir%\*' -DestinationPath '%zipPath%' -Force"
if %ERRORLEVEL% NEQ 0 (
    echo [错误] zip 压缩失败。
    goto :error
)

echo [5/5] 清理临时目录...
rd /s /q "%tempDir%" >nul 2>&1

echo.
echo ========================================
echo [成功] 源码打包完成
echo [输出路径] %zipPath%
echo ========================================
exit /b 0

:error
echo.
echo ========================================
echo [失败] 打包过程中出现错误，已退出。
echo ========================================
exit /b 1
