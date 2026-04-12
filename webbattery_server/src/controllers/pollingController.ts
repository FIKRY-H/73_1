import { Request, Response } from 'express';
import {
  getAllDevicesData,
  getDeviceData,
  startF1CyclicTest,
  startF2FastTest,
  stopTest,
  stopCyclicTest,
  getDeviceStates,
  clearDeviceStates,
  testNewProtocolFormat,
  updateReadStrategy,
  startF1CyclicPolling,
  startF2FastPolling,
  stopPolling,
  stopAllPolling,
  getPollingStatus,
  startBatchPolling
} from '../services/pollingService';
import { getClientConnections } from '../services/modbusService';
import { getSocketIOInstance } from '../index';

// 检查是否应该启用轮询
const shouldEnablePolling = (): boolean => {
  const connections = getClientConnections();
  const activeConnections = connections.filter(conn => conn.isConnected);
  const deviceCount = activeConnections.length;
  
  console.log(`🔍 API设备数量检查: 当前连接${deviceCount}台设备`);
  
  if (deviceCount === 0) {
    console.log(`⚠️ API轮询被禁用: 没有连接的设备`);
    return false;
  }
  
  console.log(`✅ API轮询已启用: 连接设备数量(${deviceCount})台`);
  return true;
};

// 获取所有设备数据
export const getAllDevicesDataController = async (req: Request, res: Response) => {
  try {
    const devicesData = await getAllDevicesData();
    
    res.json({
      success: true,
      message: '获取所有设备数据成功',
      data: devicesData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取所有设备数据失败:', error);
    res.status(500).json({
      success: false,
      message: `获取所有设备数据失败: ${error}`
    });
  }
};

// 获取单个设备数据
export const getDeviceDataController = async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: '设备ID不能为空'
      });
    }
    
    // 验证设备连接
    const connections = getClientConnections();
    const deviceExists = connections.some(conn => 
      conn.isConnected && (
        conn.id === deviceId ||
        conn.connectionId === deviceId ||
        conn.mac === deviceId
      )
    );
    
    if (!deviceExists) {
      return res.status(404).json({
        success: false,
        message: '设备未连接或不存在'
      });
    }
    
    const deviceData = await getDeviceData(deviceId);
    
    res.json({
      success: true,
      message: '获取设备数据成功',
      data: deviceData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取设备数据失败:', error);
    res.status(500).json({
      success: false,
      message: `获取设备数据失败: ${error}`
    });
  }
};

// 启动F1周期测试
export const startF1CyclicTestController = async (req: Request, res: Response) => {
  try {
    let { deviceId, periodSeconds, selectedDevices, writeValue } = req.body;
    
    // 如果未指定写入值，则默认写入周期时间（根据新协议：写入1~60即为周期时间）
    if (writeValue === undefined) {
      writeValue = periodSeconds;
    }
    
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: '设备ID不能为空'
      });
    }

    // 检测设备接收到小于1秒检测频率，统一按1秒周期测试
    if (periodSeconds && periodSeconds < 1) {
      periodSeconds = 1;
    }
    
    if (!periodSeconds || periodSeconds > 60) {
      return res.status(400).json({
        success: false,
        message: '周期时间必须在1-60秒之间'
      });
    }
    
    // 检查设备连接状态
    if (!shouldEnablePolling()) {
      return res.status(400).json({
        success: false,
        message: 'F1测试功能已禁用：没有连接的设备'
      });
    }
    
    // 验证设备连接
    const connections = getClientConnections();
    const deviceExists = connections.some(conn => 
      conn.isConnected && (
        conn.id === deviceId ||
        conn.connectionId === deviceId ||
        conn.mac === deviceId
      )
    );
    
    if (!deviceExists) {
      return res.status(404).json({
        success: false,
        message: '设备未连接或不存在'
      });
    }
    
    // 直接启动F1轮询，不等待写命令响应
    console.log(`🚀 直接启动F1轮询 ${deviceId}: 周期=${periodSeconds}秒，写值=0x${Number(writeValue).toString(16).padStart(4, '0')}，目标设备=${Array.isArray(selectedDevices) && selectedDevices.length > 0 ? selectedDevices.join(', ') : '所有连接设备'}`);
    
    const success = await startF1CyclicPolling(deviceId, periodSeconds, selectedDevices, Number(writeValue));
    
    if (success) {
      res.json({
        success: true,
        message: `F1周期测试启动成功，周期: ${periodSeconds}秒，写值: 0x${Number(writeValue).toString(16).padStart(4, '0')}，目标设备: ${Array.isArray(selectedDevices) && selectedDevices.length > 0 ? selectedDevices.join(', ') : '所有连接设备'}`,
        data: {
          deviceId,
          selectedDevices,
          periodSeconds,
          writeValue: Number(writeValue),
          timestamp: new Date().toISOString()
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'F1周期测试启动失败'
      });
    }
  } catch (error) {
    console.error('启动F1周期测试失败:', error);
    res.status(500).json({
      success: false,
      message: `启动F1周期测试失败: ${error}`
    });
  }
};

