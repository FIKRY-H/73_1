// Define the frame types enum
export enum FrameType {
  CyclicTest = 0xAA,          // 周期测试：电压(2B) + Rohm(4B) + Rsei(4B) + Rct(4B) = 14字节，用户设定时间间隔
  FastTest = 0xFA,            // 快速测试（GET_for_Tesla已移除，保留枚举兼容历史数据）
  DeviceAddResponse = 0x05    // 设备检测响应
}

// Define command types enum
export enum CommandType {
  HighFrequencyTest = 0xFA,   // 高频测试（已废弃）
  LowFrequencyTest = 0xF5,    // 低频测试
  HighAndLowFrequencyTest = 0xAA, // 高频+低频测试
  StopTest = 0xA0,           // 停止测试/复位
}

// Battery data interface
export interface BatteryData {
  // 统一以MAC作为设备唯一标识；设备编号不再必需
  deviceNumber?: number;
  status?: number;       // 状态标识位
  // 读寄存器扩展：包含控制寄存器A/B (0x0001/0x0002)
  controlRegisterA?: number; // 控制寄存器A (0x0001) 原始值
  controlRegisterB?: number; // 控制寄存器B (0x0002) 原始值
  // 新增：拆分MAC中的IP前缀与设备地址，便于查询
  ip_prefix?: string;
  device_address?: string;
  voltage: number;       // 电压 (mV)
  r_ct?: { value: number; power: number; actual: number };  // R_ct阻抗 (μΩ) - 对应R3
  r_ohm?: { value: number; power: number; actual: number };  // R_ohm阻抗 (μΩ) - 对应R1
  r_sei?: { value: number; power: number; actual: number };  // R_sei阻抗 (μΩ) - 对应R2
  // 映射关系：r1→R_ohm，r2→R_sei，r3→R_ct
  r1?: { value: number; power: number; actual: number };  // R1对应R_ohm
  r2?: { value: number; power: number; actual: number };  // R2对应R_sei
  r3?: { value: number; power: number; actual: number };  // R3对应R_ct

  // GET_for_Tesla: RAW 数据 (单次测试时读取)
  rawR2?: number[];  // RAW R2[0..31] 32点原始数据
  rawR3?: number[];  // RAW R3[0..31] 32点原始数据

  rOhm?: number;
  rSei?: number;
  rCt?: number;
  testType: FrameType;
  timestamp?: string | Date;
  mac: string;  // 设备MAC地址（必需字段）
}

// Device mapping interface
export interface DeviceMapping {
  mac: string; // 使用MAC地址作为主键
  deviceNumber: string;
  createdAt?: Date;
}

// Client connection interface
export interface ClientConnection {
  clientId: string;
  mac?: string; // MAC地址
  ipAddress: string;
  port: number;
  lastHeartbeat: Date;
  isConnected: boolean;
  socket?: any; // Socket instance
}

// Data processing result interface
export interface ProcessedData {
  success: boolean;
  data?: BatteryData;
  error?: string;
}