// Mock Modbus TCP Server - 模拟12通道电池测试设备
// 用于软件测试，无需真实硬件
// 启动: npx ts-node src/mock/mockModbusServer.ts
// 默认监听端口 1502 (避免与真实设备502冲突)

import net from 'net';

const MOCK_PORT = 1502;
const DEVICE_COUNT = 12;
const UID_MIN = 1;
const UID_MAX = 12;

// ============ 设备状态机 ============

interface SimDevice {
  uid: number;
  statusRegister: number;  // 0x0000
  controlA: number;        // 0x0001
  controlB: number;        // 0x0002 (period when running)
  gearValue: number;       // 0x0003
  voltage: number;         // 0x0004 (mV)
  r1: number;              // 0x0005 Rohm
  r2: number;              // 0x0006 Rsei
  r3: number;              // 0x0007 Rct
  rawR2: number[];         // 0x0100-0x011F, 32个点
  rawR3: number[];         // 0x0120-0x013F, 32个点

  // 测试状态
  testMode: 'idle' | 'cycle' | 'single';
  cyclePeriod: number;     // F1周期秒数
  cycleTimer: NodeJS.Timeout | null;
  singleTimer: NodeJS.Timeout | null;
  dataReadyTimer: NodeJS.Timeout | null;

  // 模拟值
  baseResistance: number;  // 基础阻抗值
  noiseAmplitude: number;  // 噪声幅度
}

function createDevice(uid: number): SimDevice {
  const baseR = 1000 + uid * 200 + Math.floor(Math.random() * 500);
  return {
    uid,
    statusRegister: (uid << 9), // bit9-15 = address
    controlA: 0,
    controlB: 0,
    gearValue: 10, // 默认1.0mA
    voltage: 3700 + Math.floor(Math.random() * 100), // ~3.7V
    r1: baseR,
    r2: baseR + 200,
    r3: baseR + 400,
    rawR2: Array.from({ length: 32 }, () => Math.floor(Math.random() * 100)),
    rawR3: Array.from({ length: 32 }, () => Math.floor(Math.random() * 100)),
    testMode: 'idle',
    cyclePeriod: 5,
    cycleTimer: null,
    singleTimer: null,
    dataReadyTimer: null,
    baseResistance: baseR,
    noiseAmplitude: 30,
  };
}

const devices: Map<number, SimDevice> = new Map();
for (let uid = UID_MIN; uid <= UID_MAX; uid++) {
  devices.set(uid, createDevice(uid));
}

// ============ 状态位操作 ============

const BIT_MEAS_ENABLE  = 0x0001; // bit0
const BIT_MEAS_RUNNING = 0x0002; // bit1
const BIT_COMM_TIMEOUT = 0x0010; // bit4
const BIT_TEST_DONE    = 0x0020; // bit5
const BIT_DATA_READY   = 0x0080; // bit7
const BIT_COMM_ERROR   = 0x0100; // bit8

function setBit(reg: number, bit: number): number { return reg | bit; }
function clrBit(reg: number, bit: number): number { return reg & ~bit; }
function hasBit(reg: number, bit: number): boolean { return (reg & bit) !== 0; }

function updateResistance(dev: SimDevice): void {
  const noise = () => Math.floor((Math.random() - 0.5) * 2 * dev.noiseAmplitude);
  dev.r1 = dev.baseResistance + noise();
  dev.r2 = dev.baseResistance + 200 + noise();
  dev.r3 = dev.baseResistance + 400 + noise();
  dev.rawR2 = Array.from({ length: 32 }, () => Math.floor(Math.random() * 100));
  dev.rawR3 = Array.from({ length: 32 }, () => Math.floor(Math.random() * 100));
}

// ============ F1 周期测试模拟 ============

