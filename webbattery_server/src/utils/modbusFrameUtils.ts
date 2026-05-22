/**
 * Modbus TCP 帧处理工具
 * 按照标准 Modbus TCP 协议实现
 * 帧格式：MBAP Header + PDU
 * MBAP: Transaction ID(2) + Protocol ID(2) + Length(2) + Unit ID(1)
 * PDU: Function Code(1) + Data(N)
 */

/**
 * Modbus TCP 帧结构
 */
export interface ModbusTCPFrame {
  transactionId: number;  // 事务ID (2字节)
  protocolId: number;     // 协议ID (2字节，固定0x0000)
  length: number;         // 长度字段 (2字节，后续字段长度含Unit ID)
  unitId: number;         // 单元ID (1字节，从机地址)
  functionCode: number;   // 功能码 (1字节)
  data: Buffer;           // 数据区 (可变长度)
}

/**
 * 命令映射表
 */
export const COMMAND_MAP = {
  QUERY_STATUS: 0x00BB       // 查询状态
} as const;

/**
 * 寄存器地址映射（根据新协议文档定义）
 */
export const REGISTER_MAP = {
  // 状态寄存器 (0x0000)
  STATUS_REGISTER: 0x0000,  // 状态寄存器

  // 控制寄存器
  CONTROL_A: 0x0001,        // 控制寄存器A (强制停止0x0002/清除告警0x0004)
  CONTROL_B: 0x0002,        // 控制寄存器B (F1周期测试) - 与CONTROL_CYCLE相同
  CONTROL_CYCLE: 0x0002,    // 周期值写入 (启动周期测试)

  // GET_for_Tesla 协议: 0x0003 为档位控制寄存器
  GEAR_CTRL: 0x0003,        // 档位控制寄存器 (0.1mA步进, 写入值=电流mA*10, 范围1-624)

  // 数据寄存器 (0x0004-0x0007)
  UNIT_VOLT: 0x0004,        // 电压/阻值单位 (高3位为倍率索引, 低13位为电压mV)
  BAT1_R1: 0x0005,          // 电池1阻抗 R1 (μΩ)
  BAT1_R2: 0x0006,          // 电池1阻抗 R2 (μΩ)
  BAT1_R3: 0x0007,          // 电池1阻抗 R3 (μΩ)

  // RAW 内部数据寄存器 (单次测试时读取)
  RAW_R2_START: 0x0100,     // RAW R2[0..31] 起始地址
  RAW_R2_COUNT: 32,         // RAW R2 点数
  RAW_R3_START: 0x0120,     // RAW R3[0..31] 起始地址
  RAW_R3_COUNT: 32,         // RAW R3 点数

  // 兼容旧代码的别名
  VOLTAGE: 0x0004           // 向后兼容别名
} as const;

/**
 * F2 快速测试命令 (功能码 0x06)
 */
export const F2_COMMANDS = {
  // START: 0x0001,        // GET_for_Tesla: F2快速测试已移除
  STOP: 0x0000,            // 停止测试
  FORCE_STOP: 0x0002,      // 强制停止/复位
  CLEAR_STATUS: 0x0004     // 清除状态标志
} as const;

/**
 * 状态寄存器位定义 (0x0000) - 根据最新协议定义
 */
export const STATUS_BITS = {
  MEAS_ENABLE: 0x0001,        // bit0: 表示测试已启动
  MEAS_RUNNING: 0x0002,       // bit1: 当前测试正在执行中
  ALARM_CELL1_OV: 0x0004,     // bit2: 电池电压超出上限
  ALARM_CELL1_UV: 0x0008,     // bit3: 电池电压低于下限
  COMM_TIMEOUT: 0x0010,       // bit4: 通讯超时故障
  TEST_DONE: 0x0020,          // bit5: F2单次测试完成标志
  FORCE_STOPPED: 0x0040,      // bit6: 被强行中止标志
  DATA_READY: 0x0080,         // bit7: 采样数据更新标志
  COMM_ERROR: 0x0100,         // bit8: 写入命令错误标志
  // 以下两项保留为兼容字段，当前协议文档中无对应状态位定义
  COOLDOWN_LOCKED: 0x0000,
  ALARM_DEV_OV: 0x0000,
  ADDRESS_MASK: 0xFE00        // bit9-15: 地址寄存器
} as const;

