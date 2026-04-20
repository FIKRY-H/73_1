import { EventEmitter } from 'events';
import { getClientConnections, readHoldingRegisters, writeSingleRegister, writeSingleRegisterWithFixedTxId, readHoldingRegistersWithFixedTxId, sendReadCommand, commandQueues } from './modbusService';
import { getSocketIOInstance } from '../index';
import { STATUS_BITS } from '../utils/modbusFrameUtils';

// 检查是否应该启用轮询
const shouldEnablePolling = (): boolean => {
  const connections = getClientConnections();
  const activeConnections = connections.filter(conn => conn.isConnected);
  const deviceCount = activeConnections.length;

  console.log(` 设备数量检查: 当前连接${deviceCount}台设备`);

  if (deviceCount === 0) {
    console.log(` 轮询被禁用: 没有连接的设备`);
    return false;
  }

  console.log(` 轮询已启用: 连接设备数量(${deviceCount})台`);
  return true;
};

// 数据采样服务事件发射器
export const pollingEvents = new EventEmitter();

// 设备数据接口（按照新协议规范 2026-04-14）
interface DeviceData {
  connectionId: string;
  host: string;
  mac: string;
  deviceId: number;
  statusRegister: number; // 0x0000: 状态寄存器
  voltage: number;        // 0x0003: 电压（mV）
  r1: number;             // 0x0004: 电池1阻抗 R1
  r2: number;             // 0x0005: 电池1阻抗 R2
  r3: number;             // 0x0006: 电池1阻抗 R3
  bat3_r1?: number;       // 0x0007: 电池3阻抗 R1
  bat3_r2?: number;       // 0x0008: 电池3阻抗 R2
  bat3_r3?: number;       // 0x0009: 电池3阻抗 R3
  bat4_r1?: number;       // 0x000A: 电池4阻抗 R1
  bat4_r2?: number;       // 0x000B: 电池4阻抗 R2
  bat4_r3?: number;       // 0x000C: 电池4阻抗 R3

  controlA: number;       // 0x0001: 控制寄存器A
  controlB: number;       // 0x0002: 控制寄存器B

  r1Actual: number;       // 计算后的R1实际值
  r2Actual: number;       // 计算后的R2实际值
  r3Actual: number;       // 计算后的R3实际值
  timestamp: Date;
  errorCount: number;
}

// 寄存器地址定义 (按照GET3017协议)
// 写入命令(广播): UnitID = 0xFF
// 读数据命令(单播): UnitID = 1~128
const REGISTERS = {
  DATA_START: 0x0000,        // 数据起始地址
  DATA_COUNT: 13,            // 数据读取长度 (0x0000 ~ 0x000C)
  STATUS: 0x0000,            // 状态寄存器
  STATUS_READ_COUNT: 3,      // 读取0x0000~0x0002（状态+控制A+控制B）
  CONTROL_CYCLE: 0x0002,     // 启动(写周期)/停止(写0)地址
  BROADCAST_UNIT_ID: 0xFF,   // 广播/控制 Unit ID
  CONTROL_A: 0x0001,
  CONTROL_B: 0x0002
};

const DEVICE_UNIT_MIN = 1;
const DEVICE_UNIT_MAX = 128;

// 状态位掩码
const STATUS_MASK = {
  MEAS_ENABLE: 0x0001, // Bit 0
  COMM_TIMEOUT: 0x0010, // Bit 4
  TEST_DONE: 0x0020, // Bit 5
  DATA_READY: 0x0080, // Bit 7
  COMM_ERROR: 0x0100  // Bit 8
};

// 设备状态映射
const deviceStates = new Map<string, DeviceData>();

// 事务ID计数器
let transactionId = 0x0001;
function getNextTransactionId(): number {
  transactionId++;
  if (transactionId > 0xFFFF) transactionId = 0x0001;
  return transactionId;
}

// 读取状态寄存器 (特定Unit)
export const readDeviceStatus = async (connectionId: string, unitId: number): Promise<number | null> => {
  try {
    const txId = getNextTransactionId();
    // 读取3个寄存器 0x0000~0x0002（按协议要求）
    const buffer = await readHoldingRegistersWithFixedTxId(connectionId, txId, REGISTERS.STATUS, REGISTERS.STATUS_READ_COUNT, unitId);
    if (buffer && buffer.length >= 2) {
      return buffer.readUInt16BE(0);
    }
    return null;
  } catch (error) {
    return null;
  }
};

