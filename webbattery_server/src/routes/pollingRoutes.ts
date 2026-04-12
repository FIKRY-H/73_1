import { Router } from 'express';
import {
  getAllDevicesDataController,
  getDeviceDataController,
  startF1CyclicTestController,
  startF2FastTestController,
  stopTestController,
  stopCyclicTestController,
  clearDeviceStatesController,
  testNewProtocolFormatController,
  updateReadStrategyController,
  getDeviceStatesController,
  getAvailableDevices,
  startF1CyclicPollingController,
  startF2FastPollingController,
  stopPollingController,
  stopAllPollingController,
  getPollingStatusController,
  startBatchPollingController
} from '../controllers/pollingController';

const router = Router();

// 数据获取路由
router.get('/devices/data/all', getAllDevicesDataController);
router.get('/devices/data/:deviceId', getDeviceDataController);

// 新协议测试控制路由
router.post('/devices/test/f1-cyclic', startF1CyclicTestController);
router.post('/devices/test/f2-fast', startF2FastTestController);
router.post('/devices/test/stop', stopTestController);
router.post('/devices/test/stop-cyclic', stopCyclicTestController);
// 删除clearStatusAlarm路由，不再需要处理状态寄存器与控制寄存器

// 设备状态管理路由
router.get('/devices/states', getDeviceStatesController);
router.post('/devices/states/clear', clearDeviceStatesController);
router.get('/devices/available', getAvailableDevices);

// 新协议格式测试路由
router.post('/test/new-protocol-format', testNewProtocolFormatController);
router.post('/test/update-strategy', updateReadStrategyController);

// 轮询管理路由
router.post('/start-f1-polling', startF1CyclicPollingController);     // 启动F1周期轮询
router.post('/start-f2-polling', startF2FastPollingController);       // 启动F2快速轮询
router.post('/stop-polling', stopPollingController);                  // 停止指定设备轮询
router.post('/stop-all-polling', stopAllPollingController);           // 停止所有轮询
router.get('/polling-status', getPollingStatusController);            // 获取轮询状态
router.post('/start-batch-polling', startBatchPollingController);     // 批量启动轮询

export default router;