function startCycleSimulation(dev: SimDevice, period: number): void {
  stopAllTimers(dev);
  dev.testMode = 'cycle';
  dev.cyclePeriod = period;
  dev.statusRegister = setBit(dev.statusRegister, BIT_MEAS_ENABLE);
  dev.statusRegister = clrBit(dev.statusRegister, BIT_DATA_READY);
  dev.statusRegister = clrBit(dev.statusRegister, BIT_TEST_DONE);

  console.log(`  [UID${dev.uid}] F1周期测试启动, 周期=${period}s, 档位=${(dev.gearValue / 10).toFixed(1)}mA`);

  // 每周期产生一次 DATA_READY
  const tick = () => {
    if (dev.testMode !== 'cycle') return;
    updateResistance(dev);
    dev.statusRegister = setBit(dev.statusRegister, BIT_DATA_READY);
    dev.statusRegister = setBit(dev.statusRegister, BIT_TEST_DONE);
    console.log(`  [UID${dev.uid}] DATA_READY=1, R1=${dev.r1}, R2=${dev.r2}, R3=${dev.r3}`);

    // DATA_READY 保持 500ms 后自动清除 (模拟上位机读取后清除)
    if (dev.dataReadyTimer) clearTimeout(dev.dataReadyTimer);
    dev.dataReadyTimer = setTimeout(() => {
      dev.statusRegister = clrBit(dev.statusRegister, BIT_DATA_READY);
    }, 500);

    // 下一周期
    dev.cycleTimer = setTimeout(tick, period * 1000);
  };

  // 首次 DATA_READY 在半个周期后
  dev.cycleTimer = setTimeout(tick, period * 500);
}

function startSingleSimulation(dev: SimDevice, gear: number): void {
  stopAllTimers(dev);
  dev.testMode = 'single';
  dev.gearValue = gear;
  dev.statusRegister = setBit(dev.statusRegister, BIT_MEAS_ENABLE);
  dev.statusRegister = clrBit(dev.statusRegister, BIT_DATA_READY);
  dev.statusRegister = clrBit(dev.statusRegister, BIT_TEST_DONE);

  console.log(`  [UID${dev.uid}] 单次测试启动, 档位=${(gear / 10).toFixed(1)}mA`);

  // 2秒后产生 DATA_READY
  dev.singleTimer = setTimeout(() => {
    if (dev.testMode !== 'single') return;
    updateResistance(dev);
    dev.statusRegister = setBit(dev.statusRegister, BIT_DATA_READY);
    dev.statusRegister = setBit(dev.statusRegister, BIT_TEST_DONE);
    console.log(`  [UID${dev.uid}] 单次测试 DATA_READY=1`);
  }, 2000);
}

function stopAllTimers(dev: SimDevice): void {
  if (dev.cycleTimer) { clearTimeout(dev.cycleTimer); dev.cycleTimer = null; }
  if (dev.singleTimer) { clearTimeout(dev.singleTimer); dev.singleTimer = null; }
  if (dev.dataReadyTimer) { clearTimeout(dev.dataReadyTimer); dev.dataReadyTimer = null; }
}

function stopTest(dev: SimDevice): void {
  stopAllTimers(dev);
  dev.testMode = 'idle';
  dev.statusRegister = clrBit(dev.statusRegister, BIT_MEAS_ENABLE);
  dev.statusRegister = clrBit(dev.statusRegister, BIT_DATA_READY);
  dev.statusRegister = clrBit(dev.statusRegister, BIT_TEST_DONE);
  dev.controlB = 0;
  console.log(`  [UID${dev.uid}] 测试停止`);
}

// ============ Modbus 帧处理 ============

// 读取保持寄存器 FC 0x03
function handleReadHoldingRegisters(uid: number, address: number, quantity: number): Buffer {
  const dev = devices.get(uid);
  if (!dev) {
    return buildExceptionResponse(uid, 0x03, 0x0B); // Gateway target failed to respond
  }

  const response = Buffer.alloc(3 + quantity * 2); // FC + ByteCount + Data
  response.writeUInt8(0x03, 0); // Function code
  response.writeUInt8(quantity * 2, 1); // Byte count
  let offset = 2;

  for (let i = 0; i < quantity; i++) {
    const regAddr = address + i;
    let value = 0;

    switch (regAddr) {
      case 0x0000: value = dev.statusRegister; break;
      case 0x0001: value = dev.controlA; break;
      case 0x0002: value = dev.controlB; break;
      case 0x0003: value = dev.gearValue; break;
      case 0x0004: value = dev.voltage; break;
      case 0x0005: value = dev.r1 & 0xFFFF; break;
      case 0x0006: value = dev.r2 & 0xFFFF; break;
      case 0x0007: value = dev.r3 & 0xFFFF; break;
      default:
        if (regAddr >= 0x0100 && regAddr < 0x0120) {
          value = dev.rawR2[regAddr - 0x0100] || 0;
        } else if (regAddr >= 0x0120 && regAddr < 0x0140) {
          value = dev.rawR3[regAddr - 0x0120] || 0;
        }
        break;
    }
    response.writeUInt16BE(value, offset);
    offset += 2;
  }

  return buildMBAPResponse(uid, response);
}

