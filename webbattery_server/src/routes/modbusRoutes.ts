import { Router } from 'express';
import {
  createConnection,
  closeConnection,
  closeAllConnections,
  getStatus,
  getConnections,
  sendCommandToConnection,
  broadcastCommandToAll,
  readHoldingRegistersFromConnection,
  readInputRegistersFromConnection,
  writeSingleRegisterToConnection,
  writeMultipleRegistersToConnection,
  batchConnectDevices,
  sendCommandByIdentifier,
  sendCommandByGroup,
  pingGatewaySubnet,
  pingAllConnectedSubnets,
  autoConnectDiscoveredDevices,
  detectSingleIP,
  detectMultipleIPs,
  autoDiscoverAndConnect
} from '../controllers/modbusController';

const router = Router();

// 连接管理
router.post('/connect', createConnection);
router.delete('/disconnect/:connectionId', closeConnection);
router.delete('/disconnect-all', closeAllConnections);

// 状态查询
router.get('/status', getStatus);
router.get('/connections', getConnections);



// 批量操作
router.post('/batch-connect', batchConnectDevices);
router.post('/command/by-identifier', sendCommandByIdentifier);
router.post('/command/by-group', sendCommandByGroup);

// 命令操作
router.post('/command', sendCommandToConnection);
router.post('/broadcast', broadcastCommandToAll);

// 寄存器操作
router.post('/read-holding', readHoldingRegistersFromConnection);
router.post('/read-input', readInputRegistersFromConnection);
router.post('/write-single', writeSingleRegisterToConnection);
router.post('/write-multiple', writeMultipleRegistersToConnection);

// 网络扫描操作
router.post('/ping-subnet', pingGatewaySubnet);
router.post('/ping-all-subnets', pingAllConnectedSubnets);

// 自动连接操作
router.post('/auto-connect-devices', autoConnectDiscoveredDevices);

// IP检测操作
router.post('/detect-single-ip', detectSingleIP);
router.post('/detect-multiple-ips', detectMultipleIPs);

// 综合自动化操作
router.post('/auto-discover-and-connect', autoDiscoverAndConnect);

export default router;
