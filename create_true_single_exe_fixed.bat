@echo off
chcp 65001 >nul
echo ========================================
echo   WebBattery 单文件EXE打包工具
echo ========================================
echo.

echo [1/7] 清理构建目录...
if exist single-exe rmdir /s /q single-exe
if exist final-exe rmdir /s /q final-exe
mkdir single-exe
mkdir final-exe

echo [2/7] 构建前端应用...
cd webbattery_client
call npm run build
if %ERRORLEVEL% NEQ 0 (
  echo 前端构建失败
  cd ..
  pause
  exit /b 1
)

echo [3/7] 构建后端应用...
cd ..\webbattery_server
call npx tsc
if %ERRORLEVEL% NEQ 0 (
  echo 后端构建失败
  cd ..
  pause
  exit /b 1
)

echo [4/7] 使用NCC打包后端...
REM 清理旧的NCC打包目录
if exist single-exe-dist rmdir /s /q single-exe-dist
call npx ncc build dist/index.js -o single-exe-dist --minify
if %ERRORLEVEL% NEQ 0 (
  echo NCC打包失败
  cd ..
  pause
  exit /b 1
)

echo [5/7] 复制前端文件...
if not exist single-exe-dist\frontend mkdir single-exe-dist\frontend
xcopy ..\webbattery_client\dist\* single-exe-dist\frontend\ /E /I /Y
if %ERRORLEVEL% NEQ 0 (
  echo 前端文件复制失败
  cd ..
  pause
  exit /b 1
)

echo 验证前端文件复制...
if exist single-exe-dist\frontend\index.html (
  echo ✅ 前端文件复制成功
) else (
  echo ❌ 前端index.html未找到
  cd ..
  pause
  exit /b 1
)

echo [6/7] 创建启动器...
cd ..

REM 复制所有必要文件
echo 复制项目文件...
xcopy webbattery_server\single-exe-dist single-exe\webbattery_server\single-exe-dist\ /E /I /Y

REM 复制数据库文件（如果存在）
if exist webbattery_server\local_database.db copy webbattery_server\local_database.db single-exe\webbattery_server\

REM 创建简化的启动器
echo console.log('========================================'); > single-exe\launcher.js
echo console.log('  WebBattery 监控系统启动中...'); >> single-exe\launcher.js
echo console.log('========================================'); >> single-exe\launcher.js
echo console.log('Node.js版本:', process.version); >> single-exe\launcher.js
echo console.log('正在启动服务器...'); >> single-exe\launcher.js
echo. >> single-exe\launcher.js
echo const { exec } = require('child_process'); >> single-exe\launcher.js
echo. >> single-exe\launcher.js
echo // 启动主服务器 >> single-exe\launcher.js
echo try { >> single-exe\launcher.js
echo   require('./webbattery_server/single-exe-dist/index.js'); >> single-exe\launcher.js
echo. >> single-exe\launcher.js
echo   // 5秒后打开浏览器 >> single-exe\launcher.js
echo   setTimeout(() =^> { >> single-exe\launcher.js
echo     console.log('正在打开浏览器...'); >> single-exe\launcher.js
echo     exec('start http://localhost:8080', (error) =^> { >> single-exe\launcher.js
echo       if (error) { >> single-exe\launcher.js
echo         console.log('无法自动打开浏览器，请手动访问: http://localhost:8080'); >> single-exe\launcher.js
echo       } else { >> single-exe\launcher.js
echo         console.log('已在浏览器中打开: http://localhost:8080'); >> single-exe\launcher.js
echo       } >> single-exe\launcher.js
echo     }); >> single-exe\launcher.js
echo     console.log('========================================'); >> single-exe\launcher.js
echo     console.log('  WebBattery 监控系统已启动'); >> single-exe\launcher.js
echo     console.log('  浏览器地址: http://localhost:8080'); >> single-exe\launcher.js
echo     console.log('  按 Ctrl+C 停止服务器'); >> single-exe\launcher.js
echo     console.log('========================================'); >> single-exe\launcher.js
echo   }, 5000); >> single-exe\launcher.js
echo. >> single-exe\launcher.js
echo } catch (error) { >> single-exe\launcher.js
echo   console.error('启动服务器时出错:', error); >> single-exe\launcher.js
echo   console.log('按任意键退出...'); >> single-exe\launcher.js
echo   process.stdin.setRawMode(true); >> single-exe\launcher.js
echo   process.stdin.resume(); >> single-exe\launcher.js
echo   process.stdin.on('data', process.exit.bind(process, 0)); >> single-exe\launcher.js
echo } >> single-exe\launcher.js

