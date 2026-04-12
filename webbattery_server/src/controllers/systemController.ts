import { Request, Response } from 'express';
import os from 'os';
// TCP服务已移除，仅支持Modbus TCP协议

// 获取网络接口信息
export const getNetworkInterfaces = (req: Request, res: Response) => {
  try {
    const networkInterfaces = os.networkInterfaces();
    const interfaces: { name: string; address: string }[] = [];

    // 遍历所有网络接口
    Object.keys(networkInterfaces).forEach(name => {
      const ifaces = networkInterfaces[name];
      if (ifaces) {
        ifaces.forEach(iface => {
          // 只添加IPv4地址
          if (iface.family === 'IPv4') {
            interfaces.push({
              name,
              address: iface.address
            });
          }
        });
      }
    });

    res.json({
      success: true,
      interfaces
    });
  } catch (error) {
    console.error('获取网络接口信息失败:', error);
    res.status(500).json({
      success: false,
      message: '获取网络接口信息失败'
    });
  }
};

// 获取系统状态
export const getSystemStatus = (req: Request, res: Response) => {
  try {
    // TCP监听器已移除，返回Modbus TCP协议状态
    res.json({
      success: true,
      protocol: 'Modbus TCP',
      message: 'TCP协议已移除，系统仅支持Modbus TCP协议'
    });
  } catch (error) {
    console.error('获取系统状态失败:', error);
    res.status(500).json({
      success: false,
      message: '获取系统状态失败'
    });
  }
};

// TCP监听功能已移除
export const startListening = (req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    message: 'TCP监听功能已移除，请使用Modbus TCP协议连接设备'
  });
};

// TCP监听功能已移除
export const stopListening = (req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    message: 'TCP监听功能已移除，请使用Modbus TCP协议连接设备'
  });
};