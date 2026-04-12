import { Request, Response } from 'express';
import { 
  createModbusClient, 
  closeModbusClient, 
  closeAllModbusClients,
  getConnectionStatus,
  getClientConnections,
  sendModbusCommand,
  sendCommand,
  broadcastCommand,
  readHoldingRegisters,
  readInputRegisters,
  readHoldingRegistersPolling,
  writeSingleRegister,
  writeMultipleRegisters
} from '../services/modbusService';
import { pingSubnet, pingConnectedGateways, PingResult, extractConnectableDevices, pingIP, discoverLocalGateways } from '../utils/networkUtils';
import { COMMAND_MAP, REGISTER_MAP, getCommandDescription } from '../utils/modbusFrameUtils';

// 创建Modbus TCP客户端连接
export const createConnection = async (req: Request, res: Response) => {
  try {
    const { host, port = 502, deviceId = 1 } = req.body;

    if (!host) {
      return res.status(400).json({
        success: false,
        message: '主机地址不能为空'
      });
    }

    const connectionId = await createModbusClient(host, port, deviceId);
    
    res.json({
      success: true,
      message: 'Modbus TCP客户端连接创建成功',
      connectionId
    });
  } catch (error) {
    console.error('创建Modbus连接失败:', error);
    res.status(500).json({
      success: false,
      message: `创建连接失败: ${error}`
    });
  }
};



// 批量连接发现的Modbus服务器
export const batchConnectDevices = async (req: Request, res: Response) => {
  try {
    const { devices } = req.body;
    
    if (!Array.isArray(devices) || devices.length === 0) {
      return res.status(400).json({
        success: false,
        message: '设备列表不能为空'
      });
    }
    
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
    
    res.json({
      success: true,
      message: `批量连接完成，成功: ${results.filter(r => r.success).length}/${results.length}`,
      results
    });
  } catch (error) {
    console.error('批量连接失败:', error);
    res.status(500).json({
      success: false,
      message: `批量连接失败: ${error}`
    });
  }
};