/**
 * 可被识别为“完整电池数据帧”的字节数（不含MBAP+FC+ByteCount，仅Data区）
 * - 16字节: 0x0000~0x0007（8个寄存器，旧流程）
 * - 26字节: 0x0000~0x000C（13个寄存器，GET_for_Tesla 周期测试流程）
 */
const COMPLETE_BATTERY_DATA_BYTES = new Set([16, 26]);

/**
 * 构建 Modbus TCP 帧
 * @param transactionId 事务ID
 * @param unitId 单元ID (从机地址)
 * @param functionCode 功能码
 * @param data 数据区
 * @returns 完整的 Modbus TCP 帧
 */
export function buildModbusTCPFrame(
  transactionId: number,
  unitId: number,
  functionCode: number,
  data: Buffer
): Buffer {
  const protocolId = 0x0000;  // 固定值
  const length = 1 + 1 + data.length;  // Unit ID + Function Code + Data

  const frame = Buffer.alloc(6 + 1 + 1 + data.length);
  let offset = 0;

  // MBAP Header
  frame.writeUInt16BE(transactionId, offset); offset += 2;  // Transaction ID
  frame.writeUInt16BE(protocolId, offset); offset += 2;     // Protocol ID
  frame.writeUInt16BE(length, offset); offset += 2;        // Length
  frame.writeUInt8(unitId, offset); offset += 1;           // Unit ID

  // PDU
  frame.writeUInt8(functionCode, offset); offset += 1;     // Function Code
  data.copy(frame, offset);                                // Data

  return frame;
}



/**
 * 修复GET1001阻抗测试仪的Modbus TCP帧数据问题
 * @param hexString 十六进制字符串
 * @returns 修复后的十六进制字符串
 */
function fixGET1001ModbusFrame(hexString: string): string {
  // GET1001阻抗测试仪的标准响应帧应该是23字节
  // 格式：MBAP(7) + Function Code(1) + Byte Count(1) + Data(16) = 23字节

  console.log(`原始十六进制字符串: "${hexString}" (${hexString.length / 2}字节)`);

  // 检查是否是GET1001的读寄存器响应（以000100000开头）
  if (hexString.startsWith('000100000') && hexString.length === 44) {
    console.log('检测到GET1001读寄存器响应，长度为22字节，需要修复为23字节');

    // 分析当前帧结构
    const transactionId = hexString.substring(0, 4);     // 0001
    const protocolId = hexString.substring(4, 8);       // 0000
    const lengthField = hexString.substring(8, 12);     // 0F01 (错误)
    const remaining = hexString.substring(12);          // 其余部分

    console.log(`  Transaction ID: ${transactionId}`);
    console.log(`  Protocol ID: ${protocolId}`);
    console.log(`  Length Field: ${lengthField} (错误，应该是000E)`);
    console.log(`  Remaining: ${remaining}`);

    // 修复策略：重构正确的23字节帧
    // 分析remaining部分：03100FA0138813881388138813881388
    // 这里0310应该是Unit ID(01) + Function Code(03) + Byte Count(10)
    // 但是被错位了，实际应该是：01 + 03 + 10 + 0FA0138813881388138813881388

    if (remaining.startsWith('0310') && remaining.length === 36) {
      // 提取16字节的寄存器数据
      const registerData = remaining.substring(4); // 0FA0138813881388138813881388

      if (registerData.length === 32) { // 16字节 = 32个十六进制字符
        // 重构正确的23字节帧：MBAP(7) + Function Code(1) + Byte Count(1) + Data(16)
        const fixedFrame = transactionId + protocolId + '0012' + '01' + '03' + '10' + registerData;
        console.log(`修复后的帧: "${fixedFrame}" (${fixedFrame.length / 2}字节)`);
        return fixedFrame;
      }
    }

    // 如果无法按标准格式修复，尝试插入Unit ID
    console.log('尝试插入Unit ID字节进行修复...');
    const fixedFrame = transactionId + protocolId + '000F' + '01' + remaining;
    console.log(`插入Unit ID后: "${fixedFrame}" (${fixedFrame.length / 2}字节)`);
    return fixedFrame;
  }

  return hexString;
}