// 读取完整设备数据 (0x0000-0x0007)
export const readDeviceData = async (
  connectionId: string,
  targetUnitId: number = 1,
  logContext?: 'F1_POLLING' | 'F2_HARVEST'
): Promise<DeviceData | null> => {
  try {
    const txId = getNextTransactionId();

    // 仅在F1主轮询路径输出完整帧日志，便于排查上位机下发内容
    if (logContext === 'F1_POLLING') {
      const txHex = txId.toString(16).toUpperCase().padStart(4, '0');
      const unitHex = targetUnitId.toString(16).toUpperCase().padStart(2, '0');
      console.log(`F1轮询读取帧 ${connectionId}: ${txHex.slice(0, 2)} ${txHex.slice(2)} 00 00 00 06 ${unitHex} 03 00 00 00 0D`);
    } else if (logContext === 'F2_HARVEST') {
      const txHex = txId.toString(16).toUpperCase().padStart(4, '0');
      const unitHex = targetUnitId.toString(16).toUpperCase().padStart(2, '0');
      console.log(`[F2阶段4] 读取完整数据帧 ${connectionId}: ${txHex.slice(0, 2)} ${txHex.slice(2)} 00 00 00 06 ${unitHex} 03 00 00 00 0D`);
    }

    // 读取13个寄存器
    const dataBuffer = await readHoldingRegistersWithFixedTxId(connectionId, txId, REGISTERS.DATA_START, REGISTERS.DATA_COUNT, targetUnitId);

    const { getClientConnections } = await import('./modbusService');
    const connections = getClientConnections();
    const connection = connections.find(conn => conn.id === connectionId);
    const host = connection?.host || '';
    const uniqueMac = `${host}_${targetUnitId.toString().padStart(2, '0')}`;

    // 解析数据
    let voltage = 0;
    let r1 = 0; let r2 = 0; let r3 = 0;
    let bat3_r1 = 0; let bat3_r2 = 0; let bat3_r3 = 0;
    let bat4_r1 = 0; let bat4_r2 = 0; let bat4_r3 = 0;
    let statusRegister = 0;
    let controlA = 0; let controlB = 0;

    if (dataBuffer && dataBuffer.length >= 26) {
      statusRegister = dataBuffer.readUInt16BE(0); // 0x0000
      controlA = dataBuffer.readUInt16BE(2);       // 0x0001
      controlB = dataBuffer.readUInt16BE(4);       // 0x0002
      let rawV = dataBuffer.readUInt16BE(6);       // 0x0003
      voltage = rawV & 0x1FFF;
      const multiplierIndex = (rawV >> 13) & 0x07;
      const multipliers = [1, 4, 8, 12, 16, 20, 24, 28];
      const m = multipliers[multiplierIndex] || 1;

      r1 = dataBuffer.readUInt16BE(8) * m;
      r2 = dataBuffer.readUInt16BE(10) * m;
      r3 = dataBuffer.readUInt16BE(12) * m;

      bat3_r1 = dataBuffer.readUInt16BE(14) * m;
      bat3_r2 = dataBuffer.readUInt16BE(16) * m;
      bat3_r3 = dataBuffer.readUInt16BE(18) * m;

      bat4_r1 = dataBuffer.readUInt16BE(20) * m;
      bat4_r2 = dataBuffer.readUInt16BE(22) * m;
      bat4_r3 = dataBuffer.readUInt16BE(24) * m;
    } else {
      // 读取失败或数据不完整
      return null;
    }

    const deviceData: DeviceData = {
      connectionId,
      host,
      mac: uniqueMac,
      deviceId: targetUnitId,
      statusRegister,
      voltage,
      r1, r2, r3,
      bat3_r1, bat3_r2, bat3_r3,
      bat4_r1, bat4_r2, bat4_r3,
      controlA, controlB,
      r1Actual: r1, r2Actual: r2, r3Actual: r3,
      timestamp: new Date(),
      errorCount: 0
    };

    console.log(` [Unit ${targetUnitId}] Data: V=${voltage}, Status=0x${statusRegister.toString(16)}`);

    // 更新缓存并发送前端
    deviceStates.set(connectionId, deviceData);
    await sendDataToFrontend(deviceData);

    return deviceData;

  } catch (error) {
    console.error(`Read error ${connectionId} Unit:${targetUnitId}`, error);
    return null;
  }
};