// 根据MAC地址或IP地址发送命令
export const sendCommandByIdentifier = async (req: Request, res: Response) => {
  try {
    const { identifier, command, register, value, quantity } = req.body;
    
    if (!identifier || !command) {
      return res.status(400).json({
        success: false,
        message: '设备标识符和命令不能为空'
      });
    }
    
    // 获取所有连接
    const connections = getClientConnections();
    
    // 根据MAC或IP查找对应的连接
    const targetConnections = connections.filter(conn => {
      return conn.host === identifier || conn.mac === identifier;
    });
    
    if (targetConnections.length === 0) {
      return res.status(404).json({
        success: false,
        message: `未找到标识符为 ${identifier} 的设备连接`
      });
    }
    
    const results = [];
    
    for (const connection of targetConnections) {
      try {
        let result;
        
        switch (command) {
          case 'readHoldingRegisters':
            await readHoldingRegistersPolling(connection.id, register, quantity || 1);
            result = { success: true, message: '读命令已发送，无需等待响应' };
            break;
          case 'readInputRegisters':
            await readHoldingRegistersPolling(connection.id, register, quantity || 1);
            result = { success: true, message: '读命令已发送，无需等待响应' };
            break;
          case 'writeSingleRegister':
            await writeSingleRegister(connection.id, register, value);
            result = { success: true, message: '写命令已发送，无需等待响应' };
            break;
          case 'writeMultipleRegisters':
            await writeMultipleRegisters(connection.id, register, Array.isArray(value) ? value : [value]);
            result = { success: true, message: '写命令已发送，无需等待响应' };
            break;

          case 'queryStatus':
            result = await sendCommand(connection.id, Buffer.from([COMMAND_MAP.QUERY_STATUS]));
            break;
          default:
            // 对于其他命令，尝试从命令映射中查找
            const commandCode = COMMAND_MAP[command as keyof typeof COMMAND_MAP] || 
                              (typeof command === 'string' ? parseInt(command, 16) : command);
            const parameters = [register, value, quantity].filter(x => x !== undefined);
            result = await sendCommand(connection.id, Buffer.from([commandCode, ...parameters]));
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
    
    res.json({
      success: true,
      message: `命令发送完成，成功: ${results.filter(r => r.success).length}/${results.length}`,
      results
    });
  } catch (error) {
    console.error('发送命令失败:', error);
    res.status(500).json({
      success: false,
      message: `发送命令失败: ${error}`
    });
  }
};

// 按分组批量发送命令
export const sendCommandByGroup = async (req: Request, res: Response) => {
  try {
    const { groupType, groupValue, command, register, value, quantity } = req.body;
    
    if (!groupType || !groupValue || !command) {
      return res.status(400).json({
        success: false,
        message: '分组类型、分组值和命令不能为空'
      });
    }
    
    // 获取所有连接
    const connections = getClientConnections();
    
    // 根据分组类型筛选连接
    let targetConnections = [];
    
    switch (groupType) {
      case 'subnet':
        // 按子网分组
        targetConnections = connections.filter(conn => {
          const hostParts = conn.host.split('.');
          const subnetPrefix = hostParts.slice(0, 3).join('.');
          return subnetPrefix === groupValue;
        });
        break;
      case 'mac':
        // 按MAC地址分组
        targetConnections = connections.filter(conn => conn.mac === groupValue);
        break;
      case 'all':
        // 所有设备
        targetConnections = connections;
        break;
      default:
        return res.status(400).json({
          success: false,
          message: `不支持的分组类型: ${groupType}`
        });
    }
    
    if (targetConnections.length === 0) {
      return res.status(404).json({
        success: false,
        message: `未找到分组 ${groupType}:${groupValue} 的设备连接`
      });
    }
    
    const results = [];
    
    for (const connection of targetConnections) {
      try {
        let result;
        
        switch (command) {
          case 'readHoldingRegisters':
            await readHoldingRegistersPolling(connection.id, register, quantity || 1);
            result = { success: true, message: '读命令已发送，无需等待响应' };
            break;
          case 'readInputRegisters':
            await readHoldingRegistersPolling(connection.id, register, quantity || 1);
            result = { success: true, message: '读命令已发送，无需等待响应' };
            break;
          case 'writeSingleRegister':
            await writeSingleRegister(connection.id, register, value);
            result = { success: true, message: '写命令已发送，无需等待响应' };
            break;
          case 'writeMultipleRegisters':
            await writeMultipleRegisters(connection.id, register, Array.isArray(value) ? value : [value]);
            result = { success: true, message: '写命令已发送，无需等待响应' };
            break;

          case 'queryStatus':
            result = await sendCommand(connection.id, Buffer.from([COMMAND_MAP.QUERY_STATUS]));
            break;
          default:
            // 对于其他命令，尝试从命令映射中查找
            const commandCode = COMMAND_MAP[command as keyof typeof COMMAND_MAP] || 
                              (typeof command === 'string' ? parseInt(command, 16) : command);
            const parameters = [register, value, quantity].filter(x => x !== undefined);
            result = await sendCommand(connection.id, Buffer.from([commandCode, ...parameters]));
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
    
    res.json({
      success: true,
      message: `分组命令发送完成，成功: ${results.filter(r => r.success).length}/${results.length}`,
      results,
      group: {
        type: groupType,
        value: groupValue,
        deviceCount: targetConnections.length
      }
    });
  } catch (error) {
    console.error('发送分组命令失败:', error);
    res.status(500).json({
      success: false,
      message: `发送分组命令失败: ${error}`
    });
  }
};

// 关闭Modbus TCP客户端连接
export const closeConnection = async (req: Request, res: Response) => {
  try {
    const { connectionId } = req.params;

    if (!connectionId) {
      return res.status(400).json({
        success: false,
        message: '连接ID不能为空'
      });
    }

    await closeModbusClient(connectionId);
    
    res.json({
      success: true,
      message: 'Modbus TCP客户端连接关闭成功'
    });
  } catch (error) {
    console.error('关闭Modbus连接失败:', error);
    res.status(500).json({
      success: false,
      message: `关闭连接失败: ${error}`
    });
  }
};

// 关闭所有Modbus TCP客户端连接
export const closeAllConnections = async (req: Request, res: Response) => {
  try {
    await closeAllModbusClients();
    
    res.json({
      success: true,
      message: '所有Modbus TCP客户端连接已关闭'
    });
  } catch (error) {
    console.error('关闭所有Modbus连接失败:', error);
    res.status(500).json({
      success: false,
      message: `关闭所有连接失败: ${error}`
    });
  }
};

// 获取连接状态
export const getStatus = async (req: Request, res: Response) => {
  try {
    const status = getConnectionStatus();
    res.json({
      success: true,
      status
    });
  } catch (error) {
    console.error('获取连接状态失败:', error);
    res.status(500).json({
      success: false,
      message: `获取连接状态失败: ${error}`
    });
  }
};

// 获取所有连接信息
export const getConnections = async (req: Request, res: Response) => {
  try {
    const connections = getClientConnections();
    res.json({
      success: true,
      connections
    });
  } catch (error) {
    console.error('获取连接信息失败:', error);
    res.status(500).json({
      success: false,
      message: `获取连接信息失败: ${error}`
    });
  }
};

// 发送命令到指定连接
export const sendCommandToConnection = async (req: Request, res: Response) => {
  try {
    const { connectionId, command, parameters = [] } = req.body;

    if (!connectionId || command === undefined) {
      return res.status(400).json({
        success: false,
        message: '连接ID和命令不能为空'
      });
    }

    // 构建Modbus命令Buffer
    const commandBuffer = Buffer.from([command, ...parameters]);
    await sendCommand(connectionId, commandBuffer);
    
    res.json({
      success: true,
      message: '命令发送成功'
    });
  } catch (error) {
    console.error('发送命令失败:', error);
    res.status(500).json({
      success: false,
      message: `发送命令失败: ${error}`
    });
  }
};

// 广播命令到所有连接
export const broadcastCommandToAll = async (req: Request, res: Response) => {
  try {
    const { command, parameters = [] } = req.body;

    if (command === undefined) {
      return res.status(400).json({
        success: false,
        message: '命令不能为空'
      });
    }

    // 构建Modbus命令Buffer
    const commandBuffer = Buffer.from([command, ...parameters]);
    await broadcastCommand(commandBuffer);
    
    res.json({
      success: true,
      message: '广播命令发送成功'
    });
  } catch (error) {
    console.error('广播命令失败:', error);
    res.status(500).json({
      success: false,
      message: `广播命令失败: ${error}`
    });
  }
};

// 读取保持寄存器
export const readHoldingRegistersFromConnection = async (req: Request, res: Response) => {
  try {
    const { connectionId, address, quantity = 1 } = req.body;

    if (!connectionId || address === undefined) {
      return res.status(400).json({
        success: false,
        message: '连接ID和寄存器地址不能为空'
      });
    }

    await readHoldingRegisters(connectionId, address, quantity);
    
    res.json({
      success: true,
      message: '读取保持寄存器命令已发送，无需等待响应'
    });
  } catch (error) {
    console.error('读取保持寄存器失败:', error);
    res.status(500).json({
      success: false,
      message: `读取保持寄存器失败: ${error}`
    });
  }
};

// 读取输入寄存器
export const readInputRegistersFromConnection = async (req: Request, res: Response) => {
  try {
    const { connectionId, address, quantity = 1 } = req.body;

    if (!connectionId || address === undefined) {
      return res.status(400).json({
        success: false,
        message: '连接ID和寄存器地址不能为空'
      });
    }

    await readInputRegisters(connectionId, address, quantity);
    
    res.json({
      success: true,
      message: '读取输入寄存器命令已发送，无需等待响应'
    });
  } catch (error) {
    console.error('读取输入寄存器失败:', error);
    res.status(500).json({
      success: false,
      message: `读取输入寄存器失败: ${error}`
    });
  }
};

// 写入单个寄存器
export const writeSingleRegisterToConnection = async (req: Request, res: Response) => {
  try {
    const { connectionId, address, value } = req.body;

    if (!connectionId || address === undefined || value === undefined) {
      return res.status(400).json({
        success: false,
        message: '连接ID、寄存器地址和值不能为空'
      });
    }

    await writeSingleRegister(connectionId, address, value);
    
    res.json({
      success: true,
      message: '写入单个寄存器成功'
    });
  } catch (error) {
    console.error('写入单个寄存器失败:', error);
    res.status(500).json({
      success: false,
      message: `写入单个寄存器失败: ${error}`
    });
  }
};

// 写入多个寄存器
export const writeMultipleRegistersToConnection = async (req: Request, res: Response) => {
  try {
    const { connectionId, address, values } = req.body;

    if (!connectionId || address === undefined || !Array.isArray(values)) {
      return res.status(400).json({
        success: false,
        message: '连接ID、寄存器地址和值数组不能为空'
      });
    }

    await writeMultipleRegisters(connectionId, address, values);
    
    res.json({
      success: true,
      message: '写入多个寄存器成功'
    });
  } catch (error) {
    console.error('写入多个寄存器失败:', error);
    res.status(500).json({
      success: false,
      message: `写入多个寄存器失败: ${error}`
    });
  }
};

// Ping指定网关的子网
export const pingGatewaySubnet = async (req: Request, res: Response) => {
  try {
    const { gateway, concurrency = 20, timeout = 3000 } = req.body;

    if (!gateway) {
      return res.status(400).json({
        success: false,
        message: '网关地址不能为空'
      });
    }

    console.log(`开始ping网关 ${gateway} 的子网...`);
    const results = await pingSubnet(gateway, concurrency, timeout);
    
    // 过滤出可达的IP
    const reachableIPs = results.filter(result => result.isReachable);
    
    res.json({
      success: true,
      message: `子网扫描完成，发现 ${reachableIPs.length} 个可达设备`,
      gateway,
      totalScanned: results.length,
      reachableCount: reachableIPs.length,
      results: results
    });
  } catch (error) {
    console.error('Ping子网失败:', error);
    res.status(500).json({
      success: false,
      message: `Ping子网失败: ${error}`
    });
  }
};

// Ping所有已连接网关的子网
export const pingAllConnectedSubnets = async (req: Request, res: Response) => {
  try {
    const { concurrency = 20, timeout = 3000 } = req.body;
    
    // 获取所有连接
    const connections = getClientConnections();
    
    if (connections.length === 0) {
      return res.json({
        success: true,
        message: '当前没有已连接的设备',
        results: []
      });
    }

    console.log(`开始ping所有已连接网关的子网，共 ${connections.length} 个连接...`);
    const results = await pingConnectedGateways(connections, concurrency, timeout);
    
    // 统计总体信息
    let totalScanned = 0;
    let totalReachable = 0;
    
    results.forEach(gatewayResult => {
      totalScanned += gatewayResult.results.length;
      totalReachable += gatewayResult.results.filter(r => r.isReachable).length;
    });
    
    res.json({
      success: true,
      message: `所有子网扫描完成，共扫描 ${totalScanned} 个IP，发现 ${totalReachable} 个可达设备`,
      totalScanned,
      totalReachable,
      gatewayCount: results.length,
      results: results
    });
  } catch (error) {
    console.error('Ping所有子网失败:', error);
    res.status(500).json({
      success: false,
      message: `Ping所有子网失败: ${error}`
    });
  }
};

// 自动连接所有ping到的子网设备（排除网关和本机）
export const autoConnectDiscoveredDevices = async (req: Request, res: Response) => {
  try {
    const { concurrency = 20, timeout = 3000, port = 502 } = req.body;
    
    // 获取所有连接
    const connections = getClientConnections();
    
    if (connections.length === 0) {
      return res.json({
        success: false,
        message: '当前没有已连接的设备，无法进行子网扫描',
        results: []
      });
    }

    console.log(`开始扫描并自动连接设备，共 ${connections.length} 个网关...`);
    
    // 1. 先ping所有子网
    const pingResults = await pingConnectedGateways(connections, concurrency, timeout);
    
    // 2. 提取可连接的设备IP（排除网关和本机）
    const connectableDevices = extractConnectableDevices(pingResults);
    
    // 3. 统计总的可连接设备数量
    const totalConnectableDevices = connectableDevices.reduce(
      (total, gateway) => total + gateway.connectableIPs.length, 
      0
    );
    
    if (totalConnectableDevices === 0) {
      return res.json({
        success: true,
        message: '未发现可连接的新设备',
        totalScanned: pingResults.reduce((total, gateway) => total + gateway.results.length, 0),
        totalConnectable: 0,
        connectionResults: []
      });
    }

    console.log(`发现 ${totalConnectableDevices} 个可连接设备，开始尝试连接...`);
    
    // 4. 批量连接设备
    const connectionResults = [];
    let successCount = 0;
    let failureCount = 0;
    
    for (const gatewayGroup of connectableDevices) {
      const gatewayResults = [];
      
      for (const ip of gatewayGroup.connectableIPs) {
        try {
          // 检查是否已经存在连接
          const existingConnection = connections.find(conn => conn.host === ip);
          if (existingConnection) {
            gatewayResults.push({
              ip,
              success: false,
              message: '设备已连接',
              connectionId: existingConnection.id
            });
            continue;
          }
          
          // 尝试创建新连接
          const connectionId = await createModbusClient(ip, port, 1);
          
          gatewayResults.push({
            ip,
            success: true,
            message: '连接成功',
            connectionId
          });
          successCount++;
          
        } catch (error) {
          gatewayResults.push({
            ip,
            success: false,
            message: `连接失败: ${(error as Error).message}`,
            connectionId: null
          });
          failureCount++;
        }
      }
      
      connectionResults.push({
        gateway: gatewayGroup.gateway,
        results: gatewayResults
      });
    }
    
    res.json({
      success: true,
      message: `自动连接完成，成功连接 ${successCount} 个设备，失败 ${failureCount} 个`,
      totalScanned: pingResults.reduce((total, gateway) => total + gateway.results.length, 0),
      totalConnectable: totalConnectableDevices,
      successCount,
      failureCount,
      connectionResults
    });
    
  } catch (error) {
    console.error('自动连接设备失败:', error);
    res.status(500).json({
      success: false,
      message: `自动连接设备失败: ${error}`
    });
  }
};

// 单IP轮询检测
export const detectSingleIP = async (req: Request, res: Response) => {
  try {
    const { ip, timeout = 1500, interval = 1000, count = 5 } = req.body;
    
    if (!ip) {
      return res.status(400).json({
        success: false,
        message: 'IP地址不能为空'
      });
    }

    console.log(`开始单IP轮询检测: ${ip}，检测次数: ${count}，间隔: ${interval}ms`);
    
    const results: PingResult[] = [];
    
    for (let i = 0; i < count; i++) {
      const result = await pingIP(ip, timeout);
      results.push({
        ...result,
        sequence: i + 1
      });
      
      console.log(`第${i + 1}次检测 ${ip}: ${result.isReachable ? '成功' : '失败'} (${result.responseTime}ms)`);
      
      // 如果不是最后一次检测，等待间隔时间
      if (i < count - 1) {
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
    
    const successCount = results.filter(r => r.isReachable).length;
    const avgResponseTime = results
      .filter(r => r.isReachable && r.responseTime)
      .reduce((sum, r) => sum + (r.responseTime || 0), 0) / successCount || 0;
    
    res.json({
      success: true,
      message: `单IP检测完成，成功率: ${successCount}/${count} (${((successCount/count)*100).toFixed(1)}%)`,
      ip,
      totalCount: count,
      successCount,
      failureCount: count - successCount,
      successRate: (successCount / count) * 100,
      averageResponseTime: Math.round(avgResponseTime),
      results
    });
    
  } catch (error) {
    console.error('单IP检测失败:', error);
    res.status(500).json({
      success: false,
      message: `单IP检测失败: ${error}`
    });
  }
};

// 多IP并发检测
export const detectMultipleIPs = async (req: Request, res: Response) => {
  try {
    const { ips, timeout = 1500, concurrency = 50 } = req.body;
    
    if (!Array.isArray(ips) || ips.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'IP地址列表不能为空'
      });
    }

    console.log(`开始多IP并发检测，共 ${ips.length} 个IP，并发数: ${concurrency}`);
    
    const results: PingResult[] = [];
    
    // 分批处理，控制并发数量
    for (let i = 0; i < ips.length; i += concurrency) {
      const batch = ips.slice(i, i + concurrency);
      const batchPromises = batch.map(ip => pingIP(ip, timeout));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // 输出进度
      const progress = Math.min(i + concurrency, ips.length);
      console.log(`多IP检测进度: ${progress}/${ips.length}`);
    }
    
    const reachableIPs = results.filter(r => r.isReachable);
    const unreachableIPs = results.filter(r => !r.isReachable);
    
    res.json({
      success: true,
      message: `多IP检测完成，发现 ${reachableIPs.length} 个可达设备`,
      totalCount: ips.length,
      reachableCount: reachableIPs.length,
      unreachableCount: unreachableIPs.length,
      reachableIPs: reachableIPs.map(r => r.ip),
      unreachableIPs: unreachableIPs.map(r => r.ip),
      results
    });
    
  } catch (error) {
    console.error('多IP检测失败:', error);
    res.status(500).json({
      success: false,
      message: `多IP检测失败: ${error}`
    });
  }
};

// 综合自动化流程：ping + 自动连接 + 轮询
export const autoDiscoverAndConnect = async (req: Request, res: Response) => {
  try {
    const { 
      concurrency = 50, 
      timeout = 1500, 
      port = 502,
      enableSingleIPPolling = true,
      enableMultiIPTesting = true,
      pollingInterval = 5000,
      testDuration = 30000
    } = req.body;

    console.log('开始综合自动化流程：ping + 自动连接 + 轮询');
    
    // 第一步：自动发现本地网关并扫描子网
    console.log('步骤1: 自动发现本地网关...');
    const localGateways = await discoverLocalGateways();
    
    if (localGateways.length === 0) {
      return res.status(400).json({
        success: false,
        message: '无法发现本地网关，请检查网络连接'
      });
    }

    console.log(`发现 ${localGateways.length} 个本地网关: ${localGateways.join(', ')}`);

    let allReachableIPs: string[] = [];
    const pingResults: any[] = [];

    for (const gateway of localGateways) {
      console.log(`正在扫描网关 ${gateway} 的子网...`);
      const result = await pingSubnet(gateway, concurrency, timeout);
      const reachableIPs = result.filter(r => r.isReachable).map(r => r.ip);
      
      pingResults.push({
        gateway: gateway,
        reachableIPs: reachableIPs,
        totalScanned: result.length,
        reachableCount: reachableIPs.length
      });
      allReachableIPs.push(...reachableIPs);
    }

    // 去重
    allReachableIPs = [...new Set(allReachableIPs)];
    console.log(`扫描完成，发现 ${allReachableIPs.length} 个可达设备`);

    // 第二步：自动连接到发现的设备
    console.log('步骤2: 自动连接到发现的设备...');
    
    // 构建子网结果数据结构
    const subnetResults = pingResults.map(result => ({
      gateway: result.gateway,
      results: result.reachableIPs.map((ip: string) => ({
        ip,
        isReachable: true,
        responseTime: 0
      }))
    }));
    
    const connectableDevices = extractConnectableDevices(subnetResults);
    const connectableIPs = connectableDevices.flatMap(device => device.connectableIPs);
    const connectionResults: any[] = [];
    let successCount = 0;
    let failureCount = 0;

    for (const ip of connectableIPs) {
      try {
        console.log(`尝试连接到设备: ${ip}:${port}`);
        const connectionId = await createModbusClient(ip, port, 1);
        connectionResults.push({
          ip,
          port,
          success: true,
          connectionId,
          message: '连接成功'
        });
        successCount++;
        console.log(`✓ 成功连接到 ${ip}:${port}，连接ID: ${connectionId}`);
      } catch (error) {
        connectionResults.push({
          ip,
          port,
          success: false,
          connectionId: null,
          message: `连接失败: ${error}`
        });
        failureCount++;
        console.log(`✗ 连接失败 ${ip}:${port}: ${error}`);
      }
    }

    // 第三步：对成功连接的设备进行轮询测试
    const connectedDevices = connectionResults.filter(r => r.success);
    const pollingResults: any[] = [];
    const multiIPResults: any[] = [];

    if (enableSingleIPPolling && connectedDevices.length > 0) {
      console.log('步骤3: 开始单IP轮询测试...');
      for (const device of connectedDevices) {
        try {
          // 进行5次ping测试，间隔1秒
          const results: PingResult[] = [];
          for (let i = 0; i < 5; i++) {
            const result = await pingIP(device.ip, timeout);
            result.sequence = i + 1;
            results.push(result);
            
            if (i < 4) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
          
          const successCount = results.filter(r => r.isReachable).length;
          const avgResponseTime = results
            .filter(r => r.isReachable && r.responseTime !== undefined)
            .reduce((sum, r) => sum + (r.responseTime || 0), 0) / successCount || 0;
          
          const singleIPResult = {
            ip: device.ip,
            totalTests: 5,
            successCount,
            failureCount: 5 - successCount,
            successRate: Math.round((successCount / 5) * 100),
            averageResponseTime: Math.round(avgResponseTime * 100) / 100,
            results
          };
          
          pollingResults.push({
            ip: device.ip,
            connectionId: device.connectionId,
            pollingResult: singleIPResult
          });
          console.log(`单IP轮询完成: ${device.ip}, 成功率: ${singleIPResult.successRate}%`);
        } catch (error) {
          console.error(`单IP轮询失败 ${device.ip}:`, error);
        }
      }
    }

    if (enableMultiIPTesting && connectedDevices.length > 1) {
      console.log('步骤4: 开始多IP并发测试...');
      try {
        const deviceIPs = connectedDevices.map(d => d.ip);
        const batchConcurrency = Math.min(concurrency, deviceIPs.length);
        
        // 直接进行多IP ping测试
        const results: PingResult[] = [];
        for (let i = 0; i < deviceIPs.length; i += batchConcurrency) {
          const batch = deviceIPs.slice(i, i + batchConcurrency);
          const batchPromises = batch.map(ip => pingIP(ip, timeout));
          const batchResults = await Promise.all(batchPromises);
          results.push(...batchResults);
        }
        
        const reachableIPs = results.filter(r => r.isReachable);
        const multiIPResult = {
          totalCount: deviceIPs.length,
          reachableCount: reachableIPs.length,
          unreachableCount: deviceIPs.length - reachableIPs.length,
          reachableIPs: reachableIPs.map(r => r.ip),
          results
        };
        
        multiIPResults.push(multiIPResult);
        console.log(`多IP并发测试完成，测试了 ${deviceIPs.length} 个设备`);
      } catch (error) {
        console.error('多IP并发测试失败:', error);
      }
    }

    // 返回综合结果
    res.json({
      success: true,
      message: `自动化流程完成！扫描 ${allReachableIPs.length} 个设备，成功连接 ${successCount} 个，失败 ${failureCount} 个`,
      summary: {
        totalScanned: allReachableIPs.length,
        totalConnectable: connectableIPs.length,
        successfulConnections: successCount,
        failedConnections: failureCount,
        pollingTestsCompleted: pollingResults.length,
        multiIPTestsCompleted: multiIPResults.length
      },
      details: {
        pingResults,
        connectionResults,
        pollingResults,
        multiIPResults
      }
    });

  } catch (error) {
    console.error('综合自动化流程失败:', error);
    res.status(500).json({
      success: false,
      message: `自动化流程失败: ${error}`
    });
  }
};
