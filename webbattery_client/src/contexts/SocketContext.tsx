import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { ClientInfo } from '../types/batteryTypes';

interface ListenerStatus {
  isListening: boolean;
  address: string | null;
  port: number | null;
}

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  clients: ClientInfo[];
  listenerStatus: ListenerStatus;
  sendCommand: (deviceId: string, command: number, parameters?: any) => boolean;
  reconnect: () => void;
}

const SocketContext = createContext<SocketContextType>({
  socket: null,
  isConnected: false,
  clients: [],
  listenerStatus: {
    isListening: false,
    address: null,
    port: null
  },
  sendCommand: () => false,
  reconnect: () => {}
});

export const useSocket = () => useContext(SocketContext);

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [listenerStatus, setListenerStatus] = useState<ListenerStatus>({
    isListening: false,
    address: null,
    port: null
  });

  // 创建Socket连接
  const createSocketConnection = () => {
    try {
      // 确保先断开旧连接
      if (socket) {
        socket.disconnect();
      }
      
      console.log('创建新的WebSocket连接...');
      // 使用相对路径连接，配合Vite代理转发到后端端口
      const socketInstance = io('/', {
        path: '/socket.io',
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 500,
        timeout: 5000,
        // 优化传输
        transports: ['websocket', 'polling'],
        // 优先使用WebSocket
        upgrade: true,
        // 自动重连
        autoConnect: true,
        // 强制创建新连接
        forceNew: true,
        // 禁用多路复用
        multiplex: false
      });

      setSocket(socketInstance);

      // 连接事件
      socketInstance.on('connect', () => {
        console.log('已连接到服务器，Socket ID:', socketInstance.id);
        setIsConnected(true);
        
        // 连接后延迟一点时间再请求状态，确保服务器准备就绪
        setTimeout(() => {
          // 连接后立即请求Modbus连接列表
          socketInstance.emit('getModbusConnections');
          
          // 连接后立即请求监听状态
          socketInstance.emit('getListenerStatus');
          
          console.log('已发送初始状态请求');
        }, 100);
      });

      // 断开连接事件
      socketInstance.on('disconnect', () => {
        console.log('与服务器断开连接');
        setIsConnected(false);
      });

      // 连接错误事件
      socketInstance.on('connect_error', (error) => {
        console.error('连接错误:', error);
        setIsConnected(false);
      });

      // 重连尝试事件
      socketInstance.on('reconnect_attempt', (attempt) => {
        console.log(`尝试重连 (${attempt})`);
      });

      // 重连失败事件
      socketInstance.on('reconnect_failed', () => {
        console.error('重连失败');
        setIsConnected(false);
      });

      // Modbus连接列表更新
      socketInstance.on('modbusConnectionsUpdate', (connections: any[]) => {
        console.log('🔄 SocketContext - 收到Modbus连接列表更新:', connections);
        console.log('📊 SocketContext - Modbus连接数量:', connections.length);
        
        // 转换Modbus连接为ClientInfo格式
        const clientList: ClientInfo[] = connections.map((conn, index) => {
          console.log(`📱 SocketContext - Modbus连接 ${index + 1}:`, {
            id: conn.id,
            host: conn.host,
            port: conn.port,
            mac: conn.mac,
            isConnected: conn.isConnected,
            完整对象: conn
          });
          
          return {
            id: conn.id,
            socketId: conn.id, // 添加缺失的socketId属性
            mac: conn.mac || `${conn.host}:${conn.port}`,
            address: conn.host,
            port: conn.port,
            isConnected: conn.isConnected,
            lastHeartbeat: conn.lastHeartbeat
          };
        });
        
        setClients(clientList);
      });
      
      // 保持对旧的clientsUpdate事件的兼容性
      socketInstance.on('clientsUpdate', (updatedClients: ClientInfo[]) => {
        console.log('🔄 SocketContext - 收到客户端列表更新(兼容模式):', updatedClients);
        setClients(updatedClients);
      });

      // MAC地址更新事件
      socketInstance.on('deviceMacUpdated', (data: { 
        clientId: string; 
        mac: string; 
        oldMac: string | null; 
        address: string; 
        port: number; 
        timestamp: string 
      }) => {
        console.log('收到设备MAC地址更新:', data);
        
        // 立即请求最新的Modbus连接列表
        socketInstance.emit('getModbusConnections');
        
        console.log(`设备MAC地址已更新: ${data.clientId} -> ${data.mac}`);
      });

      // 设备识别事件
      socketInstance.on('deviceIdentified', (data: { 
        clientId: string; 
        uid: string; 
        mac: string; 
        address: string; 
        port: number; 
        timestamp: string 
      }) => {
        console.log('收到设备识别事件:', data);
        
        // 立即请求最新的Modbus连接列表
        socketInstance.emit('getModbusConnections');
        
        console.log(`设备已识别: ${data.clientId} -> MAC:${data.mac}, UID:${data.uid}`);
      });

      // 设备检测响应
      socketInstance.on('deviceDetected', (data: { clientId: string, mac: string, timestamp: string }) => {
        console.log('收到设备检测响应:', data);
        
        // 设备检测到后，立即请求最新的Modbus连接列表
        socketInstance.emit('getModbusConnections');
        
        // 通知用户设备已检测到
        console.log(`检测到设备: MAC=${data.mac}, 客户端ID=${data.clientId}`);
      });

      // 监听状态更新
      socketInstance.on('listenerStatusUpdate', (status: ListenerStatus) => {
        console.log('收到监听状态更新:', status);
        setListenerStatus(status);
      });
      
      // 命令响应
      socketInstance.on('commandResponse', (response: { success: boolean; message: string }) => {
        console.log('收到命令响应:', response);
      });
      
      // 电池数据更新
      socketInstance.on('batteryUpdate', (data: any) => {
        console.log('收到电池数据更新:', data);
      });
      
      // 网络扫描完成事件
      socketInstance.on('networkScanCompleted', (data: {
        totalScanned: number;
        foundServers: number;
        results: any[];
        duration: number;
        timestamp: string;
      }) => {
        console.log('🔍 网络扫描完成:', data);
        console.log(`📊 扫描结果: 扫描了${data.totalScanned}个IP，发现${data.foundServers}个Modbus服务器`);
        
        if (data.results && data.results.length > 0) {
          console.log('🎯 发现的Modbus设备:');
          data.results.forEach((device, index) => {
            console.log(`  ${index + 1}. IP: ${device.ip}, 端口: ${device.port || 502}, MAC: ${device.mac || '未知'}`);
          });
        }
      });
      
      // 自动连接完成事件
      socketInstance.on('autoConnectCompleted', (data: {
        totalDevices: number;
        successCount: number;
        results: any[];
        timestamp: string;
      }) => {
        console.log('🔗 自动连接完成:', data);
        console.log(`📊 连接结果: ${data.successCount}/${data.totalDevices} 个设备连接成功`);
        
        if (data.results && data.results.length > 0) {
          console.log('🎯 连接结果详情:');
          data.results.forEach((result, index) => {
            const status = result.success ? '✅ 成功' : '❌ 失败';
            console.log(`  ${index + 1}. ${result.ip}:${result.port} (MAC: ${result.mac || '未知'}) - ${status}: ${result.message}`);
          });
        }
        
        // 自动连接完成后，立即刷新设备列表
        setTimeout(() => {
          socketInstance.emit('getModbusConnections');
        }, 500);
      });

      return socketInstance;
    } catch (error) {
      console.error('创建Socket连接失败:', error);
      return null;
    }
  };

  // 初始化连接
  useEffect(() => {
    // 如果已经有连接且连接正常，不需要重新创建
    if (socket && socket.connected) {
      console.log('Socket连接已存在且正常，跳过重新创建');
      return;
    }
    
    const socketInstance = createSocketConnection();
    
    // 定期检查连接状态
    const checkConnectionInterval = setInterval(() => {
      if (socketInstance && !socketInstance.connected) {
        console.log('检测到连接断开，尝试重新连接...');
        socketInstance.connect();
      }
    }, 5000);
    
    // 添加页面卸载时的清理
    const handleBeforeUnload = () => {
      console.log('页面即将关闭，断开Socket连接');
      if (socketInstance && socketInstance.connected) {
        socketInstance.disconnect();
      }
    };
    
    // 监听页面卸载事件
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    // 清理函数 - 只清理定时器和事件监听器，不断开连接
    return () => {
      clearInterval(checkConnectionInterval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      // 注释掉断开连接的代码，让连接在页面切换时保持
      // if (socketInstance) {
      //   console.log('组件卸载，断开Socket连接');
      //   socketInstance.disconnect();
      // }
    };
  }, []); // 移除socket依赖，避免重复创建

  // 手动重连
  const reconnect = () => {
      console.log('手动重连...');
      const newSocket = createSocketConnection();
      setSocket(newSocket);
  };

  // 发送命令
  const sendCommand = (deviceId: string, command: number, parameters?: any): boolean => {
    if (!socket || !socket.connected) {
      console.error('Socket未连接，无法发送命令');
      return false;
    }

    try {
      console.log(`发送命令: 设备ID=${deviceId}, 命令=0x${command.toString(16).toUpperCase()}`);
      
      socket.emit('executeCommand', {
        deviceId,
        command,
        parameters
      });
      
      return true;
    } catch (error) {
      console.error('发送命令失败:', error);
      return false;
    }
  };

  return (
    <SocketContext.Provider value={{ 
      socket, 
      isConnected, 
      clients, 
      listenerStatus, 
      sendCommand,
      reconnect
    }}>
      {children}
    </SocketContext.Provider>
  );
};