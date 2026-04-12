@echo off
chcp 65001 >nul
echo ========================================
echo   WebBattery 监控系统启动器
echo ========================================
echo.

REM 检查Node.js和npm
where node >nul 2>&1 || (
  echo ❌ Node.js未安装，请从 https://nodejs.org/ 安装
  pause & exit /b 1
)

where npm >nul 2>&1 || (
  echo ❌ npm未安装，请从 https://nodejs.org/ 安装
  pause & exit /b 1
)

echo ✅ Node.js和npm已就绪
echo.

REM 安装服务器依赖
if not exist webbattery_server\node_modules (
  echo 📦 安装服务器依赖...
  cd webbattery_server && npm install || (
    echo ❌ 服务器依赖安装失败
    cd .. & pause & exit /b 1
  )
  cd ..
)

REM 构建服务器
if not exist webbattery_server\dist (
  echo 🔨 构建服务器...
  cd webbattery_server && npx tsc || (
    echo ❌ 服务器构建失败
    cd .. & pause & exit /b 1
  )
  cd ..
)

REM 安装客户端依赖
if not exist webbattery_client\node_modules (
  echo 📦 安装客户端依赖...
  cd webbattery_client && npm install || (
    echo ❌ 客户端依赖安装失败
    cd .. & pause & exit /b 1
  )
  cd ..
)

echo.
echo 🚀 启动服务器（端口8080）...
start "WebBattery-Server" cmd /k "chcp 65001 >nul && cd webbattery_server && node dist/index.js"

echo ⏳ 等待服务器启动...
timeout /t 5 /nobreak > nul

echo 🚀 启动前端开发服务器（端口3000）...
start "WebBattery-Client" cmd /k "chcp 65001 >nul && cd webbattery_client && npm run dev"

echo ⏳ 等待前端启动...
timeout /t 8 /nobreak > nul

echo 🌐 打开浏览器...
start http://localhost:3000

echo.
echo ========================================
echo   ✅ WebBattery 系统启动成功!
echo   📡 后端服务: http://localhost:8080
echo   🎨 前端界面: http://localhost:3000
echo   📝 使用前端界面进行操作
echo ========================================
echo.
echo 💡 提示: 关闭此窗口不会停止服务
echo 🛑 要停止服务，请关闭对应的服务器窗口
echo.
pause