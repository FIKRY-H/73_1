import { EventEmitter } from 'events';
import {
  getClientConnections, readHoldingRegisters, writeSingleRegister, writeSingleRegisterWithFixedTxId,
  readHoldingRegistersWithFixedTxId, sendReadCommand, commandQueues, writeSingleRegisterWithFixedTxIdAndResponse,
  modbusEvents
} from './modbusService';
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

// F1异步轮询的掉线计数器
export const f1StrikeCounts = new Map<number, number>();

export const clearF1Strike = (unitId: number) => {
  f1StrikeCounts.set(unitId, 0);
};

// 设备数据接口（GET_for_Tesla 协议）
interface DeviceData {
  connectionId: string;
  host: string;
  mac: string;
  deviceId: number;
  statusRegister: number; // 0x0000: 状态寄存器
  voltage: number;        // 0x0004: 电压（mV）
  r1: number;             // 0x0005: 电池1阻抗 R1
  r2: number;             // 0x0006: 电池1阻抗 R2
  r3: number;             // 0x0007: 电池1阻抗 R3

  controlA: number;       // 0x0001: 控制寄存器A
  controlB: number;       // 0x0002: 控制寄存器B
  gearValue?: number;     // 0x0003: 档位寄存器

  r1Actual: number;       // 计算后的R1实际值
  r2Actual: number;       // 计算后的R2实际值
  r3Actual: number;       // 计算后的R3实际值
  timestamp: Date;
  errorCount: number;
}

interface DeviceStatusSnapshot {
  statusRegister: number;
  controlRegisterA: number;
  controlRegisterB: number;
}

// 寄存器地址定义 (按照GET3017协议)
// 写入命令(广播): UnitID = 0xFF
// 读数据命令(单播): UnitID = 1~128
const REGISTERS = {
  STATUS: 0x0000,            // 状态寄存器
  CONTROL_A: 0x0001,         // 强制停止/清除告警
  CONTROL_B: 0x0002,         //周期测试
  GEAR_CTRL: 0x0003,         // 档位控制寄存器 (GET_for_Tesla)
  DATA_START: 0x0000,        // 数据起始地址
  DATA_COUNT: 8,             // GET_for_Tesla: 数据读取长度 (0x0000 ~ 0x0007)
  STATUS_READ_COUNT: 3,      // 读取0x0000~0x0002（状态+控制A+控制B）
  CONTROL_CYCLE: 0x0002,     // 启动(写周期)/停止(写0)地址
  BROADCAST_UNIT_ID: 0xFF,   // 广播/控制 Unit ID
  RAW_R2_START: 0x0100,      // RAW R2[0..31] 起始地址
  RAW_R3_START: 0x0120,      // RAW R3[0..31] 起始地址
  RAW_COUNT: 32,             // RAW 数据点数
};

const DEVICE_UNIT_MIN = 1;
const DEVICE_UNIT_MAX = 12;  // GET_for_Tesla: 每IP最多12个设备

// 状态位掩码
const STATUS_MASK = {
  MEAS_ENABLE: 0x0001, // Bit 0
  COMM_TIMEOUT: 0x0010, // Bit 4
  TEST_DONE: 0x0020, // Bit 5
  DATA_READY: 0x0080, // Bit 7
  COMM_ERROR: 0x0100  // Bit 8
};

const emitAgentDebugLog = (payload: {
  runId: string;
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
}) => {
  fetch('http://127.0.0.1:7799/ingest/bcae092e-e546-43fb-9417-75685ac13d6d', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': 'd1842a'
    },
    body: JSON.stringify({
      sessionId: 'd1842a',
      runId: payload.runId,
      hypothesisId: payload.hypothesisId,
      location: payload.location,
      message: payload.message,
      data: payload.data || {},
      timestamp: Date.now()
    })
  }).catch(() => { });
};

// 设备状态映射
const deviceStates = new Map<string, DeviceData>();

// 事务ID计数器
let transactionId = 0x0001;
// 获取递增的Transaction ID
export function getNextTransactionId(): number {
  transactionId++;
  if (transactionId > 0xFFFF) transactionId = 0x0001;
  return transactionId;
}