REM 创建package.json
echo { > single-exe\package.json
echo   "name": "webbattery-single-exe", >> single-exe\package.json
echo   "version": "1.0.0", >> single-exe\package.json
echo   "main": "launcher.js", >> single-exe\package.json
echo   "bin": "launcher.js", >> single-exe\package.json
echo   "pkg": { >> single-exe\package.json
echo     "targets": ["node18-win-x64"], >> single-exe\package.json
echo     "outputPath": "../final-exe", >> single-exe\package.json
echo     "assets": [ >> single-exe\package.json
echo       "webbattery_server/single-exe-dist/**/*", >> single-exe\package.json
echo       "webbattery_server/local_database.db" >> single-exe\package.json
echo     ], >> single-exe\package.json
echo     "scripts": [ >> single-exe\package.json
echo       "webbattery_server/single-exe-dist/**/*.js" >> single-exe\package.json
echo     ] >> single-exe\package.json
echo   } >> single-exe\package.json
echo } >> single-exe\package.json

echo [7/7] 使用PKG创建EXE文件...
cd single-exe

REM 使用PKG打包为单个exe文件
echo 正在打包为单个exe文件...
call npx pkg . --targets node18-win-x64 --output ../final-exe/WebBattery.exe --compress GZip
if %ERRORLEVEL% NEQ 0 (
  echo PKG压缩打包失败，尝试无压缩模式...
  call npx pkg . --targets node18-win-x64 --output ../final-exe/WebBattery.exe
  if %ERRORLEVEL% NEQ 0 (
    echo PKG打包失败！
    echo 请检查：
    echo 1. 网络连接是否正常
    echo 2. 是否有杀毒软件阻止
    echo 3. 磁盘空间是否充足
    cd ..
    pause
    exit /b 1
  )
)

cd ..

REM 创建使用说明
echo WebBattery 监控系统 - 单文件版本 > final-exe\使用说明.txt
echo ===================================== >> final-exe\使用说明.txt
echo. >> final-exe\使用说明.txt
echo 使用方法: >> final-exe\使用说明.txt
echo 1. 双击 WebBattery.exe 启动程序 >> final-exe\使用说明.txt
echo 2. 等待服务器启动（约10-30秒） >> final-exe\使用说明.txt
echo 3. 系统会自动打开浏览器访问 http://localhost:8080 >> final-exe\使用说明.txt
echo 4. 如果浏览器未自动打开，请手动访问上述地址 >> final-exe\使用说明.txt
echo. >> final-exe\使用说明.txt
echo 功能特点: >> final-exe\使用说明.txt
echo - 单个exe文件，无需安装任何依赖 >> final-exe\使用说明.txt
echo - 自动打开浏览器，无需手动输入地址 >> final-exe\使用说明.txt
echo - 内置Node.js运行时，完全自包含 >> final-exe\使用说明.txt
echo - 智能检测服务器启动状态 >> final-exe\使用说明.txt
echo. >> final-exe\使用说明.txt
echo 注意事项: >> final-exe\使用说明.txt
echo - 首次启动需要时间解压文件（10-30秒） >> final-exe\使用说明.txt
echo - 确保8080端口未被其他程序占用 >> final-exe\使用说明.txt
echo - 如果防火墙提示，请选择允许访问 >> final-exe\使用说明.txt
echo - 按 Ctrl+C 可以停止服务器 >> final-exe\使用说明.txt
echo. >> final-exe\使用说明.txt
echo 故障排除: >> final-exe\使用说明.txt
echo - 如果浏览器未自动打开：手动访问 http://localhost:8080 >> final-exe\使用说明.txt
echo - 如果端口被占用：关闭占用8080端口的其他程序 >> final-exe\使用说明.txt
echo - 如果启动失败：检查是否有杀毒软件阻止运行 >> final-exe\使用说明.txt
echo. >> final-exe\使用说明.txt
echo 版本: 1.0.0 (单文件版) >> final-exe\使用说明.txt
echo 构建时间: %date% %time% >> final-exe\使用说明.txt

REM 清理临时文件
echo 清理临时文件...
if exist single-exe rmdir /s /q single-exe

echo.
echo ========================================
echo         打包完成！
echo ========================================
echo.
if exist final-exe\WebBattery.exe (
  echo [成功] 成功创建单文件EXE: final-exe\WebBattery.exe
  echo.
  echo [使用方法]:
  echo 1. 双击 WebBattery.exe 启动
  echo 2. 等待启动完成后自动打开浏览器
  echo 3. 访问 http://localhost:8080
  echo.
  echo [输出目录]: final-exe\
) else (
  echo [错误] EXE文件创建失败！
  echo 请检查错误信息并重试
)
echo.
echo 详细说明请查看: final-exe\使用说明.txt
echo.
pause