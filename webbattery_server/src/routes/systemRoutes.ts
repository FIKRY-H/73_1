import express from 'express';
import {
  getNetworkInterfaces,
  getSystemStatus,
  startListening,
  stopListening
} from '../controllers/systemController';

const router = express.Router();

// 获取网络接口信息
router.get('/network-interfaces', getNetworkInterfaces);

// 获取系统状态
router.get('/status', getSystemStatus);

// 开始监听
router.post('/start-listening', startListening);

// 停止监听
router.post('/stop-listening', stopListening);

export default router; 