// 启动F2快速测试（包含快速轮询）
export const startF2FastTestController = async (req: Request, res: Response) => {
  try {
    const { deviceId, targetUnitId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: '设备ID不能为空'
      });
    }
    
    // 检查设备连接状态
    if (!shouldEnablePolling()) {
      return res.status(400).json({
        success: false,
        message: 'F2测试功能已禁用：没有连接的设备'
      });
    }
    
    // 验证设备连接
    const connections = getClientConnections();
    const deviceExists = connections.some(conn => 
      conn.isConnected && (
        conn.id === deviceId ||
        conn.connectionId === deviceId ||
        conn.mac === deviceId
      )
    );
    
    if (!deviceExists) {
      return res.status(404).json({
        success: false,
        message: '设备未连接或不存在'
      });
    }
    
    // 使用F2快速轮询功能（包含写命令+快速读取）
    // 如果未指定 targetUnitId，默认为 1
    const unitId = targetUnitId ? Number(targetUnitId) : 1;
    const success = await startF2FastPolling(deviceId, unitId);
    
    if (success) {
      res.json({
        success: true,
        message: `F2快速测试启动成功，目标设备: ${unitId}，30秒内快速读取60条有效数据`,
        data: {
          deviceId,
          targetUnitId: unitId,
          timestamp: new Date().toISOString(),
          description: '每250ms读取一次，目标获取60条有效数据'
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'F2快速测试启动失败'
      });
    }
  } catch (error) {
    console.error('启动F2快速测试失败:', error);
    res.status(500).json({
      success: false,
      message: `启动F2快速测试失败: ${error}`
    });
  }
};

// 停止测试（F1/F2）
export const stopTestController = async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: '设备ID不能为空'
      });
    }
    
    // 验证设备连接
    const connections = getClientConnections();
    const targetConnection = connections.find(conn => 
      conn.isConnected && (
        conn.id === deviceId ||
        conn.connectionId === deviceId ||
        conn.mac === deviceId
      )
    );
    
    if (!targetConnection) {
      return res.status(404).json({
        success: false,
        message: '设备未连接或不存在'
      });
    }
    
    // 获取实际的连接ID
    const connectionId = targetConnection.connectionId || targetConnection.id;
    
    // 1. 停止轮询定时器
    const pollingStopSuccess = stopPolling(connectionId);
    console.log(`🔄 轮询停止结果 ${connectionId}: ${pollingStopSuccess}`);
    
    // 2. 发送停止命令到设备
    const deviceStopSuccess = await stopTest(connectionId);
    console.log(`🛑 设备停止命令结果 ${connectionId}: ${deviceStopSuccess}`);
    
    // 3. 通知前端轮询已停止
    const io = getSocketIOInstance();
    if (io) {
      io.emit('pollingStopped', {
        deviceId: targetConnection.id,
        connectionId: connectionId,
        timestamp: new Date().toISOString(),
        pollingStopSuccess,
        deviceStopSuccess
      });
    }
    
    const overallSuccess = pollingStopSuccess || deviceStopSuccess;
    
    if (overallSuccess) {
      res.json({
        success: true,
        message: '测试停止成功',
        data: {
          deviceId: targetConnection.id,
          connectionId: connectionId,
          pollingStopSuccess,
          deviceStopSuccess,
          timestamp: new Date().toISOString()
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: '测试停止失败：轮询和设备命令都未成功'
      });
    }
  } catch (error) {
    console.error('停止测试失败:', error);
    res.status(500).json({
      success: false,
      message: `停止测试失败: ${error}`
    });
  }
};

