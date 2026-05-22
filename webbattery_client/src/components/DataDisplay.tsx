import React, { useEffect, useState, useCallback, useReducer } from 'react';
import {
  Box,
  Paper,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Alert,
  Button,
  Tooltip,
  Chip,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Grid,
  LinearProgress,
  Tabs,
  Tab
} from '@mui/material';
import {
  Add as AddIcon,
  NetworkPing as PingIcon
} from '@mui/icons-material';
import { useBatteryData } from '../contexts/BatteryDataContext';
import { useSocket } from '../contexts/SocketContext';
import { FrameType } from '../types/batteryTypes';
import DeviceCard, { cardReducer } from './DeviceCard';

interface DataDisplayProps {
  displayMode: FrameType;
  onDisplayModeChange: (mode: FrameType) => void;
}

// Modbus相关接口
interface ModbusConnection {
  id: string;
  host: string;
  port: number;
  deviceId: number;
  isConnected: boolean;
  lastHeartbeat: string;
  mac?: string;
}

interface ModbusStatus {
  isConnected: boolean;
  host: string | null;
  port: number | null;
  deviceId: number | null;
  connectionCount: number;
}

// Ping相关接口
interface PingResult {
  ip: string;
  isReachable: boolean;
  responseTime?: number;
  error?: string;
}

interface PingSubnetResult {
  gateway: string;
  results: PingResult[];
}



