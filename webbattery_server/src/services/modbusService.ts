import net from 'net';
import { EventEmitter } from 'events';
import { getMacByIp } from '../utils/arpUtils';
import { getLocalNetworkInterfaces } from '../utils/arpUtils';
// 删除状态寄存器监控相关的import，不再需要处理状态寄存器与控制寄存器

// Modbus TCP连接接口
interface ModbusConnection {
  id: string;
  deviceSeq: number; // 设备序号，按连接顺序递增
  socket: net.Socket;
  host: string;
  port: number;
  deviceId: number;
  isConnected: boolean;
  lastActivity: Date;
  mac?: string;
}

// 存储所有Modbus连接
const connections = new Map<string, ModbusConnection>();

// 全局设备序号计数器
let deviceSequenceCounter = 1;

// 存储心跳定时器
const heartbeatTimers = new Map<string, NodeJS.Timeout>();

// 命令队列，避免并发命令冲突
export const commandQueues = new Map<string, Array<() => Promise<any>>>();
const processingCommands = new Map<string, boolean>();
const MAX_QUEUE_SIZE = 100; // 增加队列长度，确保100ms轮询不被丢弃

// 事件发射器
export const modbusEvents = new EventEmitter();

// 心跳间隔（毫秒）
const HEARTBEAT_INTERVAL = 10000; // 10秒
// Socket超时时间（毫秒）
const SOCKET_TIMEOUT = 1800000; // 30分钟，防止长时间无操作断开
const COMMAND_TIMEOUT = 120000; // 120秒命令超时，包括写响应和读响应

// 生成连接ID
const generateConnectionId = (host: string, port: number, deviceId: number): string => {
  return `${host}:${port}:${deviceId}`;
};

// 处理命令队列
const processCommandQueue = async (connectionId: string): Promise<void> => {
  if (processingCommands.get(connectionId)) {
    return; // 已经在处理队列
  }

  processingCommands.set(connectionId, true);
  const queue = commandQueues.get(connectionId) || [];

  while (queue.length > 0) {
    const command = queue.shift();
    if (command) {
      try {
        await command();
      } catch (error) {
        console.error(`队列命令执行失败 ${connectionId}:`, error);
      }
    }
  }

  processingCommands.set(connectionId, false);
};

// 添加命令到队列
const enqueueCommand = <T>(connectionId: string, commandFn: () => Promise<T>): Promise<T> => {
  return new Promise((resolve, reject) => {
    const queue = commandQueues.get(connectionId) || [];

    // 检查队列大小，如果超过限制则清理旧命令
    if (queue.length >= MAX_QUEUE_SIZE) {
      console.warn(`命令队列已满 ${connectionId}，清理旧命令`);
      // 清理队列中的旧命令，保留最近的一半命令
      const keepCount = Math.floor(MAX_QUEUE_SIZE / 2);
      while (queue.length > keepCount) {
        queue.shift();
      }
    }

    const wrappedCommand = async () => {
      try {
        const result = await commandFn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    };

    queue.push(wrappedCommand);
    commandQueues.set(connectionId, queue);

    // 启动队列处理
    processCommandQueue(connectionId);
  });
};

// 发送心跳查询
const sendHeartbeat = async (connectionId: string): Promise<void> => {
  try {
    const connection = connections.get(connectionId);
    if (!connection || !connection.isConnected) {
      stopHeartbeat(connectionId);
      return;
    }

    // 检查连接是否正在处理其他命令，如果是则跳过本次心跳
    if (connection.socket.readyState !== 'open') {
      console.log(`跳过心跳，连接状态异常: ${connectionId}`);
      return;
    }

    // 使用简单的TCP连接检查作为心跳，避免与业务命令冲突
    // 只更新最后活动时间，不发送实际的Modbus命令
    connection.lastActivity = new Date();
    console.log(`心跳检查完成: ${connectionId}`);
  } catch (error) {
    console.error(`心跳检查失败 ${connectionId}:`, error);
    // 心跳失败，可能连接已断开
    stopHeartbeat(connectionId);
    const connection = connections.get(connectionId);
    if (connection) {
      connection.isConnected = false;
      modbusEvents.emit('connectionError', { connectionId, error });
    }
  }
};

// 启动心跳
const startHeartbeat = (connectionId: string): void => {
  // 先清除可能存在的旧定时器
  stopHeartbeat(connectionId);

  // 设置新的心跳定时器
  const timer = setInterval(() => {
    sendHeartbeat(connectionId);
  }, HEARTBEAT_INTERVAL);

  heartbeatTimers.set(connectionId, timer);
  console.log(`心跳已启动: ${connectionId}`);
};

// 停止心跳
const stopHeartbeat = (connectionId: string): void => {
  const timer = heartbeatTimers.get(connectionId);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(connectionId);
    console.log(`心跳已停止: ${connectionId}`);
  }
};