// 读取状态寄存器 (特定Unit)
export const readDeviceStatus = async (connectionId: string, unitId: number, timeoutMs: number = 10): Promise<DeviceStatusSnapshot | null> => {
  try {
    const txId = getNextTransactionId();
    // 读取3个寄存器 0x0000~0x0002（按协议要求）
    const buffer = await readHoldingRegistersWithFixedTxId(connectionId, txId, REGISTERS.STATUS, REGISTERS.STATUS_READ_COUNT, unitId, timeoutMs);
    if (buffer && buffer.length >= 6) {
      return {
        statusRegister: buffer.readUInt16BE(0),
        controlRegisterA: buffer.readUInt16BE(2),
        controlRegisterB: buffer.readUInt16BE(4)
      };
    }
    if (buffer && buffer.length >= 2) {
      return {
        statusRegister: buffer.readUInt16BE(0),
        controlRegisterA: 0,
        controlRegisterB: 0
      };
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
  logContext?: 'F1_POLLING' | 'F2_HARVEST',
  timeoutMs: number = 1000
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
    const dataBuffer = await readHoldingRegistersWithFixedTxId(connectionId, txId, REGISTERS.DATA_START, REGISTERS.DATA_COUNT, targetUnitId, timeoutMs);

    const { getClientConnections } = await import('./modbusService');
    const connections = getClientConnections();
    const connection = connections.find(conn => conn.id === connectionId);
    const host = connection?.host || '';
    const uniqueMac = `${host}_${targetUnitId.toString().padStart(2, '0')}`;

    // GET_for_Tesla: 解析数据 (8个寄存器 = 16字节)
    let voltage = 0;
    let r1 = 0; let r2 = 0; let r3 = 0;
    let statusRegister = 0;
    let controlA = 0; let controlB = 0;
    let gearValue = 0;

    if (dataBuffer && dataBuffer.length >= 16) {
      statusRegister = dataBuffer.readUInt16BE(0); // 0x0000
      controlA = dataBuffer.readUInt16BE(2);       // 0x0001
      controlB = dataBuffer.readUInt16BE(4);       // 0x0002
      gearValue = dataBuffer.readUInt16BE(6);       // 0x0003
      let rawV = dataBuffer.readUInt16BE(8);       // 0x0004 = UNIT_VOLT
      voltage = rawV & 0x1FFF;
      const multiplierIndex = (rawV >> 13) & 0x07;
      const multipliers = [1, 4, 8, 12, 16, 20, 24, 28];
      const m = multipliers[multiplierIndex] || 1;

      r1 = dataBuffer.readUInt16BE(10) * m; // 0x0005
      r2 = dataBuffer.readUInt16BE(12) * m; // 0x0006
      r3 = dataBuffer.readUInt16BE(14) * m; // 0x0007
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
      controlA, controlB,
      gearValue,
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

// 静默探测设备在线状态（FC06 写 0x0001=0x0004）
// 仅用于扫描：不发送电池数据事件、不写设备缓存。
const scanDeviceSilentlyWith06 = async (connectionId: string, targetUnitId: number): Promise<boolean> => {
  try {
    const txId = getNextTransactionId();
    const ok = await writeSingleRegisterWithFixedTxIdAndResponse(
      connectionId,
      txId,
      REGISTERS.CONTROL_A,
      0x0004,
      targetUnitId,
      100
    );
    return ok;
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

// 扫描 1-12 设备是否在线（按 UID 跨网关剪枝与3遍重试策略）
export const scanOnlineDevices = async (preferredConnectionId?: string): Promise<{
  onlineDevices: number[];
  onlineDevicesByHost: Record<string, number[]>;
  totalScanned: number;
}> => {
  const activeConnections = getClientConnections().filter(conn => conn.isConnected && conn.id && conn.host);
  if (activeConnections.length === 0) {
    return {
      onlineDevices: [],
      onlineDevicesByHost: {},
      totalScanned: DEVICE_UNIT_MAX - DEVICE_UNIT_MIN + 1
    };
  }

  const orderedConnections = [...activeConnections];
  if (preferredConnectionId) {
    const preferredIndex = orderedConnections.findIndex(c => c.id === preferredConnectionId || c.connectionId === preferredConnectionId);
    if (preferredIndex > 0) {
      const [preferred] = orderedConnections.splice(preferredIndex, 1);
      orderedConnections.unshift(preferred);
    }
  }

  const onlineDevices: number[] = [];
  const onlineDevicesByHost: Record<string, number[]> = {};
  const io = getSocketIOInstance();
  const totalScanned = DEVICE_UNIT_MAX - DEVICE_UNIT_MIN + 1;

  console.log(`[Scan] 开始扫描所有已连接网关 (${orderedConnections.length} 条连接), UID范围 ${DEVICE_UNIT_MIN}-${DEVICE_UNIT_MAX}`);

  // 发送开始事件
  io.emit('deviceScanStarted', {
    total: totalScanned,
    connectionCount: orderedConnections.length,
    preferredConnectionId: preferredConnectionId || null
  });

  // 记录待检测的UID集合
  const remainingUids = new Set<number>();
  for (let unitId = DEVICE_UNIT_MIN; unitId <= DEVICE_UNIT_MAX; unitId++) {
    remainingUids.add(unitId);
  }

  // 最多扫描三遍
  for (let round = 1; round <= 3; round++) {
    console.log(`[Scan] 开始第 ${round} 遍扫描，当前待检测UID数: ${remainingUids.size}`);
    if (remainingUids.size === 0) {
      break;
    }

    const currentRoundUids = Array.from(remainingUids);
    for (const unitId of currentRoundUids) {
      let isOnline = false;
      let matchedConnectionId: string | null = null;
      let matchedHost: string | null = null;

      try {
        // 对当前UID遍历所有连接，命中即剪枝
        for (const conn of orderedConnections) {
          const detected = await scanDeviceSilentlyWith06(conn.id, unitId);
          if (detected) {
            isOnline = true;
            matchedConnectionId = conn.id;
            matchedHost = conn.host;

            onlineDevices.push(unitId);
            if (!onlineDevicesByHost[conn.host]) {
              onlineDevicesByHost[conn.host] = [];
            }
            onlineDevicesByHost[conn.host].push(unitId);
            
            // 成功扫到，从待检测集合中移除
            remainingUids.delete(unitId);
            break;
          }
        }

        // 实时发送进度
        io.emit('deviceScanProgress', {
          unitId,
          online: isOnline,
          matchedConnectionId,
          matchedHost,
          progress: unitId,
          total: totalScanned,
          round
        });

      } catch (error) {
        io.emit('deviceScanProgress', {
          unitId,
          online: false,
          progress: unitId,
          total: totalScanned,
          round
        });
      }

      // 短暂延时，避免瞬间发包过多导致拥塞
      await new Promise(r => setTimeout(r, 50));
    }

    // 剪枝策略：如果在第1或第2遍扫描后，所有通道都已扫描在线，则提前结束扫描
    if (remainingUids.size === 0 && (round === 1 || round === 2)) {
      console.log(`[Scan] 第 ${round} 遍扫描结束，全部通道皆已在线，提前结束扫描`);
      break;
    }
  }

  // 对结果进行排序
  onlineDevices.sort((a, b) => a - b);
  for (const host in onlineDevicesByHost) {
    onlineDevicesByHost[host].sort((a, b) => a - b);
  }

  console.log(`[Scan] 扫描完成。发现 ${onlineDevices.length} 个在线设备`);

  io.emit('deviceScanComplete', {
    onlineDevices,
    onlineDevicesByHost,
    totalScanned
  });

  return { onlineDevices, onlineDevicesByHost, totalScanned };
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
      console.log(`基于F1轮询状态判断测试类型: ${testType} (周期测试)`);
    } else if (currentPolling.type === 'F2') {
      testType = FrameType.FastTest; // F2快速测试
      console.log(`基于F2轮询状态判断测试类型: ${testType} (快速测试)`);
    }
  } else {
    // 如果没有活跃轮询，检查全局F1轮询定时器（兼容旧的轮询机制）
    if (global.f1PollingTimers && global.f1PollingTimers.has(deviceData.connectionId)) {
      testType = FrameType.CyclicTest; // F1周期测试
      console.log(`基于全局F1轮询状态判断测试类型: ${testType} (周期测试)`);
    } else {
      // 默认为周期测试（因为两种测试类型数据格式相同，无法通过数据内容区分）
      testType = FrameType.CyclicTest;
      console.log(`无法确定测试类型，默认为周期测试: ${testType}`);
    }
  }

  // 由于移除了状态寄存器，所有数据都会被发送
  console.log(`发送电池数据到前端 ${deviceData.connectionId}: 电压=${deviceData.voltage}mV`);
  console.log(`前端使用设备标识: ${deviceData.mac}`);

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
  targetUnitIds?: number[]; // F2测试目标设备地址数组
  startTime: number;
  readCount?: number; // F2测试用
  controller?: { active: boolean }; // 用于控制异步循环停止
}

// 全局轮询定时器映射
const pollingTimers = new Map<string, PollingTimer>();

// 新增：Per-UID 测试状态
export interface UidTestState {
  connectionId: string;
  host: string;
  uid: number;
  testType: 'Cycle' | 'Single';
  active: boolean;
  periodSeconds?: number;   // Cycle模式下的周期
  gearValue?: number;
  startTime: number;
  controller: { active: boolean };
  harvestInProgress: boolean; // 防止重复收割DATA_READY
  singleTestPhase?: 'WRITING_GEAR' | 'WRITING_START' | 'WAITING_DATA_READY' | 'READING_DATA' | 'READING_RAW' | 'STOPPING';
}

// key = `${connectionId}_${uid}`
export const uidTestStates = new Map<string, UidTestState>();

// 单次测试结果存储，key = `${host}_${uid_padded}`，value = 历史数组
export interface SingleTestResult {
  r1: number;
  r2: number;
  r3: number;
  voltage: number;
  rawR2: number[];
  rawR3: number[];
  parsedR2: number[];
  parsedR3: number[];
  timestamp: string;
}
export const singleTestResults = new Map<string, SingleTestResult[]>();

// 存储单次测试结果
const storeSingleTestResult = (host: string, uid: number, result: Omit<SingleTestResult, 'timestamp'>) => {
  const deviceKey = `${host}_${String(uid).padStart(2, '0')}`;
  const entry: SingleTestResult = { ...result, timestamp: new Date().toISOString() };
  const existing = singleTestResults.get(deviceKey) || [];
  existing.push(entry);
  // 最多保留最近 50 次单次测试
  if (existing.length > 50) existing.shift();
  singleTestResults.set(deviceKey, existing);
  console.log(`[SingleTest] 存储结果: ${deviceKey}, 历史共${existing.length}次`);
};

// 新增：停止指定 UID 的测试
export const stopUidTest = async (connectionId: string, uid: number, reason?: string): Promise<boolean> => {
  const key = `${connectionId}_${uid}`;
  const state = uidTestStates.get(key);
  if (!state) return false;

  console.log(`[stopUidTest] Stopping UID ${uid} on ${connectionId}. Reason: ${reason || 'none'}`);
  state.active = false;
  state.controller.active = false;
  uidTestStates.delete(key);

  const io = getSocketIOInstance();

  // 发送停止测试命令 (写 0x0002 = 0)
  try {
    const txId = getNextTransactionId();
    await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, 0x0000, uid);
    console.log(`[stopUidTest] Unit ${uid} hardware stop command sent.`);
    
    // 平滑延时，读取最终状态
    await new Promise(r => setTimeout(r, 20));

    // 紧接着读取一次状态，确保前端更新 status
    const readTxId = getNextTransactionId();
    const buffer = await readHoldingRegistersWithFixedTxId(connectionId, readTxId, REGISTERS.STATUS, 3, uid, 1000);
    if (buffer && buffer.length >= 6) {
      const statusRegister = buffer.readUInt16BE(0);
      const controlRegisterA = buffer.readUInt16BE(2);
      const controlRegisterB = buffer.readUInt16BE(4);

      const { parseStatusRegister } = await import('../utils/modbusFrameUtils');
      const parsedStatus = parseStatusRegister(statusRegister);

      io?.emit('registerStatusUpdate', {
        connectionId,
        host: state.host,
        unitId: uid,
        timestamp: Date.now(),
        ...parsedStatus,
        statusRegister,
        controlRegisterA,
        controlRegisterB
      });
    }
  } catch (e) {
    console.error(`[stopUidTest] Unit ${uid} 停止命令/读取最终状态失败:`, e);
  }

  // 发送 IDLE 到前端
  io?.emit('testStateChange', {
    state: 'IDLE',
    connectionId,
    host: state.host,
    message: `${state.testType === 'Cycle' ? '周期' : '单次'}测试已停止`,
    testType: state.testType === 'Cycle' ? 'F1' : 'Single',
    unitIds: [uid]
  });

  return true;
};

// 删除寄存器监控相关的函数，不再需要处理状态寄存器与控制寄存器

// 恢复错误状态：停止 -> 快速读取直到 clean -> 返回
const recoverConnectionState = async (connectionId: string, targetUnitIds: number[]): Promise<boolean> => {
  console.log(`进入恢复模式 ${connectionId} ...`);

  // 1. 发送停止命令 (UnitFF)
  try {
    const txId = getNextTransactionId();
    await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, 0x0000, REGISTERS.BROADCAST_UNIT_ID);
    console.log(`[恢复] 停止命令已发送 (Unit FF)`);
  } catch (e) {
    console.error(`[恢复] 停止命令失败`, e);
  }

  // 2. 快速读取循环 (10ms)
  // 策略优化:
  // 1. 维护pending列表，只检查尚未就绪的设备
  // 2. 只有所有在线设备都就绪(Cnt=0)才退出，保证同步
  // 3. 读取失败(离线)的设备直接移除，防止拖慢整体进度(解决卡顿问题)
  const maxWrapperTime = 1000; // 最多尝试1秒
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

    // 纯递增正序遍历 (1 -> 80)
    const nextPendingUnitIds: number[] = [];
    for (let i = 0; i < pendingUnitIds.length; i++) {
      const unitId = pendingUnitIds[i];
      const data = await readDeviceData(connectionId, unitId);
      didWork = true;

      if (data) {
        // 利用 COMM_TIMEOUT 位来判断设备是否从掉线状态完全恢复通讯。
        // COMM_TIMEOUT == 0 说明设备底层的通讯超时报警已经被清除（收到上位机的帧了）
        if ((data.statusRegister & STATUS_MASK.COMM_TIMEOUT) === 0) {
          // 设备就绪，从等待列表移除
          // console.log(`Unit ${unitId} 就绪 (COMM_TIMEOUT === 0)`);
        } else {
          // 设备忙(COMM_TIMEOUT != 0)，保留在列表，下一轮继续检查
          nextPendingUnitIds.push(unitId);
        }
      } else {
        // 读取失败(超时/离线)，视为"无法恢复"或"无需等待"
        // 直接移除，避免因等待离线设备导致界面卡顿10秒
        console.warn(`[恢复] Unit ${unitId} 读取失败，跳过等待`);
      }
    }
    pendingUnitIds = nextPendingUnitIds;

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

// F1周期轮询 (GET_for_Tesla 协议)
export const startF1CyclicPolling = async (
  connectionId: string,
  periodSeconds: number,
  targetDevices?: string[],
  writeValue: number = 0x0001,
  gearValue?: number  // GET_for_Tesla: 档位值 (0.1mA步进, 1-624)
): Promise<boolean> => {
  try {
    let period = Number(periodSeconds);
    if (!Number.isFinite(period) || period < 1 || period > 60) period = 1;
    periodSeconds = period;

    if (!shouldEnablePolling()) {
      return false;
    }

    const allConnections = getClientConnections();
    const targetConnection = allConnections.find(c => c.id === connectionId || c.connectionId === connectionId);
    const host = targetConnection?.host || '';
    const io = getSocketIOInstance();

    if (!targetConnection) {
      console.warn(`F1启动: 找不到连接 ${connectionId}`);
      return false;
    }

    // 如果传入了目标设备列表，只轮询这些设备；否则轮询全部 12 个从机
    const unitIds = (targetDevices && targetDevices.length > 0)
      ? targetDevices.map(Number).filter(n => n >= DEVICE_UNIT_MIN && n <= DEVICE_UNIT_MAX)
      : Array.from({ length: DEVICE_UNIT_MAX - DEVICE_UNIT_MIN + 1 }, (_, i) => DEVICE_UNIT_MIN + i);

    console.log(`[F1 Start] 周期:${periodSeconds}s, Conn:${connectionId}, Units:${unitIds.join(', ')}`);

    // 对每个目标 UID，检查是否已有测试。如果有，先停止它
    for (const uid of unitIds) {
      const key = `${connectionId}_${uid}`;
      const existing = uidTestStates.get(key);
      if (existing) {
        console.log(`[F1 Start] UID ${uid} 已有活跃测试 (${existing.testType})，先将其停止。`);
        await stopUidTest(connectionId, uid, 'F1 Start Mutex');
      }
    }

    // 为每个 UID 启动独立的轮询周期
    for (const uid of unitIds) {
      const controller = { active: true };
      const key = `${connectionId}_${uid}`;
      const state: UidTestState = {
        connectionId,
        host,
        uid,
        testType: 'Cycle',
        active: true,
        periodSeconds,
        gearValue,
        startTime: Date.now(),
        controller,
        harvestInProgress: false
      };
      uidTestStates.set(key, state);

      // 启动独立的异步循环
      (async () => {
        try {
          console.log(`[F1 UID ${uid}] 独立轮询线程启动...`);

          // 1. 写档位寄存器 0x0003
          if (gearValue !== undefined && gearValue > 0) {
            console.log(`[F1 UID ${uid}] 写档位寄存器: gear=${gearValue} (${(gearValue * 0.1).toFixed(1)}mA)`);
            try {
              const txId = getNextTransactionId();
              await writeSingleRegisterWithFixedTxIdAndResponse(connectionId, txId, REGISTERS.GEAR_CTRL, gearValue, uid, 90);
              console.log(`[F1 UID ${uid}] 档位写入成功: ${gearValue}`);
            } catch (e) {
              console.warn(`[F1 UID ${uid}] 档位写入失败:`, e);
            }
            await new Promise(r => setTimeout(r, 100));
          }

          if (!controller.active) return;

          // 2. 写启动命令 (Write 0x0002 = periodSeconds)
          console.log(`[F1 UID ${uid}] 发送启动命令 (period=${periodSeconds}s)`);
          io?.emit('testStateChange', { state: 'STARTING', connectionId, message: `UID ${uid} 启动命令发送中...`, testType: 'F1', unitIds: [uid] });

          try {
            const txId = getNextTransactionId();
            const success = await writeSingleRegisterWithFixedTxIdAndResponse(connectionId, txId, REGISTERS.CONTROL_CYCLE, periodSeconds, uid, 90);
            if (success) {
              console.log(`[F1 UID ${uid}] 启动命令发送成功 (ACK)`);
            } else {
              console.warn(`[F1 UID ${uid}] 启动命令发送失败 (未收到 ACK)`);
            }
          } catch (e) {
            console.error(`[F1 UID ${uid}] 启动命令发送异常:`, e);
          }

          await new Promise(r => setTimeout(r, 100));
          if (!controller.active) return;

          // 通知前端：正式进入测试阶段
          io?.emit('testStateChange', { state: 'TESTING', connectionId, message: `UID ${uid} 周期测试已启动`, testType: 'F1', unitIds: [uid] });

          let strikes = 0;

          while (controller.active) {
            const loopStart = Date.now();
            let recoveryTriggered = false;

            // 检查状态寄存器
            const currentTxId = getNextTransactionId();
            console.log(`[F1 Poll UID ${uid}] status check (TxId=${currentTxId})...`);
            
            try {
              const buffer = await readHoldingRegistersWithFixedTxId(connectionId, currentTxId, 0x0000, 3, uid, 2000);
              if (buffer && buffer.length >= 6) {
                strikes = 0; // 重置掉线计数
                const statusRegister = buffer.readUInt16BE(0);
                const controlRegisterA = buffer.readUInt16BE(2);
                const controlRegisterB = buffer.readUInt16BE(4);

                const { parseStatusRegister } = await import('../utils/modbusFrameUtils');
                const parsedStatus = parseStatusRegister(statusRegister);

                io?.emit('registerStatusUpdate', {
                  connectionId,
                  host,
                  unitId: uid,
                  timestamp: Date.now(),
                  ...parsedStatus,
                  statusRegister,
                  controlRegisterA,
                  controlRegisterB
                });

                // 检查 DATA_READY (bit 7)
                if (parsedStatus.dataReady && !state.harvestInProgress) {
                  state.harvestInProgress = true;
                  console.log(`[F1 Poll UID ${uid}] DATA_READY=1, 正在下发获取完整数据指令(13寄存器)...`);
                  const dataTxId = getNextTransactionId();
                  try {
                    const dataBuf = await readHoldingRegistersWithFixedTxId(connectionId, dataTxId, 0x0000, 13, uid, 2000);
                    if (dataBuf && dataBuf.length >= 26) {
                      const values: number[] = [];
                      for (let i = 0; i < 13; i++) {
                        values.push(dataBuf.readUInt16BE(i * 2));
                      }
                      const { parseBatteryData } = await import('../utils/modbusFrameUtils');
                      const batteryDataParsed = parseBatteryData(values);
                      batteryDataParsed.unitId = uid;

                      const batteryDataForSave = {
                        ...batteryDataParsed,
                        mac: `${host}_${uid.toString().padStart(2, '0')}`,
                        ip_prefix: host,
                        device_address: uid.toString().padStart(2, '0')
                      };

                      const { saveBatteryData } = await import('./batteryService');
                      await saveBatteryData(batteryDataForSave as any);
                      io?.emit('batteryUpdate', batteryDataForSave);
                    }
                  } catch (err) {
                    console.error(`[F1 Poll UID ${uid}] 读取13个寄存器数据失败:`, err);
                  } finally {
                    state.harvestInProgress = false;
                  }
                }

                // 检查异常位 (bit 8)
                if (parsedStatus.commError) {
                  recoveryTriggered = true;
                }
              } else {
                strikes++;
              }
            } catch (e) {
              console.warn(`[F1 Poll UID ${uid}] 状态读取超时或错误.`);
              strikes++;
            }

            if (strikes >= 4) {
              console.warn(`[F1 UID ${uid}] 连续3次无响应，判定为离线`);
              io?.emit('testStateChange', { state: 'IDLE', connectionId, message: `UID ${uid} 已离线`, testType: 'F1', unitIds: [uid] });
              controller.active = false;
              uidTestStates.delete(key);
              break;
            }

            if (recoveryTriggered && controller.active) {
              io?.emit('testStateChange', { state: 'COMM_ERROR', connectionId, testType: 'F1', unitIds: [uid] });
              console.warn(`[F1 UID ${uid}] 检测到通信错误，执行单个UID恢复流程`);

              // 发送停止命令
              try {
                const txId = getNextTransactionId();
                await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, 0x0000, uid);
              } catch (e) { console.error(e); }

              // 快速恢复
              await recoverConnectionState(connectionId, [uid]);

              await new Promise(r => setTimeout(r, 50));

              // 重新启动
              if (controller.active) {
                console.log(`[故障恢复 UID ${uid}] 重新发送启动命令...`);
                try {
                  const txId = getNextTransactionId();
                  await writeSingleRegisterWithFixedTxIdAndResponse(connectionId, txId, REGISTERS.CONTROL_CYCLE, periodSeconds, uid, 100);
                } catch (e) { console.error(e); }
                
                if (controller.active) {
                  io?.emit('testStateChange', { state: 'TESTING', connectionId, testType: 'F1', unitIds: [uid] });
                }
              }
            }

            // 循环间隔控制：固定1秒
            const elapsed = Date.now() - loopStart;
            const delay = Math.max(10, 1000 - elapsed);
            if (controller.active) {
              await new Promise(r => setTimeout(r, delay));
            }
          }

          console.log(`[F1 UID ${uid}] 退出循环，执行停止清理...`);
          // 清理逻辑：发送停止命令并同步读取状态
          try {
            const stopTxId = getNextTransactionId();
            await writeSingleRegisterWithFixedTxId(connectionId, stopTxId, REGISTERS.CONTROL_CYCLE, 0x0000, uid);
            await new Promise(r => setTimeout(r, 20));

            // 读取状态确保前端更新
            const readTxId = getNextTransactionId();
            const buffer = await readHoldingRegistersWithFixedTxId(connectionId, readTxId, REGISTERS.STATUS, 3, uid, 1000);
            if (buffer && buffer.length >= 6) {
              const statusRegister = buffer.readUInt16BE(0);
              const controlRegisterA = buffer.readUInt16BE(2);
              const controlRegisterB = buffer.readUInt16BE(4);

              const { parseStatusRegister } = await import('../utils/modbusFrameUtils');
              const parsedStatus = parseStatusRegister(statusRegister);

              io?.emit('registerStatusUpdate', {
                connectionId,
                host,
                unitId: uid,
                timestamp: Date.now(),
                ...parsedStatus,
                statusRegister,
                controlRegisterA,
                controlRegisterB
              });
            }
          } catch (e) {
            console.error(`[F1清理 UID ${uid}] 失败:`, e);
          }
          console.log(`[F1 UID ${uid}] 独立轮询线程结束.`);

        } catch (err) {
          console.error(`[F1 UID ${uid}] 独立轮询线程异常:`, err);
        }
      })();
    }

    return true;
  } catch (error) {
    console.error(` F1周期轮询启动失败:`, error);
    return false;
  }
};


// F2快速轮询：写命令启动后每秒读取状态寄存器并解析；
// 等待 TEST_DONE=1，然后进行收割（60次读），随后检测 MEAS_ENABLE=0 判断冷却结束
export const startF2FastPolling = async (connectionId: string, targetUnitIds: number[] | number = [1]): Promise<boolean> => {
  try {
    const io = getSocketIOInstance();
    const debugRunId = `f2-${connectionId}-${Date.now()}`;
    const targetConnection = getClientConnections().find(c => c.id === connectionId || c.connectionId === connectionId);
    const host = targetConnection?.host || '';

    // Ensure array format
    const unitIds = Array.isArray(targetUnitIds) ? targetUnitIds : [targetUnitIds];

    // 检查是否应该启用轮询
    if (!shouldEnablePolling()) {
      console.log(`F2快速轮询启动被拒绝 ${connectionId}: 没有连接的设备`);
      return false;
    }

    // 停止现有轮询
    // #region agent log
    emitAgentDebugLog({
      runId: debugRunId,
      hypothesisId: 'H2',
      location: 'pollingService.ts:startF2FastPolling:beforeStopPolling',
      message: 'Starting F2, checking previous polling timer',
      data: {
        connectionId,
        previousTimer: pollingTimers.get(connectionId)
          ? {
            type: pollingTimers.get(connectionId)?.type,
            targetUnitIds: pollingTimers.get(connectionId)?.targetUnitIds,
            readCount: pollingTimers.get(connectionId)?.readCount
          }
          : null
      }
    });
    // #endregion
    stopPolling(connectionId);

    console.log(`启动F2快速轮询 ${connectionId}: 阶段1/发送启动信号`);

    // 1. 发送F2启动命令 (写 0x0001 = 1 到 CONTROL_A 0x0001)
    // 每个UID使用独立事务号，便于日志追踪与问题定位。
    for (const uId of unitIds) {
      const txId = getNextTransactionId();
      await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_A, 0x0001, uId).catch(console.error);
      await new Promise(r => setTimeout(r, 5)); // 5ms间隔
    }
    console.log(` F2启动命令已发送 ${connectionId} (UnitIDs=${unitIds.join(',')}, Reg=0x0001, Val=1)`);
    io?.emit('testStateChange', {
      state: 'TESTING',
      connectionId,
      message: '阶段2：命令写入成功，开始每秒轮询状态寄存器',
      testType: 'F2',
      unitIds
    });

    const startTime = Date.now();
    const controller = { active: true };

    // 提前注册到系统，确保在状态轮询阶段也可以被 stopPolling 及时停止
    pollingTimers.set(connectionId, {
      timer: null,
      type: 'F2',
      connectionId,
      targetUnitId: unitIds[0], // Keep for backward compat
      targetUnitIds: unitIds,
      startTime,
      readCount: 0,
      controller
    });
    // #region agent log
    emitAgentDebugLog({
      runId: debugRunId,
      hypothesisId: 'H1',
      location: 'pollingService.ts:startF2FastPolling:afterSetPollingTimer',
      message: 'F2 timer initialized',
      data: { connectionId, unitIds, stage: 'monitoring-ready' }
    });
    // #endregion

    // F2 全新异步流水线架构
    (async () => {
      let isResolved = false;
      const unitStates = new Map<number, 'WAIT_HARVEST' | 'HARVESTING' | 'WAIT_COOLDOWN'>();
      const failCounts = new Map<number, number>();
      const harvestQueue: number[] = [];
      const receivedThisRound = new Set<number>();
      const activeUnitIds = new Set(unitIds);
      const droppedUnitIds = new Set<number>();
      const finishedUnitIds = new Set<number>();
      let harvestingUnitId: number | null = null;
      let monitorRound = 0;

      // 初始化状态
      for (const uId of unitIds) {
        unitStates.set(uId, 'WAIT_HARVEST');
        failCounts.set(uId, 0);
      }

      // 统一发送F2结构化进度，前端据此展示统计区与事件区。
      const emitF2Progress = (
        eventType: string,
        message?: string,
        eventUnitId?: number,
        extra?: Record<string, unknown>
      ) => {
        let pendingTestDone = 0;
        let coolingCount = 0;
        for (const uid of activeUnitIds) {
          const state = unitStates.get(uid);
          if (state === 'WAIT_HARVEST') pendingTestDone++;
          if (state === 'WAIT_COOLDOWN') coolingCount++;
        }

        io?.emit('f2ProgressUpdate', {
          connectionId,
          testType: 'F2',
          eventType,
          eventUnitId,
          message: message || '',
          totalUid: unitIds.length,
          activeUid: activeUnitIds.size,
          pendingTestDone,
          harvestingUid: harvestingUnitId,
          coolingCount,
          completedCount: finishedUnitIds.size,
          droppedCount: droppedUnitIds.size,
          round: monitorRound,
          timestamp: new Date().toISOString(),
          ...extra
        });
      };

      const cleanup = () => {
        isResolved = true;
      };

      emitF2Progress('START', 'F2测试启动成功，开始状态监听');

      try {
        console.log(`F2快速轮询 ${connectionId}: 阶段3/开始非阻塞联合状态监测`);

        while (activeUnitIds.size > 0 && controller.active) {
          const loopStart = Date.now();

          // 1. 如果有设备需要收割，暂停轮询，专心收割
          if (harvestQueue.length > 0) {
            const currentHarvest = harvestQueue.shift()!;
            harvestingUnitId = currentHarvest;
            // #region agent log
            emitAgentDebugLog({
              runId: debugRunId,
              hypothesisId: 'H4',
              location: 'pollingService.ts:monitorLoop:HARVEST_START_BEFORE_STATE_SWITCH',
              message: 'Dequeued harvest unit before state switch',
              data: {
                connectionId,
                currentHarvest,
                queueAfterShift: [...harvestQueue],
                stateBefore: unitStates.get(currentHarvest)
              }
            });
            // #endregion
            // 立即将状态改为 HARVESTING，防止收割期间回传的 TEST_DONE=1 导致二次排队
            unitStates.set(currentHarvest, 'HARVESTING');
            // #region agent log
            emitAgentDebugLog({
              runId: debugRunId,
              hypothesisId: 'H4',
              location: 'pollingService.ts:monitorLoop:HARVEST_START_AFTER_STATE_SWITCH',
              message: 'Harvest state switched to HARVESTING',
              data: {
                connectionId,
                currentHarvest,
                stateAfter: unitStates.get(currentHarvest)
              }
            });
            // #endregion
            console.log(`F2快速轮询 ${connectionId}: 开始专属数据收割 Unit ${currentHarvest} (60次)...`);
            io?.emit('testStateChange', {
              state: 'TESTING',
              connectionId,
              message: `正在收割 Unit ${currentHarvest} 的测试数据...`,
              testType: 'F2',
              unitIds: [currentHarvest]
            });
            emitF2Progress('HARVEST_START', `开始收割 Unit ${currentHarvest}`, currentHarvest);

            let readCount = 0;
            for (let i = 0; i < 60 && controller.active; i++) {
              readCount++;
              // 同步收割，不用管超时（只要发出指令等待响应即可，底层enqueueCommand会处理）
              await readDeviceData(connectionId, currentHarvest, 'F2_HARVEST', 20);

              const pollingInfo = pollingTimers.get(connectionId);
              if (pollingInfo) pollingInfo.readCount = readCount;

              if (readCount === 1 || readCount === 30 || readCount === 60) {
                emitF2Progress('HARVEST_PROGRESS', `Unit ${currentHarvest} 收割进度 ${readCount}/60`, currentHarvest, {
                  harvestReadCount: readCount
                });
              }

              await new Promise(r => setTimeout(r, 10)); // 10ms间距
            }

            console.log(`F2快速轮询 ${connectionId}: Unit ${currentHarvest} 收割完成，转入冷却监控`);
            // 收割完成不用等
            unitStates.set(currentHarvest, 'WAIT_COOLDOWN');
            // #region agent log
            emitAgentDebugLog({
              runId: debugRunId,
              hypothesisId: 'H5',
              location: 'pollingService.ts:monitorLoop:HARVEST_DONE',
              message: 'Harvest done and switched to WAIT_COOLDOWN',
              data: {
                connectionId,
                currentHarvest,
                queueNow: [...harvestQueue],
                stateNow: unitStates.get(currentHarvest)
              }
            });
            // #endregion
            harvestingUnitId = null;
            emitF2Progress('HARVEST_DONE', `Unit ${currentHarvest} 收割完成，转入冷却监听`, currentHarvest);
            continue; // 继续外层 while 循环，检查 harvestQueue 是否还有其它元素
          }

          // 2. 状态轮询：所有还在活跃列表中的设备
          monitorRound++;
          receivedThisRound.clear();
          const activeArr = Array.from(activeUnitIds);

          for (const unitId of activeArr) {
            if (!controller.active) break;
            const currentTxId = getNextTransactionId();
            console.log(`[F2 Status Poll] Unit ${unitId} status check (TxId=${currentTxId})...`);
            try {
              const buffer = await readHoldingRegistersWithFixedTxId(connectionId, currentTxId, REGISTERS.STATUS, REGISTERS.STATUS_READ_COUNT, unitId, 1000);
              if (buffer && buffer.length >= REGISTERS.STATUS_READ_COUNT * 2) {
                receivedThisRound.add(unitId);
                failCounts.set(unitId, 0); // 清零超时次数

                const statusReg = buffer.readUInt16BE(0);
                const controlA = buffer.readUInt16BE(2);
                const controlB = buffer.readUInt16BE(4);

                const measEnable = (statusReg & STATUS_MASK.MEAS_ENABLE) !== 0;
                const testDone = (statusReg & STATUS_MASK.TEST_DONE) !== 0;
                const statusMac = host ? `${host}_${unitId.toString().padStart(2, '0')}` : '';

                io?.emit('registerStatusUpdate', {
                  connectionId, host, unitId, deviceAddress: unitId,
                  mac: statusMac || undefined,
                  statusRegister: statusReg, controlRegisterA: controlA, controlRegisterB: controlB,
                  statusBits: {
                    measEnable, testDone, rawValue: statusReg,
                    binaryString: statusReg.toString(2).padStart(16, '0')
                  },
                  timestamp: new Date().toISOString(), isRegisterUpdate: true
                });

                const currentState = unitStates.get(unitId);
                if (currentState === 'WAIT_HARVEST') {
                  if (testDone) {
                    // #region agent log
                    emitAgentDebugLog({
                      runId: debugRunId,
                      hypothesisId: 'H3',
                      location: 'pollingService.ts:monitorLoop:WAIT_HARVEST_TEST_DONE',
                      message: 'TEST_DONE observed while WAIT_HARVEST',
                      data: {
                        connectionId,
                        resUnitId: unitId,
                        queueBefore: [...harvestQueue],
                        currentState
                      }
                    });
                    // #endregion
                    console.log(`F2快速轮询 ${connectionId}: 发现Unit ${unitId} TEST_DONE=1`);
                    if (!harvestQueue.includes(unitId)) {
                      harvestQueue.push(unitId);
                      emitF2Progress('TEST_DONE_DETECTED', `Unit ${unitId} TEST_DONE=1，进入收割队列`, unitId);
                    }
                  }
                } else if (currentState === 'WAIT_COOLDOWN') {
                  if (!measEnable) {
                    console.log(`F2快速轮询 ${connectionId}: Unit ${unitId} MEAS_ENABLE=0，冷却结束`);
                    activeUnitIds.delete(unitId);
                    unitStates.delete(unitId);
                    failCounts.delete(unitId);
                    finishedUnitIds.add(unitId);
                    emitF2Progress('COOLING_DONE', `Unit ${unitId} 冷却结束`, unitId);
                  } else {
                    io?.emit('testStateChange', {
                      state: 'TESTING', connectionId,
                      message: `冷却状态监测[Unit:${unitId}]：MEAS_ENABLE=1`,
                      testType: 'F2', measEnable, testDone, statusRegister: statusReg,
                      unitIds: [unitId]
                    });
                  }
                }
              }
            } catch (err) {
              console.warn(`[F2 Status Poll] Unit ${unitId} 状态读取超时或错误:`, err);
            }
            await new Promise(r => setTimeout(r, 10)); // 防止占满带宽
          }

          // 3. 补齐 1 秒周期
          if (controller.active) {
            const elapsed = Date.now() - loopStart;
            if (elapsed < 1000) {
              await new Promise(r => setTimeout(r, 1000 - elapsed));
            } else {
              await new Promise(r => setTimeout(r, 10)); // 让出CPU
            }
          }

          // 4. 计算超时离线 (3 strike)
          for (const unitId of activeArr) {
            if (!receivedThisRound.has(unitId)) {
              const fails = (failCounts.get(unitId) || 0) + 1;
              failCounts.set(unitId, fails);

              if (fails >= 3) {
                console.log(`F2快速轮询 ${connectionId}: Unit ${unitId} 连续3次无响应，剔除设备`);
                io?.emit('testStateChange', {
                  state: 'TESTING',
                  connectionId,
                  message: `[Unit:${unitId}] 连续3次读取状态失败，剔除该设备`,
                  testType: 'F2',
                  unitIds: [unitId]
                });
                droppedUnitIds.add(unitId);
                activeUnitIds.delete(unitId);
                unitStates.delete(unitId);
                failCounts.delete(unitId);
                const queueIndex = harvestQueue.indexOf(unitId);
                if (queueIndex >= 0) {
                  harvestQueue.splice(queueIndex, 1);
                }
                emitF2Progress('UID_DROPPED', `Unit ${unitId} 连续3次无响应，后续不再发指令`, unitId);
              }
            }
          }

          emitF2Progress('MONITOR_ROUND', `状态监听第 ${monitorRound} 轮完成`);
        }

        cleanup();

        if (!controller.active) return;

        console.log(`F2快速轮询 ${connectionId}: 所有设备测试并冷却完毕（或已掉线）`);
        emitF2Progress('ALL_DONE', '快速测试完成：所有设备已完成测试及冷却');
        io?.emit('testStateChange', {
          state: 'IDLE',
          connectionId,
          message: '快速测试完成：所有设备已完成测试及冷却',
          testType: 'F2',
          measEnable: false,
          testDone: true,
          statusRegister: 0,
          unitIds
        });

        stopPolling(connectionId, {
          sendF2StopCommand: false,
          reason: 'F2流程自然结束'
        });

      } catch (err) {
        cleanup();
        console.error(` F2全流程执行失败 ${connectionId}:`, err);
        emitF2Progress('ERROR', `F2流程异常终止: ${err instanceof Error ? err.message : String(err)}`);
        stopPolling(connectionId, {
          sendF2StopCommand: true,
          reason: 'F2流程异常终止'
        });
      }
    })();

    // 立刻返回True，通知UI已成功触发测试
    return true;

  } catch (error) {
    console.error(`F2快速轮询启动失败 ${connectionId}:`, error);
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
  let stoppedAny = false;

  // 1. legacy / F2 轮询停止
  const pollingInfo = pollingTimers.get(connectionId);
  if (pollingInfo) {
    const sendF2StopCommand = options?.sendF2StopCommand ?? true;
    const f2StopValue = options?.f2StopValue ?? 0x0002;

    if (pollingInfo.timer) clearInterval(pollingInfo.timer);
    if (pollingInfo.controller) pollingInfo.controller.active = false; // 停止异步循环
    pollingTimers.delete(connectionId);

    if (pollingInfo.type === 'F2') {
      // F2 手动停止命令: 写 0x0002 到 CONTROL_A(0x0001) 强制中止
      if (sendF2StopCommand) {
        const connections = getClientConnections();
        connections.forEach(conn => {
          if (conn.isConnected) {
            const txId = getNextTransactionId();
            const unitIdsToStop = (pollingInfo as any).targetUnitIds || [pollingInfo.targetUnitId];
            for (const uid of unitIdsToStop) {
              writeSingleRegisterWithFixedTxId(conn.id, txId, REGISTERS.CONTROL_A, f2StopValue, uid)
                .catch(e => console.error(`F2停止命令发送失败 ${conn.id}:`, e));
            }
          }
        });
      } else {
        console.log(` F2轮询自然结束 ${connectionId}: 不发送F2停止写命令`);
      }
    }

    console.log(` ${pollingInfo.type}轮询已停止 ${connectionId} (${options?.reason || '未指定原因'})`);

    // 通知前端状态已停止
    const connections = getClientConnections();
    const targetConnection = connections.find(c => c.id === connectionId || c.connectionId === connectionId);
    const host = targetConnection?.host || '';

    // 尽量获取相关 unitIds，如果未知则不传
    const uids = (pollingInfo as any).targetUnitIds ||
      (pollingInfo.targetUnitId ? [pollingInfo.targetUnitId] : undefined);

    getSocketIOInstance()?.emit('testStateChange', {
      state: 'IDLE',
      connectionId,
      host,
      message: `${pollingInfo.type} 测试已停止`,
      testType: pollingInfo.type,
      unitIds: uids
    });

    stoppedAny = true;
  }

  // 2. per-UID F1 / Single 轮询停止
  for (const [key, state] of uidTestStates.entries()) {
    if (state.connectionId === connectionId) {
      stopUidTest(connectionId, state.uid, options?.reason || 'stopPolling called');
      stoppedAny = true;
    }
  }

  return stoppedAny;
};

// 停止所有轮询
export const stopAllPolling = (): void => {
  console.log(` 停止所有轮询，共${pollingTimers.size}个 legacy/F2，${uidTestStates.size}个 UID 测试`);
  
  // 1. legacy / F2
  for (const [connectionId, pollingInfo] of pollingTimers) {
    if (pollingInfo.timer) clearInterval(pollingInfo.timer);
    if (pollingInfo.controller) pollingInfo.controller.active = false;
    if (pollingInfo.readTimer) clearInterval(pollingInfo.readTimer);
    console.log(`已停止 legacy ${pollingInfo.type}轮询 ${connectionId}`);
  }
  pollingTimers.clear();

  // 2. per-UID F1 / Single
  for (const [key, state] of uidTestStates.entries()) {
    stopUidTest(state.connectionId, state.uid, 'stopAllPolling called');
  }
};

// 获取轮询状态
export const getPollingStatus = (): Array<{ connectionId: string, type: string, startTime: number, elapsed: number, readCount?: number, uid?: number }> => {
  const status: any[] = [];
  
  // 1. legacy / F2
  for (const [connectionId, pollingInfo] of pollingTimers) {
    status.push({
      connectionId,
      type: pollingInfo.type,
      startTime: pollingInfo.startTime,
      elapsed: Date.now() - pollingInfo.startTime,
      readCount: pollingInfo.readCount
    });
  }

  // 2. per-UID
  for (const [key, state] of uidTestStates.entries()) {
    status.push({
      connectionId: state.connectionId,
      type: state.testType === 'Cycle' ? 'F1' : 'Single',
      startTime: state.startTime,
      elapsed: Date.now() - state.startTime,
      uid: state.uid
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
        success = await startF1CyclicPolling(connection.connectionId, periodSeconds || 1, undefined, 0x0001); // 默认1秒间隔
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
  console.log("\n=== GET_for_Tesla 协议数据格式说明 ===");
  console.log("数据寄存器映射:");
  console.log("  0x0000: 状态寄存器");
  console.log("  0x0001: 控制寄存器A (强制停止/清除)");
  console.log("  0x0002: 控制寄存器B (周期测试)");
  console.log("  0x0003: 档位控制寄存器 (GEAR_CTRL)");
  console.log("  0x0004: 电压/阻值单位 (UNIT_VOLT)");
  console.log("  0x0005: 电池1阻抗 R1");
  console.log("  0x0006: 电池1阻抗 R2");
  console.log("  0x0007: 电池1阻抗 R3");
  console.log("  0x0100-0x011F: RAW R2[0..31]");
  console.log("  0x0120-0x013F: RAW R3[0..31]");

  return {
    message: "GET_for_Tesla 协议格式说明已输出到控制台"
  };
};

// 更新读取策略 (Stub)
export const updateReadStrategy = () => {
  return { type: 'auto' };
}

/**
 * GET_for_Tesla: 单次测试流程
 * 1. 写档位寄存器 0x0003
 * 2. 写周期寄存器 0x0002 = 10 (启动单次，10秒周期)
 * 3. 轮询状态 DATA_READY=1
 * 4. 读取 0x0000-0x0007 (数据)
 * 5. 读取 RAW R2 (0x0100-0x011F) + RAW R3 (0x0120-0x013F)
 * 6. 写停止 0x0002 = 0
 */
export const startSingleTest = async (
  connectionId: string,
  unitIds: number[],
  gearValue: number  // 档位值 (1-624, 对应 0.1mA-62.4mA)
): Promise<boolean> => {
  try {
    const io = getSocketIOInstance();
    const allConnections = getClientConnections();
    const targetConnection = allConnections.find(c => c.id === connectionId || c.connectionId === connectionId);
    const host = targetConnection?.host || '';

    if (!targetConnection) {
      console.warn(`[SingleTest] 找不到连接 ${connectionId}`);
      return false;
    }

    console.log(`[SingleTest] 启动单次测试: conn=${connectionId}, units=[${unitIds.join(',')}], gear=${gearValue}`);

    // 为每个 UID 启动独立的单次测试任务
    for (const uid of unitIds) {
      const key = `${connectionId}_${uid}`;
      
      // 检查当前 UID 是否已有测试，如有先停止
      const existing = uidTestStates.get(key);
      if (existing) {
        console.log(`[SingleTest] UID ${uid} 已有活跃测试，先将其停止。`);
        await stopUidTest(connectionId, uid, 'Mutex for Single Test');
      }

      const controller = { active: true };
      const state: UidTestState = {
        connectionId,
        host,
        uid,
        testType: 'Single',
        active: true,
        periodSeconds: 10,
        gearValue,
        startTime: Date.now(),
        controller,
        harvestInProgress: false,
        singleTestPhase: 'WRITING_GEAR'
      };
      uidTestStates.set(key, state);

      // 启动独立的单次测试执行流水线
      (async () => {
        try {
          // Step 1: 写档位
          if (!controller.active) return;
          console.log(`[SingleTest UID ${uid}] Step 1: 写档位 gear=${gearValue} (${(gearValue * 0.1).toFixed(1)}mA)`);
          io?.emit('testStateChange', { state: 'STARTING', connectionId, message: `UID ${uid} 写档位...`, testType: 'Single', unitIds: [uid] });
          
          try {
            const txId = getNextTransactionId();
            await writeSingleRegisterWithFixedTxIdAndResponse(connectionId, txId, REGISTERS.GEAR_CTRL, gearValue, uid, 90);
            console.log(`[SingleTest UID ${uid}] 档位写入成功`);
          } catch (e) {
            console.warn(`[SingleTest UID ${uid}] 档位写入失败:`, e);
          }

          await new Promise(r => setTimeout(r, 10));
          if (!controller.active) return;

          // Step 2: 写周期启动 (10秒)
          console.log(`[SingleTest UID ${uid}] Step 2: 写启动命令 (period=10s)`);
          state.singleTestPhase = 'WRITING_START';
          try {
            const txId = getNextTransactionId();
            await writeSingleRegisterWithFixedTxIdAndResponse(connectionId, txId, REGISTERS.CONTROL_CYCLE, 10, uid, 90);
            console.log(`[SingleTest UID ${uid}] 启动命令发送成功`);
          } catch (e) {
            console.warn(`[SingleTest UID ${uid}] 启动命令发送失败:`, e);
          }

          await new Promise(r => setTimeout(r, 10));
          if (!controller.active) return;

          io?.emit('testStateChange', { state: 'TESTING', connectionId, message: `UID ${uid} 测试进行中，等待就绪...`, testType: 'Single', unitIds: [uid] });

          // Step 3: 轮询等待 DATA_READY = 1
          state.singleTestPhase = 'WAITING_DATA_READY';
          console.log(`[SingleTest UID ${uid}] Step 3: 轮询等待 DATA_READY...`);
          const maxWaitMs = 30000;
          const pollIntervalMs = 1000;
          const startTime = Date.now();
          let dataReady = false;

          while (controller.active && (Date.now() - startTime) < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollIntervalMs));
            if (!controller.active) return;

            const data = await readDeviceData(connectionId, uid, 'F1_POLLING', 1000);
            if (data) {
              const dr = (data.statusRegister & STATUS_MASK.DATA_READY) !== 0;
              console.log(`[SingleTest UID ${uid}] 状态轮询: status=0x${data.statusRegister.toString(16)}, DATA_READY=${dr ? 1 : 0}`);
              if (dr) {
                dataReady = true;
                break;
              }
            }
          }

          if (!dataReady || !controller.active) {
            console.warn(`[SingleTest UID ${uid}] DATA_READY 超时或被取消`);
            try {
              const txId = getNextTransactionId();
              await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, 0x0000, uid);
            } catch (e) {}

            io?.emit('testStateChange', { state: 'IDLE', connectionId, message: '单次测试超时', testType: 'Single', unitIds: [uid] });
            io?.emit('singleTestCompleted', { connectionId, host, unitIds: [uid], timestamp: new Date().toISOString() });
            uidTestStates.delete(key);
            return;
          }

          // Step 4: 读取测试数据 (0x0000-0x0007)
          if (!controller.active) return;
          state.singleTestPhase = 'READING_DATA';
          console.log(`[SingleTest UID ${uid}] Step 4: DATA_READY=1, 读取测试数据...`);
          const deviceData = await readDeviceData(connectionId, uid, 'F1_POLLING', 1000);
          const singleR1 = deviceData?.r1Actual ?? deviceData?.r1 ?? 0;
          const singleR2 = deviceData?.r2Actual ?? deviceData?.r2 ?? 0;
          const singleR3 = deviceData?.r3Actual ?? deviceData?.r3 ?? 0;

          // Step 5: 读取 RAW R2/R3 数据 (32点)
          if (!controller.active) return;
          state.singleTestPhase = 'READING_RAW';
          console.log(`[SingleTest UID ${uid}] Step 5: 读取 RAW R2/R3 数据...`);
          const rawR2: number[] = [];
          const rawR3: number[] = [];

          try {
            // 读 RAW R2
            const txId1 = getNextTransactionId();
            const r2Buf = await readHoldingRegistersWithFixedTxId(connectionId, txId1, REGISTERS.RAW_R2_START, REGISTERS.RAW_COUNT, uid, 2000);
            if (r2Buf && r2Buf.length >= REGISTERS.RAW_COUNT * 2) {
              for (let i = 0; i < REGISTERS.RAW_COUNT; i++) {
                rawR2.push(r2Buf.readUInt16BE(i * 2));
              }
            }
            await new Promise(r => setTimeout(r, 10));

            // 读 RAW R3
            const txId2 = getNextTransactionId();
            const r3Buf = await readHoldingRegistersWithFixedTxId(connectionId, txId2, REGISTERS.RAW_R3_START, REGISTERS.RAW_COUNT, uid, 2000);
            if (r3Buf && r3Buf.length >= REGISTERS.RAW_COUNT * 2) {
              for (let i = 0; i < REGISTERS.RAW_COUNT; i++) {
                rawR3.push(r3Buf.readUInt16BE(i * 2));
              }
            }
          } catch (e) {
            console.warn(`[SingleTest UID ${uid}] RAW数据读取失败:`, e);
          }

          console.log(`[SingleTest UID ${uid}] RAW R2=${rawR2.length}点, R3=${rawR3.length}点`);

          // 更新数据库
          try {
            const mac = `${host}_${uid.toString().padStart(2, '0')}`;
            const { updateLatestBatteryRawData } = await import('./batteryService');
            await updateLatestBatteryRawData(mac, rawR2, rawR3);
            console.log(`[SingleTest UID ${uid}] 成功更新 RAW R2/R3 至数据库`);
          } catch (dbErr) {
            console.error(`[SingleTest UID ${uid}] 数据库更新失败:`, dbErr);
          }

          // 计算解析值: data * 1000 / 480
          const parsedR2 = rawR2.map(v => v * 1000 / 480);
          const parsedR3 = rawR3.map(v => v * 1000 / 480);

          // 发送 测量值 + RAW 原始值和解析值到前端
          const rawDataByUnit = {
            [uid]: { rawR2, rawR3, parsedR2, parsedR3, r1: singleR1, r2: singleR2, r3: singleR3 }
          };
          io?.emit('singleTestRawData', {
            connectionId,
            host,
            rawDataByUnit,
            voltage: deviceData?.voltage ?? 0,
            timestamp: new Date().toISOString()
          });

          // 存储单次测试结果供Excel导出
          storeSingleTestResult(host, uid, {
            r1: singleR1,
            r2: singleR2,
            r3: singleR3,
            voltage: deviceData?.voltage ?? 0,
            rawR2,
            rawR3,
            parsedR2,
            parsedR3
          });

          // Step 6: 写停止命令
          if (!controller.active) return;
          state.singleTestPhase = 'STOPPING';
          console.log(`[SingleTest UID ${uid}] Step 6: 写停止命令...`);
          try {
            const txId = getNextTransactionId();
            await writeSingleRegisterWithFixedTxId(connectionId, txId, REGISTERS.CONTROL_CYCLE, 0x0000, uid);
          } catch (e) { console.warn(e); }

          await new Promise(r => setTimeout(r, 20));

          // 状态刷新
          try {
            const readTxId = getNextTransactionId();
            const buffer = await readHoldingRegistersWithFixedTxId(connectionId, readTxId, REGISTERS.STATUS, 3, uid, 1000);
            if (buffer && buffer.length >= 6) {
              const statusRegister = buffer.readUInt16BE(0);
              const controlRegisterA = buffer.readUInt16BE(2);
              const controlRegisterB = buffer.readUInt16BE(4);

              const { parseStatusRegister } = await import('../utils/modbusFrameUtils');
              const parsedStatus = parseStatusRegister(statusRegister);

              io?.emit('registerStatusUpdate', {
                connectionId,
                host,
                unitId: uid,
                timestamp: Date.now(),
                ...parsedStatus,
                statusRegister,
                controlRegisterA,
                controlRegisterB
              });
            }
          } catch (e) {}

          console.log(`[SingleTest UID ${uid}] 单次测试顺利完成`);
          io?.emit('testStateChange', { state: 'IDLE', connectionId, message: '单次测试完成', testType: 'Single', unitIds: [uid] });
          io?.emit('singleTestCompleted', {
            connectionId,
            host,
            unitIds: [uid],
            timestamp: new Date().toISOString()
          });

          uidTestStates.delete(key);

        } catch (err) {
          console.error(`[SingleTest UID ${uid}] 异步执行出错:`, err);
          io?.emit('testStateChange', { state: 'IDLE', connectionId, message: `单次测试失败: ${err instanceof Error ? err.message : err}`, testType: 'Single', unitIds: [uid] });
          uidTestStates.delete(key);
        }
      })();
    }

    return true;
  } catch (error) {
    console.error(`[SingleTest] 单次测试失败:`, error);
    return false;
  }
};
