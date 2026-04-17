import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { BatteryData, DeviceMapping } from '../types/batteryTypes';
import { useSocket } from './SocketContext';

interface BatteryDataContextType {
  batteryData: BatteryData[];
  deviceMappings: DeviceMapping[];
  selectedDevices: string[];
  isLoading: boolean;
  error: string | null;
  fetchBatteryData: () => Promise<void>;
  fetchDeviceMappings: () => Promise<void>;
  createDeviceMapping: (uid: string, deviceNumber: string) => Promise<boolean>;
  deleteDeviceMapping: (uid: string) => Promise<boolean>;
  setSelectedDevices: (devices: string[] | ((prev: string[]) => string[])) => void;
  addSelectedDevice: (uid: string) => void;
  removeSelectedDevice: (uid: string) => void;
  clearSelectedDevices: () => void;
  clearBatteryData: () => void;
}

const BatteryDataContext = createContext<BatteryDataContextType>({
  batteryData: [],
  deviceMappings: [],
  selectedDevices: [],
  isLoading: false,
  error: null,
  fetchBatteryData: async () => {},
  fetchDeviceMappings: async () => {},
  createDeviceMapping: async () => false,
  deleteDeviceMapping: async () => false,
  setSelectedDevices: () => {},
  addSelectedDevice: () => {},
  removeSelectedDevice: () => {},
  clearSelectedDevices: () => {},
  clearBatteryData: () => {}
});

export const useBatteryData = () => useContext(BatteryDataContext);