// 删除clearStatusAlarmController函数，不再需要处理状态寄存器与控制寄存器

// 清除设备状态（保留原有功能）
export const clearDeviceStatesController = async (req: Request, res: Response) => {
  try {
    clearDeviceStates();
    
    res.json({
      success: true,
      message: '设备状态清除成功',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('清除设备状态失败:', error);
    res.status(500).json({
      success: false,
      message: `清除设备状态失败: ${error}`
    });
  }
};

// 测试新协议格式
export const testNewProtocolFormatController = async (req: Request, res: Response) => {
  try {
    const result = testNewProtocolFormat();
    
    res.json({
      success: true,
      message: '新协议格式测试完成',
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('测试新协议格式失败:', error);
    res.status(500).json({
      success: false,
      message: `测试新协议格式失败: ${error}`
    });
  }
};

// 更新读取策略
export const updateReadStrategyController = async (req: Request, res: Response) => {
  try {
    const { analysisResult } = req.body;
    
    if (!analysisResult) {
      return res.status(400).json({
        success: false,
        message: '分析结果不能为空'
      });
    }
    
    const strategy = updateReadStrategy();
    
    res.json({
      success: true,
      message: '读取策略已更新',
      data: strategy,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('更新读取策略失败:', error);
    res.status(500).json({
      success: false,
      message: `更新读取策略失败: ${error}`
    });
  }
};

// 获取设备状态
export const getDeviceStatesController = async (req: Request, res: Response) => {
  try {
    const deviceStates = getDeviceStates();
    
    res.json({
      success: true,
      data: deviceStates
    });
  } catch (error) {
    console.error('获取设备状态失败:', error);
    res.status(500).json({
      success: false,
      message: `获取设备状态失败: ${error}`
    });
  }
};

// 获取可用设备列表
export const getAvailableDevices = async (req: Request, res: Response) => {
  try {
    const connections = getClientConnections();
    const availableDevices = connections
      .filter(conn => conn.isConnected)
      .map(conn => ({
        connectionId: conn.connectionId,
        id: conn.id,
        host: conn.host,
        port: conn.port,
        deviceId: conn.deviceId,
        mac: conn.mac,
        lastActivity: conn.lastActivity,
        isConnected: conn.isConnected
      }));
    
    res.json({
      success: true,
      data: availableDevices,
      count: availableDevices.length
    });
  } catch (error) {
    console.error('获取可用设备失败:', error);
    res.status(500).json({
      success: false,
      message: `获取可用设备失败: ${error}`
    });
  }
};

// 启动F1周期轮询
export const startF1CyclicPollingController = async (req: Request, res: Response) => {
  try {
    let { deviceId, selectedDevices, periodSeconds = 3, writeValue = 0x0001 } = req.body; // 默认3秒间隔
    
    // 支持两种模式：单设备模式（deviceId）和多设备模式（selectedDevices）
    const targetDevices = selectedDevices && selectedDevices.length > 0 ? selectedDevices : (deviceId ? [deviceId] : []);
    
    if (targetDevices.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: '请选择要测试的设备' 
      });
    }
    
    // 检测设备接收到小于1秒检测频率，统一按1秒周期测试
    if (periodSeconds && periodSeconds < 1) {
      periodSeconds = 1;
    }

    if (periodSeconds > 60) {
      return res.status(400).json({ 
        success: false, 
        message: '周期时间必须在1-60秒之间' 
      });
    }
    
    // 检查设备连接状态
    if (!shouldEnablePolling()) {
      return res.status(400).json({
        success: false,
        message: '轮询功能已禁用：没有连接的设备'
      });
    }
    
    // 检查所有目标设备是否连接
    const connections = getClientConnections();
    const connectedDevices = [];
    const disconnectedDevices = [];
    
    for (const targetDeviceId of targetDevices) {
      const connection = connections.find(conn => 
        (conn.connectionId === targetDeviceId || conn.id === targetDeviceId) && conn.isConnected
      );
      
      if (connection) {
        connectedDevices.push(targetDeviceId);
      } else {
        disconnectedDevices.push(targetDeviceId);
      }
    }
    
    if (connectedDevices.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: '所有选中的设备都未连接' 
      });
    }
    
    if (disconnectedDevices.length > 0) {
      console.warn(`部分设备未连接: ${disconnectedDevices.join(', ')}`);
    }
    
    // 使用第一个连接的设备作为代表启动F1周期轮询，传递选中的设备列表
    const representativeDeviceId = connectedDevices[0];
    const success = await startF1CyclicPolling(representativeDeviceId, periodSeconds, selectedDevices, Number(writeValue));
    
    if (success) {
      res.json({ 
        success: true, 
        message: `F1周期轮询已启动，周期: ${periodSeconds}秒，写值: 0x${Number(writeValue).toString(16).padStart(4, '0')}，目标设备: ${selectedDevices?.join(', ') || '所有设备'}`,
        connectedDevices,
        disconnectedDevices: disconnectedDevices.length > 0 ? disconnectedDevices : undefined,
        targetDevices: selectedDevices
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'F1周期轮询启动失败',
        connectedDevices,
        disconnectedDevices: disconnectedDevices.length > 0 ? disconnectedDevices : undefined,
        targetDevices: selectedDevices
      });
    }
    
  } catch (error) {
    console.error('启动F1周期轮询失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '启动F1周期轮询失败', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

// 启动F2快速轮询
export const startF2FastPollingController = async (req: Request, res: Response) => {
  try {
    const { deviceId, targetUnitId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ 
        success: false, 
        message: '设备ID不能为空' 
      });
    }
    
    // 检查设备连接状态
    if (!shouldEnablePolling()) {
      return res.status(400).json({
        success: false,
        message: '轮询功能已禁用：没有连接的设备'
      });
    }
    
    // 检查设备是否连接
    const connections = getClientConnections();
    const connection = connections.find(conn => conn.connectionId === deviceId && conn.isConnected);
    
    if (!connection) {
      return res.status(404).json({ 
        success: false, 
        message: '设备未连接' 
      });
    }
    
    // 传递 targetUnitId (默认为1)
    const unitId = targetUnitId ? parseInt(targetUnitId, 10) : 1;
    console.log(`收到F2快速轮询请求: DeviceID=${deviceId}, TargetUnitID=${targetUnitId}, ParsedUnitID=${unitId}`);
    
    const success = await startF2FastPolling(deviceId, unitId);
    
    if (success) {
      res.json({ 
        success: true, 
        message: `F2快速轮询已启动 (UnitID=${unitId})，30秒内60次读取` 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'F2快速轮询启动失败' 
      });
    }
    
  } catch (error) {
    console.error('启动F2快速轮询失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '启动F2快速轮询失败', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

// 停止轮询
export const stopPollingController = async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ 
        success: false, 
        message: '设备ID不能为空' 
      });
    }
    
    const success = stopPolling(deviceId);
    
    if (success) {
      res.json({ 
        success: true, 
        message: '轮询已停止' 
      });
    } else {
      res.json({ 
        success: false, 
        message: '该设备没有正在运行的轮询' 
      });
    }
    
  } catch (error) {
    console.error('停止轮询失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '停止轮询失败', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

// 停止所有轮询
export const stopAllPollingController = async (req: Request, res: Response) => {
  try {
    stopAllPolling();
    
    res.json({ 
      success: true, 
      message: '所有轮询已停止' 
    });
    
  } catch (error) {
    console.error('停止所有轮询失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '停止所有轮询失败', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

// 获取轮询状态
export const getPollingStatusController = async (req: Request, res: Response) => {
  try {
    const status = getPollingStatus();
    
    res.json({ 
      success: true, 
      data: status 
    });
    
  } catch (error) {
    console.error('获取轮询状态失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '获取轮询状态失败', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

// 停止周期测试
export const stopCyclicTestController = async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: '设备ID不能为空'
      });
    }
    
    // 验证设备连接
    const connections = getClientConnections();
    const deviceExists = connections.some(conn => 
      conn.isConnected && (
        conn.id === deviceId ||
        conn.connectionId === deviceId ||
        conn.mac === deviceId
      )
    );
    
    if (!deviceExists) {
      return res.status(404).json({
        success: false,
        message: '设备未连接或不存在'
      });
    }
    
    // 先停止轮询定时器
    const pollingStopResult = stopPolling(deviceId);
    if (pollingStopResult) {
      console.log(`⏹️ 轮询定时器已停止 ${deviceId}`);
    }
    
    // 然后发送停止周期测试命令
    const success = await stopCyclicTest(deviceId);
    
    if (success) {
      res.json({
        success: true,
        message: '周期测试停止成功',
        data: {
          deviceId,
          timestamp: new Date().toISOString()
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: '周期测试停止失败'
      });
    }
  } catch (error) {
    console.error('停止周期测试失败:', error);
    res.status(500).json({
      success: false,
      message: `停止周期测试失败: ${error}`
    });
  }
};

// 批量启动轮询
export const startBatchPollingController = async (req: Request, res: Response) => {
  try {
    const { type, periodSeconds } = req.body;
    
    if (!type || (type !== 'F1' && type !== 'F2')) {
      return res.status(400).json({ 
        success: false, 
        message: '轮询类型必须是F1或F2' 
      });
    }
    
    if (type === 'F1' && (!periodSeconds || periodSeconds < 1 || periodSeconds > 60)) {
      return res.status(400).json({ 
        success: false, 
        message: 'F1轮询周期时间必须在1-60秒之间' 
      });
    }
    
    // 检查设备连接状态
    if (!shouldEnablePolling()) {
      return res.status(400).json({
        success: false,
        message: '批量轮询功能已禁用：没有连接的设备'
      });
    }
    
    const result = await startBatchPolling(type, periodSeconds);
    
    res.json({ 
      success: true, 
      message: `批量${type}轮询完成: 成功${result.success}个，失败${result.failed}个`, 
      data: result
    });
    
  } catch (error) {
    console.error('批量启动轮询失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '批量启动轮询失败', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

// 恢复缓冲数据控制

// 设备发现扫描 (扫描 1-24)
export const scanDevicesController = async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ 
        success: false, 
        message: '设备ID不能为空' 
      });
    }
    
    // 检查设备连接状态
    if (!shouldEnablePolling()) {
      return res.status(400).json({
        success: false,
        message: '扫描功能已禁用：没有连接的设备'
      });
    }
    
    // 检查设备是否连接
    const connections = getClientConnections();
    const connection = connections.find(conn => 
      (conn.connectionId === deviceId || conn.id === deviceId) && conn.isConnected
    );
    
    if (!connection) {
      return res.status(404).json({ 
        success: false, 
        message: '设备未连接或不存在' 
      });
    }
    
    const connectionId = connection.connectionId || connection.id;
    console.log(`🔍 开始扫描设备: ConnectionID=${connectionId}`);
    
    // 从 pollingService 获取 scanOnlineDevices
    const { scanOnlineDevices } = await import('../services/pollingService');
    const result = await scanOnlineDevices(connectionId);
    
    res.json({ 
      success: true, 
      message: '设备扫描已启动并完成', 
      data: result
    });
    
  } catch (error) {
    console.error('设备扫描失败:', error);
    res.status(500).json({ 
      success: false, 
      message: '设备扫描失败', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};