// 获取本机MAC地址
const getLocalMacAddress = async (): Promise<string> => {
  try {
    const interfaces = getLocalNetworkInterfaces();
    // 优先选择非回环接口
    for (const iface of interfaces) {
      if (!(iface as any).internal && (iface as any).family === 'IPv4' && (iface as any).mac) {
        return (iface as any).mac;
      }
    }
    // 如果没有找到，返回第一个有MAC地址的接口
    for (const iface of interfaces) {
      if ((iface as any).mac) {
        return (iface as any).mac;
      }
    }
    return '00:00:00:00:00:00'; // 默认MAC地址
  } catch (error) {
    console.error('获取本机MAC地址失败:', error);
    return '00:00:00:00:00:00';
  }
};

// 创建Modbus TCP客户端连接
export const createModbusClient = async (host: string, port: number, deviceId: number): Promise<string> => {
  const connectionId = generateConnectionId(host, port, deviceId);

  // 如果连接已存在，先关闭
  if (connections.has(connectionId)) {
    await closeModbusClient(connectionId);
  }

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    const connection: ModbusConnection = {
      id: connectionId,
      deviceSeq: deviceSequenceCounter++, // 分配递增的设备序号
      socket,
      host,
      port,
      deviceId,
      isConnected: false,
      lastActivity: new Date()
    };

    // 连接超时设置
    socket.setTimeout(SOCKET_TIMEOUT);

    socket.connect(port, host, async () => {
      console.log(`Modbus TCP连接已建立: ${connectionId}`);
      connection.isConnected = true;
      connection.lastActivity = new Date();

      // 获取MAC地址
      try {
        if (host === '127.0.0.1' || host === 'localhost') {
          // 本机连接，使用本机MAC地址
          connection.mac = await getLocalMacAddress();
        } else {
          // 远程连接，通过ARP表获取MAC地址
          connection.mac = await getMacByIp(host) || '00:00:00:00:00:00';
        }
      } catch (error) {
        console.warn(`获取MAC地址失败 ${host}:`, error);
        connection.mac = '00:00:00:00:00:00';
      }

      connections.set(connectionId, connection);

      // 启动心跳机制
      startHeartbeat(connectionId);

      // 立即发送一次初始查询以确认连接
      setTimeout(() => {
        sendHeartbeat(connectionId);
      }, 1000); // 1秒后发送初始查询

      modbusEvents.emit('connectionCreated', connection);
      modbusEvents.emit('clientConnected', { connectionId, host, port, deviceId });

      // 启动寄存器状态监控
      try {
        // 检查连接设备数量
        const allConnections = Array.from(connections.values());
        const activeConnections = allConnections.filter(conn => conn.isConnected);
        const deviceCount = activeConnections.length;

        // 删除寄存器监控启动代码，不再需要处理状态寄存器与控制寄存器
        console.log(`✅ 设备连接成功: ${connectionId} (设备数量: ${deviceCount})`);
      } catch (error) {
        console.warn(`⚠️ 设备连接处理失败: ${connectionId}`, error);
      }

      resolve(connectionId);
    });

    socket.on('data', (data) => {
      connection.lastActivity = new Date();
      modbusEvents.emit('dataReceived', connectionId, data);
      modbusEvents.emit('batteryDataReceived', { connectionId, data, timestamp: new Date() });
    });

    socket.on('error', (error) => {
      console.error(`Modbus连接错误 ${connectionId}:`, error);
      connection.isConnected = false;
      modbusEvents.emit('connectionError', { connectionId, error });
      reject(error);
    });

    socket.on('close', () => {
      console.log(`Modbus连接已关闭: ${connectionId}`);
      connection.isConnected = false;

      // 停止心跳机制
      stopHeartbeat(connectionId);

      // 删除寄存器监控停止代码，不再需要处理状态寄存器与控制寄存器

      connections.delete(connectionId);
      modbusEvents.emit('connectionClosed', connectionId);
      modbusEvents.emit('clientDisconnected', { connectionId });
    });

    socket.on('timeout', () => {
      console.error(`Modbus连接超时: ${connectionId}`);
      socket.destroy();
      reject(new Error('连接超时'));
    });
  });
};

