import { Server as SocketIOServer, Socket } from 'socket.io';
import { ClientConnection, FrameType } from '../models/batteryModel';
import { 
  saveBatteryData,
  getDeviceNumberByMac,
  processTestData
} from './batteryService';
// 仅使用Modbus TCP协议
import { 
  modbusEvents,
  getClientConnections as getModbusConnections,
  getConnectionStatus as getModbusStatus,
  createModbusClient,
  closeModbusClient,
  readHoldingRegisters,
  writeSingleRegister,
  sendModbusCommand,
  broadcastModbusCommand
} from './modbusService';
import { 
  getAllDevicesData,
  getDeviceData,
  startF1CyclicTest,
  startF2FastTest,
  startF2FastPolling,
  startF1CyclicPolling,
  stopPolling,
  stopTest,
  stopCyclicTest,
  getDeviceStates,
  clearDeviceStates,
  testNewProtocolFormat,
  updateReadStrategy,
  readDeviceData,
  sendDataToFrontend
} from './pollingService';
import { COMMAND_MAP } from '../utils/modbusFrameUtils';

// Store connected clients
const connectedClients = new Map<string, ClientConnection>();

// 全局变量声明
declare global {
  var f1PollingTimers: Map<string, NodeJS.Timeout> | undefined;
}

// 旧的startF1Polling函数已移除，现在使用pollingService.ts中的startF1CyclicPolling

// 防重复发送状态的缓存
const lastStatusSent = new Map<string, { [key: string]: number }>();
const STATUS_SEND_INTERVAL = 100; // 1秒内不重复发送相同状态

// 移除自动扫描配置

// 优化状态发送函数
const sendStatusUpdate = (io: SocketIOServer, eventName: string, data: any, socketId?: string) => {
  const now = Date.now();
  const key = `${eventName}_${socketId || 'broadcast'}`;
  const dataHash = JSON.stringify(data);
  
  if (!lastStatusSent.has(key)) {
    lastStatusSent.set(key, {});
  }
  
  const lastSent = lastStatusSent.get(key)!;
  const lastTime = lastSent[dataHash] || 0;
  
  if (now - lastTime > STATUS_SEND_INTERVAL) {
    if (socketId) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        socket.emit(eventName, data);
      }
    } else {
      io.emit(eventName, data);
    }
    lastSent[dataHash] = now;
  }
};



// 移除自动扫描相关函数