/**
 * 检测数据格式并转换为Buffer
 * 支持以下格式：
 * 1. 二进制数据（直接处理）
 * 2. ASCII十六进制字符串（有空格或无空格）
 * 3. ASCII编码的十六进制数据（双重编码）
 * @param data 原始数据
 * @returns 转换后的Buffer和格式类型
 */
function detectAndConvertData(data: Buffer): { buffer: Buffer; format: 'binary' | 'ascii-hex' } {
  const dataStr = data.toString('ascii');

  console.log(`接收到原始帧数据: ${Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ')} (${data.length}字节)`);

  // 检查是否为ASCII十六进制格式（只包含十六进制字符和空格）
  if (/^[0-9A-Fa-f\s\r\n]+$/.test(dataStr)) {
    try {
      const cleanDataStr = dataStr.replace(/\s+/g, '');

      // 检查是否为有效的十六进制字符串（偶数长度）
      if (cleanDataStr.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(cleanDataStr)) {

        // 检测是否为ASCII编码的十六进制数据（双重编码）
        // 特征：以"30"开头（ASCII字符'0'的十六进制表示）
        if (cleanDataStr.startsWith('30') && cleanDataStr.length >= 4) {
          try {
            // 尝试将十六进制转换为ASCII字符串
            const asciiString = Buffer.from(cleanDataStr, 'hex').toString('ascii');

            // 检查ASCII字符串是否为有效的十六进制格式
            const finalHexString = asciiString.replace(/\s+/g, '');
            if (/^[0-9A-Fa-f]+$/.test(finalHexString) && finalHexString.length % 2 === 0) {
              console.log('检测到ASCII编码的十六进制数据（双重编码）');
              console.log(`ASCII解码后: ${asciiString}`);

              // 应用GET1001特定的修复逻辑
              const fixedHexString = fixGET1001ModbusFrame(finalHexString);

              const finalBuffer = Buffer.from(fixedHexString, 'hex');
              console.log(`双重编码转换后: ${Array.from(finalBuffer).map(b => b.toString(16).padStart(2, '0')).join(' ')} (${finalBuffer.length}字节)`);
              return { buffer: finalBuffer, format: 'ascii-hex' };
            }
          } catch (e) {
            // 如果ASCII解码失败，继续按直接十六进制处理
          }
        }

        // 直接的ASCII十六进制格式（兼容有空格和无空格）
        console.log('检测到直接十六进制格式（兼容有无空格）');
        const finalBuffer = Buffer.from(cleanDataStr, 'hex');
        console.log(`十六进制转换后: ${Array.from(finalBuffer).map(b => b.toString(16).padStart(2, '0')).join(' ')} (${finalBuffer.length}字节)`);
        return { buffer: finalBuffer, format: 'ascii-hex' };
      }
    } catch (error) {
      console.log(`ASCII十六进制转换失败: ${error}`);
    }
  }

  console.log('当作二进制数据处理');
  return { buffer: data, format: 'binary' };
}

/**
 * 智能修复Modbus TCP帧中的长度字段问题
 * @param buffer 原始Buffer
 * @returns 修复后的Buffer
 */