// 静默读取设备数据 (0x0000-0x0007) — 仅用于扫描
// 与 readDeviceData 的区别：不调用 sendDataToFrontend()，不写 deviceStates 缓存
// 这样扫描128个 UID 时不会向前端发送 batteryUpdate 事件，也不会污染数据表格
const readDeviceDataSilently = async (connectionId: string, targetUnitId: number): Promise<boolean> => {
  try {
    const txId = getNextTransactionId();
    const dataBuffer = await readHoldingRegistersWithFixedTxId(connectionId, txId, REGISTERS.DATA_START, REGISTERS.DATA_COUNT, targetUnitId);

    // 只要收到 26 字节（13 个寄存器 × 2 字节）就认为在线
    if (dataBuffer && dataBuffer.length >= 26) {
      const statusRegister = dataBuffer.readUInt16BE(0);
      const voltage = dataBuffer.readUInt16BE(6) & 0x1FFF;
      console.log(`[Scan] Unit ${targetUnitId}: 在线 (V=${voltage}, Status=0x${statusRegister.toString(16)})`);
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
};

// 获取所有连接设备的数据
export const getAllDevicesData = async (): Promise<DeviceData[]> => {
  const connections = getClientConnections();
  const activeConnections = connections.filter(conn => conn.isConnected);

  const results: DeviceData[] = [];

  for (const connection of activeConnections) {
    try {
      const data = await readDeviceData(connection.connectionId);
      if (data) {
        // 补充连接信息
        data.host = connection.host;
        // 统一设备唯一标识：使用 IP + 设备地址
        data.mac = `${connection.host}_${connection.deviceId.toString().padStart(2, '0')}`;
        data.deviceId = connection.deviceId;
        results.push(data);
      }
    } catch (error) {
      console.error(`读取设备数据失败 ${connection.connectionId}:`, error);
    }
  }

  return results;
};

// 扫描 1-128 设备是否在线
export const scanOnlineDevices = async (connectionId: string): Promise<{
  onlineDevices: number[];
  totalScanned: number;
}> => {
  const onlineDevices: number[] = [];
  const io = getSocketIOInstance();
  const totalScanned = DEVICE_UNIT_MAX - DEVICE_UNIT_MIN + 1;

  console.log(`[Scan] 开始扫描连接 ${connectionId} 的所有设备 (${DEVICE_UNIT_MIN}-${DEVICE_UNIT_MAX})`);

  // 发送开始事件
  io.emit('deviceScanStarted', { connectionId, total: totalScanned });

  for (let unitId = DEVICE_UNIT_MIN; unitId <= DEVICE_UNIT_MAX; unitId++) {
    try {
      // 通过静默读取判断是否在线（不触发 batteryUpdate 事件）
      const isOnline = await readDeviceDataSilently(connectionId, unitId);
      if (isOnline) {
        onlineDevices.push(unitId);
      }

      // 实时发送进度
      io.emit('deviceScanProgress', {
        connectionId,
        unitId,
        online: isOnline,
        progress: unitId,
        total: totalScanned
      });

    } catch (error) {
      io.emit('deviceScanProgress', {
        connectionId,
        unitId,
        online: false,
        progress: unitId,
        total: totalScanned
      });
    }

    // 短暂延时，避免瞬间发包过多导致拥塞
    await new Promise(r => setTimeout(r, 10));
  }

  console.log(`[Scan] 扫描完成。发现 ${onlineDevices.length} 个在线设备`);

  io.emit('deviceScanComplete', {
    connectionId,
    onlineDevices,
    totalScanned
  });

  return { onlineDevices, totalScanned };
};


// 获取单个设备数据
export const getDeviceData = async (connectionId: string): Promise<DeviceData | null> => {
  const connections = getClientConnections();
  const connection = connections.find(conn =>
    conn.connectionId === connectionId && conn.isConnected
  );

  if (!connection) {
    throw new Error(`设备连接不存在或未连接: ${connectionId}`);
  }

  const data = await readDeviceData(connectionId);
  if (data) {
    // 补充连接信息
    data.host = connection.host;
    // 统一设备唯一标识：使用 IP + 设备地址
    data.mac = `${connection.host}_${connection.deviceId.toString().padStart(2, '0')}`;
    data.deviceId = connection.deviceId;
  }

  return data;
};

// 删除状态寄存器相关的函数和变量，不再需要处理状态寄存器与控制寄存器

// 发送电池数据到前端（简化版本，不再处理状态寄存器）
export const sendDataToFrontend = async (deviceData: DeviceData) => {

  // 根据当前轮询状态判断测试类型
  const { FrameType } = await import('../models/batteryModel');
  let testType = FrameType.CyclicTest; // 默认值

  // 首先检查当前是否有活跃的轮询
  const currentPolling = pollingTimers.get(deviceData.connectionId);
  if (currentPolling) {
    if (currentPolling.type === 'F1') {
      testType = FrameType.CyclicTest; // F1周期测试
      console.log(` 基于F1轮询状态判断测试类型: ${testType} (周期测试)`);
    } else if (currentPolling.type === 'F2') {
      testType = FrameType.FastTest; // F2快速测试
      console.log(` 基于F2轮询状态判断测试类型: ${testType} (快速测试)`);
    }
  } else {
    // 如果没有活跃轮询，检查全局F1轮询定时器（兼容旧的轮询机制）
    if (global.f1PollingTimers && global.f1PollingTimers.has(deviceData.connectionId)) {
      testType = FrameType.CyclicTest; // F1周期测试
      console.log(` 基于全局F1轮询状态判断测试类型: ${testType} (周期测试)`);
    } else {
      // 默认为周期测试（因为两种测试类型数据格式相同，无法通过数据内容区分）
      testType = FrameType.CyclicTest;
      console.log(` 无法确定测试类型，默认为周期测试: ${testType}`);
    }
  }

  // 由于移除了状态寄存器，所有数据都会被发送
  console.log(` 发送电池数据到前端 ${deviceData.connectionId}: 电压=${deviceData.voltage}mV`);
  console.log(` 前端使用设备标识: ${deviceData.mac}`);

  const batteryData = {
    deviceNumber: deviceData.deviceId,
    mac: deviceData.mac,
    ip_prefix: deviceData.host,
    device_address: deviceData.deviceId.toString().padStart(2, '0'),
    timestamp: deviceData.timestamp.toISOString(),
    voltage: deviceData.voltage,
    r1_low: deviceData.r1,
    r1_actual: deviceData.r1Actual,
    r2_low: deviceData.r2,
    r2_actual: deviceData.r2Actual,
    r3_low: deviceData.r3,
    r3_actual: deviceData.r3Actual,

    connectionId: deviceData.connectionId,
    host: deviceData.host,
    errorCount: deviceData.errorCount,
    // 添加测试类型字段
    testType: testType,
    // 状态位由socketService的解析结果决定，这里不设置
  };

  // 检查发送到前端的阻抗数据
  if (deviceData.r1Actual === 0 || deviceData.r2Actual === 0 || deviceData.r3Actual === 0) {
    console.warn(` 发送到前端的数据中检测到阻抗值为0: R1=${deviceData.r1Actual}, R2=${deviceData.r2Actual}, R3=${deviceData.r3Actual}`);
    console.warn(` 设备: ${deviceData.connectionId}, MAC: ${deviceData.mac}, 测试类型: ${testType}`);
  }

  // 数据保存改由socketService的Modbus接收路径统一处理，避免重复保存与零值写入

  // 注意：不在这里发送batteryDataUpdate事件，避免与socketService中的batteryUpdate重复发送
  // socketService中的modbusDataReceived事件处理器会发送batteryUpdate事件
  // 这里只负责日志与流程控制，前端数据更新与数据保存由socketService统一处理

  console.log(` 电池数据已保存 ${deviceData.connectionId}: 电压=${deviceData.voltage}mV, R1=${deviceData.r1Actual}μΩ, R2=${deviceData.r2Actual}μΩ, R3=${deviceData.r3Actual}μΩ, 测试类型=${testType}`);
};

// 启动F2快速测试模式
export const startF2FastTest = async (connectionId: string, targetUnitId: number = 1): Promise<boolean> => {
  try {
    const txId = getNextTransactionId();
    console.log(` F2快速测试模式启动 ${connectionId}: 写0x0001=0x0001, UnitID=${targetUnitId}`);
    await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_A, 0x0001, targetUnitId);
    console.log(` F2快速测试启动成功 ${connectionId}`);
    return true;
  } catch (error) {
    console.error(` F2快速测试启动失败 ${connectionId}:`, error);
    return false;
  }
};

// 初始化设备（写0x0001=0x0002）
export const initializeDevice = async (connectionId: string): Promise<boolean> => {
  try {
    const txId = getNextTransactionId();
    console.log(` 初始化设备 ${connectionId}: 写0x0001=0x0002`);
    await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_A, 0x0002);
    console.log(` 初始化指令已下发 ${connectionId}`);
    return true;
  } catch (error) {
    console.error(` 初始化设备失败 ${connectionId}:`, error);
    return false;
  }
};