// 关闭Modbus客户端连接
export const closeModbusClient = async (connectionId: string): Promise<void> => {
  const connection = connections.get(connectionId);
  if (connection) {
    // 停止心跳机制
    stopHeartbeat(connectionId);

    // 删除寄存器监控停止代码，不再需要处理状态寄存器与控制寄存器

    // 清理命令队列
    commandQueues.delete(connectionId);
    processingCommands.delete(connectionId);

    connection.socket.destroy();
    connections.delete(connectionId);
    console.log(`Modbus连接已关闭: ${connectionId}`);
  }
};

// 关闭所有Modbus客户端连接
export const closeAllModbusClients = async (): Promise<void> => {
  for (const [connectionId, connection] of connections) {
    // 停止心跳机制
    stopHeartbeat(connectionId);
    connection.socket.destroy();
  }
  connections.clear();

  // 删除所有寄存器监控停止代码，不再需要处理状态寄存器与控制寄存器

  // 清理所有命令队列
  commandQueues.clear();
  processingCommands.clear();

  console.log('所有Modbus连接已关闭');
};

// 获取连接状态
export const getConnectionStatus = (connectionId?: string) => {
  if (connectionId) {
    const connection = connections.get(connectionId);
    return connection ? {
      id: connection.id, // 使用真正的连接ID
      connectionId: connection.id,
      deviceSeq: connection.deviceSeq,
      host: connection.host,
      port: connection.port,
      deviceId: connection.deviceId,
      isConnected: connection.isConnected,
      lastActivity: connection.lastActivity,
      lastHeartbeat: connection.lastActivity,
      mac: connection.mac
    } : null;
  }

  return Array.from(connections.values()).map(conn => ({
    id: conn.id, // 使用真正的连接ID
    connectionId: conn.id,
    deviceSeq: conn.deviceSeq,
    host: conn.host,
    port: conn.port,
    deviceId: conn.deviceId,
    isConnected: conn.isConnected,
    lastActivity: conn.lastActivity,
    lastHeartbeat: conn.lastActivity,
    mac: conn.mac
  }));
};

// 获取客户端连接列表
export const getClientConnections = () => {
  return Array.from(connections.values()).map(conn => ({
    id: conn.id, // 使用真正的连接ID
    connectionId: conn.id,
    deviceSeq: conn.deviceSeq,
    host: conn.host,
    port: conn.port,
    deviceId: conn.deviceId,
    isConnected: conn.isConnected,
    lastActivity: conn.lastActivity,
    lastHeartbeat: conn.lastActivity,
    mac: conn.mac
  }));
};

// 发送Modbus命令（内部函数，不使用队列）- 等待响应版本（用于读命令）
const sendCommandDirect = async (connectionId: string, command: Buffer): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  try {
    console.log(`发送命令到 ${connectionId}: ${command.toString('hex')}`);
    connection.socket.write(command);
    connection.lastActivity = new Date();
    console.log(`✅ 命令已发送到 ${connectionId}，数据将通过事件异步返回`);
  } catch (error) {
    console.error(`❌ 发送命令失败 ${connectionId}:`, error);
    throw error;
  }
};

// 发送Modbus写命令（单向发送，不等待响应）
const sendWriteCommandDirect = async (connectionId: string, command: Buffer): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  try {
    console.log(`发送写命令到 ${connectionId}: ${command.toString('hex')}`);
    connection.socket.write(command);
    connection.lastActivity = new Date();
    console.log(`✅ 写命令已发送到 ${connectionId}，无需等待响应`);
  } catch (error) {
    console.error(`❌ 发送写命令失败 ${connectionId}:`, error);
    throw error;
  }
};

// 发送Modbus命令（使用队列）- 等待响应版本（用于读命令）
export const sendCommand = async (connectionId: string, command: Buffer): Promise<void> => {
  return enqueueCommand(connectionId, () => sendCommandDirect(connectionId, command));
};

// 发送Modbus写命令（使用队列，单向发送）
export const sendWriteCommand = async (connectionId: string, command: Buffer): Promise<void> => {
  return enqueueCommand(connectionId, () => sendWriteCommandDirect(connectionId, command));
};