export const BatteryDataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [batteryData, setBatteryData] = useState<BatteryData[]>([]);
  const [deviceMappings, setDeviceMappings] = useState<DeviceMapping[]>([]);
  const [selectedDevices, setSelectedDevicesState] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  
  const { socket, isConnected } = useSocket();

  // 从本地存储加载选中设备
  useEffect(() => {
    const storedSelectedDevices = localStorage.getItem('selectedDevices');
    if (storedSelectedDevices) {
      try {
        const parsedDevices = JSON.parse(storedSelectedDevices);
        setSelectedDevicesState(parsedDevices);
      } catch (error) {
        console.error('解析存储的设备选择失败:', error);
      }
    }
  }, []);

  // 设置选中设备并保存到本地存储
  const setSelectedDevices = (devices: string[] | ((prev: string[]) => string[])) => {
    if (typeof devices === 'function') {
      setSelectedDevicesState(prev => {
        const newDevices = devices(prev);
        localStorage.setItem('selectedDevices', JSON.stringify(newDevices));
        return newDevices;
      });
    } else {
      setSelectedDevicesState(devices);
      localStorage.setItem('selectedDevices', JSON.stringify(devices));
    }
  };

  // 添加选中设备
  const addSelectedDevice = (uid: string) => {
    setSelectedDevices((prev: string[]) => {
      if (prev.includes(uid)) return prev;
      return [...prev, uid];
    });
  };

  // 移除选中设备
  const removeSelectedDevice = (uid: string) => {
    setSelectedDevices((prev: string[]) => prev.filter((id: string) => id !== uid));
  };

  // 清空选中设备
  const clearSelectedDevices = () => {
    setSelectedDevices([]);
  };

  // 获取电池数据
  const fetchBatteryData = useCallback(async () => {
    if (!isConnected) return;
    
    setIsLoading(true);
    setError(null);
    try {
      const response = await axios.get('/api/battery/data');
      if (response.data.success) {
        setBatteryData(response.data.data);
      } else {
        setError('获取电池数据失败');
      }
    } catch (err) {
      setError('获取电池数据时发生错误');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [isConnected]);

  // 获取设备映射
  const fetchDeviceMappings = useCallback(async () => {
    if (!isConnected) return;
    
    setIsLoading(true);
    setError(null);
    try {
      const response = await axios.get('/api/battery/mapping');
      if (response.data.success) {
        setDeviceMappings(response.data.mappings);
      } else {
        setError('获取设备映射失败');
      }
    } catch (err) {
      setError('获取设备映射时发生错误');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, [isConnected]);
  // 当连接状态变化时，重新获取数据
  useEffect(() => {
    if (isConnected) {
      console.log('Socket已连接，开始加载数据...');
      // 延迟一点时间确保服务器准备就绪
      setTimeout(() => {
        fetchBatteryData();
        fetchDeviceMappings();
      }, 200);
    }
  }, [isConnected, fetchBatteryData, fetchDeviceMappings]);

  // 组件初始化时也尝试加载数据（如果已经连接）
  useEffect(() => {
    // 组件首次加载时检查连接状态
    if (isConnected) {
      console.log('组件初始化时Socket已连接，立即加载数据...');
      fetchBatteryData();
      fetchDeviceMappings();
    }
  }, []); // 只在组件挂载时执行一次

  // 设置Socket监听器
  useEffect(() => {
    if (!socket) return;

    // 修正事件名称，使用 'batteryUpdate' 而不是 'batteryDataUpdate'
    const handleBatteryUpdate = (newData: any) => {
      console.log('收到电池数据更新:', newData);
      
      try {
        // 验证数据格式
        if (!newData || typeof newData !== 'object') {
          console.error('接收到无效的电池数据格式:', newData);
          return;
        }
        
        // 如果数据被包装在data字段中，提取出来
        const actualData = newData.data || newData;
        
        // 过滤掉寄存器状态更新数据（只处理真正的电池测量数据）
        if (actualData.isRegisterUpdate) {
          console.log('BatteryDataContext: 跳过寄存器状态数据，不添加到电池数据列表');
          return;
        }
        
        // 验证必需字段
        if (!actualData.mac || typeof actualData.deviceNumber === 'undefined') {
          console.error('电池数据缺少必需字段 (mac, deviceNumber):', actualData);
          return;
        }
        
        // 根据测试类型记录状态信息，但不在前端按DATA_READY过滤
        // F1(周期)与F2(快速)的有效性由后端统一门控
        const isCyclicTest = actualData.testType === 'CyclicTest' || actualData.testType === '周期测试' || actualData.testType === 170 || actualData.testType === 0xAA;
        const isFastTest = actualData.testType === 'FastTest' || actualData.testType === '快速测试' || actualData.testType === 250 || actualData.testType === 0xFA;
        
        // 检查数据就绪状态（从status对象或直接字段获取）
        let dataReadyValue = 1; // 默认为1
        if (actualData.status && typeof actualData.status === 'object' && 'dataReady' in actualData.status) {
          dataReadyValue = actualData.status.dataReady ? 1 : 0;
        } else if (typeof actualData.status === 'number') {
          // GET3017_v4_20260416: DATA_READY 位于 bit7
          dataReadyValue = (actualData.status & 0x0080) !== 0 ? 1 : 0;
        } else if (actualData.dataReady !== undefined) {
          dataReadyValue = actualData.dataReady ? 1 : 0;
        } else if (actualData.dataready !== undefined) {
          dataReadyValue = actualData.dataready ? 1 : 0;
        }
        
        if (isCyclicTest && dataReadyValue === 0) {
          console.log('BatteryDataContext: 周期测试数据到达，DATA_READY=0（后端应已完成筛选）:', actualData);
        }

        if (isFastTest) {
          console.log('BatteryDataContext: 快速测试数据到达（由TEST_DONE流程驱动）:', actualData);
        }
        
        console.log('BatteryDataContext: 接收到电池数据，测试类型:', actualData.testType, '数据就绪状态值:', dataReadyValue);
        
        // 检查是否包含有效的电阻数据，如果只有电压没有电阻则跳过
        // 周期测试：不进行电阻数据验证，显示所有数据
        // 快速测试：需要验证电阻数据，只显示有电阻的数据
        if (isFastTest) {
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
            console.log('BatteryDataContext: 快速测试：跳过没有阻抗字段的数据:', actualData);
            return;
          }
          
          // 添加调试信息：显示阻抗值
          console.log('BatteryDataContext: 快速测试阻抗数据:', {
            rOhm: actualData.rOhm,
            rSei: actualData.rSei, 
            rCt: actualData.rCt,
            r1_actual: actualData.r1?.actual,
            r2_actual: actualData.r2?.actual,
            r3_actual: actualData.r3?.actual
          });
        } else if (isCyclicTest) {
          console.log('BatteryDataContext: 周期测试：不验证电阻数据，显示所有数据，dataready值:', actualData.dataready || actualData.dataReady);
        }
        
        setBatteryData(prev => {
          // 确保时间戳是字符串格式
          const processedData: BatteryData = {
            ...actualData,
            timestamp: typeof actualData.timestamp === 'string' ? 
              actualData.timestamp : 
              new Date(actualData.timestamp || Date.now()).toISOString()
          };
          
          // 更新或添加新数据
          const index = prev.findIndex(item => 
            item.mac === processedData.mac &&
            item.testType === processedData.testType &&
            item.timestamp === processedData.timestamp
          );
          
          if (index >= 0) {
            const updated = [...prev];
            updated[index] = processedData;
            return updated;
          } else {
            return [...prev, processedData];
          }
        });
      } catch (error) {
        console.error('处理电池数据更新时出错:', error, '原始数据:', newData);
      }
    };

    // 监听两个事件：batteryUpdate 和 batteryDataUpdate
    socket.on('batteryUpdate', handleBatteryUpdate);
    socket.on('batteryDataUpdate', handleBatteryUpdate);

    return () => {
      socket.off('batteryUpdate', handleBatteryUpdate);
      socket.off('batteryDataUpdate', handleBatteryUpdate);
    };
  }, [socket]);

  // 创建设备映射
  const createDeviceMapping = async (uid: string, deviceNumber: string): Promise<boolean> => {
    if (!isConnected) return false;
    
    setIsLoading(true);
    setError(null);
    try {
      const response = await axios.post('/api/battery/mapping', {
        uid,
        deviceNumber
      });
      
      if (response.data.success) {
        // 更新设备映射列表
        await fetchDeviceMappings();
        addSelectedDevice(uid);
        return true;
      } else {
        setError(response.data.message || '创建设备映射失败');
        return false;
      }
    } catch (err) {
      setError('创建设备映射时发生错误');
      console.error(err);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  // 删除设备映射
  const deleteDeviceMapping = async (uid: string): Promise<boolean> => {
    if (!isConnected) return false;
    
    setIsLoading(true);
    setError(null);

    try {
      const response = await axios.delete(`/api/battery/mapping/${uid}`);
      
      if (response.data.success) {
        // 重新获取设备映射
        await fetchDeviceMappings();
        removeSelectedDevice(uid);
        return true;
      } else {
        setError(response.data.message || '删除设备映射失败');
        return false;
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || '删除设备映射时发生错误';
      setError(errorMsg);
      console.error(errorMsg, err);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  // 清空电池数据（只清空内存中的数据，不影响数据库）
  const clearBatteryData = useCallback(() => {
    console.log('清空BatteryDataContext中的数据');
    setBatteryData([]);
    setDeviceMappings([]);
    setError(null);
  }, []);

  return (
    <BatteryDataContext.Provider
      value={{
        batteryData,
        deviceMappings,
        selectedDevices,
        isLoading,
        error,
        fetchBatteryData,
        fetchDeviceMappings,
        createDeviceMapping,
        deleteDeviceMapping,
        setSelectedDevices,
        addSelectedDevice,
        removeSelectedDevice,
        clearSelectedDevices,
        clearBatteryData
      }}
    >
      {children}
    </BatteryDataContext.Provider>
  );
};