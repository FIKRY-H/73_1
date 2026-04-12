import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { initializeSocketServer } from './services/socketService';
import batteryRoutes from './routes/batteryRoutes';
import healthRoutes from './routes/healthRoutes';
import systemRoutes from './routes/systemRoutes';
import modbusRoutes from './routes/modbusRoutes';
import pollingRoutes from './routes/pollingRoutes';
import { errorHandler } from './middleware/errorHandler';
import { initializeDatabase } from './config/database';

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // 增加心跳超时设置，防止长时间无操作断开
  pingTimeout: 6000000, // 6000秒无响应才断开
  pingInterval: 25000 // 25秒发送一次心跳
});

// 导出Socket.IO实例的函数
export function getSocketIOInstance() {
  return io;
}

const PORT = process.env.PORT || 8080; // 后端服务器主端口
const ALT_PORT = 8081; // 备用端口

// 中间件设置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件服务 - 用于单文件EXE部署
const frontendPath = path.join(__dirname, 'frontend');
if (fs.existsSync(frontendPath)) {
  console.log('设置静态文件服务:', frontendPath);
  app.use(express.static(frontendPath));
  
  // SPA路由支持 - 所有非API请求都返回index.html
  app.get('*', (req, res, next) => {
    // 跳过API路由
    if (req.path.startsWith('/api/')) {
      return next();
    }
    
    const indexPath = path.join(frontendPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Frontend not found');
    }
  });
} else {
  console.log('前端文件未找到，仅提供API服务');
  
  // 根路径提示
  app.get('/', (req, res) => {
    res.json({
      message: 'WebBattery API Server',
      version: '2.0.0',
      endpoints: {
        health: '/api/health',
        battery: '/api/battery',
        modbus: '/api/modbus',
        polling: '/api/polling'
      }
    });
  });
}

// 设置API路由
const setupRoutes = () => {
  // API路由
  app.use('/api/battery', batteryRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/modbus', modbusRoutes);
  app.use('/api/polling', pollingRoutes);
  
  // API状态端点
  app.get('/api/status', (req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      service: 'WebBattery Server (Modbus TCP Only)',
      protocols: ['Modbus TCP']
    });
  });

  // API 404处理
  app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });
};

// API 404处理
const setupApiErrorHandling = () => {
  // 处理未找到的API路径
  app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });
};

// 启动服务器
async function startServer() {
  try {
    // 初始化数据库
    console.log('正在初始化数据库...');
    await initializeDatabase();
    
    // 保留已有数据，不在启动时清空数据库
    console.log('数据库已初始化，保留历史数据');
    
    // 设置API路由
    console.log('正在设置API路由...');
    setupRoutes();
    
    // 设置Socket.IO
    console.log('正在设置Socket.IO服务...');
    initializeSocketServer(io);
    
    // 设置API错误处理
    console.log('正在设置API错误处理...');
    setupApiErrorHandling();
    
    // 全局错误处理
    app.use(errorHandler);
    
    // 启动服务器
    server.listen(PORT, () => {
      console.log('========================================');
      console.log('    WebBattery 服务器启动成功！');
      console.log('========================================');
      console.log(`服务器运行在端口: ${PORT}`);
      console.log(`Socket.IO 服务已启动`);
      console.log(`数据库连接已建立`);
      
      console.log(`API服务可用: http://localhost:${PORT}/api`);
      
      console.log('========================================');
      
      // 在控制台显示一些有用的信息
      console.log('\n可用的API端点:');
      console.log(`- GET  /api/health        - 健康检查`);
      console.log(`- GET  /api/battery/data  - 获取电池数据`);
      console.log(`- POST /api/battery/mapping - 创建设备映射`);
      console.log(`- GET  /api/battery/mapping - 获取设备映射`);
      console.log(`- GET  /api/polling/devices/available - 获取可用设备`);
      console.log(`- GET  /api/polling/polling-status - 获取轮询状态`);
      console.log(`- POST /api/polling/start-f1-polling - 启动F1轮询`);
      console.log(`- POST /api/polling/start-f2-polling - 启动F2轮询`);
      console.log(`- POST /api/polling/stop-polling - 停止轮询`);
      console.log(`- POST /api/polling/stop-all-polling - 停止所有轮询`);
      console.log(`- POST /api/polling/start-batch-polling - 批量启动轮询`);
      
      console.log('\n按 Ctrl+C 停止服务器');
    }).on('error', (error: any) => {
      if (error.code === 'EADDRINUSE' && Number(PORT) !== ALT_PORT) {
        console.log(`端口 ${PORT} 被占用，尝试使用端口 ${ALT_PORT}...`);
        server.listen(ALT_PORT, () => {
          console.log('========================================');
          console.log('    WebBattery 服务器启动成功！');
          console.log('========================================');
          console.log(`服务器运行在端口: ${ALT_PORT}`);
          console.log(`Socket.IO 服务已启动`);
          console.log(`数据库连接已建立`);
          
          console.log(`API服务可用: http://localhost:${ALT_PORT}/api`);
          
          console.log('========================================');
          console.log('\n按 Ctrl+C 停止服务器');
        });
      } else {
        console.error('启动服务器失败:', error);
        throw error;
      }
    });
    
  } catch (error) {
    console.error('服务器启动失败:', error);
    process.exit(1);
  }
}

// 优雅关闭处理
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n接收到 SIGTERM，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

// 全局错误处理
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
  console.error('Promise:', promise);
});

// 启动服务器
startServer();