export enum FrameType {
  CyclicTest = 0xAA,          // 周期测试：电压(2B) + Rohm(4B) + Rsei(4B) + Rct(4B) = 14字节，用户设定时间间隔
  FastTest = 0xFA,            // 快速测试：电压(2B) + Rohm(4B) + Rsei(4B) + Rct(4B) = 14字节，0.5秒间隔
  DeviceAddResponse = 0x05    // 设备添加响应
}

export enum CommandType {
  HighFrequencyTest = 0x01FA,   // 高频测试（开始充电）
  LowFrequencyTest = 0x01F5,    // 低频测试（开始测试）
  HighAndLowFrequencyTest = 0x01AA, // 高频+低频测试（开始放电）
  StopTest = 0x00AA,           // 停止测试（停止放电/重置设备）
}

export interface BatteryData {
  deviceNumber: number;
  status?: number;       // 状态标识位
  voltage: number;       // 电压 (mV)
  b2Voltage?: number;    // 补电电源电压 (mV)
  r_ct?: { value: number; power: number; actual: number };  // R_ct阻抗 (μΩ) - 对应R3
  r_ohm?: { value: number; power: number; actual: number };  // R_ohm阻抗 (μΩ) - 对应R1
  r_sei?: { value: number; power: number; actual: number };  // R_sei阻抗 (μΩ) - 对应R2
  // 映射关系：r1→R_ohm，r2→R_sei，r3→R_ct
  r1?: { value: number; power: number; actual: number };  // R1对应R_ohm
  r2?: { value: number; power: number; actual: number };  // R2对应R_sei
  r3?: { value: number; power: number; actual: number };  // R3对应R_ct
  
  // 离线测试计数器
  offlineCounter?: number;
  
  // 控制寄存器
  controlA?: number;
  controlB?: number;
  
  // 电池3阻抗
  bat3_r1?: { value: number; power: number; actual: number };
  bat3_r2?: { value: number; power: number; actual: number };
  bat3_r3?: { value: number; power: number; actual: number };
  
  // 电池4阻抗
  bat4_r1?: { value: number; power: number; actual: number };
  bat4_r2?: { value: number; power: number; actual: number };
  bat4_r3?: { value: number; power: number; actual: number };

  rOhm?: number;
  rSei?: number;
  rCt?: number;
  testType: FrameType;
  timestamp: string;
  mac: string; // 设备MAC地址（必需字段）
  // 新增状态寄存器相关字段
  statusRegister?: number; // 状态寄存器原始值
  statusBits?: {
    measEnable: boolean;      // bit0: 表示测试已启动，无论是否正在采样
    measRunning: boolean;     // bit1: 当前测试正在执行中（如采样/计算进行中）
    cooldownLocked: boolean;  // bit2: F2测试冷却保护标志，冷却保护时间30秒
    alarmDevOv: boolean;      // bit3: 检测设备供电异常标志
    alarmCell1Ov: boolean;    // bit4: 电池电压超出4.5V上限标志
    alarmCell1Uv: boolean;    // bit5: 电池电压低于0.2V下限标志
    commTimeout: boolean;     // bit6: F1模式中充放电机超过设定周期+30s未发生通讯，自动停止并标志为1
    testDone: boolean;        // bit7: F2测试完成标志
    forceStopped: boolean;    // bit8: 被充放电机强行中止标志
    dataReady: boolean;       // bit9: F1采样数据更新标志，可作为充放电机数据同步时钟戳
    commError: boolean;       // bit10: 检测设备收到的写入命令错误时置1，收到的写入命令正确时清0
    address: number;          // bit11-14: 地址寄存器 (1-12)
    rawValue: number;
    binaryString: string;
  };
  controlRegisterA?: number; // 控制寄存器A
  controlRegisterB?: number; // 控制寄存器B
  dataReady?: number; // 数据就绪标志
}

export interface ClientInfo {
  socketId: string;
  id: string; // 客户端连接ID
  mac: string | null; // 设备MAC地址
  address: string; // IP地址
  port: number;
  lastHeartbeat: string;
  isConnected: boolean;
}

export interface DeviceMapping {
  mac: string; // 使用MAC地址作为主键
  deviceNumber: string;
  createTime: string;
}

export interface CommandRequest {
  deviceId: string; // 使用设备ID
  command: number;
  parameters?: {
    [key: string]: any;
  };
}

export interface TestCommandParameters {
  // 测试命令参数（已移除补电功能）
}