// Socket.IO server initialization
export const initializeSocketServer = (io: SocketIOServer): void => {
  console.log('初始化Socket.IO服务器...');
  
  // 初始化全局变量
  if (!global.f1PollingTimers) {
    global.f1PollingTimers = new Map();
  }
  
  // 清理所有全局定时器的函数
  const clearAllGlobalTimers = () => {
    console.log('清理所有全局F1轮询定时器...');
    if (global.f1PollingTimers) {
      global.f1PollingTimers.forEach((timer, connectionId) => {
        if (timer) {
          clearInterval(timer);
          console.log(`已清理全局F1定时器: ${connectionId}`);
        }
      });
      global.f1PollingTimers.clear();
    }
  };
  
  // 清理单个连接的全局定时器
  const clearGlobalTimer = (connectionId: string) => {
    if (global.f1PollingTimers && global.f1PollingTimers.has(connectionId)) {
      const timer = global.f1PollingTimers.get(connectionId);
      if (timer) {
        clearInterval(timer);
        global.f1PollingTimers.delete(connectionId);
        console.log(`已清理全局F1定时器: ${connectionId}`);
      }
    }
  };

  io.on('connection', (socket: Socket) => {
    console.log(`客户端连接: ${socket.id}`);

    // Handle client registration
    socket.on('register', (data: { mac: string, ipAddress: string, port: number }) => {
      const { mac, ipAddress, port } = data;
      
      const clientConnection: ClientConnection = {
        clientId: socket.id,
        ipAddress,
        port,
        lastHeartbeat: new Date(),
        isConnected: true,
        socket
      };

      // Store the connection
      connectedClients.set(socket.id, clientConnection);

      console.log(`Client registered: ${socket.id} with MAC: ${mac}`);

      // Store MAC in socket data
      socket.data.mac = mac;

      // Send back the client list
      socket.emit('clientsUpdate', Array.from(connectedClients.values()).map(client => ({
        socketId: client.clientId,
        id: client.clientId,
        mac: client.mac, // MAC地址字段
        address: client.ipAddress,
        port: client.port,
        lastHeartbeat: client.lastHeartbeat.toISOString(),
        isConnected: client.isConnected
      })));
    });

    // Handle incoming battery data (统一处理测试数据)
    socket.on('batteryData', async (data: { testType: 'F1' | 'F2', hexValues: string[] }) => {
      try {
        const { testType, hexValues } = data;
        console.log(`收到测试数据: 类型=${testType}, 数据=${hexValues.join(' ')}`);

        // 获取MAC地址：优先从Modbus连接中获取，确保与周期测试使用相同的MAC地址
        let mac = socket.data.mac || 'unknown';
        
        // 如果Socket没有MAC地址，尝试从Modbus连接中获取
        if (mac === 'unknown') {
          const clientIp = socket.handshake.address?.replace(/^::ffff:/, '') || socket.conn.remoteAddress?.replace(/^::ffff:/, '');
          console.log(`🔍 Socket客户端IP: ${clientIp}`);
          
          if (clientIp) {
            // 查找对应的Modbus连接
            const modbusConnections = getModbusConnections();
            const matchingConnection = modbusConnections.find(conn => 
              conn.host === clientIp || 
              conn.host === '127.0.0.1' && (clientIp === '127.0.0.1' || clientIp === 'localhost') ||
              conn.host === 'localhost' && (clientIp === '127.0.0.1' || clientIp === 'localhost')
            );
            
            if (matchingConnection && matchingConnection.mac) {
              mac = matchingConnection.mac;
              // 将MAC地址存储到socket中，避免重复查找
              socket.data.mac = mac;
              console.log(`✅ 从Modbus连接获取MAC地址: ${mac} (IP: ${clientIp})`);
            } else {
              console.log(`⚠️ 未找到对应的Modbus连接，使用IP作为标识: ${clientIp}`);
              mac = clientIp || 'unknown';
            }
          }
        }
        
        // Process test data using unified function
        const processedData = await processTestData(mac, hexValues, testType);

        if (processedData.success && processedData.data) {
          console.log(`测试数据处理完成 - 设备编号: ${processedData.data.deviceNumber}, MAC: ${processedData.data.mac}`);

          // 注意：数据保存已在pollingService.ts的sendDataToFrontend函数中处理
          // 这里不再重复保存，避免数据重复
          // await saveBatteryData(processedData.data);
          
          // 始终发送寄存器状态到前端
          if (processedData.data.status !== undefined) {
            // 兼容对象或数字两种格式，统一为原始数值
            const status = (processedData.data as any).status;
            const statusRegisterValue = typeof status === 'number'
              ? status
              : (status?.rawValue ?? status?.value);

            io.emit('registerStatusUpdate', {
              deviceNumber: (processedData.data as any).deviceNumber,
              mac: (processedData.data as any).mac,
              statusRegister: statusRegisterValue,
              controlRegisterA: (processedData.data as any).controlRegisterA,
              timestamp: (processedData.data as any).timestamp,
              isRegisterUpdate: true
            });
          }
          
          // 根据测试类型决定是否过滤DATA_READY位
          if (processedData.data.status !== undefined) {
            // processedData.data.status可能是对象或数字，需要兼容处理
            let dataReady = false;
            if (typeof processedData.data.status === 'object' && processedData.data.status && (processedData.data.status as any).dataReady !== undefined) {
              dataReady = (processedData.data.status as any).dataReady;
            } else if (typeof processedData.data.status === 'number') {
              // 按RS485文档：DATA_READY位位于bit8
              dataReady = (processedData.data.status & 0x0100) !== 0;
            }
           
           // 周期测试模式：无论dataready是否为1都广播数据
           // 快速测试模式：只有dataready为1时才广播数据
           const isCyclicTest = processedData.data.testType === FrameType.CyclicTest;
           
           if (isCyclicTest || dataReady) {
             // Broadcast to all connected socket clients
             io.emit('batteryUpdate', processedData.data);
             if (isCyclicTest) {
               console.log(`周期测试数据已广播 (DATA_READY=${dataReady ? 1 : 0})`);
             } else {
               console.log('快速测试数据已广播 (DATA_READY=1)');
             }
           } else {
             console.log('⚠️ 快速测试模式且DATA_READY位为0，跳过测试数据广播');
           }
         } else {
           console.log('⚠️ 状态寄存器未定义，跳过测试数据广播');
         }
          
          console.log('测试数据已处理并广播');
        } else {
          console.error('测试数据处理失败:', processedData.error);
          socket.emit('error', { message: processedData.error });
        }
      } catch (error) {
        console.error('处理测试数据时出错:', error);
        socket.emit('error', { message: '处理测试数据时出错' });
      }
    });

    // 移除旧的batteryDataLegacy处理逻辑

    // 移除旧的executeCommand处理逻辑
    
    // 移除旧的executeBatchCommands处理逻辑

    // 移除旧的readRegisters处理逻辑



    // Handle get modbus status request (for Modbus mode)
    socket.on('getModbusStatus', () => {
      const status = getModbusStatus();
      console.log(`发送Modbus状态到 ${socket.id}:`, status);
      sendStatusUpdate(io, 'modbusStatusUpdate', status, socket.id);
    });

    // Handle modbus connection request
    socket.on('createModbusConnection', async (data: { host: string, port?: number, deviceId?: number }) => {
      try {
        const { host, port = 502, deviceId = 1 } = data;
        const connectionId = await createModbusClient(host, port, deviceId);
        
        socket.emit('modbusConnectionResponse', {
          success: true,
          connectionId,
          message: 'Modbus连接创建成功'
        });
      } catch (error) {
        socket.emit('modbusConnectionResponse', {
          success: false,
          message: `创建Modbus连接失败: ${error}`
        });
      }
    });

    // Handle connectModbus event (alias for createModbusConnection)
    socket.on('connectModbus', async (data: { host: string, port?: number, deviceId?: number }) => {
      try {
        const { host, port = 502, deviceId = 1 } = data;
        const connectionId = await createModbusClient(host, port, deviceId);
        
        socket.emit('modbusConnectionResponse', {
          success: true,
          connectionId,
          message: 'Modbus连接创建成功'
        });
      } catch (error) {
        socket.emit('modbusConnectionResponse', {
          success: false,
          message: `创建Modbus连接失败: ${error}`
        });
      }
    });

    // Handle modbus disconnect request
    socket.on('disconnectModbus', async (data: { connectionId: string }) => {
      try {
        await closeModbusClient(data.connectionId);
        
        socket.emit('modbusDisconnectResponse', {
          success: true,
          message: 'Modbus连接已关闭'
        });
      } catch (error) {
        socket.emit('modbusDisconnectResponse', {
          success: false,
          message: `关闭Modbus连接失败: ${error}`
        });
      }
    });

    // Handle modbus command request
    socket.on('sendModbusCommand', async (data: { connectionId: string, command: number, parameters?: number[] }) => {
      try {
        const { connectionId, command, parameters = [] } = data;
        await sendModbusCommand(connectionId, command, parameters);
        
        socket.emit('modbusCommandResponse', {
          success: true,
          message: 'Modbus命令发送成功'
        });
      } catch (error) {
        socket.emit('modbusCommandResponse', {
          success: false,
          message: `发送Modbus命令失败: ${error}`
        });
      }
    });

    // Handle modbus broadcast command request
    socket.on('broadcastModbusCommand', async (data: { command: number, parameters?: number[] }) => {
      try {
        const { command, parameters = [] } = data;
        const result = await broadcastModbusCommand(command, parameters);
        
        const successCount = Object.values(result).filter(r => !(r instanceof Error)).length;
        const failedCount = Object.values(result).filter(r => r instanceof Error).length;
        
        socket.emit('modbusBroadcastResponse', {
          success: true,
          message: `Modbus广播命令完成: 成功=${successCount}, 失败=${failedCount}`,
          result: {
            success: successCount,
            failed: failedCount,
            details: result
          }
        });
      } catch (error) {
        socket.emit('modbusBroadcastResponse', {
          success: false,
          message: `Modbus广播命令失败: ${error}`
        });
      }
    });

    // Handle get clients request (兼容性支持，重定向到Modbus连接)
    socket.on('getClients', () => {
      const modbusConnections = getModbusConnections();
      const clientList = modbusConnections.map(conn => ({
        id: conn.id,
        mac: conn.mac || `${conn.host}:${conn.port}`,
        address: conn.host,
        port: conn.port,
        isConnected: conn.isConnected,
        lastHeartbeat: conn.lastHeartbeat.toISOString()
      }));
      console.log(`发送客户端列表到 ${socket.id}: ${clientList.length} 个Modbus设备`);
      sendStatusUpdate(io, 'clientsUpdate', clientList, socket.id);
    });

    // Handle get modbus connections request
    socket.on('getModbusConnections', () => {
      const modbusConnections = getModbusConnections();
      const connectionList = modbusConnections.map(conn => ({
        socketId: conn.id,
        id: conn.id,
        host: conn.host,
        port: conn.port,
        deviceId: conn.deviceId,
        isConnected: conn.isConnected,
        lastHeartbeat: conn.lastHeartbeat ? conn.lastHeartbeat.toISOString() : new Date().toISOString(),
        mac: conn.mac
      }));
      
      console.log(`发送Modbus连接列表到 ${socket.id}:`, connectionList.length, '个连接', connectionList);
      sendStatusUpdate(io, 'modbusConnectionsUpdate', connectionList, socket.id);
    });

    // Handle get all devices data request
    socket.on('getAllDevicesData', async () => {
      try {
        console.log('获取所有设备数据请求');
        
        const devicesData = await getAllDevicesData();
        
        socket.emit('allDevicesDataResponse', {
          success: true,
          data: devicesData,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        socket.emit('allDevicesDataResponse', {
          success: false,
          message: `获取设备数据失败: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle get single device data request
    socket.on('getDeviceData', async (data: { connectionId: string }) => {
      try {
        const { connectionId } = data;
        console.log(`获取设备数据请求: ${connectionId}`);
        
        const deviceData = await getDeviceData(connectionId);
        
        socket.emit('deviceDataResponse', {
          success: true,
          connectionId,
          data: deviceData,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        socket.emit('deviceDataResponse', {
          success: false,
          connectionId: data.connectionId,
          message: `获取设备数据失败: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle F1 cyclic test request
    socket.on('startF1CyclicTest', async (data: { connectionId: string, periodSeconds?: number }) => {
      try {
        const { connectionId, periodSeconds = 3 } = data; // 默认3秒间隔
        console.log(`启动F1周期测试: ${connectionId}, 周期: ${periodSeconds}秒`);
        
        // 检查设备连接状态
        const connections = getModbusConnections();
        const activeConnections = connections.filter(conn => conn.isConnected);
        const deviceCount = activeConnections.length;
        
        console.log(`🔍 WebSocket F1测试设备数量检查: 当前连接${deviceCount}台设备`);
        
        if (deviceCount === 0) {
          console.log(`❌ WebSocket F1测试启动被拒绝 ${connectionId}: 没有连接的设备`);
          socket.emit('startF1CyclicTestResponse', {
            success: false,
            connectionId,
            periodSeconds,
            message: 'F1测试功能已禁用：没有连接的设备',
            timestamp: new Date().toISOString()
          });
          return;
        }
        
        // 直接启动F1轮询，不等待写命令响应
        console.log(`🚀 直接启动F1轮询 ${connectionId}: 周期=${periodSeconds}秒`);
        
        // 启动F1轮询（包含写命令发送和立即开始轮询读取）
        const pollingStarted = await startF1CyclicPolling(connectionId, periodSeconds, undefined, 0x0001);
        
        if (pollingStarted) {
          console.log(`✅ F1周期轮询已启动 ${connectionId}: 周期=${periodSeconds}秒`);
        } else {
          console.error(`❌ F1周期轮询启动失败 ${connectionId}`);
        }
        
        socket.emit('startF1CyclicTestResponse', {
          success: pollingStarted,
          connectionId,
          periodSeconds,
          result: pollingStarted,
          message: pollingStarted ? 'F1轮询已启动' : 'F1轮询启动失败',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error(`❌ F1周期测试启动失败 ${data.connectionId}:`, error);
        socket.emit('startF1CyclicTestResponse', {
          success: false,
          connectionId: data.connectionId,
          periodSeconds: data.periodSeconds,
          message: `启动F1周期测试失败: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle F2 fast test request
    socket.on('startF2FastTest', async (data: { connectionId: string, targetUnitId?: number }) => {
      try {
        const { connectionId, targetUnitId } = data;
        
        // 获取连接信息以确定设备ID
        const connections = getModbusConnections();
        const connection = connections.find(c => c.id === connectionId);
        // 优先使用传入的targetUnitId，其次使用连接的deviceId，最后默认为1
        const unitId = targetUnitId || connection?.deviceId || 1;
        
        console.log(`启动F2快速测试: ${connectionId}, UnitID=${unitId}`);
        
        // 检查设备连接状态
        const activeConnections = connections.filter(conn => conn.isConnected);
        const deviceCount = activeConnections.length;
        
        console.log(`🔍 WebSocket F2测试设备数量检查: 当前连接${deviceCount}台设备`);
        
        if (deviceCount === 0) {
          console.log(`❌ WebSocket F2测试启动被拒绝 ${connectionId}: 没有连接的设备`);
          socket.emit('startF2FastTestResponse', {
            success: false,
            connectionId,
            message: 'F2测试功能已禁用：没有连接的设备',
            timestamp: new Date().toISOString()
          });
          return;
        }
        
        const result = await startF2FastTest(connectionId, unitId);
        
        socket.emit('startF2FastTestResponse', {
          success: true,
          connectionId,
          result,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        socket.emit('startF2FastTestResponse', {
          success: false,
          connectionId: data.connectionId,
          message: `启动F2快速测试失败: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle stop test request
    socket.on('stopTest', async (data: { connectionId: string }) => {
      try {
        const { connectionId } = data;
        console.log(`停止测试: ${connectionId}`);
        
        // 停止所有轮询（包括F1和F2）
        const { stopPolling } = await import('./pollingService');
        const pollingStopResult = stopPolling(connectionId);
        if (pollingStopResult) {
          console.log(`⏹️ 轮询已停止 ${connectionId}`);
        }
        
        // 删除寄存器监控停止代码，不再需要处理状态寄存器与控制寄存器
        
        // 清理全局定时器
        clearGlobalTimer(connectionId);
        
        // 注意：已移除F1等待响应机制，无需清理等待状态
        
        const result = await stopTest(connectionId);
        
        socket.emit('stopTestResponse', {
          success: true,
          connectionId,
          result,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        socket.emit('stopTestResponse', {
          success: false,
          connectionId: data.connectionId,
          message: `停止测试失败: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    // 删除clearStatusAlarm事件处理器，不再需要处理状态寄存器与控制寄存器

    // Handle get device states request
    socket.on('getDeviceStates', () => {
      try {
        const deviceStates = getDeviceStates();
        
        socket.emit('deviceStatesUpdate', {
          deviceStates,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        socket.emit('deviceStatesUpdate', {
          deviceStates: {},
          error: `获取设备状态失败: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle clear device states request
    socket.on('clearDeviceStates', () => {
      try {
        clearDeviceStates();
        
        socket.emit('clearDeviceStatesResponse', {
          success: true,
          message: '设备状态已清除',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        socket.emit('clearDeviceStatesResponse', {
          success: false,
          message: `清除设备状态失败: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle test new protocol format request
    socket.on('testNewProtocolFormat', () => {
      try {
        console.log('测试新协议格式请求');
        
        const result = testNewProtocolFormat();
        updateReadStrategy();
        
        socket.emit('testNewProtocolFormatResponse', {
          success: true,
          result,
          message: '新协议格式测试完成，请查看控制台输出',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        socket.emit('testNewProtocolFormatResponse', {
          success: false,
          message: `测试新协议格式失败: ${error}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle batch connect request
    socket.on('batchConnectDevices', async (data: { devices: Array<{ ip: string, port?: number, deviceId?: number }> }) => {
      try {
        const { devices } = data;
        console.log(`批量连接设备请求: ${devices.length} 个设备`);
        
        const results = [];
        
        for (const device of devices) {
          try {
            const { ip, port = 502, deviceId = 1 } = device;
            const connectionId = await createModbusClient(ip, port, deviceId);
            
            results.push({
              ip,
              port,
              deviceId,
              connectionId,
              success: true,
              message: '连接成功'
            });
          } catch (error) {
            results.push({
              ip: device.ip,
              port: device.port || 502,
              deviceId: device.deviceId || 1,
              success: false,
              message: `连接失败: ${error}`
            });
          }
        }
        
        socket.emit('batchConnectResponse', {
          success: true,
          message: `批量连接完成，成功: ${results.filter(r => r.success).length}/${results.length}`,
          results
        });
      } catch (error) {
        socket.emit('batchConnectResponse', {
          success: false,
          message: `批量连接失败: ${error}`
        });
      }
    });

    // Handle command by identifier request
    socket.on('sendCommandByIdentifier', async (data: { 
      identifier: string, 
      command: string, 
      register?: number, 
      value?: number, 
      quantity?: number
    }) => {
      try {
        const { identifier, command, register, value, quantity } = data;
        console.log(`按标识符发送命令: ${identifier}, 命令: ${command}`);
        
        // 使用Modbus协议处理
        const connections = getModbusConnections();
        
        // 根据MAC或IP查找对应的连接
        const targetConnections = connections.filter(conn => {
          return conn.host === identifier || conn.mac === identifier;
        });
        
        if (targetConnections.length === 0) {
          socket.emit('commandByIdentifierResponse', {
            success: false,
            message: `未找到标识符为 ${identifier} 的Modbus设备连接`
          });
          return;
        }
        
        const results = [];
        
        for (const connection of targetConnections) {
          try {
            let result;
            
            // 根据命令类型执行不同的操作
            switch (command) {
              case 'queryStatus':
                result = await sendModbusCommand(connection.id, COMMAND_MAP.QUERY_STATUS, []);
                break;
              default:
                const commandCode = COMMAND_MAP[command as keyof typeof COMMAND_MAP] || 
                                  (typeof command === 'string' ? parseInt(command, 16) : command);
                result = await sendModbusCommand(connection.id, commandCode, [register, value, quantity].filter((x): x is number => x !== undefined));
            }
            
            results.push({
              connectionId: connection.id,
              host: connection.host,
              mac: connection.mac,
              success: true,
              result
            });
          } catch (error) {
            results.push({
              connectionId: connection.id,
              host: connection.host,
              mac: connection.mac,
              success: false,
              error: (error as Error).message
            });
          }
        }
        
        socket.emit('commandByIdentifierResponse', {
          success: true,
          message: `Modbus命令发送完成，成功: ${results.filter(r => r.success).length}/${results.length}`,
          results
        });
      } catch (error) {
        socket.emit('commandByIdentifierResponse', {
          success: false,
          message: `发送命令失败: ${error}`
        });
      }
    });



    // 移除自动扫描配置相关事件

    // Handle battery data update for testing
    socket.on('batteryDataUpdate', (data) => {
      console.log('收到测试电池数据:', data);
      
      // 检查是否为寄存器状态更新，如果是则直接转发
      if (data.isRegisterUpdate) {
        io.emit('registerStatusUpdate', data);
        console.log('转发寄存器状态更新');
        return;
      }
      
      // 对于电池数据，检查DATA_READY位和测试类型
      if (data.status !== undefined) {
        // data.status可能是对象或数字，需要兼容处理
        let dataReady = false;
        if (typeof data.status === 'object' && data.status && (data.status as any).dataReady !== undefined) {
          dataReady = (data.status as any).dataReady;
        } else if (typeof data.status === 'number') {
          // 按RS485文档：DATA_READY位位于bit8
          dataReady = (data.status & 0x0100) !== 0;
        }
        
        // 检查测试类型
        const isCyclicTest = data.testType === FrameType.CyclicTest;
        
        if (isCyclicTest) {
          // 周期测试：无论DATA_READY是否为1都广播数据
          io.emit('batteryUpdate', data);
          io.emit('batteryDataUpdate', data);
          console.log(`周期测试：转发电池数据 (DATA_READY=${dataReady ? 1 : 0})`);
        } else if (dataReady) {
          // 快速测试：只有DATA_READY为1时才广播数据
          io.emit('batteryUpdate', data);
          io.emit('batteryDataUpdate', data);
          console.log('快速测试：转发电池数据 (DATA_READY=1)');
        } else {
          console.log('⚠️ 快速测试模式且DATA_READY位为0，跳过电池数据转发');
        }
      } else {
        console.log('⚠️ 状态寄存器未定义，跳过电池数据转发');
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`客户端断开连接: ${socket.id}`);
      connectedClients.delete(socket.id);
      // 清理该客户端的状态发送缓存
      lastStatusSent.delete(socket.id);
      
      // 如果是最后一个客户端断开，清理所有定时器
      if (connectedClients.size === 0) {
        console.log('所有客户端已断开，清理所有定时器...');
        clearAllGlobalTimers();
        // 导入并调用停止所有轮询的函数
        const { stopAllPolling } = require('./pollingService');
        stopAllPolling();
        // 删除寄存器监控停止代码，不再需要处理状态寄存器与控制寄存器
      }
    });
  });

  // TCP事件监听器已移除，仅保留Modbus TCP协议支持

  // ===== Modbus 事件监听器 =====
  
  // 监听Modbus客户端连接事件
  modbusEvents.on('clientConnected', (data) => {
    console.log('Modbus客户端连接事件:', data);
    
    // 广播连接状态更新给所有Socket.IO客户端
    const status = getModbusStatus();
    sendStatusUpdate(io, 'modbusStatusUpdate', status);
    
    // 广播连接列表更新
    const modbusConnections = getModbusConnections();
    const connectionList = modbusConnections.map(conn => ({
      socketId: conn.id,
      id: conn.id,
      host: conn.host,
      port: conn.port,
      deviceId: conn.deviceId,
      isConnected: conn.isConnected,
      lastHeartbeat: conn.lastHeartbeat.toISOString(),
      mac: conn.mac
    }));
    
    sendStatusUpdate(io, 'modbusConnectionsUpdate', connectionList);
  });

  // 监听Modbus客户端断开事件
  modbusEvents.on('clientDisconnected', (data) => {
    console.log('Modbus客户端断开事件:', data);
    
    // 广播连接状态更新给所有Socket.IO客户端
    const status = getModbusStatus();
    sendStatusUpdate(io, 'modbusStatusUpdate', status);
    
    // 广播连接列表更新
    const modbusConnections = getModbusConnections();
    const connectionList = modbusConnections.map(conn => ({
      socketId: conn.id,
      id: conn.id,
      host: conn.host,
      port: conn.port,
      deviceId: conn.deviceId,
      isConnected: conn.isConnected,
      lastHeartbeat: conn.lastHeartbeat.toISOString(),
      mac: conn.mac
    }));
    
    sendStatusUpdate(io, 'modbusConnectionsUpdate', connectionList);
  });

  // 监听Modbus连接错误事件
  modbusEvents.on('connectionError', (data) => {
    console.log('Modbus连接错误事件:', data);
    
    // 广播错误信息给所有Socket.IO客户端
    io.emit('modbusConnectionError', {
      connectionId: data.connectionId,
      error: data.error,
      timestamp: new Date().toISOString()
    });
  });

  // 监听Modbus重连成功事件
  modbusEvents.on('reconnectSuccess', (data) => {
    console.log('Modbus重连成功事件:', data);
    
    // 广播重连成功信息
    io.emit('modbusReconnectSuccess', {
      connectionId: data.connectionId,
      timestamp: new Date().toISOString()
    });
  });

  // 监听Modbus重连失败事件
  modbusEvents.on('reconnectFailed', (data) => {
    console.log('Modbus重连失败事件:', data);
    
    // 广播重连失败信息
    io.emit('modbusReconnectFailed', {
      connectionId: data.connectionId,
      attempts: data.attempts,
      timestamp: new Date().toISOString()
    });
  });



  // 监听Modbus电池数据接收事件
  modbusEvents.on('batteryDataReceived', async (data) => {
    console.log('Modbus电池数据接收事件:', data);
    
    try {
      // 获取连接信息
      const connections = getModbusConnections();
      const connection = connections.find(c => c.id === data.connectionId);
      
      if (!connection) {
        console.error('未找到Modbus连接:', data.connectionId);
        return;
      }
      
      // 使用Modbus TCP帧解析工具解析数据
      const { parseRawModbusTCPFrame } = await import('../utils/modbusFrameUtils');
      const parseResult = parseRawModbusTCPFrame(data.data);
      
      if (!parseResult.isValid) {
        console.error('Modbus帧解析失败:', parseResult.error);
        return;
      }
      
      const batteryData = parseResult.batteryData;
      if (!batteryData) {
        console.error('未解析到电池数据');
        return;
      }
      
      // 检查是否为写命令响应（功能码0x06）
      if (batteryData.writeSuccess) {
        console.log('✅ 收到写寄存器响应: ' + data.data.toString('hex'));
        // 注意：现在不再等待写命令响应来启动F1轮询，轮询已在写命令发送后立即启动
        
        return;
      }
      
      // 只处理读命令的响应数据（功能码0x03），确保有有效的电池数据
      if (batteryData.status === undefined && batteryData.voltage === undefined) {
        console.log(data.data.toString('hex'));
        return;
      }
      
      // 额外检查：如果没有任何阻抗数据，也跳过
      if (!batteryData.r1 && !batteryData.r2 && !batteryData.r3 && !batteryData.bat3_r1 && !batteryData.bat4_r1) {
        console.log('⚠️ 跳过无阻抗数据的响应: ' + data.data.toString('hex'));
        return;
      }
      
      // 使用IP地址+设备地址的组合作为唯一标识
      const unitId = batteryData.unitId || 1; // 获取Modbus设备地址，默认为1
      const mac = `${connection.host}_${unitId.toString().padStart(2, '0')}`; // 格式：IP_设备地址
      
      console.log(`🔍 Modbus电池数据解析完成:`);
      console.log(`   连接IP: ${connection.host}`);
      console.log(`   设备地址: 0x${unitId.toString(16).padStart(2, '0')}`);
      console.log(`   设备标识: ${mac}`);
      console.log(`   解析结果:`, batteryData);
      
      // 自动获取或分配设备编号
      const { getDeviceNumberByMac } = await import('../services/batteryService');
      const deviceNumber = await getDeviceNumberByMac(mac);
      
      // 根据当前轮询状态判断测试类型
       const { FrameType } = await import('../models/batteryModel');
       let testType = FrameType.CyclicTest; // 默认值
       
       // 导入pollingService来检查当前轮询状态
       const { getPollingStatus } = await import('./pollingService');
       const pollingStatus = getPollingStatus();
       
       // 查找当前连接的轮询状态
       const currentPolling = pollingStatus.find(p => p.connectionId === connection.id);
       if (currentPolling) {
         if (currentPolling.type === 'F1') {
           testType = FrameType.CyclicTest; // F1周期测试
           console.log(`🔍 基于F1轮询状态判断测试类型: ${testType} (周期测试)`);
         } else if (currentPolling.type === 'F2') {
           testType = FrameType.FastTest; // F2快速测试
           console.log(`🔍 基于F2轮询状态判断测试类型: ${testType} (快速测试)`);
         }
       } else {
         // 如果没有活跃轮询，默认为周期测试
         testType = FrameType.CyclicTest;
         console.log(`🔍 无活跃轮询，默认为周期测试: ${testType}`);
       }
       
       // 检查DATA_READY位状态
       let dataReady = false;
       if (batteryData.status !== undefined) {
         if (typeof batteryData.status === 'object' && batteryData.status && (batteryData.status as any).dataReady !== undefined) {
           dataReady = (batteryData.status as any).dataReady;
         } else if (typeof batteryData.status === 'number') {
           // 使用modbusFrameUtils中的STATUS_BITS定义
           const { STATUS_BITS } = await import('../utils/modbusFrameUtils');
           dataReady = (batteryData.status & STATUS_BITS.DATA_READY) !== 0;
         }
       }
       
       // 构建电池数据对象
      const processedBatteryData = {
        deviceNumber,
        mac,
        status: batteryData.status,
        voltage: batteryData.voltage || 0,
        b2Voltage: batteryData.b2Voltage || 0,
        
        controlRegisterA: batteryData.controlRegisterA,
        controlRegisterB: batteryData.controlRegisterB,

        r1: batteryData.r1,
        r2: batteryData.r2,
        r3: batteryData.r3,
        // 修改映射关系：r1→R_ohm，r2→R_sei，r3→R_ct
        rOhm: batteryData.r1?.actual || 0,
        rSei: batteryData.r2?.actual || 0,
        rCt: batteryData.r3?.actual || 0,
        
        // 新增电池数据
        bat3_r1: batteryData.bat3_r1,
        bat3_r2: batteryData.bat3_r2,
        bat3_r3: batteryData.bat3_r3,
        bat4_r1: batteryData.bat4_r1,
        bat4_r2: batteryData.bat4_r2,
        bat4_r3: batteryData.bat4_r3,
        
        testType: testType, // 使用自动判断的测试类型
        timestamp: new Date().toISOString()
      };
       
       // 根据测试类型决定是否过滤dataready=0的数据
       // 周期测试模式：无论dataready是否为1都处理数据
       // 快速测试模式：只有dataready为1时才处理数据
       const isCyclicTest = testType === FrameType.CyclicTest;
       
       if (!isCyclicTest && !dataReady) {
         // 仍保存到数据库，但跳过前端数据广播
         console.log(`⚠️ 快速测试模式且DATA_READY位为0，仍保存数据但跳过广播 设备编号=${deviceNumber}`);
       }
      
      console.log(`Modbus电池数据处理完成 - 设备编号: ${deviceNumber}, 主机: ${connection.host}`);

      // 保存数据到数据库，保证IP与设备地址同步写入
      try {
        const { saveBatteryData } = await import('../services/batteryService');
        await saveBatteryData({
          ...processedBatteryData,
          ip_prefix: connection.host,
          device_address: unitId.toString().padStart(2, '0')
        } as any);
        console.log(`💾 电池数据已保存到数据库: MAC=${mac}, IP=${connection.host}, Addr=${unitId.toString().padStart(2, '0')}`);
      } catch (saveErr) {
        console.error('保存Modbus电池数据到数据库失败:', saveErr);
      }
      
      // 始终发送寄存器状态到前端（0x0000状态寄存器、0x0001/0x0002控制寄存器，以及部分数据寄存器）
      if (batteryData.status !== undefined) {
        // 兼容对象或数字两种格式，统一为原始数值
        const status = batteryData.status as any;
        const statusRegisterValue = typeof status === 'number'
          ? status
          : (status?.rawValue ?? status?.value);

        io.emit('registerStatusUpdate', {
          deviceNumber: processedBatteryData.deviceNumber,
          mac: processedBatteryData.mac,
          statusRegister: statusRegisterValue,
          controlRegisterA: (batteryData as any).controlRegisterA,
          controlRegisterB: (batteryData as any).controlRegisterB,
          r1: (batteryData as any).r1?.value,
          r2: (batteryData as any).r2?.value,
          timestamp: processedBatteryData.timestamp,
          isRegisterUpdate: true
        });
        console.log('寄存器状态已发送到前端');
      }
      
      // 注意：数据保存已在此处完成，避免在其他路径重复保存
      
      // 根据测试类型和DATA_READY位决定是否广播电池数据
      if (isCyclicTest) {
        // 周期测试：无论DATA_READY是否为1都广播数据
        io.emit('batteryUpdate', processedBatteryData);
        console.log(`周期测试模式：Modbus电池数据已处理并广播 (DATA_READY=${dataReady ? 1 : 0})`);
      } else if (dataReady) {
        // 快速测试：只有DATA_READY为1时才广播数据
        io.emit('batteryUpdate', processedBatteryData);
        console.log('快速测试模式：Modbus电池数据已处理并广播 (DATA_READY=1)');
      } else {
        console.log('快速测试模式：DATA_READY=0，跳过电池数据广播');
      }
      
    } catch (error) {
      console.error('处理Modbus电池数据时出错:', error);
    }
    
    // 同时保留原始的数据事件广播（用于调试）
    io.emit('modbusDataReceived', {
      connectionId: data.connectionId,
      data: data.data.toString('hex'),
      timestamp: data.timestamp.toISOString()
    });
  });

  // 监听Modbus命令发送事件
  modbusEvents.on('commandSent', (data) => {
    console.log('Modbus命令发送事件:', data);
    
    // 广播命令发送事件
    io.emit('modbusCommandSent', {
      connectionId: data.connectionId,
      command: data.command,
      parameters: data.parameters,
      timestamp: new Date().toISOString()
    });
  });

  // 监听Modbus广播命令完成事件
  modbusEvents.on('broadcastCommandComplete', (data) => {
    console.log('Modbus广播命令完成事件:', data);
    
    // 广播命令完成事件
    io.emit('modbusBroadcastComplete', {
      command: data.command,
      parameters: data.parameters,
      success: data.success,
      failed: data.failed,
      timestamp: new Date().toISOString()
    });
  });

  // 数据采样服务事件监听器已移除，改为按需获取数据

  console.log('Socket.IO服务器初始化完成（仅支持Modbus TCP协议）');
  console.log('🚀 网络扫描功能：输入指定IP扫描局域网段');
  console.log('🔌 默认端口: 502 (Modbus TCP)')
};