// 发送Modbus读命令（单向发送，不等待响应）
const sendReadCommandDirect = async (connectionId: string, command: Buffer): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  try {
    console.log(`发送读命令到 ${connectionId}: ${command.toString('hex')}`);
    connection.socket.write(command);
    connection.lastActivity = new Date();
    console.log(`✅ 读命令已发送到 ${connectionId}，数据将通过事件异步返回`);
  } catch (error) {
    console.error(`❌ 发送读命令失败 ${connectionId}:`, error);
    throw error;
  }
};

// 发送Modbus读命令（使用队列，单向发送）
export const sendReadCommand = async (connectionId: string, command: Buffer): Promise<void> => {
  return enqueueCommand(connectionId, () => sendReadCommandDirect(connectionId, command));
};

// 广播命令到所有连接
export const broadcastCommand = async (command: Buffer): Promise<{ [connectionId: string]: boolean | Error }> => {
  const results: { [connectionId: string]: boolean | Error } = {};

  const promises = Array.from(connections.entries()).map(async ([connectionId, connection]) => {
    if (connection.isConnected) {
      try {
        await sendCommand(connectionId, command);
        results[connectionId] = true;
      } catch (error) {
        results[connectionId] = error as Error;
      }
    }
  });

  await Promise.all(promises);
  return results;
};

// 读取输入寄存器（单向发送，不等待响应）
export const readInputRegisters = async (connectionId: string, address: number, quantity: number): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  // 构建Modbus TCP读取输入寄存器命令
  const transactionId = Math.floor(Math.random() * 65536);
  const protocolId = 0x0000;
  const length = 6; // Unit ID + Function Code + Address + Quantity
  const unitId = connection.deviceId;
  const functionCode = 0x04; // 读取输入寄存器

  const frame = Buffer.alloc(12);
  let offset = 0;

  // MBAP Header
  frame.writeUInt16BE(transactionId, offset); offset += 2;
  frame.writeUInt16BE(protocolId, offset); offset += 2;
  frame.writeUInt16BE(length, offset); offset += 2;
  frame.writeUInt8(unitId, offset); offset += 1;

  // PDU
  frame.writeUInt8(functionCode, offset); offset += 1;
  frame.writeUInt16BE(address, offset); offset += 2;
  frame.writeUInt16BE(quantity, offset); offset += 2;

  console.log(`📤 读输入寄存器 ${connectionId}: 地址=0x${address.toString(16).padStart(4, '0')}, 数量=${quantity}`);
  return sendCommand(connectionId, frame);
};

// 读取输入寄存器（单向发送，不等待响应）
export const readInputRegistersOneWay = async (connectionId: string, address: number, quantity: number): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  // 构建Modbus TCP读取输入寄存器命令
  const transactionId = Math.floor(Math.random() * 65536);
  const protocolId = 0x0000;
  const length = 6; // Unit ID + Function Code + Address + Quantity
  const unitId = connection.deviceId;
  const functionCode = 0x04; // 读取输入寄存器

  const frame = Buffer.alloc(12);
  let offset = 0;

  // MBAP Header
  frame.writeUInt16BE(transactionId, offset); offset += 2;
  frame.writeUInt16BE(protocolId, offset); offset += 2;
  frame.writeUInt16BE(length, offset); offset += 2;
  frame.writeUInt8(unitId, offset); offset += 1;

  // PDU
  frame.writeUInt8(functionCode, offset); offset += 1;
  frame.writeUInt16BE(address, offset); offset += 2;
  frame.writeUInt16BE(quantity, offset); offset += 2;

  console.log(`📤 读输入寄存器 ${connectionId}: 地址=0x${address.toString(16).padStart(4, '0')}, 数量=${quantity}`);
  return sendReadCommand(connectionId, frame);
};

// 轮询读取输入寄存器（地址01-12）（单向发送，不等待响应）
// 删除readInputRegistersPolling函数，统一使用readHoldingRegistersPolling