// 启动F1周期测试模式
export const startF1CyclicTest = async (connectionId: string, periodSeconds: number): Promise<boolean> => {
  try {
    if (periodSeconds < 1 || periodSeconds > 60) {
      throw new Error('周期时间必须在1-60秒之间');
    }

    const txId = getNextTransactionId();
    console.log(` F1周期测试模式启动 ${connectionId}: 写0x0002=${periodSeconds}`);
    await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, periodSeconds);

    console.log(` F1周期测试启动成功 ${connectionId}`);
    return true;
  } catch (error) {
    console.error(` F1周期测试启动失败 ${connectionId}:`, error);
    return false;
  }
};

// 使用现有连接读取指定设备ID的寄存器
// 删除重复的轮询读取函数，统一使用modbusService中的readHoldingRegistersPolling

// 停止测试（F1/F2）- 强制中止模式
export const stopTest = async (connectionId: string): Promise<boolean> => {
  try {
    console.log(` 停止测试 ${connectionId} (无需写入控制寄存器)`);
    console.log(` 测试停止成功 ${connectionId}`);
    return true;
  } catch (error) {
    console.error(` 测试停止失败 ${connectionId}:`, error);
    return false;
  }
};

// 停止周期检测（仅停止周期测试，不强制终止）
export const stopCyclicTest = async (connectionId: string): Promise<boolean> => {
  try {
    console.log(` 停止周期检测 ${connectionId} (写0x0007=0停止F1周期测试)`);

    // 停止轮询（若存在，会同时触发写0x0007=0）
    stopPolling(connectionId);

    // 兜底：即使当前没有轮询，也发送停止周期测试命令
    const connections = getClientConnections();
    const activeConnections = connections.filter(conn => conn.isConnected);
    for (const conn of activeConnections) {
      if (conn.id === connectionId || conn.connectionId === connectionId) {
        try {
          const txId = getNextTransactionId();
          await writeSingleRegisterWithFixedTxId(conn.id, txId, REGISTERS.CONTROL_CYCLE, 0x0000);
        } catch (error) {
          console.error(` F1停止命令发送失败 ${conn.id}:`, error);
        }
      }
    }

    console.log(` 周期检测停止成功 ${connectionId}`);
    return true;
  } catch (error) {
    console.error(` 周期检测停止失败 ${connectionId}:`, error);
    return false;
  }
};

// 获取设备状态列表
export const getDeviceStates = (): DeviceData[] => {
  return Array.from(deviceStates.values());
};

// 清除设备状态
export const clearDeviceStates = (): void => {
  deviceStates.clear();
  console.log('设备状态已清除');
};

// 获取设备状态
export const getDeviceState = (connectionId: string): DeviceData | undefined => {
  return deviceStates.get(connectionId);
};



// 轮询定时器管理
interface PollingTimer {
  timer: NodeJS.Timeout | null;
  readTimer?: NodeJS.Timeout; // F1测试用的读取定时器
  type: 'F1' | 'F2';
  connectionId: string;
  targetUnitId?: number; // F2测试目标设备地址
  startTime: number;
  readCount?: number; // F2测试用
  controller?: { active: boolean }; // 用于控制异步循环停止
}

// 全局轮询定时器映射
const pollingTimers = new Map<string, PollingTimer>();

// 删除寄存器监控相关的函数，不再需要处理状态寄存器与控制寄存器

