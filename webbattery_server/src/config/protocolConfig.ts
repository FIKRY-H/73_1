// 协议配置 - 仅支持Modbus TCP
export enum ProtocolMode {
  MODBUS = 'modbus'
}

// 默认配置
export const defaultConfig = {
  // 协议模式 - 仅支持Modbus TCP
  protocol: ProtocolMode.MODBUS,
  
  // Modbus配置
  modbus: {
    defaultPort: 502,
    defaultDeviceId: 1,
    pollingInterval: 50, // 50ms轮询
    heartbeatInterval: 30000, // 30秒心跳
    maxReconnectAttempts: 5,
    reconnectDelay: 5000, // 5秒重连延迟
    
    // 寄存器地址映射
    registers: {
      // 电池数据寄存器起始地址
      batteryDataStart: 0,
      batteryDataCount: 50,
      
      // 命令寄存器地址
      commandRegister: 100,
      chargeControlRegister: 100,
      
      // 状态寄存器地址
      statusRegister: 200,
      
      // 设备信息寄存器地址
      deviceInfoStart: 300,
      deviceInfoCount: 10
    }
  },
  
  // 数据库配置
  database: {
    retentionDays: 30, // 数据保留天数
    cleanupInterval: 24 * 60 * 60 * 1000 // 24小时清理一次
  },
  
  // Socket.IO配置
  socketio: {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
  }
};

// 环境变量配置
export const getConfig = () => {
  return {
    ...defaultConfig,
    
    // 从环境变量覆盖配置
    protocol: ProtocolMode.MODBUS, // 固定为Modbus模式
    
    modbus: {
      ...defaultConfig.modbus,
      defaultPort: parseInt(process.env.MODBUS_PORT || '') || defaultConfig.modbus.defaultPort,
      defaultDeviceId: parseInt(process.env.MODBUS_DEVICE_ID || '') || defaultConfig.modbus.defaultDeviceId,
      pollingInterval: parseInt(process.env.MODBUS_POLLING_INTERVAL || '') || defaultConfig.modbus.pollingInterval
    }
  };
};

// 获取当前协议模式
export const getCurrentProtocol = (): ProtocolMode => {
  return ProtocolMode.MODBUS; // 固定返回Modbus模式
};

// 检查是否启用Modbus模式
export const isModbusMode = (): boolean => {
  return true; // 始终为true，因为只支持Modbus
};