// 读取保持寄存器（单向发送，不等待响应）
export const readHoldingRegisters = async (connectionId: string, address: number, quantity: number): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  // 构建Modbus TCP读取保持寄存器命令
  const transactionId = Math.floor(Math.random() * 65536);
  const protocolId = 0x0000;
  const length = 6; // Unit ID + Function Code + Address + Quantity
  const unitId = connection.deviceId;
  const functionCode = 0x03; // 读取保持寄存器

  const frame = Buffer.alloc(12);
  let offset = 0;

  // MBAP Header
  frame.writeUInt16BE(transactionId, offset); offset += 2;
  frame.writeUInt16BE(protocolId, offset); offset += 2;
  frame.writeUInt16BE(length, offset); offset += 2;
  frame.writeUInt8(unitId, offset); offset += 1;

  // PDU
  frame.writeUInt8(functionCode, offset); offset += 1;
  frame.writeUInt16BE(address, offset); offset += 2;
  frame.writeUInt16BE(quantity, offset); offset += 2;

  console.log(`读保持寄存器 ${connectionId}: 地址=0x${address.toString(16).padStart(4, '0')}, 数量=${quantity}`);
  return sendCommand(connectionId, frame);
};

// 读取保持寄存器（单向发送，不等待响应）
export const readHoldingRegistersOneWay = async (connectionId: string, address: number, quantity: number): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  // 构建Modbus TCP读取保持寄存器命令
  const transactionId = Math.floor(Math.random() * 65536);
  const protocolId = 0x0000;
  const length = 6; // Unit ID + Function Code + Address + Quantity
  const unitId = connection.deviceId;
  const functionCode = 0x03; // 读取保持寄存器

  const frame = Buffer.alloc(12);
  let offset = 0;

  // MBAP Header
  frame.writeUInt16BE(transactionId, offset); offset += 2;
  frame.writeUInt16BE(protocolId, offset); offset += 2;
  frame.writeUInt16BE(length, offset); offset += 2;
  frame.writeUInt8(unitId, offset); offset += 1;

  // PDU
  frame.writeUInt8(functionCode, offset); offset += 1;
  frame.writeUInt16BE(address, offset); offset += 2;
  frame.writeUInt16BE(quantity, offset); offset += 2;

  console.log(`读保持寄存器 ${connectionId}: 地址=0x${address.toString(16).padStart(4, '0')}, 数量=${quantity}`);
  return sendReadCommand(connectionId, frame);
};

// 发送命令并等待响应（带超时）
const sendCommandAndWaitResponse = (connectionId: string, command: Buffer, transactionId: number, timeoutMs: number): Promise<boolean> => {
  return enqueueCommand(connectionId, () => {
    return new Promise<boolean>((resolve) => {
      const connection = connections.get(connectionId);
      if (!connection || !connection.isConnected) {
        resolve(false);
        return;
      }

      let isResolved = false;
      let timer: NodeJS.Timeout;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        modbusEvents.off('dataReceived', responseHandler);
      };

      const responseHandler = (connId: string, data: Buffer) => {
        if (connId === connectionId && !isResolved) {
          if (data.length >= 2) {
            const recvTxId = data.readUInt16BE(0);
            if (recvTxId === transactionId) {
              isResolved = true;
              cleanup();
              resolve(true);
            }
          }
        }
      };

      modbusEvents.on('dataReceived', responseHandler);

      timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          // console.log(`⚠️ 等待响应超时 ${connectionId}: TxID=0x${transactionId.toString(16)}`);
          resolve(false);
        }
      }, timeoutMs);

      try {
        connection.socket.write(command);
        connection.lastActivity = new Date();
      } catch (error) {
        console.error(`发送命令失败 ${connectionId}:`, error);
        if (!isResolved) {
          isResolved = true;
          cleanup();
          resolve(false);
        }
      }
    });
  });
};

