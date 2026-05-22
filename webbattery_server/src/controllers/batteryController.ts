import { Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { 
  getLatestBatteryData, 
  getAllDeviceMappings,
  saveDeviceMapping,
  getDeviceMappings,
  createDeviceMapping,
  getDeviceNumberByMac,
  getDeviceByNumber,
  deleteDeviceMapping,
  getBatteryDataByIp,
  exportDataToExcelByIp,
  exportDataToCSVByIp,
  exportDataToTXTByIp,
  getDistinctIpsFromBatteryData,
  getDistinctDeviceAddressesByIp,
  clearAllDatabaseData
} from '../services/batteryService';
// Socket functions are now handled internally

// Get latest battery data for all devices
export const getLatestData = asyncHandler(async (req: Request, res: Response) => {
  const data = await getLatestBatteryData();
  res.json({ success: true, data });
});

// 设备编号查询已废弃，统一使用MAC查询

// Get all device mappings
export const getMappings = asyncHandler(async (req: Request, res: Response) => {
  const mappings = await getAllDeviceMappings();
  res.json({ success: true, mappings });
});

// Save device mapping
export const createMapping = asyncHandler(async (req: Request, res: Response) => {
  const { uid, deviceNumber } = req.body;
  
  if (!uid || !deviceNumber) {
    res.status(400).json({ 
      success: false, 
      error: 'UID and device number are required' 
    });
    return;
  }
  
  const success = await saveDeviceMapping(uid, deviceNumber);
  res.json({ success });
});

// Get connected clients
export const getClients = asyncHandler(async (req: Request, res: Response) => {
  const clients: any[] = []; // TODO: Implement if needed
  const clientList = clients.map(client => ({
    clientId: client.clientId,
    ipAddress: client.ipAddress,
    port: client.port,
    lastHeartbeat: client.lastHeartbeat,
    isConnected: client.isConnected,
    uid: client.socket?.data?.uid
  }));
  
  res.json({ success: true, clients });
});

// Send command to client
export const sendCommand = asyncHandler(async (req: Request, res: Response) => {
  const { uid, command, parameters } = req.body;
  
  if (!uid || command === undefined) {
    res.status(400).json({ 
      success: false, 
      error: 'UID and command are required' 
    });
    return;
  }
  
  // Command sending is now handled through Socket.IO service
  const success = false; // TODO: Implement if needed
  
  if (success) {
    res.json({ success: true, message: `Command sent to ${uid}` });
  } else {
    res.status(404).json({ 
      success: false, 
      error: `Failed to send command to ${uid}. Client may be disconnected.` 
    });
  }
});


// 获取设备映射
export const getDeviceMappingsController = async (req: Request, res: Response) => {
  try {
    const mappings = await getDeviceMappings();
    res.json({
      success: true,
      mappings
    });
  } catch (error) {
    console.error('获取设备映射失败:', error);
    res.status(500).json({
      success: false,
      message: '获取设备映射失败'
    });
  }
};

// 创建设备映射
export const createDeviceMappingController = async (req: Request, res: Response) => {
  try {
    const { mac, deviceNumber } = req.body;

    if (!mac || !deviceNumber) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数'
      });
    }

    // 检查MAC地址是否已经映射
    const existingDeviceNumber = await getDeviceNumberByMac(mac);
    if (existingDeviceNumber) {
      return res.status(400).json({
        success: false,
        message: `MAC地址 ${mac} 已经映射到设备编号 ${existingDeviceNumber}`
      });
    }

    // 检查设备编号是否已被使用
    const existingDevice = await getDeviceByNumber(deviceNumber);
    if (existingDevice) {
      return res.status(400).json({
        success: false,
        message: `设备编号 ${deviceNumber} 已经被使用`
      });
    }

    // 创建映射
    const mapping = await createDeviceMapping(mac, deviceNumber);
    
    res.json({
      success: true,
      message: '设备映射创建成功',
      mapping
    });
  } catch (error) {
    console.error('创建设备映射失败:', error);
    res.status(500).json({
      success: false,
      message: '创建设备映射失败'
    });
  }
};

// 删除设备映射
export const deleteDeviceMappingController = async (req: Request, res: Response) => {
  try {
    const { mac } = req.params;
    
    if (!mac) {
      return res.status(400).json({
        success: false,
        message: '设备MAC地址不能为空'
      });
    }
    
    const result = await deleteDeviceMapping(mac);
    
    if (result) {
      res.json({
        success: true,
        message: `设备映射 ${mac} 已成功删除`
      });
    } else {
      res.status(404).json({
        success: false,
        message: `未找到MAC地址为 ${mac} 的设备映射`
      });
    }
  } catch (error) {
    console.error('删除设备映射失败:', error);
    res.status(500).json({
      success: false,
      message: '删除设备映射时发生服务器错误'
    });
  }
};