function smartFixModbusTCPFrame(buffer: Buffer): Buffer {
  if (buffer.length < 8) return buffer;

  const transactionId = buffer.readUInt16BE(0);
  const protocolId = buffer.readUInt16BE(2);
  const length = buffer.readUInt16BE(4);
  const expectedLength = buffer.length - 6;

  console.log(`智能修复检查: 长度字段=${length}, 期望长度=${expectedLength}`);

  // 如果长度字段明显错误，尝试修复
  if (length !== expectedLength && expectedLength > 0 && expectedLength < 256) {
    console.log(`检测到长度字段错误，尝试修复...`);

    // 创建修复后的Buffer
    const fixedBuffer = Buffer.from(buffer);
    fixedBuffer.writeUInt16BE(expectedLength, 4);

    console.log(`修复后: ${Array.from(fixedBuffer).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    return fixedBuffer;
  }

  return buffer;
}

/**
 * 解析 Modbus TCP 帧
 * @param buffer 接收到的数据
 * @returns 解析结果
 */
export function parseModbusTCPFrame(buffer: Buffer): {
  isValid: boolean;
  frame?: ModbusTCPFrame;
  error?: string;
  format?: 'binary' | 'ascii-hex';
} {
  try {
    // 检测并转换数据格式
    const { buffer: processedBuffer, format } = detectAndConvertData(buffer);

    // 智能修复长度字段问题
    const fixedBuffer = smartFixModbusTCPFrame(processedBuffer);

    // 检查最小长度 (MBAP Header = 7字节)
    if (fixedBuffer.length < 8) {
      return {
        isValid: false,
        error: `帧长度不足: ${fixedBuffer.length}, 最少需要8字节`,
        format
      };
    }

    let offset = 0;

    // 解析 MBAP Header
    const transactionId = fixedBuffer.readUInt16BE(offset); offset += 2;
    const protocolId = fixedBuffer.readUInt16BE(offset); offset += 2;
    const length = fixedBuffer.readUInt16BE(offset); offset += 2;
    const unitId = fixedBuffer.readUInt8(offset); offset += 1;

    console.log(`MBAP头部: 事务ID=${transactionId}, 协议ID=${protocolId}, 长度=${length}, 单元ID=${unitId}, 功能码=0x${fixedBuffer.readUInt8(offset).toString(16)}`);

    // 验证协议ID
    if (protocolId !== 0x0000) {
      return {
        isValid: false,
        error: `协议ID错误: 0x${protocolId.toString(16)}, 应为0x0000`,
        format
      };
    }

    // 验证长度字段
    const expectedLength = fixedBuffer.length - 6; // 总长度减去前6字节
    if (length !== expectedLength) {
      return {
        isValid: false,
        error: `长度字段错误: ${length}, 应为${expectedLength}`,
        format
      };
    }

    // 解析 PDU
    const functionCode = fixedBuffer.readUInt8(offset); offset += 1;
    const data = fixedBuffer.slice(offset);

    return {
      isValid: true,
      format,
      frame: {
        transactionId,
        protocolId,
        length,
        unitId,
        functionCode,
        data
      }
    };

  } catch (error) {
    return {
      isValid: false,
      error: `解析异常: ${error}`,
      format: 'binary'
    };
  }
}

/**
 * 构建读取保持寄存器请求 (功能码 0x03)
 * @param transactionId 事务ID
 * @param unitId 单元ID
 * @param startAddress 起始地址
 * @param quantity 寄存器数量
 * @returns Modbus TCP 帧
 */
export function buildReadHoldingRegistersRequest(
  transactionId: number,
  unitId: number,
  startAddress: number,
  quantity: number
): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(startAddress, 0);  // 起始地址
  data.writeUInt16BE(quantity, 2);      // 寄存器数量

  return buildModbusTCPFrame(transactionId, unitId, 0x03, data);
}

/**
 * 构建写入单个寄存器请求 (功能码 0x06)
 * @param transactionId 事务ID
 * @param unitId 单元ID
 * @param address 寄存器地址
 * @param value 寄存器值
 * @returns Modbus TCP 帧
 */
export function buildWriteSingleRegisterRequest(
  transactionId: number,
  unitId: number,
  address: number,
  value: number
): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt16BE(address, 0);  // 寄存器地址
  data.writeUInt16BE(value, 2);    // 寄存器值

  return buildModbusTCPFrame(transactionId, unitId, 0x06, data);
}

/**
 * 解析读取保持寄存器响应
 * @param frame 解析后的帧
 * @returns 寄存器值数组
 */
export function parseReadHoldingRegistersResponse(frame: ModbusTCPFrame): {
  isValid: boolean;
  values?: number[];
  error?: string;
} {
  try {
    if (frame.functionCode !== 0x03) {
      return { isValid: false, error: `功能码错误: 0x${frame.functionCode.toString(16)}, 应为0x03` };
    }

    if (frame.data.length < 1) {
      return { isValid: false, error: '数据长度不足' };
    }

    const byteCount = frame.data.readUInt8(0);
    const expectedDataLength = byteCount + 1;

    if (frame.data.length !== expectedDataLength) {
      return { isValid: false, error: `数据长度错误: ${frame.data.length}, 应为${expectedDataLength}` };
    }

    const values: number[] = [];
    for (let i = 1; i < frame.data.length; i += 2) {
      const value = frame.data.readUInt16BE(i);
      values.push(value);
    }

    return { isValid: true, values };

  } catch (error) {
    return { isValid: false, error: `解析异常: ${error}` };
  }
}

/**
 * 构建F1周期测试启动命令
 * @param transactionId 事务ID
 * @param unitId 单元ID
 * @param cycleSeconds 周期时间（秒）
 * @returns Modbus TCP 帧
 */
export function buildF1CycleStartCommand(
  transactionId: number,
  unitId: number,
  cycleSeconds: number
): Buffer {
  return buildWriteSingleRegisterRequest(
    transactionId,
    unitId,
    REGISTER_MAP.CONTROL_B,
    cycleSeconds
  );
}

/**
 * 构建F1周期测试停止命令
 * @param transactionId 事务ID
 * @param unitId 单元ID
 * @returns Modbus TCP 帧
 */
export function buildF1CycleStopCommand(
  transactionId: number,
  unitId: number
): Buffer {
  return buildWriteSingleRegisterRequest(
    transactionId,
    unitId,
    REGISTER_MAP.CONTROL_B,
    0
  );
}

/**
 * 构建F2快速测试启动命令
 * @param transactionId 事务ID
 * @param unitId 单元ID
 * @returns Modbus TCP 帧
 */
// GET_for_Tesla: F2 快速测试已移除，此函数不再使用
// export function buildF2QuickStartCommand(
//   transactionId: number,
//   unitId: number
// ): Buffer {
//   return buildWriteSingleRegisterRequest(
//     transactionId,
//     unitId,
//     REGISTER_MAP.CONTROL_A,
//     F2_COMMANDS.START
//   );
// }

/**
 * 构建F2快速测试清除状态命令
 * @param transactionId 事务ID
 * @param unitId 单元ID
 * @returns Modbus TCP 帧
 */
export function buildF2ClearStatusCommand(
  transactionId: number,
  unitId: number
): Buffer {
  return buildWriteSingleRegisterRequest(
    transactionId,
    unitId,
    REGISTER_MAP.CONTROL_A,
    F2_COMMANDS.CLEAR_STATUS
  );
}

/**
 * 构建读取数据寄存器命令 (0x0000-0x000C)
 * @param transactionId 事务ID
 * @param unitId 单元ID
 * @returns Modbus TCP 帧
 */
export function buildReadDataRegistersCommand(
  transactionId: number,
  unitId: number
): Buffer {
  return buildReadHoldingRegistersRequest(
    transactionId,
    unitId,
    REGISTER_MAP.STATUS_REGISTER,
    8  // GET_for_Tesla: 读取8个寄存器: 0x0000-0x0007
  );
}

/**
 * 构建设备初始化命令（写0x0001=0x0002）
 * @param transactionId 事务ID
 * @param unitId 单元ID
 */
export function buildF2InitDeviceCommand(
  transactionId: number,
  unitId: number
): Buffer {
  return buildWriteSingleRegisterRequest(
    transactionId,
    unitId,
    REGISTER_MAP.CONTROL_A,
    F2_COMMANDS.FORCE_STOP
  );
}

/**
 * 直接解析原始Modbus TCP帧数据（绕过长度检查）
 * @param rawFrame 原始帧数据
 * @returns 解析后的电池数据
 */
export function parseRawModbusTCPFrame(rawFrame: Buffer): {
  isValid: boolean;
  batteryData?: any;
  error?: string;
  format?: 'binary' | 'ascii-hex';
  frameType?: 'write-response' | 'status-response' | 'data-response' | 'other-read-response';
} {
  try {
    // 检测并转换数据格式
    const { buffer: processedFrame, format } = detectAndConvertData(rawFrame);

    console.log(`接收到原始帧数据: ${formatModbusFrameHex(rawFrame)} (${rawFrame.length}字节)`);
    if (format === 'ascii-hex') {
      console.log(`检测到ASCII十六进制格式，转换后: ${formatModbusFrameHex(processedFrame)} (${processedFrame.length}字节)`);
    }

    // 检查最小长度
    if (processedFrame.length < 9) {
      return { isValid: false, error: `帧长度不足: ${processedFrame.length}字节`, format };
    }

    // 解析MBAP头部
    const transactionId = processedFrame.readUInt16BE(0);
    const protocolId = processedFrame.readUInt16BE(2);
    const length = processedFrame.readUInt16BE(4);
    const unitId = processedFrame.readUInt8(6);
    const functionCode = processedFrame.readUInt8(7);

    console.log(`MBAP头部: 事务ID=${transactionId}, 协议ID=${protocolId}, 长度=${length}, 单元ID=${unitId}, 功能码=0x${functionCode.toString(16)}`);

    // 检查功能码是否为支持的响应类型
    if (functionCode !== 0x03 && functionCode !== 0x06) {
      return { isValid: false, error: `不支持的功能码: 0x${functionCode.toString(16)}`, format };
    }

    // 如果是写单个寄存器响应（功能码0x06），直接返回成功
    if (functionCode === 0x06) {
      console.log('收到写单个寄存器响应，操作成功');
      return { isValid: true, batteryData: { writeSuccess: true, unitId }, format, frameType: 'write-response' };
    }

    // 获取字节计数
    if (processedFrame.length < 9) {
      return { isValid: false, error: '缺少字节计数字段', format };
    }

    const byteCount = processedFrame.readUInt8(8);
    console.log(`字节计数: ${byteCount}`);

    // 计算可用的数据字节数
    const availableDataBytes = processedFrame.length - 9; // 减去MBAP头(7字节) + 功能码(1字节) + 字节计数(1字节)
    console.log(`可用数据字节: ${availableDataBytes}, 期望字节: ${byteCount}`);

    // 使用实际可用的字节数，而不是期望的字节数
    const actualDataBytes = Math.min(byteCount, availableDataBytes);

    // 读1个或3个寄存器的标准响应（属于状态帧探测），不应按完整电池数据帧处理。
    if (actualDataBytes === 2 || actualDataBytes === 6) {
      const statusValue = processedFrame.readUInt16BE(9);
      const statusData = parseStatusRegister(statusValue);
      const batteryData: any = {
        unitId,
        status: {
          value: statusValue,
          ...statusData
        }
      };

      if (actualDataBytes === 6) {
        batteryData.controlRegisterA = processedFrame.readUInt16BE(11);
        batteryData.controlRegisterB = processedFrame.readUInt16BE(13);
      }

      console.log(`状态/控制寄存器响应帧: status=0x${statusValue.toString(16).toUpperCase().padStart(4, '0')}, measEnable=${statusData.measEnable ? 1 : 0}, testDone=${statusData.testDone ? 1 : 0}`);
      return { isValid: true, batteryData, format, frameType: 'status-response' };
    }

    // 解析寄存器值
    const values: number[] = [];
    for (let i = 0; i < actualDataBytes; i += 2) {
      if (i + 1 < actualDataBytes) {
        const value = processedFrame.readUInt16BE(9 + i);
        values.push(value);
        console.log(`寄存器${Math.floor(i / 2)}: 0x${value.toString(16)} (${value})`);
      }
    }

    // 解析电池数据
    const batteryData = parseBatteryData(values);

    // 添加设备地址信息到电池数据中
    if (batteryData) {
      batteryData.unitId = unitId; // 添加Modbus设备地址
    }

    const frameType = COMPLETE_BATTERY_DATA_BYTES.has(actualDataBytes)
      ? 'data-response'
      : 'other-read-response';
    return { isValid: true, batteryData, format, frameType };

  } catch (error) {
    return { isValid: false, error: `解析异常: ${error}`, format: 'binary' };
  }
}

/**
 * 解析状态寄存器 (0x0000) - 根据 GET3017_v4_20260416 定义解析
 * @param statusValue 状态寄存器值
 * @returns 解析后的状态位
 */
export function parseStatusRegister(statusValue: number): {
  address: number;
  measEnable: boolean;
  measRunning: boolean;
  cooldownLocked: boolean;
  alarmDevOv: boolean;
  alarmCell1Ov: boolean;
  alarmCell1Uv: boolean;
  commTimeout: boolean;
  testDone: boolean;
  forceStopped: boolean;
  dataReady: boolean;
  commError: boolean;
  rawValue: number;
  binaryString: string;
} {
  return {
    address: (statusValue & STATUS_BITS.ADDRESS_MASK) >> 9, // 地址在Bit9-15
    measEnable: (statusValue & STATUS_BITS.MEAS_ENABLE) !== 0,
    measRunning: (statusValue & STATUS_BITS.MEAS_RUNNING) !== 0,
    cooldownLocked: (statusValue & STATUS_BITS.COOLDOWN_LOCKED) !== 0,
    alarmDevOv: (statusValue & STATUS_BITS.ALARM_DEV_OV) !== 0,
    alarmCell1Ov: (statusValue & STATUS_BITS.ALARM_CELL1_OV) !== 0,
    alarmCell1Uv: (statusValue & STATUS_BITS.ALARM_CELL1_UV) !== 0,
    commTimeout: (statusValue & STATUS_BITS.COMM_TIMEOUT) !== 0,
    testDone: (statusValue & STATUS_BITS.TEST_DONE) !== 0,
    forceStopped: (statusValue & STATUS_BITS.FORCE_STOPPED) !== 0,
    dataReady: (statusValue & STATUS_BITS.DATA_READY) !== 0,
    commError: (statusValue & STATUS_BITS.COMM_ERROR) !== 0,
    rawValue: statusValue,
    binaryString: statusValue.toString(2).padStart(16, '0')
  };
}

/**
 * 计算实际阻抗值
 * @param value 有效值
 * @param power 幂次 (如果未提供，默认为-6，即μΩ)
 * @returns 实际阻抗值 (μΩ)
 */
export function calculateActualImpedance(value: number, power: number = -6): number {
  return value * Math.pow(10, power);
}

// 高位寄存器不再用于R1/R2/R3实际值拼接；保留低16位作为当前阻抗值

/**
 * 解析电池数据 (GET_for_Tesla 协议)
 * 寄存器映射：
 * 0x0000: 状态寄存器
 * 0x0001: 控制寄存器A
 * 0x0002: 控制寄存器B
 * 0x0003: 档位控制寄存器 (GEAR_CTRL)
 * 0x0004: 电压/阻值单位 (高3位倍率, 低13位电压mV)
 * 0x0005-0x0007: Bat1 R1-R3
 */
export function parseBatteryData(values: number[]): {
  voltage?: number;      // 电压 (mV)
  r1?: { value: number; actual: number };  // R1阻抗 (μΩ)
  r2?: { value: number; actual: number };  // R2阻抗 (μΩ)
  r3?: { value: number; actual: number };  // R3阻抗 (μΩ)
  status?: {             // 状态寄存器
    value: number;
    dataReady: boolean;
    testDone: boolean;
    cooldownLocked: boolean;
    address: number;
    measEnable: boolean;
    measRunning: boolean;
    alarmDevOv: boolean;
    alarmCell1Ov: boolean;
    alarmCell1Uv: boolean;
    commTimeout: boolean;
    forceStopped: boolean;
    commError: boolean;
    rawValue: number;
    binaryString: string;
  };
  controlRegisterA?: number; // 控制寄存器A
  controlRegisterB?: number; // 控制寄存器B
  gearCtrl?: number;     // 档位控制寄存器值
  unitId?: number;       // Modbus设备地址
} {
  const data: any = {};

  console.log(`解析电池数据，寄存器值数组长度: ${values.length}`);

  // 0x0000: 状态寄存器
  if (values.length > 0) {
    const statusValue = values[0];
    const statusData = parseStatusRegister(statusValue);
    data.status = {
      value: statusValue,
      ...statusData
    };
  }

  // 0x0001: 控制寄存器A
  if (values.length > 1) {
    data.controlRegisterA = values[1];
  }

  // 0x0002: 控制寄存器B
  if (values.length > 2) {
    data.controlRegisterB = values[2];
  }

  // 0x0003: 档位控制寄存器 (GET_for_Tesla: GEAR_CTRL)
  if (values.length > 3) {
    data.gearCtrl = values[3];
  }

  let multiplier = 1;

  // 0x0004: 电压/阻值单位 (GET_for_Tesla: UNIT_VOLT)
  if (values.length > 4) {
    const rawVal = values[4];
    const voltage = rawVal & 0x1FFF; // 低13位
    const multiplierIndex = (rawVal >> 13) & 0x07; // 高3位
    const multipliers = [1, 2, 4, 8, 16, 32, 64, 128];
    multiplier = multipliers[multiplierIndex] || 1;

    data.voltage = voltage;
    console.log(`0x0004 原始值: 0x${rawVal.toString(16)}, 电压: ${voltage}mV, 倍率: *${multiplier}`);
  }

  // 计算阻抗辅助函数
  const getImpedance = (raw: number) => ({ value: raw, actual: raw * multiplier });

  // 0x0005-0x0007: Bat1 R1-R3 (GET_for_Tesla)
  if (values.length > 7) {
    data.r1 = getImpedance(values[5]);
    data.r2 = getImpedance(values[6]);
    data.r3 = getImpedance(values[7]);
  }

  // GET_for_Tesla: Bat3/Bat4 已移除，不再解析

  return data;
}

/**
 * 格式化帧数据为十六进制字符串（用于调试）
 */
export function formatModbusFrameHex(frame: Buffer): string {
  return Array.from(frame)
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

/**
 * 验证命令码是否有效
 */
export function isValidCommand(command: number): boolean {
  return Object.values(COMMAND_MAP).includes(command as any);
}

/**
 * 获取命令描述
 */
export function getCommandDescription(command: number): string {
  switch (command) {
    case COMMAND_MAP.QUERY_STATUS: return '查询状态';
    default: return `未知命令 (0x${command.toString(16)})`;
  }
}