// 恢复错误状态：停止 -> 快速读取直到 clean -> 返回
const recoverConnectionState = async (connectionId: string, targetUnitIds: number[]): Promise<boolean> => {
  console.log(` 进入恢复模式 ${connectionId} ...`);

  // 1. 发送停止命令 (UnitFF)
  try {
    const txId = getNextTransactionId();
    await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, 0x0000, REGISTERS.BROADCAST_UNIT_ID);
    console.log(` [恢复] 停止命令已发送 (Unit FF)`);
  } catch (e) {
    console.error(` [恢复] 停止命令失败`, e);
  }

  // 2. 快速读取循环 (10ms)
  // 策略优化:
  // 1. 维护pending列表，只检查尚未就绪的设备
  // 2. 只有所有在线设备都就绪(Cnt=0)才退出，保证同步
  // 3. 读取失败(离线)的设备直接移除，防止拖慢整体进度(解决卡顿问题)
  const maxWrapperTime = 10000; // 最多尝试10秒
  const startTime = Date.now();

  // 初始包含所有目标设备
  let pendingUnitIds = [...targetUnitIds];

  while (Date.now() - startTime < maxWrapperTime) {
    if (pendingUnitIds.length === 0) {
      console.log(`[恢复] 所有设备已恢复正常 (Cnt=0)`);
      return true;
    }

    // 记录本轮是否发生过耗时操作(如读取)，用于控制循环速率
    let didWork = false;

    // 倒序遍历以便安全删除
    for (let i = pendingUnitIds.length - 1; i >= 0; i--) {
      const unitId = pendingUnitIds[i];
      const data = await readDeviceData(connectionId, unitId);
      didWork = true;

      if (data) {
        // 利用 COMM_TIMEOUT 位来判断设备是否从掉线状态完全恢复通讯。
        // COMM_TIMEOUT == 0 说明设备底层的通讯超时报警已经被清除（收到上位机的帧了）
        if ((data.statusRegister & STATUS_MASK.COMM_TIMEOUT) === 0) {
          // 设备就绪，从等待列表移除
          // console.log(`Unit ${unitId} 就绪 (COMM_TIMEOUT === 0)`);
          pendingUnitIds.splice(i, 1);
        } else {
          // 设备忙(COMM_TIMEOUT != 0)，保留在列表，下一轮继续检查
          // console.log(` Unit ${unitId} 忙 (COMM_TIMEOUT 尚未清零)`);
        }
      } else {
        // 读取失败(超时/离线)，视为"无法恢复"或"无需等待"
        // 直接移除，避免因等待离线设备导致界面卡顿10秒
        console.warn(`[恢复] Unit ${unitId} 读取失败，跳过等待`);
        pendingUnitIds.splice(i, 1);
      }
    }

    // 如果列表被清空，立即成功
    if (pendingUnitIds.length === 0) {
      return true;
    }

    // 简单延时，避免过于密集的空转
    await new Promise(r => setTimeout(r, 10));
  }

  console.warn(`[恢复] 超时 (${maxWrapperTime}ms)，强制退出`);
  return false;
};

// F1周期轮询 (新逻辑 2026-01-16)
export const startF1CyclicPolling = async (
  connectionId: string,
  periodSeconds: number,
  targetDevices?: string[],
  writeValue: number = 0x0001
): Promise<boolean> => {
  try {
    let period = Number(periodSeconds);
    if (!Number.isFinite(period) || period < 1 || period > 60) period = 3;
    periodSeconds = period;

    if (!shouldEnablePolling()) {
      return false;
    }

    stopAllPolling();

    const allConnections = getClientConnections();
    const targetConnection = allConnections.find(c => c.id === connectionId || c.connectionId === connectionId);

    if (!targetConnection) {
      console.warn(`F1启动: 找不到连接 ${connectionId}`);
      return false;
    }

    // 如果传入了目标设备列表，只轮询这些设备；否则轮询全部 128 个从机
    const unitIds = (targetDevices && targetDevices.length > 0)
      ? targetDevices.map(Number).filter(n => n >= DEVICE_UNIT_MIN && n <= DEVICE_UNIT_MAX)
      : Array.from({ length: DEVICE_UNIT_MAX - DEVICE_UNIT_MIN + 1 }, (_, i) => DEVICE_UNIT_MIN + i);

    if (targetDevices && targetDevices.length > 0) {
      console.log(`[F1] 使用目标设备列表: [${unitIds.join(', ')}] (共 ${unitIds.length} 个)`);
    }

    console.log(` [F1 Start] 周期:${periodSeconds}s, Conn:${connectionId}, Units:${DEVICE_UNIT_MIN}-${DEVICE_UNIT_MAX}`);

    // 0. 初始恢复检查
    console.log(`Running initial recovery check...`);
    await recoverConnectionState(connectionId, unitIds);

    // 增加短暂延时，平滑过渡到正常轮询
    await new Promise(r => setTimeout(r, 20));

    // 1. 发送启动命令 (Write 0x0002 = Period, Unit FF)
    try {
      const txId = getNextTransactionId();
      await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, periodSeconds, REGISTERS.BROADCAST_UNIT_ID);
      console.log(` F1启动命令已发送 (Unit FF): 0x0002=${periodSeconds}`);
    } catch (e) {
      console.error(` F1启动命令发送失败`, e);
      return false;
    }

    // 2. 启动周期循环
    const controller = { active: true };

    (async () => {
      console.log(` [F1]状态轮询循环已启动: 间隔50ms (Update 2026-01-17)`);
      while (controller.active) {
        const loopStart = Date.now();
        let recoveryTriggered = false;

        // 轮询目标设备：先读状态寄存器，再按DATA_READY抓取完整数据
        for (const unitId of unitIds) {
          if (!controller.active) break;

          // 2.1 读取状态寄存器(0x0000)
          const status = await readDeviceStatus(connectionId, unitId);
          if (status === null) {
            continue;
          }

          if ((status & STATUS_MASK.COMM_TIMEOUT) !== 0) {
            console.warn(`Unit ${unitId} 报告 COMM_TIMEOUT (0x${status.toString(16)}) -> 触发恢复流程`);
            recoveryTriggered = true;
            break;
          }

          // 2.2 DATA_READY=1时再抓取完整数据(0x0000-0x000C)
          if ((status & STATUS_MASK.DATA_READY) !== 0) {
            await readDeviceData(connectionId, unitId, 'F1_POLLING');
          }
        }

        if (recoveryTriggered && controller.active) {
          const io = getSocketIOInstance();

          // 1. 界面告警
          io.emit('testStateChange', { state: 'COMM_ERROR', connectionId, testType: 'F1' });
          console.warn(` [F1故障] 检测到通信错误，执行恢复流程: 停止 -> 恢复 -> 重启`);

          // 2. 发送停止命令
          try {
            const txId = getNextTransactionId();
            await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, 0x0000, REGISTERS.BROADCAST_UNIT_ID);
          } catch (e) { console.error(e); }

          // 3. 执行快速恢复 (等待Cnt=0)
          await recoverConnectionState(connectionId, unitIds);

          // 增加短暂延时，平滑过渡
          await new Promise(r => setTimeout(r, 20));

          // 4.恢复后重新发送启动
          if (controller.active) {
            try {
              const txId = getNextTransactionId();
              await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, periodSeconds, REGISTERS.BROADCAST_UNIT_ID);
              console.log(` [故障恢复] 重新发送启动命令`);
              io.emit('testStateChange', { state: 'TESTING', connectionId, testType: 'F1' });
            } catch (e) { console.error(e); }
          }
        }

        // 3. 循环间隔控制 (改为动态读取频率: T/3)
        const elapsed = Date.now() - loopStart;
        const intervalMs = Math.floor((periodSeconds * 1000) / 3);
        // 确保至少有5ms间隔
        const delay = Math.max(5, intervalMs - elapsed);
        if (controller.active) {
          await new Promise(r => setTimeout(r, delay));
        }
      }
      console.log(` F1 轮询任务结束`);
    })();

    pollingTimers.set(connectionId, {
      timer: null,
      type: 'F1',
      connectionId,
      startTime: Date.now(),
      controller
    });

    return true;
  } catch (error) {
    console.error(` F1周期轮询启动失败:`, error);
    return false;
  }
};