// 导出数据
export const exportDataByIpController = async (req: Request, res: Response) => {
  try {
    const { format, ip, deviceNumber, deviceAddress } = req.query as {
      format?: string;
      ip?: string;
      deviceNumber?: string;
      deviceAddress?: string;
    };

    if (!ip) {
      return res.status(400).json({
        success: false,
        message: '缺少IP参数'
      });
    }

    const exportFormat = (format || 'xlsx').toLowerCase();
    let exportData: string | Buffer;
    let filename: string;
    let contentType: string;

    // 统一设备地址为两位零填充，数据库中保存为"01"格式
    const deviceAddrTextRaw = (deviceAddress || deviceNumber)?.trim();
    const deviceAddrText = deviceAddrTextRaw ? deviceAddrTextRaw.padStart(2, '0') : undefined;

    if (exportFormat === 'xlsx') {
      // 获取单次测试结果用于导出
      let singleTestData: Record<string, any[]> | undefined;
      try {
        const { singleTestResults } = await import('../services/pollingService');
        if (singleTestResults.size > 0) {
          singleTestData = {};
          singleTestResults.forEach((val, key) => {
            singleTestData![key] = val;
          });
        }
      } catch (e) {
        console.error('[Export] 获取单次测试结果失败:', e);
      }

      exportData = await exportDataToExcelByIp(ip, deviceAddrText, singleTestData);
      filename = deviceAddrText
        ? `battery_data_${ip}_${deviceAddrText}.xlsx`
        : `battery_data_${ip}.xlsx`;
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else if (exportFormat === 'csv') {
      exportData = await exportDataToCSVByIp(ip, deviceAddrText);
      filename = deviceAddrText
        ? `battery_data_${ip}_${deviceAddrText}.csv`
        : `battery_data_${ip}.csv`;
      contentType = 'text/csv; charset=utf-8';
      exportData = '\uFEFF' + exportData; // 添加BOM，兼容Excel
    } else if (exportFormat === 'txt') {
      exportData = await exportDataToTXTByIp(ip, deviceAddrText);
      filename = deviceAddrText
        ? `battery_data_${ip}_${deviceAddrText}.txt`
        : `battery_data_${ip}.txt`;
      contentType = 'text/plain; charset=utf-8';
      exportData = '\uFEFF' + exportData; // 兼容常见编辑器
    } else {
      return res.status(400).json({
        success: false,
        message: '不支持的导出格式，仅支持csv或txt'
      });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(exportData);
  } catch (error) {
    console.error('导出数据失败:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '导出数据失败'
    });
  }
};

// 按IP导出全部12个UID的独立xlsx文件，打包为ZIP
export const exportAllUidsController = async (req: Request, res: Response) => {
  try {
    const { ip } = req.query as { ip?: string };
    if (!ip) {
      return res.status(400).json({ success: false, message: '缺少IP参数' });
    }

    const { exportAllUidsZip } = await import('../services/batteryService');
    const zipBuffer = await exportAllUidsZip(ip);

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `battery_data_all_${ip}_${dateStr}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(zipBuffer);
  } catch (error) {
    console.error('导出全部UID ZIP失败:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '导出全部UID ZIP失败'
    });
  }
};

// 获取数据库中存在的IP列表
export const getIpListController = asyncHandler(async (req: Request, res: Response) => {
  const ips = await getDistinctIpsFromBatteryData();
  res.json({ success: true, ips });
});

// 根据IP获取设备号列表
export const getDeviceAddressesByIpController = asyncHandler(async (req: Request, res: Response) => {
  const { ip } = req.query as { ip?: string };
  if (!ip) {
    return res.status(400).json({ success: false, message: '缺少IP参数' });
  }
  const deviceAddresses = await getDistinctDeviceAddressesByIp(ip);
  res.json({ success: true, deviceAddresses });
});


// 清空所有数据库数据
export const clearAllDatabaseDataController = async (req: Request, res: Response) => {
  try {
    await clearAllDatabaseData();
    
    res.json({
      success: true,
      message: '所有数据库数据已清空'
    });
  } catch (error) {
    console.error('清空数据库数据失败:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : '清空数据库数据失败'
    });
  }
};

// 导入CSV文本到指定表（仅支持安全白名单）
// 已移除：CSV文本导入接口（不再需要）