// 轮询读取保持寄存器（地址01-0C）（等待响应或超时）
export const readHoldingRegistersPolling = async (connectionId: string, registerAddress: number, quantity: number): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  // 轮询地址01到0C
  for (let unitId = 0x01; unitId <= 0x0C; unitId++) {
    try {
      // 构建Modbus TCP读取保持寄存器命令
      const transactionId = Math.floor(Math.random() * 65536);
      const protocolId = 0x0000;
      const length = 6; // Unit ID + Function Code + Address + Quantity
      const functionCode = 0x03; // 读取保持寄存器

      const frame = Buffer.alloc(12);
      let offset = 0;

      // MBAP Header
      frame.writeUInt16BE(transactionId, offset); offset += 2;
      frame.writeUInt16BE(protocolId, offset); offset += 2;
      frame.writeUInt16BE(length, offset); offset += 2;
      frame.writeUInt8(unitId, offset); offset += 1;

      // PDU
      frame.writeUInt8(functionCode, offset); offset += 1;
      frame.writeUInt16BE(registerAddress, offset); offset += 2;
      frame.writeUInt16BE(quantity, offset); offset += 2;

      console.log(`📤 轮询读取 ${connectionId}: UnitID=0x${unitId.toString(16).padStart(2, '0')}, TxID=0x${transactionId.toString(16)}`);

      // 使用200ms超时等待响应
      // 接收到响应或超时后，立即继续下一个
      await sendCommandAndWaitResponse(connectionId, frame, transactionId, 200);

    } catch (error) {
      console.warn(`轮询读取保持寄存器设备地址 0x${unitId.toString(16).padStart(2, '0')} 失败:`, error);
      // 继续轮询下一个地址
    }
  }
};

// 使用固定Transaction ID读取保持寄存器并返回数据
export const readHoldingRegistersWithFixedTxId = async (connectionId: string, transactionId: number, address: number, quantity: number, targetUnitId?: number): Promise<Buffer | null> => {
  const connection = connections.get(connectionId);
  if (!connection) {
    console.error(`未找到Modbus连接: ${connectionId}`);
    return null;
  }
  if (!connection.isConnected) {
    console.error(`Modbus连接未建立: ${connectionId}`);
    return null;
  }

  // 构建Modbus TCP读取保持寄存器命令，使用固定Transaction ID
  const protocolId = 0x0000;
  const length = 6; // Unit ID + Function Code + Address + Quantity
  const unitId = targetUnitId !== undefined ? targetUnitId : connection.deviceId;
  const functionCode = 0x03; // 读取保持寄存器

  const frame = Buffer.alloc(12);
  let offset = 0;

  // MBAP Header
  frame.writeUInt16BE(transactionId, offset); offset += 2;
  frame.writeUInt16BE(protocolId, offset); offset += 2;
  frame.writeUInt16BE(length, offset); offset += 2;
  frame.writeUInt8(unitId, offset); offset += 1;

  // PDU
  frame.writeUInt8(functionCode, offset); offset += 1;
  frame.writeUInt16BE(address, offset); offset += 2;
  frame.writeUInt16BE(quantity, offset); offset += 2;

  console.log(`读保持寄存器(固定TxID) ${connectionId}: TxID=0x${transactionId.toString(16).padStart(4, '0')}, UnitID=${unitId}, 地址=0x${address.toString(16).padStart(4, '0')}, 数量=${quantity}`);

  // 发送命令并等待响应
  return enqueueCommand(connectionId, () => {
    return new Promise<Buffer | null>((resolve) => {
      let isResolved = false;
      let timer: NodeJS.Timeout;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        modbusEvents.off('dataReceived', responseHandler);
      };

      const responseHandler = (connId: string, data: Buffer) => {
        if (connId === connectionId && !isResolved) {
          // 检查Transaction ID
          if (data.length >= 8) {
            const recvTxId = data.readUInt16BE(0);
            if (recvTxId === transactionId) {
              // 检查功能码 (Offset 7)
              const fc = data.readUInt8(7);
              if (fc === 0x03) {
                // 提取数据: Byte Count (Offset 8) + Data
                const byteCount = data.readUInt8(8);
                // 宽松检查：只要数据长度足够包含 byteCount 字节的数据即可
                // 即使数据包末尾有多余字节，或者数据包长度正好，都接受
                if (data.length >= 9 + byteCount) {
                  const payload = data.subarray(9, 9 + byteCount);
                  isResolved = true;
                  cleanup();
                  resolve(payload);
                  return;
                } else {
                  console.warn(`Modbus响应数据长度不足 ${connectionId}: 期望至少${9 + byteCount}字节，实际${data.length}字节`);
                }
              } else if (fc === 0x83) {
                // 异常响应
                console.warn(`Modbus异常响应 ${connectionId}: TxID=0x${transactionId.toString(16)}, Code=0x${data.readUInt8(8).toString(16)}`);
                isResolved = true;
                cleanup();
                resolve(null);
                return;
              }
            }
          }
        }
      };

      modbusEvents.on('dataReceived', responseHandler);

      // 250ms 超时
      timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          // console.log(`⚠️ 读响应超时 ${connectionId}: TxID=0x${transactionId.toString(16)}`);
          resolve(null);
        }
      }, 250);

      try {
        connection.socket.write(frame);
        connection.lastActivity = new Date();
      } catch (error) {
        console.error(`发送命令失败 ${connectionId}:`, error);
        if (!isResolved) {
          isResolved = true;
          cleanup();
          resolve(null);
        }
      }
    });
  });
};

