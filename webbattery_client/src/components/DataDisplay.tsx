import React, { useEffect, useState, useCallback, useRef } from 'react';
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

  FormControlLabel,
  Divider,
  Chip,
  Checkbox,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Grid,
  LinearProgress,
  Tabs,
  Tab,
  FormControl,
  InputLabel,
  Select,
  MenuItem
} from '@mui/material';
import {
  Add as AddIcon,
  NetworkPing as PingIcon
} from '@mui/icons-material';
import { useBatteryData } from '../contexts/BatteryDataContext';
import { useSocket } from '../contexts/SocketContext';
import { FrameType } from '../types/batteryTypes';

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
  const F2_COOLDOWN_SECONDS = 30;
  const F2_TEST_SECONDS = 30;
  const { clearBatteryData } = useBatteryData();
  const { isConnected, socket, clients } = useSocket();
  // const [filteredData, setFilteredData] = useState<any[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [realtimeData, setRealtimeData] = useState<any[]>([]);
  const [selectedIp, setSelectedIp] = useState<string>('');
  const [selectedDeviceAddr, setSelectedDeviceAddr] = useState<string>('');
  const [, setRegisterStatus] = useState<any>({
    statusRegister: 0,
    controlRegisterA: 0,
    controlRegisterB: 0,
    statusBits: {
      measEnable: false,
      measRunning: false,
      alarmCell1Ov: false,
      alarmCell1Uv: false,
      commTimeout: false,
      testDone: false,
      forceStopped: false,
      dataReady: false,
      commError: false,
      rawValue: 0,
      binaryString: '0000000000000000'
    }
  });
  // 设备状态寄存器缓存，键为 "IP_设备号(两位)"
  const [registerStatusByDevice, setRegisterStatusByDevice] = useState<Record<string, {
    statusRegister: number;
    controlRegisterA: number;
    controlRegisterB: number;
    r1?: number;
    r2?: number;
    timestamp?: string;
  }>>({});

  // 基于当前选择的IP与设备号，从缓存中获取对应设备的状态寄存器原始值
  const selectedKey = (selectedIp && selectedDeviceAddr)
    ? `${selectedIp}_${String(selectedDeviceAddr).padStart(2, '0')}`
    : '';
  const selectedReg = selectedKey ? registerStatusByDevice[selectedKey] : undefined;
  // 状态原始值展示改为使用 displayStatusRawValue，下方已定义
  // 旧的 parsedStatus 计算未使用，已移除，改用下方 displayStatusRawValue/parsedStatusDisplay



  // 测试控制状态 - 简化的互锁逻辑
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [lastCommandResult, setLastCommandResult] = useState<string>('');
  const [loopIntervalTime, setLoopIntervalTime] = useState<number>(3); // 周期测试时间（秒），范围3-60
  // 输入框字符串态，允许清空
  const [loopIntervalInput, setLoopIntervalInput] = useState<string>('3');
  const [fastTestDeviceId, setFastTestDeviceId] = useState<number>(1); // F2快速测试目标设备号


  /*
  // 中断监控状态 - 已废弃
  const [interruptMonitoring, setInterruptMonitoring] = useState<{
    active: boolean;
    devices: Set<string>;
  }>({ active: false, devices: new Set() });
  */

  // 简化的测试状态管理 - 只用一个状态控制所有互锁
  const [testingState, setTestingState] = useState<{
    isF1Testing: boolean;
    isF2Testing: boolean;
    f2CooldownTime: number;
    testingDevices: Set<string>;
    activeF1Mode: 'cyclic' | 'static' | null;
    testStatus: 'idle' | 'testing' | 'error'; // 新增状态机状态
    errorConnectionId?: string; // 记录出错的连接
  }>({
    isF1Testing: false,
    isF2Testing: false,
    f2CooldownTime: 0,
    testingDevices: new Set(),
    activeF1Mode: null,
    testStatus: 'idle'
  });
  const prevF2CooldownTimeRef = useRef<number>(0);
  const [f2TestingTimeLeft, setF2TestingTimeLeft] = useState<number>(0);
  const [isF2ReadResultLocked, setIsF2ReadResultLocked] = useState<boolean>(false);
  const [f2TestDoneValue, setF2TestDoneValue] = useState<0 | 1 | null>(null);

  // 设备在线状态（扫描后填充）
  const [onlineDevices, setOnlineDevices] = useState<number[]>([]);

  // 扫描状态
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 24 });

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
    setScanProgress({ current: 0, total: 24 });
    setOnlineDevices([]);
    setSelectedDevices([]);
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
        setLastCommandResult(`✅ 扫描完成: 发现 ${result.data?.onlineDevices?.length || 0} 个在线设备`);
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

  // 检查当前选中的设备是否离线 (>12s无数据)
  const [isSelectedDeviceOffline, setIsSelectedDeviceOffline] = useState(false);

  const getEffectiveLoopPeriodSeconds = useCallback(() => {
    const raw = (loopIntervalInput ?? '').trim();
    const value = raw === '' ? 3 : (loopIntervalTime || 3);
    return Math.max(3, Math.min(60, value));
  }, [loopIntervalInput, loopIntervalTime]);

  useEffect(() => {
    const checkOffline = () => {
      if (!selectedReg?.timestamp) {
        // 如果从来没有时间戳，视作离线或未连接
        setIsSelectedDeviceOffline(true);
        return;
      }
      const lastTime = new Date(selectedReg.timestamp).getTime();
      const diff = Date.now() - lastTime;
      // 超过12000ms视为离线
      setIsSelectedDeviceOffline(diff > 12000);
    };

    checkOffline(); // Initial check
    const timer = setInterval(checkOffline, 1000); // Periodic check
    return () => clearInterval(timer);
  }, [selectedReg?.timestamp]);

  // 监听后端测试状态变更
  useEffect(() => {
    if (!socket) return;
    const handleTestStateChange = (payload: { state: string, connectionId?: string, message?: string, testType?: string, cooldownSeconds?: number }) => {
      console.log("Test State Change:", payload);

      const testDoneMatch = payload.message?.match(/test[_\s-]*done\s*=\s*([01])/i);
      if (testDoneMatch) {
        setF2TestDoneValue(testDoneMatch[1] === '1' ? 1 : 0);
      }

      if (payload.message) {
        const shouldHoldReadResult = isF2ReadResultLocked && testingState.isF2Testing && testingState.f2CooldownTime > 0;
        // 冷却期内锁定“数据读取结束”文案，避免被 testStateChange 的过程消息覆盖。
        if (!shouldHoldReadResult) {
          setLastCommandResult(payload.message);
        }
      }

      if (payload.testType === 'F2' && payload.state === 'TESTING' && (payload.cooldownSeconds ?? 0) > 0) {
        // 后端在首次检测到 TEST_DONE=1 时下发 cooldownSeconds，前端立即进入冷却倒计时。
        setF2TestingTimeLeft(0);
        setF2TestDoneValue(1);
        setLastCommandResult('正在获取数据');
        setTestingState(prev => ({
          ...prev,
          isF2Testing: true,
          f2CooldownTime: prev.f2CooldownTime > 0 ? prev.f2CooldownTime : (payload.cooldownSeconds || 0)
        }));
      }

      if (payload.state === 'COMM_ERROR') {
        setTestingState(prev => ({
          ...prev,
          testStatus: 'error',
          errorConnectionId: payload.connectionId,
          // 保持 isF1Testing = true，以便按钮显示为"测试中/停止"或显示错误状态，
          // 用户反馈说"测试按钮没有恢复"，可能因为这里之前的逻辑把它设为 false 了
          // isF1Testing: false // Don't disable testing mode, just mark as error
        }));
        setLastCommandResult(`设备 ${payload.connectionId} 通讯异常，正在尝试恢复...`);
      } else if (payload.state === 'IDLE' || payload.state === 'RECOVERY_COMPLETE') {
        setTestingState(prev => ({
          ...prev,
          testStatus: 'idle',
          errorConnectionId: undefined,
          // Only reset if explicitly IDLE, RECOVERY_COMPLETE might be transient before TESTING
          isF1Testing: payload.state === 'IDLE' ? false : prev.isF1Testing
        }));
        if (payload.state === 'RECOVERY_COMPLETE') {
          setLastCommandResult(`设备 ${payload.connectionId} 通讯已恢复，准备就绪`);
        }
      } else if (payload.state === 'TESTING') {
        // 接收到 TESTING 状态，恢复界面为正常测试中
        setTestingState(prev => {
          const isF1 = payload.testType === 'F1' || (!payload.testType && !prev.isF2Testing);
          const isF2 = payload.testType === 'F2' || (!payload.testType && prev.isF2Testing);
          return {
            ...prev,
            testStatus: 'testing',
            isF1Testing: isF1 ? true : prev.isF1Testing,
            isF2Testing: isF2 ? true : prev.isF2Testing,
            activeF1Mode: isF1 ? (prev.activeF1Mode || 'cyclic') : prev.activeF1Mode,
            errorConnectionId: undefined
          };
        });
        if (!payload.message) {
          setLastCommandResult(`设备 ${payload.connectionId} 处于测试中`);
        }
      }
    };
    socket.on('testStateChange', handleTestStateChange);

    return () => {
      socket.off('testStateChange', handleTestStateChange);
    }
  }, [socket, isF2ReadResultLocked, testingState.isF2Testing, testingState.f2CooldownTime]);


  /*
  // 单个设备中断监控处理 (已废弃，逻辑并入通讯错误自动恢复)
  const handleSingleInterruptMonitor = async () => {
     console.warn("Manual interrupt monitor deprecated. System handles recovery automatically.");
  };
  */


  // F2冷却时间倒计时 - 修复2秒一跳的问题
  useEffect(() => {
    if (testingState.f2CooldownTime > 0) {
      const timer = setTimeout(() => {
        setTestingState(prev => ({
          ...prev,
          f2CooldownTime: prev.f2CooldownTime - 1
        }));
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [testingState.f2CooldownTime]);

  // F2快速测试阶段倒计时（25秒）
  useEffect(() => {
    if (testingState.isF2Testing && testingState.f2CooldownTime === 0 && f2TestingTimeLeft > 0) {
      const timer = setTimeout(() => {
        setF2TestingTimeLeft(prev => Math.max(0, prev - 1));
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [testingState.isF2Testing, testingState.f2CooldownTime, f2TestingTimeLeft]);

  // 动态省略号动画状态（不直接渲染，忽略局部变量）
  const [, setDotAnimation] = useState('');

  // 省略号动画效果
  useEffect(() => {
    if (testingState.f2CooldownTime > 0) {
      const animationTimer = setInterval(() => {
        setDotAnimation(prev => {
          if (prev === '') return '.';
          if (prev === '.') return '..';
          if (prev === '..') return '...';
          return '';
        });
      }, 500); // 每500ms更新一次省略号

      return () => clearInterval(animationTimer);
    } else {
      setDotAnimation('');
    }
  }, [testingState.f2CooldownTime]);


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

  // 轮询功能相关状态
  const [pollingStatus, setPollingStatus] = useState({
    isPolling: false,
    testType: null as string | null,
    devices: [] as string[],
    startTime: null as Date | null
  });



  // 停止周期测试函数（不发送强制命令，用于F1周期测试）
  const handleStopCyclicTest = useCallback(async (deviceId: string) => {
    try {
      const response = await fetch('/api/polling/devices/test/stop-cyclic', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId })
      });

      const result = await response.json();
      if (result.success) {
        console.log(`✅ 设备${deviceId}周期测试停止成功`);
        return true;
      } else {
        console.error(`❌ 设备${deviceId}周期测试停止失败:`, result.message);
        return false;
      }
    } catch (error) {
      console.error(`❌ 停止设备${deviceId}周期测试时出错:`, error);
      return false;
    }
  }, []);

  // 重置状态寄存器为0的函数
  const resetRegisterStatus = useCallback(() => {

    setRegisterStatus({
      statusRegister: 0,
      controlRegisterA: 0,
      controlRegisterB: 0,
      statusBits: {
        measEnable: false,
        measRunning: false,
        alarmCell1Ov: false,
        alarmCell1Uv: false,
        commTimeout: false,
        testDone: false,
        forceStopped: false,
        dataReady: false,
        commError: false,
        rawValue: 0,
        binaryString: '0000000000000000'
      }
    });
  }, []);

  // 当F2冷却时间结束时重置寄存器状态并清除F2测试状态
  useEffect(() => {
    const prevCooldownTime = prevF2CooldownTimeRef.current;
    const currentCooldownTime = testingState.f2CooldownTime;
    prevF2CooldownTimeRef.current = currentCooldownTime;

    // 仅在冷却倒计时由正数降到0时释放F2状态，避免启动F2时被立即复位。
    const cooldownJustEnded = prevCooldownTime > 0 && currentCooldownTime <= 0;
    if (cooldownJustEnded && testingState.isF2Testing) {
      console.log('F2冷却时间结束，重置寄存器状态并释放F1按钮');
      resetRegisterStatus();
      setLastCommandResult('冷却保护结束，可以进行新的测试');
      setF2TestingTimeLeft(0);
      setIsF2ReadResultLocked(false);
      setF2TestDoneValue(null);

      // 清除F2测试状态，释放F1按钮
      setTestingState(prev => ({
        ...prev,
        isF2Testing: false,
        testingDevices: new Set(),
        f2CooldownTime: 0
      }));
    }
  }, [testingState.f2CooldownTime, testingState.isF2Testing, resetRegisterStatus]);



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

        // 根据测试类型分类数据
        // 添加到实时数据列表（保持原有逻辑用于兼容）
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

      // 合并新的寄存器数据，保持现有结构
      setRegisterStatus((prev: any) => ({
        ...prev,
        statusRegister: data.statusRegister !== undefined ? data.statusRegister : prev.statusRegister,
        controlRegisterA: data.controlRegisterA !== undefined ? data.controlRegisterA : prev.controlRegisterA,
        controlRegisterB: data.controlRegisterB !== undefined ? data.controlRegisterB : prev.controlRegisterB,
        r1: data.r1 !== undefined ? data.r1 : prev.r1,
        r2: data.r2 !== undefined ? data.r2 : prev.r2,
        statusBits: data.statusBits ? {
          ...prev.statusBits,
          ...data.statusBits
        } : prev.statusBits,
        deviceNumber: data.deviceNumber,
        mac: data.mac,
        timestamp: data.timestamp,
        connectionId: data.connectionId,
        host: data.host
      }));

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
        setLastCommandResult('命令写入成功，正在进行F2快速测试');
        setF2TestingTimeLeft(F2_TEST_SECONDS);
        setIsF2ReadResultLocked(false);
        setF2TestDoneValue(0);
      } else {
        setError(data?.message || 'F2快速测试启动失败');
        setLastCommandResult(`${data?.message || 'F2快速测试启动失败'}`);
        setF2TestingTimeLeft(0);
        setIsF2ReadResultLocked(false);
        setF2TestDoneValue(null);
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
      setScanProgress({ current: data.progress || data.unitId || 0, total: data.total || 24 });
    });
    socket.on('deviceScanComplete', (data: any) => {
      console.log('扫描完成事件:', data);
      const devices: number[] = data.onlineDevices || [];
      setOnlineDevices(devices);
      // 扫描完成后自动选中所有在线设备
      setSelectedDevices(devices.map(String));
      setIsScanning(false);
      setScanProgress({ current: 24, total: 24 });
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
      setPollingStatus({
        isPolling: true,
        testType: data.testType,
        devices: data.devices,
        startTime: new Date()
      });
      setSuccess(`${data.testType} 轮询已开始，设备数量: ${data.devices.length}`);
    });

    socket.on('pollingStopped', (data) => {
      console.log('轮询停止:', data);
      setPollingStatus({
        isPolling: false,
        testType: null,
        devices: [],
        startTime: null
      });
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
        setLastCommandResult('数据读取结束，共六十条');
        setF2TestingTimeLeft(0);
        setIsF2ReadResultLocked(true);
      } else {
        setSuccess(`设备 ${data.deviceId} 的 ${data.testType} 测试完成`);
      }

      // 清除对应测试类型的状态
      if (data.testType === 'F1') {
        setTestingState(prev => {
          const newTestingDevices = new Set(prev.testingDevices);
          newTestingDevices.delete(data.deviceId);
          return {
            ...prev,
            testingDevices: newTestingDevices,
            isF1Testing: newTestingDevices.size === 0 ? false : prev.isF1Testing
          };
        });
        console.log(`已清除设备 ${data.deviceId} 的F1测试状态`);
      }

      if (data.testType === 'F2') {
        setTestingState(prev => {
          const newTestingDevices = new Set(prev.testingDevices);
          newTestingDevices.delete(data.deviceId);
          return {
            ...prev,
            testingDevices: newTestingDevices,
            // 即使所有设备都完成了，也不要清除 isF2Testing 状态，
            // 冷却从首次 TEST_DONE=1 开始计时，若未收到该事件则回退为30秒。
            isF2Testing: true,
            f2CooldownTime: prev.f2CooldownTime > 0 ? prev.f2CooldownTime : F2_COOLDOWN_SECONDS
          };
        });
        console.log(`已清除设备 ${data.deviceId} 的F2测试状态，开始30秒冷却`);
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

  // 基于当前数据显示页面的设备数据，派生状态寄存器原始值与位解析
  const latestDisplayRow = filteredData && filteredData.length > 0 ? filteredData[0] : undefined;
  const deriveStatusRawFromRow = (row: any): number | undefined => {
    if (!row) return undefined;
    // 多种兼容形态：statusRegister、status.statusRegister、status.rawValue、statusBits.rawValue、status.binaryString
    if (typeof row.statusRegister === 'number') return row.statusRegister;
    if (row.status && typeof row.status.statusRegister === 'number') return row.status.statusRegister;
    if (row.status && typeof row.status.rawValue === 'number') return row.status.rawValue;
    if (row.statusBits && typeof row.statusBits.rawValue === 'number') return row.statusBits.rawValue;
    if (row.status && typeof row.status.binaryString === 'string') {
      const bin = String(row.status.binaryString).replace(/[^01]/g, '');
      if (bin.length > 0) return parseInt(bin, 2);
    }
    return undefined;
  };
  const displayStatusRawValue = (() => {
    const fromRow = deriveStatusRawFromRow(latestDisplayRow);
    if (typeof fromRow === 'number') return fromRow;
    // 回退到所选设备的缓存值
    return (selectedReg?.statusRegister ?? 0);
  })();
  const parsedStatusDisplay = {
    measEnable: (displayStatusRawValue & 0x0001) !== 0,
    measRunning: (displayStatusRawValue & 0x0002) !== 0,
    // 协议文档未定义独立的 COOLDOWN_LOCKED 位，前端使用本地倒计时表示冷却期
    cooldownLocked: testingState.f2CooldownTime > 0,
    alarmCell1Ov: (displayStatusRawValue & 0x0004) !== 0,
    alarmCell1Uv: (displayStatusRawValue & 0x0008) !== 0,
    commTimeout: (displayStatusRawValue & 0x0010) !== 0,
    testDone: (displayStatusRawValue & 0x0020) !== 0,
    forceStopped: (displayStatusRawValue & 0x0040) !== 0,
    dataReady: (displayStatusRawValue & 0x0080) !== 0,
    commError: (displayStatusRawValue & 0x0100) !== 0,
    deviceAddr: (displayStatusRawValue & 0xFE00) >> 9
  };

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
              <TableCell>电池电压(mV)</TableCell>
              <TableCell>Bat1 R1(μΩ)</TableCell>
              <TableCell>Bat1 R2(μΩ)</TableCell>
              <TableCell>Bat1 R3(μΩ)</TableCell>
              <TableCell>Bat3 R1(μΩ)</TableCell>
              <TableCell>Bat3 R2(μΩ)</TableCell>
              <TableCell>Bat3 R3(μΩ)</TableCell>
              <TableCell>Bat4 R1(μΩ)</TableCell>
              <TableCell>Bat4 R2(μΩ)</TableCell>
              <TableCell>Bat4 R3(μΩ)</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={13} align="center">
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

                  {/* Bat3 */}
                  <TableCell>{hasValue(row.bat3_r1?.actual) ? formatValue(row.bat3_r1.actual, '', 0) : '-'}</TableCell>
                  <TableCell>{hasValue(row.bat3_r2?.actual) ? formatValue(row.bat3_r2.actual, '', 0) : '-'}</TableCell>
                  <TableCell>{hasValue(row.bat3_r3?.actual) ? formatValue(row.bat3_r3.actual, '', 0) : '-'}</TableCell>

                  {/* Bat4 */}
                  <TableCell>{hasValue(row.bat4_r1?.actual) ? formatValue(row.bat4_r1.actual, '', 0) : '-'}</TableCell>
                  <TableCell>{hasValue(row.bat4_r2?.actual) ? formatValue(row.bat4_r2.actual, '', 0) : '-'}</TableCell>
                  <TableCell>{hasValue(row.bat4_r3?.actual) ? formatValue(row.bat4_r3.actual, '', 0) : '-'}</TableCell>
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









  // 设备选择处理
  const handleDeviceSelection = (deviceId: string, selected: boolean) => {
    // 如果正在进行测试，禁止修改设备选择
    if (testingState.isF1Testing || testingState.isF2Testing) {
      setLastCommandResult('⚠️ 测试进行中，无法修改设备选择');
      return;
    }

    if (selected) {
      setSelectedDevices(prev => [...prev, deviceId]);
    } else {
      setSelectedDevices(prev => prev.filter(m => m !== deviceId));
    }
  };

  // 全选/取消全选
  const handleSelectAll = () => {
    // 如果正在进行测试，禁止修改设备选择
    if (testingState.isF1Testing || testingState.isF2Testing) {
      setLastCommandResult('⚠️ 测试进行中，无法修改设备选择');
      return;
    }

    // 统一使用 UID 字符串（"1"-"128"），不再混入连接 ID
    const allUIDs = onlineDevices.map(String);
    if (selectedDevices.length === allUIDs.length && allUIDs.length > 0) {
      setSelectedDevices([]);
    } else {
      setSelectedDevices(allUIDs);
    }
  };

  // 监听命令响应
  useEffect(() => {
    if (!socket) return;

    const handleCommandResponse = (response: { success: boolean; message: string; mac?: string; command?: number }) => {
      if (response.success) {
        setLastCommandResult(`✅ ${response.message}`);
      } else {
        setLastCommandResult(`❌ ${response.message}`);
      }
    };

    const handleBatchCommandResponse = (response: any) => {
      if (response.success) {
        const { summary } = response;
        setLastCommandResult(`✅ 批量命令执行完成: 成功${summary.success}/${summary.total}个设备`);
      } else {
        setLastCommandResult(`❌ 批量命令执行失败: ${response.message}`);
      }
    };

    const handleReadRegistersResponse = (response: any) => {
      if (response.success) {
        setLastCommandResult(prev => prev + ' | 读寄存器成功');
      } else {
        setLastCommandResult(prev => prev + ` | 读寄存器失败: ${response.error}`);
      }
    };

    socket.on('commandResponse', handleCommandResponse);
    socket.on('batchCommandResponse', handleBatchCommandResponse);
    socket.on('readRegistersResponse', handleReadRegistersResponse);

    return () => {
      socket.off('commandResponse', handleCommandResponse);
      socket.off('batchCommandResponse', handleBatchCommandResponse);
      socket.off('readRegistersResponse', handleReadRegistersResponse);
    };
  }, [socket]);


  /*
    const clearDeviceStatus = useCallback(async () => {
      if (selectedDevices.length === 0) {
        setError('请先选择要清除状态的设备');
        return;
      }
  
      try {
        setIsLoading(true);
        setError(null);
        setSuccess(null);
        
        // 为每个选中的设备清除状态/告警位
        // 功能说明：向控制寄存器A (0x0001) 写入 0x0004 命令
        // 用于清除设备的状态寄存器和告警位，重置设备错误状态
        const results = [];
        for (const deviceId of selectedDevices) {
          const response = await fetch('/api/polling/devices/status/clear-alarm', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ deviceId: deviceId })
          }); 
  
          const result = await response.json();
          results.push({ deviceId, result });
        }
  
        const successCount = results.filter(r => r.result.success).length;
        if (successCount === selectedDevices.length) {
          setSuccess('设备状态寄存器和告警位已清除，设备错误状态已重置');
          setLastCommandResult(`✅ 状态/告警清除成功 (${successCount}/${selectedDevices.length}个设备)`);
        } else if (successCount > 0) {
          const failedDevices = results.filter(r => !r.result.success).map(r => r.deviceId);
          setError(`部分设备清除状态失败: ${failedDevices.join(', ')}`);
          setLastCommandResult(`⚠️ 状态清除部分成功: 成功${successCount}个，失败${selectedDevices.length - successCount}个`);
        } else {
          const failedDevices = results.filter(r => !r.result.success).map(r => r.deviceId);
          setError(`所有设备清除状态失败: ${failedDevices.join(', ')}`);
          setLastCommandResult(`❌ 状态清除完全失败: ${selectedDevices.length}个设备都失败`);
        }
      } catch (error) {
        setError('清除状态失败: ' + error);
        setLastCommandResult(`❌ 清除状态失败: ${error}`);
      } finally {
        setIsLoading(false);
      }
    }, [selectedDevices]);
  */
  // F1测试（支持启动和停止）- 简化的互锁逻辑
  const handleSingleF1Test = useCallback(async () => {
    if (selectedDevices.length === 0) {
      setError('请先选择要测试的设备');
      return;
    }

    // 简化的互锁检查：如果正在进行F2测试，则不能启动F1测试
    if (testingState.isF2Testing) {
      setError('无法启动F1测试：正在进行F2测试，请等待F2测试完成');
      return;
    }

    // 检查是否正在进行F1测试
    if (testingState.isF1Testing || testingState.testStatus === 'error') {
      // 停止测试
      try {
        setIsLoading(true);
        setError(null);
        setSuccess(null);

        const firstConnected = clients.find(c => c.isConnected && c.id);
        const connectionIdToStop = firstConnected ? firstConnected.id : null;

        const results = [];
        if (connectionIdToStop) {
          const success = await handleStopCyclicTest(connectionIdToStop);
          results.push({ deviceId: connectionIdToStop, success });
        }

        // 清除所有测试状态
        setTestingState(prev => ({
          ...prev,
          isF1Testing: false,
          testingDevices: new Set(),
          activeF1Mode: null,
          testStatus: 'idle'
        }));

        const successCount = results.filter(r => r.success).length;
        if (successCount === results.length) {
          setSuccess('F1测试停止成功');
          setLastCommandResult(`⏹️ F1测试停止成功 (${successCount}/${results.length}个设备)`);
          // 重置前端状态寄存器为0
          resetRegisterStatus();
        } else {
          setError(`部分设备F1测试停止失败`);
          setLastCommandResult(`⚠️ F1测试停止部分成功: 成功${successCount}个，失败${results.length - successCount}个`);
        }
      } catch (error) {
        setError('F1测试停止失败: ' + error);
        setLastCommandResult(`❌ F1测试停止失败: ${error}`);
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // 启动广播写+轮询读测试
    try {
      setIsLoading(true);
      setError(null);
      setSuccess(null);

      // 找到一个已连接的 Modbus 连接 ID 作为通信通道
      const firstConnected = clients.find(c => c.isConnected && c.id);
      if (!firstConnected) {
        setError('没有已连接的通信通道，无法启动测试');
        setIsLoading(false);
        return;
      }
      const representativeDeviceId = firstConnected.id;

      const response = await fetch('/api/polling/devices/test/f1-cyclic', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deviceId: representativeDeviceId,
          selectedDevices: selectedDevices,
          periodSeconds: getEffectiveLoopPeriodSeconds()
        })
      });

      const result = await response.json();

      if (result.success) {
        // 后端确认启动成功后再更新按钮状态
        setTestingState(prev => ({
          ...prev,
          isF1Testing: true,
          testingDevices: new Set(selectedDevices),
          activeF1Mode: 'cyclic',
          testStatus: 'testing'
        }));
        setSuccess('F1广播周期测试启动成功');
        setLastCommandResult(`F1广播周期测试启动成功 - 每${getEffectiveLoopPeriodSeconds()}秒广播写命令并轮询读取 - 再次点击可停止`);
      } else {
        setError(`F1广播周期测试启动失败: ${result.message || '未知错误'}`);
        setLastCommandResult(`❌ F1广播周期测试启动失败: ${result.message || '未知错误'}`);
      }
    } catch (error) {
      // 捕获异常，回滚按钮状态
      setTestingState(prev => ({
        ...prev,
        isF1Testing: false,
        testingDevices: new Set(),
        activeF1Mode: null,
        testStatus: 'idle'
      }));
      setError('F1测试启动失败: ' + error);
      setLastCommandResult(`❌ F1测试启动失败: ${error}`);
    } finally {
      setIsLoading(false);
    }
  }, [selectedDevices, testingState.isF1Testing, testingState.isF2Testing, testingState.testingDevices, handleStopCyclicTest, resetRegisterStatus, testingState.testStatus, clients, socket, getEffectiveLoopPeriodSeconds]);

  // F2测试（写命令启动，由后端静默等待25s，并随后监控TEST_DONE进入高频捞取数据）
  const handleF2Test = useCallback(async () => {
    if (testingState.isF1Testing) {
      setError('无法启动F2测试：正在进行F1测试');
      return;
    }

    if (testingState.isF2Testing) {
      // 停止F2测试
      try {
        setIsLoading(true);
        const firstConnected = clients.find(c => c.isConnected && c.id)
          || modbusConnections.find((c: any) => c.isConnected && c.id);
        const connectionIdToStop = firstConnected ? firstConnected.id : null;
        if (connectionIdToStop && socket) {
          socket.emit('stopTest', { connectionId: connectionIdToStop });
          setSuccess('停止F2测试命令已发送');
          setF2TestingTimeLeft(0);
          setIsF2ReadResultLocked(false);
          setF2TestDoneValue(null);
          setTestingState(prev => ({ ...prev, isF2Testing: false, f2CooldownTime: 0 }));
        }
      } catch (err) {
        setError('停止F2测试失败: ' + err);
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // 启动F2测试
    try {
      setIsLoading(true);
      const firstConnected = clients.find(c => c.isConnected && c.id)
        || modbusConnections.find((c: any) => c.isConnected && c.id);
      if (!firstConnected) {
        setError('没有已连接的通信通道，无法启动测试');
        setLastCommandResult('没有已连接的通信通道，无法启动F2测试');
        return;
      }

      setTestingState(prev => ({ ...prev, isF2Testing: true }));
      setF2TestingTimeLeft(0);
      setIsF2ReadResultLocked(false);
      setF2TestDoneValue(0);
      setLastCommandResult('正在发送F2启动命令');

      if (socket) {
        socket.emit('startF2FastTest', {
          connectionId: firstConnected.id,
          targetUnitId: fastTestDeviceId
        });
      }
    } catch (err) {
      setTestingState(prev => ({ ...prev, isF2Testing: false }));
      setError('F2测试启动失败: ' + err);
    } finally {
      setIsLoading(false);
    }
  }, [clients, modbusConnections, testingState.isF1Testing, testingState.isF2Testing, fastTestDeviceId, socket]);

  // 静置测试（F1写值0x0004，沿用F1轮询机制）
  const handleStaticF1Test = useCallback(async () => {
    if (selectedDevices.length === 0) {
      setError('请先选择要测试的设备');
      return;
    }

    // 互锁：F2测试进行中不能启动F1静置测试
    if (testingState.isF2Testing) {
      setError('无法启动静置测试：正在进行F2测试，请等待F2测试完成');
      return;
    }

    // 如果当前已在进行F1测试，则点击静置测试按钮视为停止当前F1测试
    if (testingState.isF1Testing) {
      try {
        setIsLoading(true);
        setError(null);
        setSuccess(null);

        const results = [];
        for (const deviceId of Array.from(testingState.testingDevices)) {
          const success = await handleStopCyclicTest(deviceId);
          results.push({ deviceId, success });
        }

        // 清除测试状态
        setTestingState(prev => ({
          ...prev,
          isF1Testing: false,
          testingDevices: new Set(),
          activeF1Mode: null
        }));

        const successCount = results.filter(r => r.success).length;
        if (successCount === results.length) {
          setSuccess('静置测试已停止');
          setLastCommandResult(`⏹️ 静置测试停止成功 (${successCount}/${results.length}个设备)`);
          resetRegisterStatus();
        } else {
          setError('部分设备静置测试停止失败');
          setLastCommandResult(`⚠️ 静置测试停止部分成功: 成功${successCount}个，失败${results.length - successCount}个`);
        }
      } catch (error) {
        setError('静置测试停止失败: ' + error);
        setLastCommandResult(`❌ 静置测试停止失败: ${error}`);
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // 启动静置测试（广播写0x0001=0x0004，并按周期轮询读取）
    try {
      setIsLoading(true);
      setError(null);
      setSuccess(null);

      const representativeDeviceId = selectedDevices[0];

      const response = await fetch('/api/polling/devices/test/f1-cyclic', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deviceId: representativeDeviceId,
          selectedDevices: selectedDevices,
          periodSeconds: getEffectiveLoopPeriodSeconds(),
          writeValue: 0x0004
        })
      });

      const result = await response.json();

      if (result.success) {
        setTestingState(prev => ({
          ...prev,
          isF1Testing: true,
          testingDevices: new Set(selectedDevices),
          activeF1Mode: 'static'
        }));

        setSuccess('静置测试启动成功');
        setLastCommandResult(`静置测试启动成功 - 每${getEffectiveLoopPeriodSeconds()}秒广播写0x0001=0x0004并轮询读取`);
      } else {
        setError(`静置测试启动失败: ${result.message || '未知错误'}`);
        setLastCommandResult(`❌ 静置测试启动失败: ${result.message || '未知错误'}`);
      }
    } catch (error) {
      setError('静置测试启动失败: ' + error);
      setLastCommandResult(`❌ 静置测试启动失败: ${error}`);
    } finally {
      setIsLoading(false);
    }
  }, [selectedDevices, testingState.isF1Testing, testingState.isF2Testing, testingState.testingDevices, handleStopCyclicTest, resetRegisterStatus, getEffectiveLoopPeriodSeconds]);

  return (
    <Box>
      {/* Modbus功能选项卡 */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs value={modbusTabValue} onChange={(_, newValue) => setModbusTabValue(newValue)}>
          <Tab label="测试控制" />
          <Tab label="连接管理" />
          {/* 网络扫描Tab已移除 */}
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

            {/* 设备选择 */}
            <Box sx={{ mb: 3 }}>
              <Typography variant="subtitle2" gutterBottom>
                选择测试设备:
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleSelectAll}
                  sx={{ mr: 2 }}
                  disabled={testingState.isF1Testing || testingState.isF2Testing}
                >
                  {selectedDevices.length === clients.filter(c => c.isConnected && c.id).length ? '取消全选' : '全选'}
                </Button>
                <Chip
                  label={`已选择 ${selectedDevices.length} 个设备`}
                  color={selectedDevices.length > 0 ? 'primary' : 'default'}
                  size="small"
                />
              </Box>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {clients.filter(c => c.isConnected && c.id).map((client) => (
                  <FormControlLabel
                    key={client.id}
                    control={
                      <Checkbox
                        checked={selectedDevices.includes(client.id)}
                        onChange={(e) => handleDeviceSelection(client.id, e.target.checked)}
                        size="small"
                        disabled={testingState.isF1Testing || testingState.isF2Testing}
                      />
                    }
                    label={`设备${client.id} | MAC: ${client.mac || 'Unknown'} | IP: ${client.address || 'Unknown'}`}
                    sx={{ mr: 2 }}
                  />
                ))}
              </Box>
            </Box>

            <Divider sx={{ my: 2 }} />

            {/* 周期测试时间设置和寄存器显示 */}
            <Box sx={{ mb: 3, display: 'flex', gap: 3, alignItems: 'flex-start' }}>
              {/* 周期测试时间设置 */}
              <Box sx={{ minWidth: 200 }}>
                <TextField
                  label="周期测试时间"
                  type="number"
                  value={loopIntervalInput}
                  onChange={(e) => {
                    const raw = e.target.value;
                    // 允许清空输入框
                    setLoopIntervalInput(raw);
                    if (raw === '') {
                      return;
                    }
                    const value = parseInt(raw, 10);
                    if (!isNaN(value)) {
                      // 精度为1秒
                      setLoopIntervalTime(value);
                    }
                  }}
                  onBlur={(e) => {
                    const raw = (e.target.value ?? '').trim();
                    if (raw === '') {
                      // 空输入默认3秒
                      setLoopIntervalTime(3);
                      setLoopIntervalInput('3');
                      return;
                    }
                    const value = parseInt(raw || '3', 10);
                    // 精度为1秒并在范围内（3-60秒）
                    // 检测设备接收到小于3秒检测频率，统一按3秒周期测试
                    const clampedValue = Math.max(3, Math.min(60, isNaN(value) ? 3 : value));
                    setLoopIntervalTime(clampedValue);
                    setLoopIntervalInput(String(clampedValue));
                  }}
                  size="small"
                  sx={{
                    width: 180,
                    '& .MuiInputBase-input:disabled': {
                      color: 'rgba(0, 0, 0, 0.6)',
                      WebkitTextFillColor: 'rgba(0, 0, 0, 0.6)'
                    }
                  }}
                  inputProps={{ min: 3, max: 60, step: 1 }}
                  helperText="3-60秒，精度1秒"
                />
              </Box>

              {/* 寄存器显示界面 - 始终可见 */}
              <Box sx={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 2 }}>

                {/* 通讯超时特殊状态指示 */}
                {parsedStatusDisplay.commTimeout && (
                  <Box sx={{ gridColumn: '1 / -1', p: 2, border: '1px solid #ff9800', borderRadius: 1, backgroundColor: '#fff3e0' }}>
                    <Typography variant="subtitle1" color="error" gutterBottom sx={{ fontWeight: 'bold' }}>
                      通讯超时故障 (COMM_TIMEOUT)
                    </Typography>
                    {parsedStatusDisplay.measEnable ? (
                      <Alert severity="error">通讯错误 + 测试中，系统正在自动恢复...</Alert>
                    ) : (
                      <Alert severity="warning">通讯错误 + 测试完成</Alert>
                    )}
                  </Box>
                )}

                {/* 状态寄存器显示 */}
                <Box sx={{ p: 2, border: '1px solid #ddd', borderRadius: 1, backgroundColor: '#f8f9fa' }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'primary.main' }}>
                      状态寄存器 (0x0000)
                    </Typography>
                    {/* 自动恢复不再需要手动按钮 */}
                  </Box>

                  <Typography variant="body2" sx={{ fontFamily: 'monospace', display: 'block', mb: 1, color: 'text.secondary' }}>
                    原始值: 0x{(displayStatusRawValue).toString(16).padStart(4, '0').toUpperCase()}
                  </Typography>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', display: 'block', mb: 1, color: 'text.secondary' }}>
                    二进制: {(displayStatusRawValue).toString(2).padStart(16, '0')}
                  </Typography>
                  <Box sx={{ fontSize: '0.75rem' }}>
                    <Typography variant="caption" sx={{ fontWeight: 'bold', display: 'block', mb: 0.5 }}>状态位解析:</Typography>
                    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.2, fontSize: '0.7rem' }}>
                      <Typography variant="caption" sx={{ color: parsedStatusDisplay.measEnable ? 'green' : 'gray' }}>
                        Bit0 MEAS_ENABLE: {parsedStatusDisplay.measEnable ? '✓' : '✗'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: parsedStatusDisplay.measRunning ? 'green' : 'gray' }}>
                        Bit1 MEAS_RUNNING: {parsedStatusDisplay.measRunning ? '✓' : '✗'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: parsedStatusDisplay.alarmCell1Ov ? 'red' : 'gray' }}>
                        Bit2 ALARM_CELL1_OV: {parsedStatusDisplay.alarmCell1Ov ? '✓' : '✗'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: parsedStatusDisplay.alarmCell1Uv ? 'red' : 'gray' }}>
                        Bit3 ALARM_CELL1_UV: {parsedStatusDisplay.alarmCell1Uv ? '✓' : '✗'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: parsedStatusDisplay.commTimeout ? 'red' : 'gray' }}>
                        Bit4 COMM_TIMEOUT: {parsedStatusDisplay.commTimeout ? '✓' : '✗'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: parsedStatusDisplay.testDone ? 'green' : 'gray' }}>
                        Bit5 TEST_DONE: {parsedStatusDisplay.testDone ? '✓' : '✗'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: parsedStatusDisplay.forceStopped ? 'red' : 'gray' }}>
                        Bit6 FORCE_STOPPED: {parsedStatusDisplay.forceStopped ? '✓' : '✗'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: parsedStatusDisplay.dataReady ? 'green' : 'gray' }}>
                        Bit7 DATA_READY: {parsedStatusDisplay.dataReady ? '✓' : '✗'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: parsedStatusDisplay.commError ? 'red' : 'gray' }}>
                        Bit8 COMM_ERROR: {parsedStatusDisplay.commError ? '✓' : '✗'}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'gray' }}>
                        Bit9-15 ADDR: {parsedStatusDisplay.deviceAddr}
                      </Typography>
                    </Box>
                  </Box>
                </Box>

                {/* 控制寄存器显示 - 0x0006(A) 和 0x0007(B) */}
                <Box sx={{ p: 2, border: '1px solid #ddd', borderRadius: 1, backgroundColor: '#f8f9fa' }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 'bold', display: 'block', mb: 1, color: 'primary.main' }}>
                    控制寄存器
                  </Typography>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', display: 'block', mb: 1, color: 'text.secondary' }}>
                    A (0x0001): 0x{(selectedReg?.controlRegisterA ?? 0).toString(16).toUpperCase().padStart(4, '0')}
                  </Typography>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', display: 'block', mb: 1, color: 'text.secondary' }}>
                    B (0x0002): {(selectedReg?.controlRegisterB ?? 0)} (Cycle)
                  </Typography>
                  <Typography variant="caption" sx={{ color: isSelectedDeviceOffline ? 'error.main' : 'text.secondary', display: 'block', mt: 1 }}>
                    {isSelectedDeviceOffline ? "注意: 该设备不在线 (已超过12秒无数据)" : ""}
                  </Typography>
                </Box>
              </Box>
            </Box>

            <Divider sx={{ my: 2 }} />

            {/* 轮询状态显示 */}
            {pollingStatus.isPolling && (
              <Box sx={{ mb: 3, p: 2, bgcolor: 'background.default', borderRadius: 1 }}>
                <Typography variant="subtitle2" gutterBottom>
                  轮询状态: {pollingStatus.testType} - 已运行 {pollingStatus.startTime ? Math.floor((Date.now() - new Date(pollingStatus.startTime).getTime()) / 1000) : 0} 秒
                </Typography>
                <Typography variant="body2">
                  设备数量: {pollingStatus.devices.length} 个
                </Typography>
              </Box>
            )}

            {/* 设备扫描与在线状态 */}
            <Box sx={{ mb: 3 }}>
              <Typography variant="subtitle2" gutterBottom>
                设备扫描与操作 (<Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>先扫描设备，再进行周期测试，在线设备数: {onlineDevices.length}</Typography>):
              </Typography>

              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2, alignItems: 'center' }}>
                <Button
                  variant="contained"
                  color="info"
                  onClick={handleScanOnlineDevices}
                  disabled={isScanning || !isConnected || clients.length === 0 || testingState.isF1Testing || testingState.isF2Testing}
                >
                  {isScanning ? "扫描中..." : "扫描在线设备 (1-24)"}
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

              {/* 128设备网格显示 */}
              <Box sx={{
                p: 2,
                bgcolor: 'background.paper',
                borderRadius: 1,
                border: '1px solid #e0e0e0',
                mb: 3
              }}>
                <Typography variant="caption" sx={{ display: 'block', mb: 1, color: 'text.secondary' }}>
                  在线设备指示 (绿色: 在线 / 已选中, 灰色: 离线 / 未选中) - 点击可更改选中状态
                </Typography>
                <Grid container spacing={0.5}>
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((id) => {
                    const isOnline = onlineDevices.includes(id);
                    const isSelected = selectedDevices.includes(id.toString());

                    return (
                      <Grid item key={id} sx={{ width: '12.5%' }}>
                        <Box
                          onClick={() => {
                            const idStr = id.toString();
                            setSelectedDevices(prev =>
                              prev.includes(idStr)
                                ? prev.filter(x => x !== idStr)
                                : [...prev, idStr]
                            );
                          }}
                          sx={{
                            bgcolor: isSelected ? 'success.main' : (isOnline ? 'success.light' : 'grey.300'),
                            color: isSelected ? 'white' : (isOnline ? 'white' : 'text.disabled'),
                            borderRadius: 1,
                            p: 0.5,
                            textAlign: 'center',
                            fontSize: '0.75rem',
                            cursor: 'pointer',
                            border: isSelected ? '2px solid #2e7d32' : '1px solid transparent',
                            '&:hover': {
                              opacity: 0.8
                            }
                          }}
                        >
                          {id}
                        </Box>
                      </Grid>
                    );
                  })}
                </Grid>
              </Box>

              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2 }}>
                <Button
                  variant="contained"
                  color={testingState.testStatus === 'error' ? "warning" : (testingState.isF1Testing && testingState.activeF1Mode === 'cyclic' ? "error" : "primary")}
                  onClick={() => handleSingleF1Test()}
                  disabled={
                    testingState.testStatus === 'error' ||
                    !isConnected ||
                    testingState.isF2Testing ||
                    testingState.f2CooldownTime > 0 ||
                    (testingState.isF1Testing && testingState.activeF1Mode === 'static')
                  }
                >
                  {testingState.testStatus === 'error' ? "通讯错误恢复中..." : (testingState.isF1Testing && testingState.activeF1Mode === 'cyclic' ? "停止周期测试" : "周期测试")}
                </Button>
                <Button
                  variant="outlined"
                  color={testingState.isF1Testing && testingState.activeF1Mode === 'static' ? "error" : "secondary"}
                  onClick={() => handleStaticF1Test()}
                  disabled={true}
                  style={{ display: 'none' }}
                  title="向控制寄存器A(0x0001)广播写入0x0004并按周期轮询读取"
                >
                  {testingState.isF1Testing && testingState.activeF1Mode === 'static' ? "停止静置测试" : "静置测试"}
                </Button>

                <Button
                  variant="contained"
                  color={testingState.isF2Testing ? "error" : "warning"}
                  onClick={() => handleF2Test()}
                  disabled={
                    !isConnected ||
                    testingState.isF1Testing ||
                    testingState.isF2Testing ||
                    testingState.f2CooldownTime > 0
                  }
                >
                  {testingState.isF2Testing ? `停止快速测试 ${testingState.f2CooldownTime > 0 ? `(${testingState.f2CooldownTime}s)` : ''}` : "快速测试"}
                </Button>

                <FormControl size="small" sx={{ minWidth: 80 }}>
                  <InputLabel id="fast-test-device-select-label">快速测试设备号</InputLabel>
                  <Select
                    labelId="fast-test-device-select-label"
                    id="fast-test-device-select"
                    value={fastTestDeviceId}
                    label="快速测试设备号"
                    onChange={(e) => setFastTestDeviceId(Number(e.target.value))}
                    disabled={testingState.isF2Testing}
                  >
                    {(onlineDevices.length > 0 ? onlineDevices : Array.from({ length: 24 }, (_, i) => i + 1)).map((n) => (
                      <MenuItem key={n} value={n}>
                        {n} {onlineDevices.length > 0 ? '(在线)' : ''}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {/* <Button
              variant="outlined"
              onClick={clearDeviceStatus}
              disabled={!isConnected || selectedDevices.length === 0}
              title="清除选中设备的状态寄存器和告警位，用于重置设备错误状态"
            >
              清除状态/告警
            </Button> */}
              </Box>
            </Box>

            {/* 命令执行结果 */}
            {lastCommandResult && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="subtitle2" gutterBottom>
                  执行结果:
                </Typography>
                <Paper
                  elevation={1}
                  sx={{
                    p: 2,
                    backgroundColor: /(失败|错误|异常)/.test(lastCommandResult) ? '#ffebee' : '#e8f5e8',
                    border: /(失败|错误|异常)/.test(lastCommandResult) ? '1px solid #f44336' : '1px solid #4caf50'
                  }}
                >
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-line' }}>
                    {lastCommandResult}
                  </Typography>
                </Paper>
                {testingState.isF2Testing && testingState.f2CooldownTime === 0 && f2TestingTimeLeft > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      正在进行快速测试（剩余{f2TestingTimeLeft}s）
                    </Typography>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      TEST_DONE = {f2TestDoneValue ?? 0}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <Box sx={{ width: '100%', mr: 1 }}>
                        <LinearProgress
                          variant="determinate"
                          value={((F2_TEST_SECONDS - f2TestingTimeLeft) / F2_TEST_SECONDS) * 100}
                        />
                      </Box>
                      <Box sx={{ minWidth: 40 }}>
                        <Typography variant="body2" color="text.secondary">{`${F2_TEST_SECONDS - f2TestingTimeLeft}/${F2_TEST_SECONDS}`}</Typography>
                      </Box>
                    </Box>
                  </Box>
                )}
                {testingState.isF2Testing && testingState.f2CooldownTime > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      设备冷却保护中（{testingState.f2CooldownTime}s）
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <Box sx={{ width: '100%', mr: 1 }}>
                        <LinearProgress
                          variant="determinate"
                          value={((F2_COOLDOWN_SECONDS - testingState.f2CooldownTime) / F2_COOLDOWN_SECONDS) * 100}
                        />
                      </Box>
                      <Box sx={{ minWidth: 40 }}>
                        <Typography variant="body2" color="text.secondary">{`${F2_COOLDOWN_SECONDS - testingState.f2CooldownTime}/${F2_COOLDOWN_SECONDS}`}</Typography>
                      </Box>
                    </Box>
                  </Box>
                )}
              </Box>
            )}
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
                {Object.entries(registerStatusByDevice)
                  .filter(([key, data]) => {
                    if (!selectedIp) return false;
                    if (!key.startsWith(selectedIp + '_')) return false;
                    if (!data.timestamp) return false;
                    return (Date.now() - new Date(data.timestamp).getTime()) <= 120000;
                  })
                  .map(([key]) => parseInt(key.split('_')[1], 10))
                  .filter((v, i, a) => !isNaN(v) && a.indexOf(v) === i)
                  .sort((a, b) => a - b)
                  .map((n) => (
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
                  disabled={testingState.isF1Testing || testingState.isF2Testing}
                  sx={{ mr: 1 }}
                >
                  新建连接
                </Button>
                <Button
                  variant="contained"
                  startIcon={<PingIcon />}
                  onClick={handleAutoDiscoverAndConnect}
                  disabled={isAutoDiscovering || testingState.isF1Testing || testingState.isF2Testing}
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
            disabled={testingState.isF1Testing || testingState.isF2Testing}
            helperText={(testingState.isF1Testing || testingState.isF2Testing) ? '测试期间禁用输入' : ''}
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
            disabled={testingState.isF1Testing || testingState.isF2Testing}
            helperText={(testingState.isF1Testing || testingState.isF2Testing) ? '测试期间禁用输入' : ''}
          />
          <TextField
            margin="dense"
            label="设备地址"
            type="number"
            fullWidth
            variant="outlined"
            value={newConnection.deviceId}
            onChange={(e) => setNewConnection(prev => ({ ...prev, deviceId: parseInt(e.target.value) || 1 }))}
            disabled={testingState.isF1Testing || testingState.isF2Testing}
            helperText={(testingState.isF1Testing || testingState.isF2Testing) ? '测试期间禁用输入' : ''}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsConnectionDialogOpen(false)}>取消</Button>
          <Button onClick={handleCreateConnection} disabled={isLoading || testingState.isF1Testing || testingState.isF2Testing}>连接</Button>
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