const DataDisplay: React.FC<DataDisplayProps> = ({ displayMode }) => {
  const DEVICE_UNIT_MIN = 1;
  const DEVICE_UNIT_MAX = 12;
  const DEVICE_UNIT_TOTAL = DEVICE_UNIT_MAX - DEVICE_UNIT_MIN + 1;
  const { clearBatteryData } = useBatteryData();
  const { isConnected, socket, clients } = useSocket();
  // const [filteredData, setFilteredData] = useState<any[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [realtimeData, setRealtimeData] = useState<any[]>([]);
  const [selectedIp, setSelectedIp] = useState<string>('');
  const [selectedDeviceAddr, setSelectedDeviceAddr] = useState<string>('');
  // 设备状态寄存器缓存，键为 "IP_设备号(两位)"
  const [registerStatusByDevice, setRegisterStatusByDevice] = useState<Record<string, {
    statusRegister: number;
    controlRegisterA: number;
    controlRegisterB: number;
    r1?: number;
    r2?: number;
    timestamp?: string;
  }>>({});

  /*
  // 中断监控状态 - 已废弃
  const [interruptMonitoring, setInterruptMonitoring] = useState<{
    active: boolean;
    devices: Set<string>;
  }>({ active: false, devices: new Set() });
  */

  // 简化的测试状态管理 - F1已独立到卡片，仅保留F2全局状态
  const [testingState, setTestingState] = useState<{
    isF2Testing: boolean;
    f2CooldownTime: number;
  }>({
    isF2Testing: false,
    f2CooldownTime: 0
  });
  const [cardStates, dispatchCardAction] = useReducer(cardReducer, {});
  const [rawTestResults, setRawTestResults] = useState<Record<string, any[]>>({});

  // 设备在线状态（扫描后填充）
  const [onlineDevices, setOnlineDevices] = useState<number[]>([]);

  // 扫描状态
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: DEVICE_UNIT_TOTAL });

  // 扫描在线设备处理函数
  const handleScanOnlineDevices = useCallback(async () => {
    if (isScanning) return;
    // 找到第一个已连接的 Modbus 连接 ID
    const firstConnected = clients.find(c => c.isConnected && c.id);
    if (!firstConnected) {
      setError('没有已连接的设备，无法扫描');
      return;
    }
    setIsScanning(true);
    setScanProgress({ current: 0, total: DEVICE_UNIT_TOTAL });
    setOnlineDevices([]);
    try {
      console.log(`[Scan] 向后端发送扫描请求: deviceId=${firstConnected.id}`);
      const response = await fetch('/api/polling/devices/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: firstConnected.id })
      });
      const result = await response.json();
      console.log(`[Scan] 后端响应:`, result);

      if (result.success) {
        setSuccess(`扫描完成，发现 ${result.data?.onlineDevices?.length || 0} 个在线设备`);
      } else {
        setError(`扫描失败: ${result.message}`);
      }
    } catch (err) {
      console.error(`[Scan] 扫描请求抛出异常:`, err);
      setError(`扫描失败: ${err}`);
    } finally {
      setIsScanning(false);
    }
  }, [isScanning, clients]);

  // 监听后端测试状态变更已移至下方 modbusConnections 声明之后，以解决 block-scoped variable 报错。


  /*
  // 单个设备中断监控处理 (已废弃，逻辑并入通讯错误自动恢复)
  const handleSingleInterruptMonitor = async () => {
     console.warn("Manual interrupt monitor deprecated. System handles recovery automatically.");
  };
  */

  // Modbus连接管理状态
  const [modbusConnections, setModbusConnections] = useState<ModbusConnection[]>([]);
  const [modbusStatus, setModbusStatus] = useState<ModbusStatus>({
    isConnected: false,
    host: null,
    port: null,
    deviceId: null,
    connectionCount: 0
  });
  const [isConnectionDialogOpen, setIsConnectionDialogOpen] = useState(false);
  const [newConnection, setNewConnection] = useState({
    host: '',
    port: 502,
    deviceId: 1
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [modbusTabValue, setModbusTabValue] = useState(0);
  // scanConfig 状态已移除（网络扫描功能相关）

  // Ping功能相关状态
  const [pingResults, setPingResults] = useState<PingSubnetResult[]>([]);



  // 综合自动化流程相关状态
  const [isAutoDiscovering, setIsAutoDiscovering] = useState(false);
  const [autoDiscoveryProgress, setAutoDiscoveryProgress] = useState<string>('');
  const [autoDiscoveryResults, setAutoDiscoveryResults] = useState<any>(null);

  // 监听后端测试状态变更
  useEffect(() => {
    if (!socket) return;
    const handleTestStateChange = (payload: {
      state: string,
      connectionId?: string,
      message?: string,
      testType?: string,
      measEnable?: boolean | number,
      testDone?: boolean | number,
      statusRegister?: number,
      unitIds?: number[]
    }) => {
      // 分发到 cardReducer 保持卡片状态同步
      if (payload.connectionId) {
        const conn = (modbusConnections.find(c => c.id === payload.connectionId)
          || clients.find(c => c.id === payload.connectionId)) as any;
        const host = conn?.host || conn?.address || '';
        if (host) {
          // 获取涉及的 unitIds，没有则跳过本次状态同步
          if (!payload.unitIds || payload.unitIds.length === 0) return;
          const targetUnits = payload.unitIds;

          targetUnits.forEach((uid) => {
            const deviceKey = `${host}_${String(uid).padStart(2, '0')}`;
            let cardState: 'idle' | 'testing' | 'starting' | 'error' = 'idle';
            let cardTestType: 'Cycle' | 'Single' | null = null;

            if (payload.state === 'COMM_ERROR') {
              cardState = 'error';
              cardTestType = payload.testType === 'Single' ? 'Single' : 'Cycle';
            } else if (payload.state === 'IDLE' || payload.state === 'RECOVERY_COMPLETE') {
              cardState = 'idle';
              cardTestType = null;
            } else if (payload.state === 'STARTING') {
              cardState = 'starting';
              cardTestType = payload.testType === 'Single' ? 'Single' : 'Cycle';
            } else if (payload.state === 'TESTING') {
              cardState = 'testing';
              cardTestType = payload.testType === 'Single' ? 'Single' : 'Cycle';
            }

            dispatchCardAction({
              type: 'SET_TESTING_STATE',
              key: deviceKey,
              state: cardState,
              testType: cardTestType
            });

            if (payload.message) {
              dispatchCardAction({
                type: 'ADD_FEEDBACK',
                key: deviceKey,
                level: payload.state === 'COMM_ERROR' ? 'error' : (payload.state === 'TESTING' ? 'success' : 'info'),
                message: payload.message
              });
            }
          });
        }
      }
    };
    socket.on('testStateChange', handleTestStateChange);

    return () => {
      socket.off('testStateChange', handleTestStateChange);
    }
  }, [socket, clients, modbusConnections]);

  // 监听单次测试 RAW 数据更新
  useEffect(() => {
    if (!socket) return;

    const handleSingleTestRawData = (data: {
      connectionId: string;
      host: string;
      voltage?: number;
      rawDataByUnit: Record<number, {
        r1?: number;
        r2?: number;
        r3?: number;
        rawR2: number[];
        rawR3: number[];
        parsedR2: number[];
        parsedR3: number[];
      }>;
      timestamp: string;
    }) => {
      console.log('收到单次测试 RAW 数据:', data);
      if (!data || !data.rawDataByUnit) return;

      setRawTestResults((prev) => {
        const next = { ...prev };
        Object.entries(data.rawDataByUnit).forEach(([uidStr, rawData]) => {
          const uid = parseInt(uidStr, 10);
          const deviceKey = `${data.host}_${String(uid).padStart(2, '0')}`;
          const entry = {
            r1: rawData.r1,
            r2: rawData.r2,
            r3: rawData.r3,
            voltage: data.voltage,
            rawR2: rawData.rawR2 || [],
            rawR3: rawData.rawR3 || [],
            parsedR2: rawData.parsedR2 || [],
            parsedR3: rawData.parsedR3 || [],
            timestamp: data.timestamp || new Date().toISOString()
          };
          next[deviceKey] = [...(prev[deviceKey] || []), entry];
        });
        return next;
      });
    };

    socket.on('singleTestRawData', handleSingleTestRawData);

    return () => {
      socket.off('singleTestRawData', handleSingleTestRawData);
    };
  }, [socket]);

  // 监听实时电池数据更新
  useEffect(() => {
    if (!socket) return;

    const handleBatteryDataUpdate = (data: any) => {
      console.log('收到电池数据更新:', data);

      try {
        // 验证数据格式
        if (!data || typeof data !== 'object') {
          console.error('DataDisplay: 接收到无效的电池数据格式:', data);
          return;
        }

        // 如果数据被包装在data字段中，提取出来
        const actualData = data.data || data;

        // 过滤掉寄存器状态更新数据（只处理真正的电池测量数据）
        if (actualData.isRegisterUpdate) {
          console.log('跳过寄存器状态数据，不添加到电池数据列表');
          return;
        }

        // 验证必需字段（MAC 必须；设备编号允许缺失，用0兜底）
        if (!actualData.mac) {
          console.error('DataDisplay: 电池数据缺少MAC字段:', actualData);
          return;
        }

        // 根据测试类型决定显示策略
        // F1(周期): 由后端按DATA_READY门控，前端不过滤
        // F2(快速): 由后端TEST_DONE流程收割，前端不过滤DATA_READY
        const testType = actualData.testType || actualData.frameType;
        const isCyclicTest = testType === 'CyclicTest' || testType === '周期测试' || testType === 170 || testType === 0xAA;
        const isFastTest = testType === 'FastTest' || testType === '快速测试' || testType === 250 || testType === 0xFA;

        // 检查数据就绪状态（从status对象或直接字段获取）
        let dataReadyValue = 1; // 默认为true
        if (actualData.status && typeof actualData.status === 'object' && 'dataReady' in actualData.status) {
          dataReadyValue = actualData.status.dataReady;
        } else if (actualData.dataReady !== undefined) {
          dataReadyValue = actualData.dataReady;
        } else if (actualData.dataready !== undefined) {
          dataReadyValue = actualData.dataready;
        }

        if (isCyclicTest) {
          console.log('周期测试：显示后端筛选后的有效数据，DATA_READY值:', dataReadyValue);
        } else if (isFastTest) {
          console.log('快速测试：显示TEST_DONE流程收割数据，DATA_READY值:', dataReadyValue);
        }

        console.log('接收到电池数据，测试类型:', testType, 'dataready值:', dataReadyValue);

        // 检查是否包含有效的电阻数据，周期测试时不进行此验证
        if (!isCyclicTest) {
          const hasValidResistanceData = (
            (actualData.r1 && actualData.r1.actual !== undefined) ||
            (actualData.r2 && actualData.r2.actual !== undefined) ||
            (actualData.r3 && actualData.r3.actual !== undefined) ||
            (actualData.r_ohm !== undefined) ||
            (actualData.r_sei !== undefined) ||
            (actualData.r_ct !== undefined) ||
            (actualData.rOhm !== undefined) ||
            (actualData.rSei !== undefined) ||
            (actualData.rCt !== undefined)
          );

          if (!hasValidResistanceData) {
            console.log('快速测试：跳过只有电压没有电阻的数据:', actualData);
            return;
          }
        } else {
          console.log('周期测试：不验证电阻数据，显示所有数据包括dataready=0的数据:', actualData);
        }

        // 兼容并补充字段：ip_prefix / device_address
        const deriveIpPrefix = (macVal?: string) => {
          if (!macVal) return '';
          const parts = String(macVal).split('_');
          return parts[0] || '';
        };
        const deriveDeviceAddress = (macVal?: string) => {
          if (!macVal) return 0;
          const parts = String(macVal).split('_');
          const addr = parseInt(parts[1] || '0', 10);
          return isNaN(addr) ? 0 : addr;
        };

        // 确保数据包含必要字段并补齐新字段
        const processedData = {
          ...actualData,
          timestamp: actualData.timestamp || new Date().toISOString(),
          deviceNumber: actualData.deviceNumber ?? actualData.device_address ?? actualData.deviceAddress ?? deriveDeviceAddress(actualData.mac) ?? 0,
          deviceAddress: actualData.deviceAddress ?? actualData.device_address ?? deriveDeviceAddress(actualData.mac),
          ip_prefix: actualData.ip_prefix ?? deriveIpPrefix(actualData.mac),
          mac: actualData.mac || '',
        };

        // 单次测试数据不进入主表，仅在 DeviceCard Dialog 中展示
        const ipPrefix = processedData.ip_prefix || (typeof processedData.mac === 'string' ? String(processedData.mac).split('_')[0] : '');
        const devAddr = processedData.deviceAddress ?? processedData.device_address ?? (typeof processedData.mac === 'string' ? String(processedData.mac).split('_')[1] : '');
        if (ipPrefix && devAddr) {
          const key = `${ipPrefix}_${String(devAddr).padStart(2, '0')}`;
          if (cardStates[key]?.testType === 'Single') {
            // 跳过：单次测试数据仅展示在卡片 Dialog 中
          } else {
            // F1/F2 数据正常入表
            setRealtimeData(prev => {
              // 检查是否已存在相同ID的数据
              const existingIndex = prev.findIndex(item =>
                item.deviceNumber === processedData.deviceNumber &&
                item.mac === processedData.mac &&
                item.timestamp === processedData.timestamp
              );

              if (existingIndex >= 0) {
                // 更新现有数据
                const updated = [...prev];
                updated[existingIndex] = processedData;
                return updated;
              } else {
                // 添加新数据，按时间戳排序，最新的在前
                return [processedData, ...prev].slice(0, 200); // 限制最多显示200条
              }
            });
          }
        }

        // 将电池数据中的寄存器字段回填到寄存器缓存，保证解析页及时刷新
        const statusRaw =
          (typeof processedData.statusRegister === 'number' ? processedData.statusRegister : undefined)
          ?? (typeof processedData.status?.statusRegister === 'number' ? processedData.status.statusRegister : undefined)
          ?? (typeof processedData.status?.rawValue === 'number' ? processedData.status.rawValue : undefined)
          ?? (typeof processedData.statusBits?.rawValue === 'number' ? processedData.statusBits.rawValue : undefined);

        const controlA =
          (typeof processedData.controlRegisterA === 'number' ? processedData.controlRegisterA : undefined)
          ?? (typeof processedData.controlA === 'number' ? processedData.controlA : undefined)
          ?? (typeof processedData.status?.controlRegisterA === 'number' ? processedData.status.controlRegisterA : undefined);

        const controlB =
          (typeof processedData.controlRegisterB === 'number' ? processedData.controlRegisterB : undefined)
          ?? (typeof processedData.controlB === 'number' ? processedData.controlB : undefined)
          ?? (typeof processedData.status?.controlRegisterB === 'number' ? processedData.status.controlRegisterB : undefined);

        const ipText = String(processedData.ip_prefix || '').trim();
        const addrNum = parseInt(String(processedData.deviceAddress ?? processedData.device_address ?? ''), 10);
        if (ipText && !isNaN(addrNum)) {
          const key = `${ipText}_${String(addrNum).padStart(2, '0')}`;
          const fallbackTimestamp = typeof processedData.timestamp === 'string'
            ? processedData.timestamp
            : new Date(processedData.timestamp || Date.now()).toISOString();

          setRegisterStatusByDevice(prev => ({
            ...prev,
            [key]: {
              statusRegister: typeof statusRaw === 'number' ? statusRaw : (prev[key]?.statusRegister ?? 0),
              controlRegisterA: typeof controlA === 'number' ? controlA : (prev[key]?.controlRegisterA ?? 0),
              controlRegisterB: typeof controlB === 'number' ? controlB : (prev[key]?.controlRegisterB ?? 0),
              r1: processedData.r1?.actual ?? processedData.rOhm ?? prev[key]?.r1 ?? 0,
              r2: processedData.r2?.actual ?? processedData.rSei ?? prev[key]?.r2 ?? 0,
              timestamp: fallbackTimestamp
            }
          }));
        }

        // 更新最后刷新时间
        setLastRefresh(new Date());

        // 设备在线状态现在由扫描流程(deviceScanComplete)管理，
        // 不再在 batteryUpdate 中自动更新 onlineDevices
      } catch (error) {
        console.error('DataDisplay: 处理电池数据更新时出错:', error, '原始数据:', data);
      }
    };

    const handleDeviceDetected = (data: any) => {
      console.log('检测到新设备:', data);
      // 设备检测不直接显示在数据表中，只更新刷新时间
      setLastRefresh(new Date());
    };

    const handleModbusConnectionsUpdate = (connections: any[]) => {
      console.log('DataDisplay: 收到Modbus连接更新，刷新在线设备列表');
      // 当Modbus连接更新时，刷新最后更新时间
      setLastRefresh(new Date());
      // 同时更新Modbus连接列表
      setModbusConnections(connections);
    };

    // 处理寄存器状态更新
    const handleRegisterStatusUpdate = (data: any) => {
      console.log('收到寄存器状态更新:', data);
      console.log('寄存器数据详情:', {
        statusRegister: data.statusRegister,
        controlRegisterA: data.controlRegisterA,
        controlRegisterB: data.controlRegisterB,
        statusBits: data.statusBits
      });

      // 写入设备状态缓存，绑定到 host 与设备号
      try {
        const host: string = (data.host !== undefined && data.host !== null)
          ? String(data.host)
          : (typeof data.mac === 'string' ? String(data.mac).split('_')[0] : '');
        const deviceNumRaw = (data.unitId !== undefined && data.unitId !== null)
          ? Number(data.unitId)
          : (data.deviceAddress !== undefined && data.deviceAddress !== null)
            ? Number(data.deviceAddress)
            : (typeof data.mac === 'string' && String(data.mac).includes('_'))
              ? Number(String(data.mac).split('_')[1])
              : (data.deviceNumber !== undefined && data.deviceNumber !== null)
                ? Number(data.deviceNumber)
                : NaN;
        const deviceAddrStr = !isNaN(deviceNumRaw) ? String(deviceNumRaw).padStart(2, '0') : '';
        const key = (host && deviceAddrStr) ? `${host}_${deviceAddrStr}` : '';
        if (key) {
          setRegisterStatusByDevice(prev => ({
            ...prev,
            [key]: {
              statusRegister: data.statusRegister !== undefined ? data.statusRegister : (prev[key]?.statusRegister ?? 0),
              controlRegisterA: data.controlRegisterA !== undefined ? data.controlRegisterA : (prev[key]?.controlRegisterA ?? 0),
              controlRegisterB: data.controlRegisterB !== undefined ? data.controlRegisterB : (prev[key]?.controlRegisterB ?? 0),
              r1: data.r1 !== undefined ? data.r1 : (prev[key]?.r1 ?? 0),
              r2: data.r2 !== undefined ? data.r2 : (prev[key]?.r2 ?? 0),
              timestamp: data.timestamp ?? prev[key]?.timestamp
            }
          }));
        }
      } catch (err) {
        // 忽略缓存写入错误，保证主流程不受影响
      }

      setLastRefresh(new Date());
    };

    const handleStartF2FastTestResponse = (data: any) => {
      if (data?.success) {
        setSuccess(data.message || 'F2快速测试已启动');
      } else {
        setError(data?.message || 'F2快速测试启动失败');
        setTestingState(prev => ({ ...prev, isF2Testing: false, f2CooldownTime: 0 }));
      }
    };

    // 监听多个事件名称以确保兼容性
    socket.on('batteryDataUpdate', handleBatteryDataUpdate);
    socket.on('batteryUpdate', handleBatteryDataUpdate); // 保持向后兼容
    socket.on('registerStatusUpdate', handleRegisterStatusUpdate); // 监听寄存器状态更新
    socket.on('deviceDetected', handleDeviceDetected);
    socket.on('modbusConnectionsUpdate', handleModbusConnectionsUpdate); // 监听Modbus连接更新

    // 扫描进度与扫描完成事件
    socket.on('deviceScanProgress', (data: any) => {
      setScanProgress({ current: data.progress || data.unitId || 0, total: data.total || DEVICE_UNIT_TOTAL });
    });
    socket.on('deviceScanComplete', (data: any) => {
      console.log('扫描完成事件:', data);
      const devices: number[] = data.onlineDevices || [];
      setOnlineDevices(devices);
      setIsScanning(false);
      setScanProgress({ current: data.totalScanned || DEVICE_UNIT_TOTAL, total: data.totalScanned || DEVICE_UNIT_TOTAL });
    });

    // Modbus相关事件监听
    socket.on('modbusStatusUpdate', (data: ModbusStatus) => {
      console.log('收到Modbus状态更新:', data);
      setModbusStatus(data);
    });

    socket.on('modbusConnectionResponse', (data) => {
      console.log('收到连接响应:', data);
      if (data.success) {
        setSuccess(data.message);
        setIsConnectionDialogOpen(false);
        setNewConnection({ host: '', port: 502, deviceId: 1 });
        refreshModbusConnections();
      } else {
        setError(data.message);
      }
      setIsLoading(false);
    });

    socket.on('modbusDisconnectResponse', (data) => {
      console.log('收到断开连接响应:', data);
      if (data.success) {
        setSuccess(data.message);
        refreshModbusConnections();
      } else {
        setError(data.message);
      }
    });



    socket.on('batchConnectResponse', (data) => {
      console.log('批量连接响应:', data);
      if (data.success) {
        setSuccess(data.message);
        refreshModbusConnections();
      } else {
        setError(data.message);
      }
    });

    // 轮询相关事件监听
    socket.on('pollingStarted', (data) => {
      console.log('轮询开始:', data);
      setSuccess(`${data.testType} 轮询已开始，设备数量: ${data.devices.length}`);
    });

    socket.on('pollingStopped', (data) => {
      console.log('轮询停止:', data);
      const message = data.reason ||
        `设备 ${data.deviceId} 测试已停止 (轮询:${data.pollingStopSuccess ? '成功' : '失败'}, 设备命令:${data.deviceStopSuccess ? '成功' : '失败'})`;
      setSuccess(`轮询已停止: ${message}`);
    });

    socket.on('devicePolled', (data) => {
      console.log('设备轮询数据:', data);
      // 轮询数据会通过batteryDataUpdate事件发送，这里只做日志记录
    });

    socket.on('pollingError', (data) => {
      console.log('轮询错误:', data);
      setError(`轮询错误 (设备 ${data.deviceId}): ${data.error}`);
    });

    socket.on('startF2FastTestResponse', handleStartF2FastTestResponse);

    socket.on('deviceStatusChanged', (data) => {
      console.log('设备状态变化:', data);
      // 可以在这里更新设备状态显示
    });

    socket.on('testCompleted', (data) => {
      console.log('测试完成:', data);

      if (data.testType === 'F2') {
        setTestingState(prev => ({ ...prev, f2CooldownTime: 0 }));
      } else {
        setSuccess(`设备 ${data.deviceId} 的 ${data.testType} 测试完成`);
      }
    });

    return () => {
      socket.off('batteryDataUpdate', handleBatteryDataUpdate);
      socket.off('batteryUpdate', handleBatteryDataUpdate);
      socket.off('registerStatusUpdate', handleRegisterStatusUpdate);
      socket.off('deviceDetected', handleDeviceDetected);
      socket.off('modbusConnectionsUpdate', handleModbusConnectionsUpdate);
      socket.off('modbusStatusUpdate');
      socket.off('modbusConnectionResponse');
      socket.off('modbusDisconnectResponse');
      socket.off('deviceScanProgress');
      socket.off('deviceScanComplete');

      socket.off('batchConnectResponse');
      socket.off('pollingStarted');
      socket.off('pollingStopped');
      socket.off('devicePolled');
      socket.off('pollingError');
      socket.off('startF2FastTestResponse', handleStartF2FastTestResponse);
      socket.off('deviceStatusChanged');
      socket.off('testCompleted');
    };
  }, [socket]);

  // 组件挂载时获取初始数据并清空数据库数据
  useEffect(() => {
    // 清空数据库数据
    handleClearAllDatabaseData();

    refreshModbusStatus();
    refreshModbusConnections();
  }, []);

  // Modbus相关功能函数
  const refreshModbusStatus = () => {
    if (socket) {
      socket.emit('getModbusStatus');
    }
  };

  const refreshModbusConnections = () => {
    if (socket) {
      socket.emit('getModbusConnections');
    }
  };

  const handleCreateConnection = () => {
    if (!newConnection.host.trim()) {
      setError('主机地址不能为空');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(null);

    if (socket) {
      socket.emit('createModbusConnection', newConnection);
    }
  };

  const handleDisconnect = (connectionId: string) => {
    if (socket) {
      socket.emit('disconnectModbus', { connectionId });
    }
  };



  // 过滤和排序实时数据
  const [filteredData, setFilteredData] = useState<any[]>([]);

  useEffect(() => {
    // 根据显示模式决定过滤逻辑
    let filtered;

    if (displayMode === FrameType.CyclicTest) {
      // 周期测试：显示所有数据，不按testType过滤，只排除设备添加响应
      filtered = realtimeData.filter((item: any) =>
        item.testType !== FrameType.DeviceAddResponse
      );
    } else {
      // 其他模式：按测试类型过滤
      filtered = realtimeData.filter((item: any) =>
        item.testType === displayMode &&
        item.testType !== FrameType.DeviceAddResponse
      );
    }
    if (selectedIp && selectedIp.trim().length > 0) {
      const ipStr = selectedIp.trim();
      filtered = filtered.filter((item: any) => {
        const ip = item.ip_prefix ?? (typeof item.mac === 'string' ? String(item.mac).split('_')[0] : '');
        return String(ip) === ipStr;
      });
    }
    if (selectedDeviceAddr && selectedDeviceAddr.trim().length > 0) {
      const selNum = parseInt(selectedDeviceAddr.trim(), 10);
      filtered = filtered.filter((item: any) => {
        const addr = item.deviceAddress ?? item.device_address ?? (typeof item.mac === 'string' ? String(item.mac).split('_')[1] : '');
        const num = parseInt(String(addr), 10);
        return !isNaN(selNum) && num === selNum;
      });
    }

    // 按时间戳排序，最新的数据在前面
    filtered.sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    setFilteredData(filtered);
  }, [realtimeData, displayMode, selectedIp, selectedDeviceAddr]);

  // 自动选择第一个连接的IP和设备
  useEffect(() => {
    // 如果已经有选择，则不自动选择
    if (selectedIp && selectedDeviceAddr) return;

    // 优先从最近状态中自动选择真实设备地址（例如125），避免默认回落到1
    const latestAddrByIp = (ip: string): string | undefined => {
      const now = Date.now();
      const candidates = Object.entries(registerStatusByDevice)
        .filter(([key, data]: [string, any]) => {
          if (!key.startsWith(ip + '_')) return false;
          if (!data?.timestamp) return false;
          return (now - new Date(data.timestamp).getTime()) <= 12000;
        })
        .map(([key]) => key.split('_')[1])
        .filter((addr) => addr && /^\d+$/.test(addr))
        .sort((a, b) => Number(a) - Number(b));

      return candidates.length > 0 ? String(Number(candidates[0])) : undefined;
    };

    // 优先从 modbusConnections 获取（包含设备ID信息）
    if (modbusConnections && modbusConnections.length > 0) {
      // 找到第一个连接
      const firstConn = modbusConnections[0];
      if (firstConn.host) {
        if (!selectedIp) setSelectedIp(firstConn.host);
        if (!selectedDeviceAddr) {
          const discoveredAddr = latestAddrByIp(firstConn.host);
          if (discoveredAddr) {
            setSelectedDeviceAddr(discoveredAddr);
          } else if (firstConn.deviceId) {
            setSelectedDeviceAddr(String(firstConn.deviceId));
          }
        }
        return;
      }
    }

    // 其次尝试从 clients 获取（通常只有IP信息）
    if (clients && clients.length > 0) {
      const connectedClients = clients.filter(c => c.isConnected && c.address);
      if (connectedClients.length > 0) {
        const firstClient = connectedClients[0];
        if (!selectedIp && firstClient.address) {
          setSelectedIp(firstClient.address);
          if (!selectedDeviceAddr) {
            const discoveredAddr = latestAddrByIp(firstClient.address);
            if (discoveredAddr) {
              setSelectedDeviceAddr(discoveredAddr);
            } else {
              // 无数据时回退默认1号设备
              setSelectedDeviceAddr('1');
            }
          }
        }
      }
    }
  }, [modbusConnections, clients, selectedIp, selectedDeviceAddr, registerStatusByDevice]);

  // 清除页面数据（不删除数据库数据）
  const handleClearData = useCallback(() => {
    console.log('清除页面显示数据');
    setRealtimeData([]);
    setLastRefresh(new Date());

    // 也清空从上下文获取的数据（如果有clearBatteryData函数）
    if (clearBatteryData && typeof clearBatteryData === 'function') {
      clearBatteryData();
    }
  }, [clearBatteryData]);



  // 综合自动化流程：ping + 自动连接 + 轮询测试
  const handleAutoDiscoverAndConnect = useCallback(async () => {
    if (isAutoDiscovering) return;

    setIsAutoDiscovering(true);
    setAutoDiscoveryProgress('开始综合自动化流程...');
    setAutoDiscoveryResults(null);
    setPingResults([]);

    try {
      const response = await fetch('/api/modbus/auto-discover-and-connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          concurrency: 50,
          timeout: 1500,
          port: 502,
          enableSingleIPPolling: true,
          enableMultiIPTesting: true,
          pollingInterval: 1000,
          testDuration: 5000
        })
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          setAutoDiscoveryResults(result);

          // 更新ping结果显示
          if (result.details.pingResults) {
            const formattedPingResults = result.details.pingResults.map((pr: any) => ({
              gateway: pr.gateway,
              results: pr.reachableIPs.map((ip: string) => ({
                ip,
                isReachable: true,
                responseTime: 0
              }))
            }));
            setPingResults(formattedPingResults);
          }



          setSuccess(`自动化流程完成！${result.message}`);
          setAutoDiscoveryProgress('');

          // 刷新连接列表
          await refreshModbusConnections();
        } else {
          setError(result.message || '自动化流程失败');
          setAutoDiscoveryProgress('');
        }
      } else {
        setError('网络请求失败');
        setAutoDiscoveryProgress('');
      }
    } catch (error) {
      console.error('自动化流程出错:', error);
      setError('自动化流程出错: ' + (error instanceof Error ? error.message : String(error)));
      setAutoDiscoveryProgress('');
    } finally {
      setIsAutoDiscovering(false);
    }
  }, [isAutoDiscovering]);

  // 自动连接所有ping到的子网设备（排除网关和本机）


  // 清空所有数据库数据
  const handleClearAllDatabaseData = async () => {
    try {
      const response = await fetch('/api/battery/clear-all', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const result = await response.json();
        console.log('数据库数据已清空:', result.message);
        // 同时清空页面显示数据
        handleClearData();
      } else {
        console.error('清空数据库失败:', response.statusText);
      }
    } catch (error) {
      console.error('清空数据库请求失败:', error);
    }
  };

  // 格式化数据显示 - 修复0值显示问题
  const formatValue = (value: number | undefined, unit: string = '', precision: number = 2): string => {
    if (value === undefined || value === null || isNaN(value)) return 'N/A';
    // 确保0值也能正常显示
    return `${Number(value).toFixed(precision)}${unit}`;
  };

  // 渲染数据表格的函数
  const getIpDisplay = (row: any): string => {
    const ip = row.ip_prefix ?? (typeof row.mac === 'string' ? String(row.mac).split('_')[0] : '');
    return ip || '-';
  };

  const getDeviceAddrDisplay = (row: any): string | number => {
    const raw = row.deviceAddress ?? row.device_address ?? (typeof row.mac === 'string' ? String(row.mac).split('_')[1] : '');
    if (raw === undefined || raw === null || raw === '') return '';
    const n = parseInt(String(raw), 10);
    return isNaN(n) ? String(raw) : n;
  };

  const hasValue = (value: any): boolean => value !== undefined && value !== null;
  const firstDefined = (...values: any[]) => values.find(hasValue);

  const renderDataTable = (data: any[]) => {
    return (
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>时间</TableCell>
              <TableCell>IP地址</TableCell>
              <TableCell>设备地址</TableCell>
              <TableCell>OCV(mV)</TableCell>
              <TableCell>Rohm(μΩ)</TableCell>
              <TableCell>Rsei(μΩ)</TableCell>
              <TableCell>Rct(μΩ)</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} align="center">
                  <Typography variant="body2" color="text.secondary">
                    {isConnected ? '暂无实时数据' : '未连接到服务器'}
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              data.map((row, index) => (
                <TableRow key={`${getIpDisplay(row)}-${getDeviceAddrDisplay(row)}-${row.timestamp}-${index}`}>
                  <TableCell>
                    <Tooltip title={formatTime(row.timestamp)}>
                      <span>{formatTime(row.timestamp)}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Tooltip title={getIpDisplay(row)}>
                      <span>{getIpDisplay(row)}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Tooltip title={String(getDeviceAddrDisplay(row) || '-')}>
                      <span>{String(getDeviceAddrDisplay(row) || '-')}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>{formatValue(row.voltage, 'mV', 0)}</TableCell>

                  {/* Bat1 */}
                  <TableCell>{hasValue(firstDefined(row.r_ohm?.actual, row.r1?.actual)) ? formatValue(firstDefined(row.r_ohm?.actual, row.r1?.actual), '', 0) : '-'}</TableCell>
                  <TableCell>{hasValue(firstDefined(row.r_sei?.actual, row.r2?.actual)) ? formatValue(firstDefined(row.r_sei?.actual, row.r2?.actual), '', 0) : '-'}</TableCell>
                  <TableCell>{hasValue(firstDefined(row.r_ct?.actual, row.r3?.actual)) ? formatValue(firstDefined(row.r_ct?.actual, row.r3?.actual), '', 0) : '-'}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
    );
  };

  // 格式化时间显示
  const formatTime = (timestamp: string | Date): string => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const milliseconds = String(Math.floor(date.getMilliseconds() / 100)).padStart(1, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
  };



  // 格式化测试类型显示
  // const getFrameTypeLabel = (frameType?: FrameType | number) => {
  //   switch (frameType) {
  //     case FrameType.HighAndLowFrequency:
  //       return '高频+低频(0xAA)';
  //     case FrameType.HighFrequency:
  //       return '高频(0xFA)';
  //     case FrameType.LowFrequency:
  //       return '低频(0xF5)';
  //     case FrameType.DeviceAddResponse:
  //       return '设备检测(0x05)';
  //     default:
  //       return `未知(0x${frameType?.toString(16).toUpperCase() || 'FF'})`;
  //   }
  // };









  const handleCardStartF1 = useCallback(async (connectionId: string, uid: number, period: number, gear: number) => {
    if (!connectionId) return false;
    try {
      const response = await fetch('/api/polling/devices/test/f1-cyclic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: connectionId,
          selectedDevices: [uid.toString()],
          periodSeconds: period,
          gearValue: gear
        })
      });
      const result = await response.json();
      if (result.success) {
        setSuccess(`设备 ${uid} F1周期测试启动成功`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const handleCardStopF1 = useCallback(async (connectionId: string, uid: number) => {
    if (!connectionId) return false;
    try {
      const response = await fetch('/api/polling/devices/test/stop-cyclic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: connectionId,
          selectedDevices: [uid.toString()]
        })
      });
      const result = await response.json();
      if (result.success) {
        setSuccess(`设备 ${uid} F1周期测试已停止`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const handleCardStartSingle = useCallback(async (connectionId: string, uid: number, gear: number) => {
    if (!connectionId) return false;
    try {
      const response = await fetch('/api/polling/devices/test/single-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: connectionId,
          selectedDevices: [uid.toString()],
          gearValue: gear
        })
      });
      const result = await response.json();
      if (result.success) {
        setSuccess(`设备 ${uid} 单次测试启动成功`);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const isAnyDeviceTesting = Object.values(cardStates).some(c => c.testingState === 'testing' || c.testingState === 'starting') || testingState.isF2Testing;

  return (
    <Box>
      {/* Modbus功能选项卡 */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs value={modbusTabValue} onChange={(_, newValue) => setModbusTabValue(newValue)}>
          <Tab label="测试控制" />
          <Tab label="连接管理" />
        </Tabs>
      </Box>

      {/* 数据监控选项卡内容 */}
      {modbusTabValue === 0 && (
        <Box>
          {/* 测试控制区域 */}
          <Paper elevation={3} sx={{ p: 3, mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              测试控制
            </Typography>

            {/* 设备扫描与在线状态 */}
            <Box sx={{ mb: 3 }}>
              <Typography variant="subtitle2" gutterBottom>
                设备扫描与操作 (<Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>先扫描设备，再进行卡片周期或单次测试，在线通道数: {onlineDevices.length}</Typography>):
              </Typography>

              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 3, alignItems: 'center' }}>
                <Button
                  variant="contained"
                  color="info"
                  onClick={handleScanOnlineDevices}
                  disabled={isScanning || !isConnected || clients.length === 0 || isAnyDeviceTesting}
                >
                  {isScanning ? "扫描中..." : `扫描在线通道 (1-12)`}
                </Button>

                {isScanning && (
                  <Box sx={{ minWidth: 200, display: 'flex', alignItems: 'center' }}>
                    <Box sx={{ width: '100%', mr: 1 }}>
                      <LinearProgress variant="determinate" value={(scanProgress.current / scanProgress.total) * 100} />
                    </Box>
                    <Box sx={{ minWidth: 35 }}>
                      <Typography variant="body2" color="text.secondary">{`${scanProgress.current}/${scanProgress.total}`}</Typography>
                    </Box>
                  </Box>
                )}
              </Box>

              {/* 12通道设备卡片网格 */}
              {selectedIp ? (
                <Box sx={{ mt: 3 }}>
                  <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'bold', mb: 2 }}>
                    设备通道控制卡片 ({selectedIp})
                  </Typography>
                  <Grid container spacing={2}>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((uid) => {
                      const deviceKey = `${selectedIp}_${String(uid).padStart(2, '0')}`;
                      const activeConn = modbusConnections.find(conn => conn.host === selectedIp);
                      const connectionId = activeConn?.id || '';
                      const isOnline = onlineDevices.includes(uid);
                      const config = cardStates[deviceKey];
                      const regData = registerStatusByDevice[deviceKey];
                      const statusData = regData ? {
                        dataReady: (regData.statusRegister & 0x0080) !== 0,
                        testDone: (regData.statusRegister & 0x0020) !== 0
                      } : undefined;

                      return (
                        <Grid item key={uid} xs={12} sm={6} md={4} lg={3}>
                          <DeviceCard
                            connectionId={connectionId}
                            deviceKey={deviceKey}
                            host={selectedIp}
                            uid={uid}
                            isOnline={isOnline}
                            config={config}
                            dispatch={dispatchCardAction}
                            onStartF1={handleCardStartF1}
                            onStopF1={handleCardStopF1}
                            onStartSingle={handleCardStartSingle}
                            statusData={statusData}
                            rawTestHistory={rawTestResults[deviceKey]}
                          />
                        </Grid>
                      );
                    })}
                  </Grid>
                </Box>
              ) : (
                <Alert severity="info" sx={{ mt: 3 }}>
                  请选择或连接一个 Modbus IP 主机以查看和控制 12 通道设备。
                </Alert>
              )}
            </Box>

          </Paper>

          {/* 数据监控标题和控制区域 */}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h5" component="h2">
              电池数据监控（实时）
            </Typography>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Typography variant="body2" color="text.secondary">
                最后更新: {lastRefresh.toLocaleTimeString()}
              </Typography>
            </Box>
          </Box>

          {/* 数据显示标题 */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="h6" component="h3">
              测试数据 ({realtimeData.length} 条)
            </Typography>
          </Box>



          {/* 连接状态和错误提示 */}
          {!isConnected && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              未连接到服务器，无法接收实时数据
            </Alert>
          )}

          {/* 数据统计信息 */}
          <Box sx={{ mb: 2, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              总数据: {realtimeData.length} 条 | 当前显示: {filteredData.length} 条
            </Typography>
          </Box>

          <Box sx={{ mb: 2, display: 'grid', gridTemplateColumns: '240px 1fr', gap: 2, alignItems: 'flex-start' }}>
            <Paper elevation={1} sx={{ p: 2 }}>
              <Typography variant="subtitle2" gutterBottom>
                IP地址列表
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {(
                  (clients && clients.length > 0)
                    ? Array.from(new Set(clients.filter(c => c.isConnected && c.address).map(c => c.address).filter(Boolean)))
                    : Array.from(new Set(realtimeData.map((item: any) => item.ip_prefix ?? (typeof item.mac === 'string' ? String(item.mac).split('_')[0] : '')).filter((ip: any) => !!ip)))
                ).map((ip: string) => (
                  <Button
                    key={ip}
                    variant={selectedIp === ip ? 'contained' : 'outlined'}
                    color={selectedIp === ip ? 'success' : 'inherit'}
                    size="small"
                    onClick={() => setSelectedIp(ip)}
                    sx={{ justifyContent: 'flex-start' }}
                  >
                    {ip}
                  </Button>
                ))}
              </Box>
            </Paper>
            <Box>
              <Box sx={{ mb: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                  <Button
                    key={n}
                    variant={selectedDeviceAddr === String(n) ? 'contained' : 'outlined'}
                    color={selectedDeviceAddr === String(n) ? 'success' : 'inherit'}
                    size="small"
                    sx={{ minWidth: 36, height: 36, borderRadius: 1 }}
                    onClick={() => setSelectedDeviceAddr(String(n))}
                    disabled={!selectedIp}
                  >
                    {n}
                  </Button>
                ))}
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => {
                    setRealtimeData((prev) => {
                      const selNum = selectedDeviceAddr ? parseInt(selectedDeviceAddr, 10) : undefined;
                      return prev.filter((item: any) => {
                        const ip = item.ip_prefix ?? (typeof item.mac === 'string' ? String(item.mac).split('_')[0] : '');
                        const addrRaw = item.deviceAddress ?? item.device_address ?? (typeof item.mac === 'string' ? String(item.mac).split('_')[1] : '');
                        const num = parseInt(String(addrRaw), 10);
                        const matchIp = selectedIp ? String(ip) === selectedIp : true;
                        const matchNum = selNum !== undefined && !isNaN(selNum) ? num === selNum : true;
                        // 保留未匹配的项，移除当前显示的项
                        return !(matchIp && matchNum);
                      });
                    });
                  }}
                  disabled={!selectedIp}
                >
                  清除显示数据
                </Button>
              </Box>
              {renderDataTable(filteredData)}
              {filteredData.length > 0 && (
                <Box sx={{ mt: 2, textAlign: 'center' }}>
                  <Typography variant="body2" color="text.secondary">
                    显示了 {Math.min(filteredData.length, 200)} 条实时数据
                    {filteredData.length > 200 && ' (已限制显示数据量)'}
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>


        </Box>
      )}

      {/* 连接管理选项卡内容 */}
      {modbusTabValue === 1 && (
        <Box>
          <Paper elevation={3} sx={{ p: 3, mb: 3 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="h6">Modbus连接管理</Typography>
              <Box>
                {/* 刷新按钮移除 */}
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => setIsConnectionDialogOpen(true)}
                  disabled={isAnyDeviceTesting}
                  sx={{ mr: 1 }}
                >
                  新建连接
                </Button>
                <Button
                  variant="contained"
                  startIcon={<PingIcon />}
                  onClick={handleAutoDiscoverAndConnect}
                  disabled={isAutoDiscovering || isAnyDeviceTesting}
                  color="primary"
                  sx={{ mr: 1 }}
                >
                  {isAutoDiscovering ? '自动化中...' : '自动扫描连接'}
                </Button>
                <Typography variant="caption" sx={{ color: 'text.secondary', alignSelf: 'center' }}>
                  (支持2-15自动连接)
                </Typography>
              </Box>
            </Box>

            {/* 连接状态显示 */}
            {modbusStatus && (
              <Box sx={{ mb: 2, p: 2, bgcolor: 'background.default', borderRadius: 1 }}>
                <Typography variant="subtitle2" gutterBottom>
                  连接状态: 总计 {modbusStatus.connectionCount} 个连接
                </Typography>
              </Box>
            )}





            {/* 自动化流程进度显示 */}
            {false && autoDiscoveryProgress && (
              <Box sx={{ mb: 2, p: 2, bgcolor: 'primary.light', borderRadius: 1 }}>
                <Typography variant="body2" color="primary.contrastText">
                  {autoDiscoveryProgress}
                </Typography>
              </Box>
            )}

            {/* Ping结果显示 */}
            {false && pingResults.length > 0 && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="h6" gutterBottom>
                  Ping扫描结果
                </Typography>
                {pingResults.map((subnetResult, index) => (
                  <Box key={index} sx={{ mb: 2, p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                    <Typography variant="subtitle2" gutterBottom>
                      网关: {subnetResult.gateway}
                    </Typography>
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>IP地址</TableCell>
                            <TableCell>状态</TableCell>
                            <TableCell>响应时间</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {subnetResult.results
                            .filter(result => result.isReachable)
                            .map((result, resultIndex) => (
                              <TableRow key={resultIndex}>
                                <TableCell>{result.ip}</TableCell>
                                <TableCell>
                                  <Chip
                                    label={result.isReachable ? '可达' : '不可达'}
                                    color={result.isReachable ? 'success' : 'error'}
                                    size="small"
                                  />
                                </TableCell>
                                <TableCell>
                                  {result.responseTime ? `${result.responseTime}ms` : '-'}
                                </TableCell>
                              </TableRow>
                            ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Box>
                ))}
              </Box>
            )}



            {/* 自动化流程结果显示 */}
            {false && autoDiscoveryResults && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="h6" gutterBottom>
                  自动化流程结果
                </Typography>
                <Box sx={{ mb: 2, p: 2, bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1 }}>
                  <Typography variant="subtitle2" gutterBottom>
                    流程摘要
                  </Typography>
                  <Typography variant="body2">
                    扫描设备: {autoDiscoveryResults.summary?.totalScanned || 0} 个 |
                    可连接设备: {autoDiscoveryResults.summary?.totalConnectable || 0} 个 |
                    成功连接: {autoDiscoveryResults.summary?.successfulConnections || 0} 个 |
                    连接失败: {autoDiscoveryResults.summary?.failedConnections || 0} 个
                  </Typography>
                  {autoDiscoveryResults.summary?.pollingTestsCompleted > 0 && (
                    <Typography variant="body2">
                      单IP轮询测试: {autoDiscoveryResults.summary.pollingTestsCompleted} 个设备
                    </Typography>
                  )}
                  {autoDiscoveryResults.summary?.multiIPTestsCompleted > 0 && (
                    <Typography variant="body2">
                      多IP并发测试: {autoDiscoveryResults.summary.multiIPTestsCompleted} 次
                    </Typography>
                  )}
                </Box>

                {/* 轮询测试结果 */}
                {autoDiscoveryResults.details?.pollingResults?.length > 0 && (
                  <Box sx={{ mb: 2, p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                    <Typography variant="subtitle2" gutterBottom>
                      单IP轮询测试结果
                    </Typography>
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>IP地址</TableCell>
                            <TableCell>连接ID</TableCell>
                            <TableCell>测试次数</TableCell>
                            <TableCell>成功率</TableCell>
                            <TableCell>平均响应时间</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {autoDiscoveryResults.details.pollingResults.map((result: any, index: number) => (
                            <TableRow key={index}>
                              <TableCell>{result.ip}</TableCell>
                              <TableCell>{result.connectionId}</TableCell>
                              <TableCell>{result.pollingResult.totalTests}</TableCell>
                              <TableCell>
                                <Chip
                                  label={`${result.pollingResult.successRate}%`}
                                  color={result.pollingResult.successRate >= 80 ? 'success' : 'warning'}
                                  size="small"
                                />
                              </TableCell>
                              <TableCell>{result.pollingResult.averageResponseTime}ms</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Box>
                )}
              </Box>
            )}

            {/* 连接列表 */}
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>主机</TableCell>
                    <TableCell>设备地址</TableCell>
                    <TableCell>状态</TableCell>
                    <TableCell>操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {modbusConnections.map((conn) => (
                    <TableRow key={conn.id}>
                      <TableCell>{conn.host}</TableCell>
                      <TableCell>{conn.deviceId}</TableCell>
                      <TableCell>
                        <Chip
                          label={conn.isConnected ? '已连接' : '未连接'}
                          color={conn.isConnected ? 'success' : 'error'}
                          size="small"
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outlined"
                          color="error"
                          size="small"
                          onClick={() => handleDisconnect(conn.id)}
                          disabled={!conn.isConnected}
                        >
                          断开
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {modbusConnections.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} align="center">
                        暂无连接
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </Box>
      )}

      {/* 网络扫描选项卡内容已完全移除 */}



      {/* 新建连接对话框 */}
      <Dialog open={isConnectionDialogOpen} onClose={() => setIsConnectionDialogOpen(false)}>
        <DialogTitle>新建Modbus连接</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="主机地址"
            fullWidth
            variant="outlined"
            value={newConnection.host}
            onChange={(e) => setNewConnection(prev => ({ ...prev, host: e.target.value }))}
            sx={{ mb: 2 }}
            disabled={isAnyDeviceTesting}
            helperText={isAnyDeviceTesting ? '测试期间禁用输入' : ''}
          />
          <TextField
            margin="dense"
            label="端口"
            type="number"
            fullWidth
            variant="outlined"
            value={newConnection.port}
            onChange={(e) => setNewConnection(prev => ({ ...prev, port: parseInt(e.target.value) || 502 }))}
            sx={{ mb: 2 }}
            disabled={isAnyDeviceTesting}
            helperText={isAnyDeviceTesting ? '测试期间禁用输入' : ''}
          />
          <TextField
            margin="dense"
            label="设备地址"
            type="number"
            fullWidth
            variant="outlined"
            value={newConnection.deviceId}
            onChange={(e) => setNewConnection(prev => ({ ...prev, deviceId: parseInt(e.target.value) || 1 }))}
            disabled={isAnyDeviceTesting}
            helperText={isAnyDeviceTesting ? '测试期间禁用输入' : ''}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsConnectionDialogOpen(false)}>取消</Button>
          <Button onClick={handleCreateConnection} disabled={isLoading || isAnyDeviceTesting}>连接</Button>
        </DialogActions>
      </Dialog>

      {/* 错误和成功提示 */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>
          {success}
        </Alert>
      )}
    </Box>
  );
};

export default DataDisplay;