// 写单个寄存器 FC 0x06
function handleWriteSingleRegister(uid: number, address: number, value: number): Buffer {
  const dev = devices.get(uid);
  if (!dev) {
    return buildExceptionResponse(uid, 0x06, 0x0B);
  }

  console.log(`  [UID${uid}] 写寄存器 0x${address.toString(16).padStart(4, '0')}=0x${value.toString(16).padStart(4, '0')} (${value})`);

  switch (address) {
    case 0x0001: // Control A
      dev.controlA = value;
      if (value === 0x0002) {
        console.log(`  [UID${uid}] -> 强制停止`);
        stopTest(dev);
      } else if (value === 0x0004) {
        console.log(`  [UID${uid}] -> 清除状态/告警`);
        dev.statusRegister = clrBit(dev.statusRegister, BIT_COMM_ERROR);
        dev.statusRegister = clrBit(dev.statusRegister, BIT_COMM_TIMEOUT);
      }
      break;

    case 0x0002: // Control B (周期控制)
      dev.controlB = value;
      if (value === 0) {
        console.log(`  [UID${uid}] -> 停止周期`);
        stopTest(dev);
      } else if (value >= 1 && value <= 60) {
        console.log(`  [UID${uid}] -> 启动周期 F1, period=${value}s`);
        startCycleSimulation(dev, value);
      } else if (value === 10) {
        console.log(`  [UID${uid}] -> 单次测试触发 (controlB=10)`);
        startSingleSimulation(dev, dev.gearValue);
      }
      break;

    case 0x0003: // Gear Control
      dev.gearValue = value;
      console.log(`  [UID${uid}] -> 档位=${(value / 10).toFixed(1)}mA`);
      break;

    default:
      console.log(`  [UID${uid}] -> 未知寄存器写入: 0x${address.toString(16)}`);
      break;
  }

  // 回显: FC + Address + Value
  const response = Buffer.alloc(5);
  response.writeUInt8(0x06, 0);
  response.writeUInt16BE(address, 1);
  response.writeUInt16BE(value, 3);
  return buildMBAPResponse(uid, response);
}

function buildMBAPResponse(uid: number, pdu: Buffer, txId?: number): Buffer {
  const frame = Buffer.alloc(7 + pdu.length);
  frame.writeUInt16BE(txId || 1, 0); // Transaction ID
  frame.writeUInt16BE(0, 2);         // Protocol ID
  frame.writeUInt16BE(1 + pdu.length, 4); // Length = UID + PDU
  frame.writeUInt8(uid, 6);          // Unit ID
  pdu.copy(frame, 7);
  return frame;
}

function buildExceptionResponse(uid: number, funcCode: number, exceptionCode: number): Buffer {
  const pdu = Buffer.alloc(2);
  pdu.writeUInt8(funcCode | 0x80, 0);
  pdu.writeUInt8(exceptionCode, 1);
  return buildMBAPResponse(uid, pdu);
}

// ============ TCP 服务器 ============