// 写入单个寄存器（单向发送，不等待响应，使用广播地址）
export const writeSingleRegister = async (connectionId: string, address: number, value: number): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  // 构建Modbus TCP写入单个寄存器命令
  const transactionId = Math.floor(Math.random() * 65536);
  const protocolId = 0x0000;
  const length = 6; // Unit ID + Function Code + Address + Value
  const unitId = 0xFF; // 使用广播地址
  const functionCode = 0x06; // 写入单个寄存器

  const frame = Buffer.alloc(12);
  let offset = 0;

  // MBAP Header
  frame.writeUInt16BE(transactionId, offset); offset += 2;
  frame.writeUInt16BE(protocolId, offset); offset += 2;
  frame.writeUInt16BE(length, offset); offset += 2;
  frame.writeUInt8(unitId, offset); offset += 1;

  // PDU
  frame.writeUInt8(functionCode, offset); offset += 1;
  frame.writeUInt16BE(address, offset); offset += 2;
  frame.writeUInt16BE(value, offset); offset += 2;

  console.log(`📤 写单个寄存器 ${connectionId}: 广播地址=0xFF, 寄存器地址=0x${address.toString(16).padStart(4, '0')}, 值=0x${value.toString(16).padStart(4, '0')}`);
  return sendWriteCommand(connectionId, frame);
};

// 使用固定Transaction ID写入单个寄存器（单向发送，不等待响应）
export const writeSingleRegisterWithFixedTxId = async (
  connectionId: string,
  transactionId: number,
  address: number,
  value: number,
  targetUnitId: number = 0xFF // 默认为广播地址
): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection) {
    console.error(`未找到Modbus连接: ${connectionId}`);
    console.log(`当前连接列表: ${Array.from(connections.keys()).join(', ')}`);
    throw new Error(`连接不存在: ${connectionId}`);
  }
  if (!connection.isConnected) {
    console.error(`Modbus连接未建立: ${connectionId}`);
    throw new Error(`连接未建立: ${connectionId}`);
  }

  console.log(`📤 Modbus写命令详情 ${connectionId}: TxID=0x${transactionId.toString(16).padStart(4, '0')}, UnitID=${targetUnitId}, 功能码=0x06, 寄存器=0x${address.toString(16).padStart(4, '0')}, 值=0x${value.toString(16).padStart(4, '0')}`);

  // 构建Modbus TCP写入单个寄存器命令，使用固定Transaction ID
  const protocolId = 0x0000;
  const length = 6; // Unit ID + Function Code + Address + Value
  const unitId = targetUnitId;
  const functionCode = 0x06; // 写入单个寄存器

  const frame = Buffer.alloc(12);
  let offset = 0;

  // MBAP Header
  frame.writeUInt16BE(transactionId, offset); offset += 2;
  frame.writeUInt16BE(protocolId, offset); offset += 2;
  frame.writeUInt16BE(length, offset); offset += 2;
  frame.writeUInt8(unitId, offset); offset += 1;

  // PDU
  frame.writeUInt8(functionCode, offset); offset += 1;
  frame.writeUInt16BE(address, offset); offset += 2;
  frame.writeUInt16BE(value, offset); offset += 2;

  console.log(`📡 发送Modbus帧 ${connectionId}: ${frame.toString('hex').toUpperCase()}`);

  await sendWriteCommand(connectionId, frame);

  console.log(`✅ Modbus写命令已发送 ${connectionId}，无需等待响应`);
};