// F2快速轮询：写命令启动后每秒读取状态寄存器并解析；
// 检测到 TEST_DONE=1 后以 10ms 频率读取 60 次（约0.6秒），
// 然后继续每秒读取 MEAS_ENABLE，检测到 Bit0=0 即判定冷却结束（阶段5），超时40秒
export const startF2FastPolling = async (connectionId: string, targetUnitId: number = 1): Promise<boolean> => {
  try {
    const io = getSocketIOInstance();
    const targetConnection = getClientConnections().find(c => c.id === connectionId || c.connectionId === connectionId);
    const host = targetConnection?.host || '';
    const statusMac = host ? `${host}_${targetUnitId.toString().padStart(2, '0')}` : '';

    // 检查是否应该启用轮询
    if (!shouldEnablePolling()) {
      console.log(` F2快速轮询启动被拒绝 ${connectionId}: 没有连接的设备`);
      return false;
    }

    // 停止现有轮询
    stopPolling(connectionId);

    console.log(` 启动F2快速轮询 ${connectionId}: 阶段1/发送启动信号`);

    // 1. 发送F2启动命令 (写 0x0001 = 1 到 CONTROL_A 0x0001)
    const txId = getNextTransactionId();
    await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_A, 0x0001, targetUnitId);
    console.log(` F2启动命令已发送 ${connectionId} (UnitID=${targetUnitId}, Reg=0x0001, Val=1)`);
    io?.emit('testStateChange', {
      state: 'TESTING',
      connectionId,
      message: '阶段2：命令写入成功，开始每秒读取状态寄存器',
      testType: 'F2'
    });

    const startTime = Date.now();
    const controller = { active: true };

    // 提前注册到系统，确保在状态轮询阶段也可以被 stopPolling 及时停止
    pollingTimers.set(connectionId, {
      timer: null,
      type: 'F2',
      connectionId,
      targetUnitId,
      startTime,
      readCount: 0,
      controller
    });

    // 我们在这里使用异步自执行闭包，不堵塞轮询管理，独立运行F2全套阶段
    (async () => {
      try {
        console.log(` F2快速轮询 ${connectionId}: 阶段3/开始每秒探测状态寄存器`);

        // 探测阶段：每秒读一次 0x0000 并解析 MEAS_ENABLE/TEST_DONE，直到获得 TEST_DONE 或超时
        let isDone = false;
        const maxStatusChecks = 40;
        for (let i = 0; i < maxStatusChecks && controller.active; i++) {
          const sBuf = await readHoldingRegistersWithFixedTxId(connectionId, getNextTransactionId(), REGISTERS.STATUS, REGISTERS.STATUS_READ_COUNT, targetUnitId);
          if (sBuf && sBuf.length >= 2) {
            const stValue = sBuf.readUInt16BE(0);
            const measEnable = (stValue & STATUS_MASK.MEAS_ENABLE) !== 0;
            const testDone = (stValue & STATUS_MASK.TEST_DONE) !== 0;

            // 每秒把状态寄存器结果反馈到前端状态寄存器表
            io?.emit('registerStatusUpdate', {
              connectionId,
              host,
              unitId: targetUnitId,
              deviceAddress: targetUnitId,
              mac: statusMac || undefined,
              statusRegister: stValue,
              statusBits: {
                measEnable,
                testDone,
                rawValue: stValue,
                binaryString: stValue.toString(2).padStart(16, '0')
              },
              timestamp: new Date().toISOString(),
              isRegisterUpdate: true
            });

            console.log(` F2快速轮询 ${connectionId}: meas_enable=${measEnable ? 1 : 0}, test_done=${testDone ? 1 : 0}, status=0x${stValue.toString(16).padStart(4, '0')}`);
            io?.emit('testStateChange', {
              state: 'TESTING',
              connectionId,
              message: `快速测试状态：MEAS_ENABLE=${measEnable ? 1 : 0}, TEST_DONE=${testDone ? 1 : 0}`,
              testType: 'F2',
              measEnable,
              testDone,
              statusRegister: stValue
            });

            if (testDone) {
              console.log(` F2快速轮询 ${connectionId}: TEST_DONE=1，快速测试流程结束，开始接收数据`);
              io?.emit('testStateChange', {
                state: 'TESTING',
                connectionId,
                message: 'TEST_DONE = 1，正在获取数据',
                testType: 'F2',
                measEnable,
                testDone: true,
                statusRegister: stValue
              });
              isDone = true;
              break;
            }
          } else {
            io?.emit('testStateChange', {
              state: 'TESTING',
              connectionId,
              message: '状态寄存器读取失败，等待下一次轮询',
              testType: 'F2'
            });
          }

          if (controller.active) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        if (!controller.active) {
          console.log(` F2快速轮询 ${connectionId}: 状态轮询阶段已停止`);
          return;
        }

        if (!isDone) {
          console.warn(` F2快速轮询 ${connectionId}: 测试等待超时，放弃本次数据收取`);
          io?.emit('testStateChange', {
            state: 'IDLE',
            connectionId,
            message: 'F2快速测试等待 test_done 超时，请重试',
            testType: 'F2'
          });
          stopPolling(connectionId);
          return;
        }

        // 阶段4: 数据收割 (每10ms收割一次，60次约0.6秒)
        console.log(` F2快速轮询 ${connectionId}: 开始10ms高频数据收割，限额60次（约0.6秒）`);
        let readCount = 0;
        const maxReads = 60;
        const harvestIntervalMs = 10;

        for (let i = 0; i < maxReads && controller.active; i++) {
          readCount = i + 1;
          try {
            await readDeviceData(connectionId, targetUnitId, 'F2_HARVEST');
          } catch (e) {
            console.error('获取数据出错', e);
          }

          const pollingInfo = pollingTimers.get(connectionId);
          if (pollingInfo) {
            pollingInfo.readCount = readCount;
          }

          if (controller.active && i < maxReads - 1) {
            await new Promise(r => setTimeout(r, harvestIntervalMs));
          }
        }

        if (!controller.active) {
          return;
        }

        console.log(` F2快速轮询 ${connectionId}: 60次数据收割完毕`);

        io?.emit('testStateChange', {
          state: 'TESTING',
          connectionId,
          message: '数据读取结束，共六十条，开始每秒检测 MEAS_ENABLE 是否复位',
          testType: 'F2'
        });

        // 数据读取后进入冷却监测阶段：每秒读取Bit0(MEAS_ENABLE)，置0即阶段5
        const pollingInfo = pollingTimers.get(connectionId);
        if (pollingInfo) {
          pollingInfo.timer = null;
        }

        const maxCooldownChecks = 40;
        let cooldownEnded = false;
        for (let i = 0; i < maxCooldownChecks && controller.active; i++) {
          const cBuf = await readHoldingRegistersWithFixedTxId(connectionId, getNextTransactionId(), REGISTERS.STATUS, REGISTERS.STATUS_READ_COUNT, targetUnitId);
          if (cBuf && cBuf.length >= 2) {
            const cValue = cBuf.readUInt16BE(0);
            const cooldownMeasEnable = (cValue & STATUS_MASK.MEAS_ENABLE) !== 0;
            const cooldownTestDone = (cValue & STATUS_MASK.TEST_DONE) !== 0;

            io?.emit('registerStatusUpdate', {
              connectionId,
              host,
              unitId: targetUnitId,
              deviceAddress: targetUnitId,
              mac: statusMac || undefined,
              statusRegister: cValue,
              statusBits: {
                measEnable: cooldownMeasEnable,
                testDone: cooldownTestDone,
                rawValue: cValue,
                binaryString: cValue.toString(2).padStart(16, '0')
              },
              timestamp: new Date().toISOString(),
              isRegisterUpdate: true
            });

            io?.emit('testStateChange', {
              state: 'TESTING',
              connectionId,
              message: `冷却状态监测：MEAS_ENABLE=${cooldownMeasEnable ? 1 : 0}, TEST_DONE=${cooldownTestDone ? 1 : 0}`,
              testType: 'F2',
              measEnable: cooldownMeasEnable,
              testDone: cooldownTestDone,
              statusRegister: cValue
            });

            if (!cooldownMeasEnable) {
              cooldownEnded = true;
              io?.emit('testStateChange', {
                state: 'IDLE',
                connectionId,
                message: '阶段5：冷却保护结束，可以进行新的测试',
                testType: 'F2',
                measEnable: false,
                testDone: cooldownTestDone,
                statusRegister: cValue
              });
              break;
            }
          } else {
            io?.emit('testStateChange', {
              state: 'TESTING',
              connectionId,
              message: '冷却状态寄存器读取失败，等待下一次轮询',
              testType: 'F2'
            });
          }

          if (controller.active) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        if (!controller.active) {
          return;
        }

        if (!cooldownEnded) {
          io?.emit('testStateChange', {
            state: 'IDLE',
            connectionId,
            message: '冷却状态监测超时（40秒），请检查设备状态',
            testType: 'F2'
          });
        }

        stopPolling(connectionId, {
          sendF2StopCommand: false,
          reason: 'F2流程自然结束'
        });

      } catch (err) {
        console.error(` F2全流程执行失败 ${connectionId}:`, err);
        stopPolling(connectionId, {
          sendF2StopCommand: true,
          reason: 'F2流程异常终止'
        });
      }
    })();

    // 立刻返回True，通知UI已成功触发测试
    return true;

  } catch (error) {
    console.error(` F2快速轮询启动失败 ${connectionId}:`, error);
    return false;
  }
};

interface StopPollingOptions {
  sendF2StopCommand?: boolean;
  f2StopValue?: number;
  reason?: string;
}

// 停止轮询
export const stopPolling = (connectionId: string, options?: StopPollingOptions): boolean => {
  const pollingInfo = pollingTimers.get(connectionId);
  if (pollingInfo) {
    const sendF2StopCommand = options?.sendF2StopCommand ?? true;
    const f2StopValue = options?.f2StopValue ?? 0x0002;

    if (pollingInfo.timer) clearInterval(pollingInfo.timer);
    if (pollingInfo.controller) pollingInfo.controller.active = false; // 停止异步循环
    pollingTimers.delete(connectionId);

    // 如果是F1轮询，还需要发送停止命令 (写 0x0002 = 0)
    if (pollingInfo.type === 'F1') {
      const connections = getClientConnections();
      connections.forEach(conn => {
        if (conn.isConnected) {
          const txId = getNextTransactionId();
          writeSingleRegisterWithFixedTxId(conn.id, txId, REGISTERS.CONTROL_B, 0x0000)
            .catch(e => console.error(`F1停止命令发送失败 ${conn.id}:`, e));
        }
      });
    } else if (pollingInfo.type === 'F2') {
      // F2 手动停止命令: 写 0x0002 到 CONTROL_A(0x0001) 强制中止
      if (sendF2StopCommand) {
        const connections = getClientConnections();
        connections.forEach(conn => {
          if (conn.isConnected) {
            const txId = getNextTransactionId();
            const targetUnitId = pollingInfo.targetUnitId;
            writeSingleRegisterWithFixedTxId(conn.id, txId, REGISTERS.CONTROL_A, f2StopValue, targetUnitId)
              .catch(e => console.error(`F2停止命令发送失败 ${conn.id}:`, e));
          }
        });
      } else {
        console.log(` F2轮询自然结束 ${connectionId}: 不发送F2停止写命令`);
      }
    }

    console.log(` ${pollingInfo.type}轮询已停止 ${connectionId} (${options?.reason || '未指定原因'})`);
    return true;
  }
  return false;
};

// 停止所有轮询
export const stopAllPolling = (): void => {
  console.log(` 停止所有轮询，共${pollingTimers.size}个`);
  for (const [connectionId, pollingInfo] of pollingTimers) {
    // 停止主定时器
    if (pollingInfo.timer) clearInterval(pollingInfo.timer);
    if (pollingInfo.controller) pollingInfo.controller.active = false; // 停止异步循环

    // 如果是F1轮询，还需要停止读取定时器
    if (pollingInfo.readTimer) {
      clearInterval(pollingInfo.readTimer);
    }

    console.log(` 已停止${pollingInfo.type}轮询 ${connectionId}`);
  }
  pollingTimers.clear();
};

// 获取轮询状态
export const getPollingStatus = (): Array<{ connectionId: string, type: 'F1' | 'F2', startTime: number, elapsed: number, readCount?: number }> => {
  const status = [];
  for (const [connectionId, pollingInfo] of pollingTimers) {
    status.push({
      connectionId,
      type: pollingInfo.type,
      startTime: pollingInfo.startTime,
      elapsed: Date.now() - pollingInfo.startTime,
      readCount: pollingInfo.readCount
    });
  }
  return status;
};

// 获取F2测试当前目标设备地址
export const getF2TargetUnitId = (connectionId: string): number | undefined => {
  const pollingInfo = pollingTimers.get(connectionId);
  if (!pollingInfo || pollingInfo.type !== 'F2') {
    return undefined;
  }
  return pollingInfo.targetUnitId;
};

// 批量轮询：对所有连接的设备启动轮询
export const startBatchPolling = async (type: 'F1' | 'F2', periodSeconds?: number): Promise<{ success: number, failed: number, results: Array<{ connectionId: string, success: boolean, error?: string }> }> => {
  // 检查是否应该启用轮询（只有连接设备数量大于1时才启用）
  if (!shouldEnablePolling()) {
    console.log(` 批量轮询启动被拒绝: 连接设备数量不大于1台`);
    return { success: 0, failed: 0, results: [] };
  }

  const connections = getClientConnections();
  const activeConnections = connections.filter(conn => conn.isConnected);

  console.log(` 开始批量${type}轮询，共${activeConnections.length}个设备`);

  const results = [];
  let successCount = 0;
  let failedCount = 0;

  for (const connection of activeConnections) {
    try {
      let success = false;

      if (type === 'F1') {
        success = await startF1CyclicPolling(connection.connectionId, periodSeconds || 3, undefined, 0x0001); // 默认3秒间隔
      } else if (type === 'F2') {
        success = await startF2FastPolling(connection.connectionId);
      }

      if (success) {
        successCount++;
        results.push({ connectionId: connection.connectionId, success: true });
      } else {
        failedCount++;
        results.push({ connectionId: connection.connectionId, success: false, error: '启动失败' });
      }

    } catch (error) {
      failedCount++;
      results.push({
        connectionId: connection.connectionId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { success: successCount, failed: failedCount, results };
};

// 测试新协议格式（打印日志）
export const testNewProtocolFormat = () => {
  console.log("\n=== 新协议数据格式说明 ===");
  console.log("数据寄存器映射:");
  console.log("  0x0000: 状态寄存器");
  console.log("  0x0001: 控制寄存器A");
  console.log("  0x0002: 控制寄存器B");
  console.log("  0x0003: 电压（mV）");
  console.log("  0x0004: 电池1阻抗 R1");
  console.log("  0x0005: 电池1阻抗 R2");
  console.log("  0x0006: 电池1阻抗 R3");
  console.log("  0x0007: 电池3阻抗 R1");
  console.log("  0x0008: 电池3阻抗 R2");
  console.log("  0x0009: 电池3阻抗 R3");
  console.log("  0x000A: 电池4阻抗 R1");
  console.log("  0x000B: 电池4阻抗 R2");
  console.log("  0x000C: 电池4阻抗 R3");

  return {
    message: "新协议格式说明已输出到控制台"
  };
};

// 更新读取策略 (Stub)
export const updateReadStrategy = () => {
  return { type: 'auto' };
}