function handleConnection(socket: net.Socket): void {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`\n[连接] 新客户端: ${remote}`);

  let buffer = Buffer.alloc(0);

  socket.on('data', (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 7) {
      // 解析 MBAP Header
      const txId = buffer.readUInt16BE(0);
      const protoId = buffer.readUInt16BE(2);
      const length = buffer.readUInt16BE(4);
      const uid = buffer.readUInt8(6);

      if (buffer.length < 6 + length) break; // 帧不完整，等待更多数据

      const pdu = buffer.subarray(7, 6 + length);
      buffer = buffer.subarray(6 + length);

      if (protoId !== 0) {
        console.log(`[帧] 非Modbus协议, ProtocolID=0x${protoId.toString(16)}`);
        continue;
      }

      const funcCode = pdu.readUInt8(0);
      let response: Buffer | null = null;

      if (funcCode === 0x03) {
        const address = pdu.readUInt16BE(1);
        const quantity = pdu.readUInt16BE(3);
        console.log(`[读] TxID=0x${txId.toString(16).padStart(4,'0')} UID=${uid} FC=0x03 Addr=0x${address.toString(16).padStart(4,'0')} Qty=${quantity}`);
        response = handleReadHoldingRegisters(uid, address, quantity);
        // 将 MBAP 中的 TxID 替换为请求的 TxID
        if (response && response.length >= 2) {
          response.writeUInt16BE(txId, 0);
        }
      } else if (funcCode === 0x06) {
        const address = pdu.readUInt16BE(1);
        const value = pdu.readUInt16BE(3);
        console.log(`[写] TxID=0x${txId.toString(16).padStart(4,'0')} UID=${uid} FC=0x06 Addr=0x${address.toString(16).padStart(4,'0')} Val=0x${value.toString(16).padStart(4,'0')}`);
        response = handleWriteSingleRegister(uid, address, value);
        if (response && response.length >= 2) {
          response.writeUInt16BE(txId, 0);
        }
      } else {
        console.log(`[?] 未知功能码: 0x${funcCode.toString(16)}`);
      }

      if (response) {
        socket.write(response);
      }
    }
  });

  socket.on('close', () => {
    console.log(`[断开] ${remote}`);
  });

  socket.on('error', (err) => {
    console.error(`[错误] ${remote}:`, err.message);
  });
}

// ============ 启动 ============

const server = net.createServer(handleConnection);

server.listen(MOCK_PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  Mock Modbus TCP Server');
  console.log('  模拟 12 通道电池测试设备');
  console.log('========================================');
  console.log(`  监听端口: ${MOCK_PORT}`);
  console.log(`  设备数量: ${DEVICE_COUNT} (UID ${UID_MIN}-${UID_MAX})`);
  console.log(`  连接方式: 前端连接 localhost:${MOCK_PORT}`);
  console.log('');
  console.log('  支持的操作:');
  console.log('  - 扫描在线设备 (FC 0x06 -> 0x0001=0x0004)');
  console.log('  - 读状态寄存器 (FC 0x03 -> 0x0000)');
  console.log('  - 读 13 寄存器数据 (FC 0x03 -> 0x0000,13)');
  console.log('  - 写档位 (FC 0x06 -> 0x0003)');
  console.log('  - F1 周期测试 (FC 0x06 -> 0x0002=period)');
  console.log('  - 单次测试 (FC 0x06 -> 0x0002=10)');
  console.log('  - 停止测试 (FC 0x06 -> 0x0002=0)');
  console.log('');
  console.log('  各 UID 独立运行，互不干扰');
  console.log('  按 Ctrl+C 停止');
  console.log('========================================');

  printDeviceSummary();
});

function printDeviceSummary(): void {
  console.log('\n设备摘要:');
  for (const [uid, dev] of devices) {
    const statusStr = [
      hasBit(dev.statusRegister, BIT_MEAS_ENABLE) ? 'MEAS' : '----',
      hasBit(dev.statusRegister, BIT_DATA_READY) ? 'DRDY' : '----',
      hasBit(dev.statusRegister, BIT_TEST_DONE) ? 'TDON' : '----',
      hasBit(dev.statusRegister, BIT_COMM_ERROR) ? 'CERR' : '----',
    ].join(' ');
    console.log(`  UID${uid.toString().padStart(2, '0')}: R=${dev.r1}Ω V=${(dev.voltage/1000).toFixed(2)}V Gear=${(dev.gearValue/10).toFixed(1)}mA [${statusStr}] Mode=${dev.testMode}`);
  }
  console.log('');
}

// 定期打印设备摘要
setInterval(() => {
  const activeDevices = Array.from(devices.values()).filter(d => d.testMode !== 'idle');
  if (activeDevices.length > 0) {
    const modes = activeDevices.map(d => `UID${d.uid}:${d.testMode}`).join(', ');
    const readyList = activeDevices.filter(d => hasBit(d.statusRegister, BIT_DATA_READY)).map(d => `UID${d.uid}`).join(',');
    if (readyList) console.log(`[状态] DATA_READY: ${readyList} | 活跃: ${modes}`);
  }
}, 5000);

export { server, devices, startCycleSimulation, startSingleSimulation, stopTest };