// 写入多个寄存器（单向发送，不等待响应）
export const writeMultipleRegisters = async (connectionId: string, address: number, values: number[]): Promise<void> => {
  const connection = connections.get(connectionId);
  if (!connection || !connection.isConnected) {
    throw new Error(`连接不存在或未连接: ${connectionId}`);
  }

  // 构建Modbus TCP写入多个寄存器命令（使用广播地址）
  const transactionId = Math.floor(Math.random() * 65536);
  const protocolId = 0x0000;
  const quantity = values.length;
  const byteCount = quantity * 2;
  const length = 7 + byteCount; // Unit ID + Function Code + Address + Quantity + Byte Count + Data
  const unitId = 0xFF; // 使用广播地址
  const functionCode = 0x10; // 写入多个寄存器

  const frame = Buffer.alloc(13 + byteCount);
  let offset = 0;

  // MBAP Header
  frame.writeUInt16BE(transactionId, offset); offset += 2;
  frame.writeUInt16BE(protocolId, offset); offset += 2;
  frame.writeUInt16BE(length, offset); offset += 2;
  frame.writeUInt8(unitId, offset); offset += 1;

  // PDU
  frame.writeUInt8(functionCode, offset); offset += 1;
  frame.writeUInt16BE(address, offset); offset += 2;
  frame.writeUInt16BE(quantity, offset); offset += 2;
  frame.writeUInt8(byteCount, offset); offset += 1;

  // 写入寄存器值
  for (const value of values) {
    frame.writeUInt16BE(value, offset);
    offset += 2;
  }

  console.log(`📤 写多个寄存器 ${connectionId}: 广播地址=0xFF, 寄存器地址=0x${address.toString(16).padStart(4, '0')}, 数量=${quantity}, 值=[${values.map(v => '0x' + v.toString(16).padStart(4, '0')).join(', ')}]`);
  return sendWriteCommand(connectionId, frame);
};



// 发送Modbus命令（兼容性函数）
export const sendModbusCommand = async (connectionId: string, command: number, parameters: number[] = []): Promise<void> => {

  // 根据命令类型构建相应的Modbus帧
  switch (command) {
    case 0x03: // 读取保持寄存器
      const address = parameters[0] || 0;
      const quantity = parameters[1] || 1;
      return readHoldingRegisters(connectionId, address, quantity);

    case 0x04: // 读取输入寄存器
      const inputAddress = parameters[0] || 0;
      const inputQuantity = parameters[1] || 1;
      return readInputRegisters(connectionId, inputAddress, inputQuantity);

    case 0x06: // 写入单个寄存器
      const regAddress = parameters[0] || 0;
      const regValue = parameters[1] || 0;
      return writeSingleRegister(connectionId, regAddress, regValue);

    case 0x10: // 写入多个寄存器
      const startAddr = parameters[0] || 0;
      const values = parameters.slice(1) || [0];
      return writeMultipleRegisters(connectionId, startAddr, values);

    default:
      // 对于其他命令，构建通用的Modbus TCP帧
      const transactionId = Math.floor(Math.random() * 65536);
      const protocolId = 0x0000;
      const connection = connections.get(connectionId);
      if (!connection || !connection.isConnected) {
        throw new Error(`连接不存在或未连接: ${connectionId}`);
      }
      const unitId = connection.deviceId;

      // 根据命令值大小决定使用的字节数
      const commandBytes = command <= 255 ? 1 : 2;
      const length = 1 + commandBytes + parameters.length * 2; // Unit ID + Function Code + Parameters

      const frame = Buffer.alloc(6 + length);
      let offset = 0;

      // MBAP Header
      frame.writeUInt16BE(transactionId, offset); offset += 2;
      frame.writeUInt16BE(protocolId, offset); offset += 2;
      frame.writeUInt16BE(length, offset); offset += 2;
      frame.writeUInt8(unitId, offset); offset += 1;

      // PDU - 根据命令值大小选择合适的写入方式
      if (command <= 255) {
        frame.writeUInt8(command, offset); offset += 1;
      } else {
        // 对于大于255的命令值，使用16位格式
        frame.writeUInt16BE(command, offset); offset += 2;
      }

      // Parameters
      for (const param of parameters) {
        frame.writeUInt16BE(param, offset);
        offset += 2;
      }

      return sendCommand(connectionId, frame);
  }
};

// 广播Modbus命令（兼容性函数）
export const broadcastModbusCommand = async (command: number, parameters: number[] = []): Promise<{ [connectionId: string]: boolean | Error }> => {
  const results: { [connectionId: string]: boolean | Error } = {};

  const promises = Array.from(connections.keys()).map(async (connectionId) => {
    try {
      await sendModbusCommand(connectionId, command, parameters);
      results[connectionId] = true;
    } catch (error) {
      results[connectionId] = error as Error;
    }
  });

  await Promise.all(promises);
  return results;
};