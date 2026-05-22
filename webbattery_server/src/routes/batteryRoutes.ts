import express from 'express';
import {
  sendCommand as sendCommandController,
  exportDataByIpController,
  exportAllUidsController,
  getIpListController,
  getDeviceAddressesByIpController,
  getDeviceMappingsController,
  createDeviceMappingController,
  deleteDeviceMappingController,
  clearAllDatabaseDataController
} from '../controllers/batteryController';

const router = express.Router();

// 新导出：按IP导出（可选设备号）
router.get('/export/ip', exportDataByIpController);
router.get('/export/ip-device', exportDataByIpController);

// 按IP导出全部12个UID的独立xlsx文件，打包为ZIP
router.get('/export/all-uids', exportAllUidsController);

// 下拉筛选数据源
router.get('/ips', getIpListController);
router.get('/device-addresses', getDeviceAddressesByIpController);

// 获取设备映射
router.get('/mapping', getDeviceMappingsController);

// 创建设备映射
router.post('/mapping', createDeviceMappingController);

// 删除设备映射
router.delete('/mapping/:mac', deleteDeviceMappingController);

// 发送命令到设备
router.post('/command', sendCommandController);

// 已移除：CSV文本导入路由（不再需要）

// 清空所有数据库数据
router.delete('/clear-all', clearAllDatabaseDataController);

export default router;