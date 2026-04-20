import { getDatabase } from '../config/database';
import { BatteryData, DeviceMapping, FrameType, ProcessedData } from '../models/batteryModel';
import { STATUS_BITS } from '../utils/modbusFrameUtils';
import ExcelJS from 'exceljs';

// Save battery data to database
export async function saveBatteryData(data: BatteryData): Promise<number> {
  const db = getDatabase();

  try {
    // 确保MAC地址不为空
    let mac = data.mac;
    if (!mac || mac.trim() === '' || mac === 'unknown') {
      console.warn(`MAC地址为空或无效: '${mac}', 跳过保存该条数据`);
      return 0;
    }

    // 修改映射关系：r1→R_ohm，r2→R_sei，r3→R_ct
    // 使用空值合并，保留0值（避免0被误判为null）
    const r1Value = data.r_ohm?.actual ?? data.r1?.actual ?? data.rOhm ?? null;
    const r2Value = data.r_sei?.actual ?? data.r2?.actual ?? data.rSei ?? null;
    const r3Value = data.r_ct?.actual ?? data.r3?.actual ?? data.rCt ?? null;

    // 获取电池3和电池4的阻抗值
    const bat3R1 = data.bat3_r1?.actual ?? null;
    const bat3R2 = data.bat3_r2?.actual ?? null;
    const bat3R3 = data.bat3_r3?.actual ?? null;

    const bat4R1 = data.bat4_r1?.actual ?? null;
    const bat4R2 = data.bat4_r2?.actual ?? null;
    const bat4R3 = data.bat4_r3?.actual ?? null;

    // 使用当前系统真实时间作为时间戳
    const timestamp = data.timestamp || new Date().toISOString();

    // 确定dataready状态
    let dataReady = 1; // 默认为1
    if (data.status !== undefined) {
      if (typeof data.status === 'object' && data.status && (data.status as any).dataReady !== undefined) {
        dataReady = (data.status as any).dataReady ? 1 : 0;
      } else if (typeof data.status === 'number') {
        dataReady = (data.status & STATUS_BITS.DATA_READY) !== 0 ? 1 : 0;
      }
    }

    // 保存策略调整：周期测试与静置/快速测试均保存全部数据（包含dataready=0）
    // 保留dataready字段用于后续分析，但不再作为过滤条件

    // 解析/使用 ip_prefix 和 device_address
    const ipPrefix = data.ip_prefix ?? (mac.includes('_') ? mac.split('_')[0] : mac);
    const deviceAddress = data.device_address ?? (mac.includes('_') ? mac.split('_')[1] : null);

    console.log(`保存电池数据: MAC=${mac}, IP=${ipPrefix}, Addr=${deviceAddress ?? ''}, testType=${data.testType}`);

    const result = await db.run(
      `INSERT INTO battery_data 
       (device_number, mac, ip_prefix, device_address, r_ohm, r_sei, r_ct, bat3_r1, bat3_r2, bat3_r3, bat4_r1, bat4_r2, bat4_r3, voltage, test_type, dataready, timestamp) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.deviceNumber ?? null,
      mac,
      ipPrefix,
      deviceAddress,
      r1Value,
      r2Value,
      r3Value,
      bat3R1,
      bat3R2,
      bat3R3,
      bat4R1,
      bat4R2,
      bat4R3,
      data.voltage,
      data.testType,
      dataReady,
      timestamp
    );

    return result.lastID || 0;
  } catch (error) {
    console.error('Error saving battery data:', error);
    throw error;
  }
}

// Get battery data by device number
export async function getBatteryDataByDeviceNumber(deviceNumber: number): Promise<BatteryData[]> {
  const db = getDatabase();

  try {
    const rows = await db.all(
      `SELECT * FROM battery_data 
       WHERE device_number = ? AND dataready = 1
       ORDER BY timestamp DESC 
       LIMIT 100`,
      deviceNumber
    );

    return rows.map(row => ({
      deviceNumber: row.device_number,
      mac: row.mac,
      // 新格式：r_ct、r_ohm、r_sei对象
      r_ct: row.r_ct ? { value: 0, power: 0, actual: row.r_ct } : undefined,
      r_ohm: row.r_ohm ? { value: 0, power: 0, actual: row.r_ohm } : undefined,
      r_sei: row.r_sei ? { value: 0, power: 0, actual: row.r_sei } : undefined,
      // 修改映射关系：r1→R_ohm，r2→R_sei，r3→R_ct
      r1: row.r_ohm ? { value: 0, power: 0, actual: row.r_ohm } : undefined,
      r2: row.r_sei ? { value: 0, power: 0, actual: row.r_sei } : undefined,
      r3: row.r_ct ? { value: 0, power: 0, actual: row.r_ct } : undefined,

      // 电池3阻抗
      bat3_r1: row.bat3_r1 ? { value: 0, power: 0, actual: row.bat3_r1 } : undefined,
      bat3_r2: row.bat3_r2 ? { value: 0, power: 0, actual: row.bat3_r2 } : undefined,
      bat3_r3: row.bat3_r3 ? { value: 0, power: 0, actual: row.bat3_r3 } : undefined,

      // 电池4阻抗
      bat4_r1: row.bat4_r1 ? { value: 0, power: 0, actual: row.bat4_r1 } : undefined,
      bat4_r2: row.bat4_r2 ? { value: 0, power: 0, actual: row.bat4_r2 } : undefined,
      bat4_r3: row.bat4_r3 ? { value: 0, power: 0, actual: row.bat4_r3 } : undefined,

      rOhm: row.r_ohm,
      rSei: row.r_sei,
      rCt: row.r_ct,
      voltage: row.voltage,
      testType: row.test_type,
      timestamp: new Date(row.timestamp)
    }));
  } catch (error) {
    console.error('Error getting battery data:', error);
    throw error;
  }
}

// Get latest battery data for all devices
export async function getLatestBatteryData(): Promise<BatteryData[]> {
  const db = getDatabase();

  try {
    const rows = await db.all(`
      SELECT b.*
      FROM battery_data b
      INNER JOIN (
        SELECT ip_prefix, device_address, MAX(timestamp) AS max_timestamp
        FROM battery_data
        GROUP BY ip_prefix, device_address
      ) m ON b.ip_prefix = m.ip_prefix 
          AND (
            (b.device_address = m.device_address) OR 
            (b.device_address IS NULL AND m.device_address IS NULL)
          )
          AND b.timestamp = m.max_timestamp
    `);

    return rows.map(row => ({
      mac: row.mac,
      ip_prefix: row.ip_prefix,
      device_address: row.device_address,
      deviceNumber: row.device_number, // 兼容旧数据，若存在则保留
      // 新格式：r_ct、r_ohm、r_sei对象
      r_ct: row.r_ct ? { value: 0, power: 0, actual: row.r_ct } : undefined,
      r_ohm: row.r_ohm ? { value: 0, power: 0, actual: row.r_ohm } : undefined,
      r_sei: row.r_sei ? { value: 0, power: 0, actual: row.r_sei } : undefined,
      // 修改映射关系：r1→R_ohm，r2→R_sei，r3→R_ct
      r1: row.r_ohm ? { value: 0, power: 0, actual: row.r_ohm } : undefined,
      r2: row.r_sei ? { value: 0, power: 0, actual: row.r_sei } : undefined,
      r3: row.r_ct ? { value: 0, power: 0, actual: row.r_ct } : undefined,

      // 电池3阻抗
      bat3_r1: row.bat3_r1 ? { value: 0, power: 0, actual: row.bat3_r1 } : undefined,
      bat3_r2: row.bat3_r2 ? { value: 0, power: 0, actual: row.bat3_r2 } : undefined,
      bat3_r3: row.bat3_r3 ? { value: 0, power: 0, actual: row.bat3_r3 } : undefined,

      // 电池4阻抗
      bat4_r1: row.bat4_r1 ? { value: 0, power: 0, actual: row.bat4_r1 } : undefined,
      bat4_r2: row.bat4_r2 ? { value: 0, power: 0, actual: row.bat4_r2 } : undefined,
      bat4_r3: row.bat4_r3 ? { value: 0, power: 0, actual: row.bat4_r3 } : undefined,

      rOhm: row.r_ohm,
      rSei: row.r_sei,
      rCt: row.r_ct,
      voltage: row.voltage,
      testType: row.test_type,
      timestamp: new Date(row.timestamp)
    }));
  } catch (error) {
    console.error('Error getting latest battery data:', error);
    throw error;
  }
}

// Save or update device mapping
export async function saveDeviceMapping(uid: string, deviceNumber: string): Promise<boolean> {
  const db = getDatabase();

  try {
    await db.run(
      `INSERT OR REPLACE INTO device_mapping (uid, device_number) VALUES (?, ?)`,
      uid,
      deviceNumber
    );

    return true;
  } catch (error) {
    console.error('Error saving device mapping:', error);
    throw error;
  }
}

// Get device number by MAC, auto-assign if not exists
export async function getDeviceNumberByMac(mac: string): Promise<number> {
  const db = getDatabase();

  try {
    // 确保MAC地址不为空
    if (!mac || mac.trim() === '') {
      console.warn('MAC地址为空，使用默认设备编号1');
      return 1;
    }

    // 检查表结构，确定使用哪个字段
    const tableInfo = await db.all("PRAGMA table_info(device_mapping)");
    const hasMacField = tableInfo.some(col => col.name === 'mac');
    const hasUidField = tableInfo.some(col => col.name === 'uid');

    let query: string;
    let params: string[];

    if (hasMacField && hasUidField) {
      // 两个字段都存在，优先查找mac字段，回退到uid字段
      query = `SELECT device_number FROM device_mapping WHERE mac = ? OR uid = ?`;
      params = [mac, mac];
    } else if (hasMacField) {
      // 只有mac字段
      query = `SELECT device_number FROM device_mapping WHERE mac = ?`;
      params = [mac];
    } else if (hasUidField) {
      // 只有uid字段（旧版本兼容）
      query = `SELECT device_number FROM device_mapping WHERE uid = ?`;
      params = [mac];
    } else {
      // 没有相关字段，直接分配新编号
      return await autoAssignDeviceNumber(mac);
    }

    const row = await db.get(query, ...params);

    if (row && row.device_number) {
      const deviceNumber = parseInt(row.device_number, 10);
      // 确保设备编号有效（大于0）
      if (deviceNumber > 0) {
        return deviceNumber;
      }
    }

    // 如果不存在或设备编号无效，自动分配新的设备编号
    return await autoAssignDeviceNumber(mac);
  } catch (error) {
    console.error('Error getting device number by MAC:', error);
    // 发生错误时返回默认设备编号，而不是抛出异常
    console.warn('使用默认设备编号1作为后备');
    return 1;
  }
}

// Auto-assign device number for new MAC address
export async function autoAssignDeviceNumber(mac: string): Promise<number> {
  const db = getDatabase();

  try {
    // 获取当前最大的设备编号
    const maxRow = await db.get(
      `SELECT MAX(CAST(device_number AS INTEGER)) as max_number FROM device_mapping`
    );

    const nextDeviceNumber = (maxRow?.max_number || 0) + 1;

    // 检查表结构
    const tableInfo = await db.all("PRAGMA table_info(device_mapping)");
    const hasMacField = tableInfo.some(col => col.name === 'mac');
    const hasUidField = tableInfo.some(col => col.name === 'uid');
    const hasCreatedAtField = tableInfo.some(col => col.name === 'created_at');

    // 构建插入语句
    let insertQuery: string;
    let insertParams: any[];

    if (hasMacField && hasUidField && hasCreatedAtField) {
      // 完整字段
      insertQuery = `INSERT INTO device_mapping (mac, uid, device_number, created_at) VALUES (?, ?, ?, ?)`;
      insertParams = [mac, mac, nextDeviceNumber.toString(), new Date().toISOString()];
    } else if (hasMacField && hasCreatedAtField) {
      // 只有mac和created_at字段
      insertQuery = `INSERT INTO device_mapping (mac, device_number, created_at) VALUES (?, ?, ?)`;
      insertParams = [mac, nextDeviceNumber.toString(), new Date().toISOString()];
    } else if (hasUidField && hasCreatedAtField) {
      // 只有uid和created_at字段（旧版本兼容）
      insertQuery = `INSERT INTO device_mapping (uid, device_number, created_at) VALUES (?, ?, ?)`;
      insertParams = [mac, nextDeviceNumber.toString(), new Date().toISOString()];
    } else if (hasMacField) {
      // 只有mac字段，没有时间戳
      insertQuery = `INSERT INTO device_mapping (mac, device_number) VALUES (?, ?)`;
      insertParams = [mac, nextDeviceNumber.toString()];
    } else if (hasUidField) {
      // 只有uid字段，没有时间戳（最基本的兼容）
      insertQuery = `INSERT INTO device_mapping (uid, device_number) VALUES (?, ?)`;
      insertParams = [mac, nextDeviceNumber.toString()];
    } else {
      throw new Error('device_mapping table structure is not supported');
    }

    // 创建新的设备映射
    await db.run(insertQuery, ...insertParams);

    // 同时插入到device_mappings表以保持兼容性
    try {
      await db.run(
        `INSERT OR IGNORE INTO device_mappings (uid, device_number, create_time) VALUES (?, ?, ?)`,
        mac,
        nextDeviceNumber.toString(),
        new Date().toISOString()
      );
    } catch (mappingsError) {
      // 如果device_mappings表不存在或插入失败，忽略错误
      console.warn('Failed to insert into device_mappings table:', mappingsError);
    }

    console.log(`为MAC地址 ${mac} 自动分配设备编号: ${nextDeviceNumber}`);

    return nextDeviceNumber;
  } catch (error) {
    console.error('Error auto-assigning device number:', error);
    throw error;
  }
}

// Get all device mappings
export async function getAllDeviceMappings(): Promise<DeviceMapping[]> {
  const db = getDatabase();

  try {
    const rows = await db.all(`SELECT * FROM device_mapping`);

    return rows.map(row => ({
      mac: row.mac || row.uid, // 使用mac字段，如果没有则回退到uid
      deviceNumber: row.device_number,
      createdAt: new Date(row.created_at)
    }));
  } catch (error) {
    console.error('Error getting all device mappings:', error);
    throw error;
  }
}

// Process test data (统一的测试数据处理函数)
export async function processTestData(
  mac: string,
  hexValues: string[],
  testType: 'F1' | 'F2'
): Promise<ProcessedData> {
  try {
    // 检查最小数据长度
    if (hexValues.length < 6) {
      return {
        success: false,
        error: `Insufficient data: got ${hexValues.length}, need at least 6`
      };
    }

    // 解析电压 (2 bytes, big endian)
    const voltageHigh = parseInt(hexValues[0], 16);
    const voltageLow = parseInt(hexValues[1], 16);
    const voltage = (voltageHigh << 8) | voltageLow;

    console.log(`📊 电压解析: ${hexValues[0]} ${hexValues[1]} -> ${voltage}mV`);

    // 解析R1阻抗 (2 bytes)
    const r1High = parseInt(hexValues[2], 16);
    const r1Low = parseInt(hexValues[3], 16);
    const r1 = (r1High << 8) | r1Low;

    // 解析R2阻抗 (2 bytes)
    const r2High = parseInt(hexValues[4], 16);
    const r2Low = parseInt(hexValues[5], 16);
    const r2 = (r2High << 8) | r2Low;

    // 解析R3阻抗 (如果有足够数据)
    let r3 = 0;
    if (hexValues.length >= 8) {
      const r3High = parseInt(hexValues[6], 16);
      const r3Low = parseInt(hexValues[7], 16);
      r3 = (r3High << 8) | r3Low;
    }

    console.log(`⚡ 阻抗解析: R1=${r1}μΩ, R2=${r2}μΩ, R3=${r3}μΩ`);

    console.log(`Processed ${testType} test data from ${mac}:`, {
      voltage: `${voltage}mV`,
      r1: `${r1}μΩ`,
      r2: `${r2}μΩ`,
      r3: `${r3}μΩ`
    });

    return {
      success: true,
      data: {
        mac,
        ip_prefix: (mac && mac.includes('_')) ? mac.split('_')[0] : mac,
        device_address: (mac && mac.includes('_')) ? mac.split('_')[1] : undefined,
        voltage,
        r1: { value: r1, power: 0, actual: r1 },
        r2: { value: r2, power: 0, actual: r2 },
        r3: { value: r3, power: 0, actual: r3 },
        rOhm: r1,
        rSei: r2,
        rCt: r3,
        testType: testType === 'F2' ? FrameType.FastTest : FrameType.CyclicTest,
        timestamp: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error('Error processing test data:', error);
    return {
      success: false,
      error: `Processing error: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

// 保持向后兼容的函数
export async function processHighAndLowFrequencyData(
  mac: string,
  hexValues: string[]
): Promise<ProcessedData> {
  return processTestData(mac, hexValues, 'F1');
}

// 保持向后兼容的函数
export async function processHighFrequencyData(
  mac: string,
  hexValues: string[]
): Promise<ProcessedData> {
  return processTestData(mac, hexValues, 'F2');
}

// 保持向后兼容的函数
export async function processLowFrequencyData(
  mac: string,
  hexValues: string[]
): Promise<ProcessedData> {
  return processTestData(mac, hexValues, 'F1');
}

// Process device detection response (05 frame)
export async function processDeviceDetectionResponse(
  uid: string,
  hexValues: string[]
): Promise<ProcessedData> {
  try {
    // 检查数据长度：帧头(1) + UID(12) + 帧尾(1) = 14
    if (hexValues.length < 14) {
      return {
        success: false,
        error: `Insufficient data for device detection frame: got ${hexValues.length}, need 14`
      };
    }

    // 检查帧头
    if (hexValues[0] !== '05') {
      return {
        success: false,
        error: `Invalid frame header: ${hexValues[0]}, expected 05`
      };
    }

    // 检查帧尾
    if (hexValues[hexValues.length - 1] !== '7e' && hexValues[hexValues.length - 1] !== '7E') {
      return {
        success: false,
        error: `Invalid frame footer: ${hexValues[hexValues.length - 1]}, expected 7E`
      };
    }

    // 提取UID (12字节，从索引1到12)
    // 根据您的描述：05 01 01 01 01 01 01 01 01 01 01 01 01 7E
    // 帧头(05) + 12字节UID + 帧尾(7E)
    const uidBytes = hexValues.slice(1, 13);
    const extractedUid = uidBytes.join('').toUpperCase();

    console.log(`处理设备检测响应帧，从 ${uid} 收到:`, {
      原始数据: hexValues.join(' '),
      提取的UID: extractedUid
    });

    return {
      success: true,
      data: {
        mac: uid, // 使用传入的设备标识符作为MAC
        rOhm: 0,
        rSei: 0,
        rCt: 0,
        voltage: 0,
        testType: FrameType.DeviceAddResponse,
        timestamp: new Date().toISOString() // 使用系统真实时间
      }
    };
  } catch (error) {
    console.error('Error processing device detection response:', error);
    return {
      success: false,
      error: `Failed to process device detection response: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// 获取所有电池数据
export const getBatteryData = async (testType?: FrameType) => {
  try {
    const db = await getDatabase();
    // 根据测试类型决定是否过滤dataready
    // 快速测试模式：只显示dataready=1的数据
    // 周期测试模式：显示所有数据包括dataready=0的数据
    let query = 'SELECT * FROM battery_data';
    if (testType === FrameType.FastTest) {
      query += ' WHERE dataready = 1';
    }
    query += ' ORDER BY timestamp DESC LIMIT 100';
    const rows = await db.all(query);

    // 映射数据库字段到前端格式，支持新的r_ct、r_ohm、r_sei格式
    return rows.map(row => ({
      deviceNumber: row.device_number,
      mac: row.mac,
      // 新格式：r_ct、r_ohm、r_sei对象
      r_ct: row.r_ct ? { value: 0, power: 0, actual: row.r_ct } : undefined,
      r_ohm: row.r_ohm ? { value: 0, power: 0, actual: row.r_ohm } : undefined,
      r_sei: row.r_sei ? { value: 0, power: 0, actual: row.r_sei } : undefined,
      // 修改映射关系：r1→R_ohm，r2→R_sei，r3→R_ct
      r1: row.r_ohm ? { value: 0, power: 0, actual: row.r_ohm } : undefined,
      r2: row.r_sei ? { value: 0, power: 0, actual: row.r_sei } : undefined,
      r3: row.r_ct ? { value: 0, power: 0, actual: row.r_ct } : undefined,
      rOhm: row.r_ohm,
      rSei: row.r_sei,
      rCt: row.r_ct,
      voltage: row.voltage,
      testType: row.test_type,
      timestamp: row.timestamp
    }));
  } catch (error) {
    console.error('获取电池数据失败:', error);
    throw error;
  }
};

// 获取所有设备映射
export const getDeviceMappings = async () => {
  try {
    const db = await getDatabase();
    // 尝试从device_mappings表获取数据
    let mappings = await db.all('SELECT * FROM device_mappings ORDER BY create_time DESC');

    // 如果device_mappings表为空，尝试从device_mapping表获取
    if (mappings.length === 0) {
      mappings = await db.all('SELECT * FROM device_mapping ORDER BY created_at DESC');

      // 将数据从device_mapping复制到device_mappings
      if (mappings.length > 0) {
        console.log('从device_mapping表复制数据到device_mappings表');
        for (const mapping of mappings) {
          const macValue = mapping.mac || mapping.uid; // 使用mac字段，如果没有则使用uid
          await db.run(
            'INSERT OR REPLACE INTO device_mappings (uid, device_number, create_time) VALUES (?, ?, ?)',
            [macValue, mapping.device_number, mapping.created_at]
          );
        }
      }
    }

    return mappings.map(mapping => ({
      mac: mapping.mac || mapping.uid, // 优先使用mac字段，如果没有则使用uid
      deviceNumber: mapping.device_number,
      createTime: mapping.create_time || mapping.created_at
    }));
  } catch (error) {
    console.error('获取设备映射失败:', error);
    throw error;
  }
};

// 创建设备映射
export const createDeviceMapping = async (mac: string, deviceNumber: string) => {
  try {
    const db = await getDatabase();
    const now = new Date().toISOString();

    // 同时插入到两个表中以确保兼容性
    await db.run(
      'INSERT OR REPLACE INTO device_mappings (uid, device_number, create_time) VALUES (?, ?, ?)',
      [mac, deviceNumber, now]
    );

    await db.run(
      'INSERT OR REPLACE INTO device_mapping (mac, uid, device_number, created_at) VALUES (?, ?, ?, ?)',
      [mac, mac, deviceNumber, now]
    );

    return {
      mac,
      deviceNumber,
      createTime: now
    };
  } catch (error) {
    console.error('创建设备映射失败:', error);
    throw error;
  }
};

// 通过设备编号获取设备
export const getDeviceByNumber = async (deviceNumber: string) => {
  try {
    const db = await getDatabase();
    return await db.get('SELECT * FROM device_mappings WHERE device_number = ?', [deviceNumber]);
  } catch (error) {
    console.error('通过设备编号获取设备失败:', error);
    throw error;
  }
};

// 删除设备映射
export const deleteDeviceMapping = async (mac: string): Promise<boolean> => {
  try {
    const db = await getDatabase();

    // 从两个表中删除以确保兼容性，支持mac和uid字段
    const result1 = await db.run('DELETE FROM device_mappings WHERE uid = ?', [mac]);
    const result2 = await db.run('DELETE FROM device_mapping WHERE mac = ? OR uid = ?', [mac, mac]);

    // 如果任一表中有删除操作，则视为成功
    return (result1.changes !== undefined && result1.changes > 0) ||
      (result2.changes !== undefined && result2.changes > 0);
  } catch (error) {
    console.error('删除设备映射失败:', error);
    throw error;
  }
};

// 按MAC地址查询设备的所有测试数据
export const getBatteryDataByMac = async (
  mac: string,
  startDate?: string,
  endDate?: string,
  testType?: FrameType,
  deviceNumber?: string
): Promise<BatteryData[]> => {
  const db = getDatabase();

  try {
    let query = `
      SELECT bd.*
      FROM battery_data bd
    `;

    const params: any[] = [];
    let hasWhere = false;

    // 根据mac参数决定是否添加mac过滤条件
    if (mac !== 'all') {
      query += ' WHERE bd.mac = ?';
      params.push(mac);
      hasWhere = true;
    }

    // 如果提供设备号，则进一步筛选
    if (deviceNumber !== undefined && deviceNumber !== null && deviceNumber !== '') {
      if (hasWhere) {
        query += ' AND bd.device_number = ?';
      } else {
        query += ' WHERE bd.device_number = ?';
        hasWhere = true;
      }
      params.push(deviceNumber);
    }

    // 根据测试类型决定是否过滤dataready
    // 快速测试模式：只显示dataready=1的数据
    // 周期测试模式：显示所有数据包括dataready=0的数据
    if (testType === FrameType.FastTest) {
      if (hasWhere) {
        query += ' AND bd.dataready = 1';
      } else {
        query += ' WHERE bd.dataready = 1';
        hasWhere = true;
      }
    }

    // 添加时间范围过滤
    if (startDate) {
      if (hasWhere) {
        query += ' AND bd.timestamp >= ?';
      } else {
        query += ' WHERE bd.timestamp >= ?';
        hasWhere = true;
      }
      params.push(startDate);
    }

    if (endDate) {
      if (hasWhere) {
        query += ' AND bd.timestamp <= ?';
      } else {
        query += ' WHERE bd.timestamp <= ?';
        hasWhere = true;
      }
      params.push(endDate);
    }

    // 添加测试类型过滤
    if (testType !== undefined) {
      if (hasWhere) {
        query += ' AND bd.test_type = ?';
      } else {
        query += ' WHERE bd.test_type = ?';
        hasWhere = true;
      }
      params.push(testType);
    }

    query += ' ORDER BY bd.timestamp DESC';

    const rows = await db.all(query, ...params);

    return rows.map(row => ({
      deviceNumber: row.device_number,
      mac: row.mac,
      ip_prefix: row.ip_prefix,
      device_address: row.device_address,
      rOhm: row.r_ohm,
      rSei: row.r_sei,
      rCt: row.r_ct,
      voltage: row.voltage,
      testType: row.test_type,
      timestamp: new Date(row.timestamp)
    }));
  } catch (error) {
    console.error('Error getting battery data by MAC:', error);
    throw error;
  }
};

// 按IP查询设备的所有测试数据（不含时间/测试类型筛选）
export const getBatteryDataByIp = async (
  ip: string,
  deviceAddress?: string
): Promise<BatteryData[]> => {
  const db = getDatabase();
  try {
    let query = `
      SELECT bd.*
      FROM battery_data bd
      WHERE bd.ip_prefix = ?
    `;
    const params: any[] = [ip];

    if (deviceAddress !== undefined && deviceAddress !== null && deviceAddress !== '') {
      const addrPadded = String(deviceAddress).padStart(2, '0');
      const addrCompact = String(deviceAddress).replace(/^0+/, '');
      query += ' AND (bd.device_address = ? OR bd.device_address = ?)';
      params.push(addrPadded, addrCompact);
    }

    query += ' ORDER BY bd.timestamp DESC';

    const rows = await db.all(query, ...params);

    return rows.map(row => ({
      deviceNumber: row.device_number,
      mac: row.mac,
      ip_prefix: row.ip_prefix,
      device_address: row.device_address,
      rOhm: row.r_ohm,
      rSei: row.r_sei,
      rCt: row.r_ct,
      // 补充电池3和电池4的数据
      bat3_r1: { value: 0, power: 0, actual: row.bat3_r1 },
      bat3_r2: { value: 0, power: 0, actual: row.bat3_r2 },
      bat3_r3: { value: 0, power: 0, actual: row.bat3_r3 },
      bat4_r1: { value: 0, power: 0, actual: row.bat4_r1 },
      bat4_r2: { value: 0, power: 0, actual: row.bat4_r2 },
      bat4_r3: { value: 0, power: 0, actual: row.bat4_r3 },
      voltage: row.voltage,
      b2Voltage: row.b2_voltage,
      testType: row.test_type,
      timestamp: new Date(row.timestamp)
    }));
  } catch (error) {
    console.error('Error getting battery data by IP:', error);
    throw error;
  }
};

// 获取数据库中存在的所有IP列表（从battery_data.mac中提取）
export const getDistinctIpsFromBatteryData = async (): Promise<string[]> => {
  const db = getDatabase();
  try {
    const rows = await db.all(`SELECT DISTINCT ip_prefix AS ip FROM battery_data WHERE ip_prefix IS NOT NULL ORDER BY ip ASC`);
    return rows.map((r: any) => String(r.ip)).filter(Boolean);
  } catch (error) {
    console.error('Error getting distinct IPs from battery_data:', error);
    throw error;
  }
};

// 获取指定IP下的设备号列表
export const getDistinctDeviceAddressesByIp = async (ip: string): Promise<string[]> => {
  const db = getDatabase();
  try {
    const rows = await db.all(
      `SELECT DISTINCT device_address
       FROM battery_data
       WHERE ip_prefix = ?
         AND device_address IS NOT NULL
         AND TRIM(device_address) <> ''
       ORDER BY CAST(device_address AS INTEGER) ASC, device_address ASC`,
      ip
    );
    const normalized = rows
      .map((r: any) => String(r.device_address || '').trim())
      .filter(Boolean)
      .map((s: string) => Number(s))
      .filter((n: number) => Number.isFinite(n) && n >= 1 && n <= 128)
      .map((n: number) => String(n));
    // 去重后返回规范化设备地址（1-128）
    return Array.from(new Set(normalized));
  } catch (error) {
    console.error('Error getting distinct device addresses by IP:', error);
    throw error;
  }
};

// 导出数据为CSV格式
export const exportDataToCSV = async (
  mac: string,
  startDate?: string,
  endDate?: string,
  testType?: FrameType,
  deviceNumber?: string
): Promise<string> => {
  try {
    const data = await getBatteryDataByMac(mac, startDate, endDate, testType, deviceNumber);

    const headers = [
      '设备MAC',
      '设备编号',
      '时间戳',
      '测试类型',
      '电压(mV)',
      'Bat1 R1(μΩ)',
      'Bat1 R2(μΩ)',
      'Bat1 R3(μΩ)'
    ];

    const getTestTypeName = (type: FrameType): string => {
      switch (type) {
        case FrameType.CyclicTest: return '周期测试';
        case FrameType.FastTest: return '快速测试';
        case FrameType.DeviceAddResponse: return '设备检测';
        default: return '未知测试';
      }
    };

    // CSV字段值转义函数
    const escapeCSVField = (value: any): string => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      // 如果包含逗号、双引号或换行符，需要用双引号包围并转义内部双引号
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const csvRows = [
      headers.map(h => escapeCSVField(h)).join(','),
      ...data.map(row => [
        escapeCSVField(row.mac || ''),
        escapeCSVField(row.deviceNumber),
        escapeCSVField((() => {
          const date = new Date(row.timestamp || new Date());
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          const hours = String(date.getHours()).padStart(2, '0');
          const minutes = String(date.getMinutes()).padStart(2, '0');
          const seconds = String(date.getSeconds()).padStart(2, '0');
          const milliseconds = String(Math.floor(date.getMilliseconds() / 100)).padStart(1, '0');
          // 使用="..."格式，强制Excel将其识别为文本格式，不显示额外字符
          return `="${year}/${month}/${day} ${hours}:${minutes}:${seconds}.${milliseconds}"`;
        })()),
        escapeCSVField(getTestTypeName(row.testType)),
        escapeCSVField(row.voltage),
        escapeCSVField(row.r1?.actual || row.rOhm || ''),
        escapeCSVField(row.r2?.actual || row.rSei || ''),
        escapeCSVField(row.r3?.actual || row.rCt || '')
      ].join(','))
    ];

    return csvRows.join('\n');
  } catch (error) {
    console.error('Error exporting data to CSV:', error);
    throw error;
  }
};

// 导出数据为TXT格式
export const exportDataToTXT = async (
  mac: string,
  startDate?: string,
  endDate?: string,
  testType?: FrameType,
  deviceNumber?: string
): Promise<string> => {
  try {
    const data = await getBatteryDataByMac(mac, startDate, endDate, testType, deviceNumber);

    const getTestTypeName = (type: FrameType): string => {
      switch (type) {
        case FrameType.CyclicTest: return '周期测试';
        case FrameType.FastTest: return '快速测试';
        case FrameType.DeviceAddResponse: return '设备检测';
        default: return '未知测试';
      }
    };

    // 定义表格列标题
    const headers = [
      '设备MAC',
      '设备编号',
      '时间戳',
      '测试类型',
      '电压(mV)',
      'Bat1 R1(μΩ)',
      'Bat1 R2(μΩ)',
      'Bat1 R3(μΩ)'
    ];

    // 创建表格头部信息
    let txtContent = `绿耳电池阻抗测试上位机485 - 数据导出报告\r\n`;
    txtContent += `=========================================================\r\n`;
    txtContent += `设备MAC: ${mac}\r\n`;
    const exportTime = new Date();
    txtContent += `导出时间: ${exportTime.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Asia/Shanghai'
    }) + '.' + String(Math.floor(exportTime.getMilliseconds() / 100)).padStart(1, '0')}\r\n`;
    txtContent += `数据条数: ${data.length}\r\n`;
    txtContent += `=========================================================\r\n\r\n`;

    // 如果没有数据，直接返回
    if (data.length === 0) {
      txtContent += `暂无数据\r\n`;
      return txtContent;
    }

    // 创建表格标题行，使用制表符分隔
    txtContent += headers.join('\t') + '\r\n';

    // 添加分隔线
    txtContent += headers.map(() => '----------').join('\t') + '\r\n';

    // 添加数据行
    data.forEach(row => {
      const rowData = [
        row.mac || '',
        String(row.deviceNumber ?? ''),
        (() => {
          const date = new Date(row.timestamp || new Date());
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          const hours = String(date.getHours()).padStart(2, '0');
          const minutes = String(date.getMinutes()).padStart(2, '0');
          const seconds = String(date.getSeconds()).padStart(2, '0');
          const milliseconds = String(Math.floor(date.getMilliseconds() / 100)).padStart(1, '0');
          return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
        })(),
        getTestTypeName(row.testType),
        row.voltage.toString(),
        (row.r1?.actual || row.rOhm || '').toString(),
        (row.r2?.actual || row.rSei || '').toString(),
        (row.r3?.actual || row.rCt || '').toString()
      ];
      txtContent += rowData.join('\t') + '\r\n';
    });

    txtContent += `\r\n=========================================================\r\n`;
    txtContent += `导出完成，共 ${data.length} 条记录\r\n`;

    return txtContent;
  } catch (error) {
    console.error('Error exporting data to TXT:', error);
    throw error;
  }
};

// 新增：按IP导出为CSV（仅单设备/单IP，不包含时间与测试类型筛选）
export const exportDataToCSVByIp = async (
  ip: string,
  deviceAddress?: string
): Promise<string> => {
  try {
    const data = await getBatteryDataByIp(ip, deviceAddress);

    const headers = [
      'IP地址',
      '设备地址',
      '时间',
      '电池电压(mV)',
      'Bat1 R1(μΩ)',
      'Bat1 R2(μΩ)',
      'Bat1 R3(μΩ)'
    ];

    const escapeCSVField = (value: any): string => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const csvRows = [
      headers.map(h => escapeCSVField(h)).join(','),
      ...data.map(row => {
        const ipText = row.ip_prefix || ((row.mac || '').split('_')[0] || row.mac || '');
        const addrRaw = row.device_address || ((row.mac || '').split('_')[1] || '');
        const addrText = String(addrRaw).padStart(2, '0');
        const date = new Date(row.timestamp || new Date());
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        const deciMs = String(Math.floor(date.getMilliseconds() / 100)).padStart(1, '0');
        const ts = `="${year}/${month}/${day} ${hours}:${minutes}:${seconds}.${deciMs}"`;
        return [
          escapeCSVField(ipText),
          escapeCSVField(addrText),
          escapeCSVField(ts),
          escapeCSVField(row.voltage),
          escapeCSVField(row.r1?.actual || row.rOhm || ''),
          escapeCSVField(row.r2?.actual || row.rSei || ''),
          escapeCSVField(row.r3?.actual || row.rCt || '')
        ].join(',');
      })
    ];

    return csvRows.join('\n');
  } catch (error) {
    console.error('Error exporting data to CSV by IP:', error);
    throw error;
  }
};

// 新增：按IP导出为TXT（仅单设备/单IP，不包含时间与测试类型筛选）
export const exportDataToTXTByIp = async (
  ip: string,
  deviceAddress?: string
): Promise<string> => {
  try {
    const data = await getBatteryDataByIp(ip, deviceAddress);

    const headers = [
      'IP地址',
      '设备地址',
      '时间',
      '电池电压(mV)',
      'Bat1 R1(μΩ)',
      'Bat1 R2(μΩ)',
      'Bat1 R3(μΩ)'
    ];

    let txtContent = `绿耳电池阻抗测试上位机485 - 数据导出\r\n`;
    txtContent += `=========================================================\r\n`;
    txtContent += `导出范围: IP=${ip}${deviceAddress ? `, 设备地址=${deviceAddress}` : ''}\r\n`;
    const exportTime = new Date();
    txtContent += `导出时间: ${exportTime.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Asia/Shanghai'
    }) + '.' + String(Math.floor(exportTime.getMilliseconds() / 100)).padStart(1, '0')}\r\n`;
    txtContent += `数据条数: ${data.length}\r\n`;
    txtContent += `=========================================================\r\n\r\n`;

    if (data.length === 0) {
      txtContent += `暂无数据\r\n`;
      return txtContent;
    }

    txtContent += headers.join('\t') + '\r\n';
    txtContent += headers.map(() => '----------').join('\t') + '\r\n';

    data.forEach(row => {
      const ipText = row.ip_prefix || ((row.mac || '').split('_')[0] || row.mac || '');
      const addrRaw = row.device_address || ((row.mac || '').split('_')[1] || '');
      const addrText = String(addrRaw).padStart(2, '0');
      const date = new Date(row.timestamp || new Date());
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      const deciMs = String(Math.floor(date.getMilliseconds() / 100)).padStart(1, '0');
      const ts = `${year}/${month}/${day} ${hours}:${minutes}:${seconds}.${deciMs}`;
      const rowData = [
        ipText,
        String(addrText ?? ''),
        ts,
        row.voltage?.toString() ?? '',
        (row.r1?.actual || row.rOhm || '').toString(),
        (row.r2?.actual || row.rSei || '').toString(),
        (row.r3?.actual || row.rCt || '').toString()
      ];
      txtContent += rowData.join('\t') + '\r\n';
    });

    txtContent += `\r\n=========================================================\r\n`;
    txtContent += `导出完成，共 ${data.length} 条记录\r\n`;

    return txtContent;
  } catch (error) {
    console.error('Error exporting data to TXT by IP:', error);
    throw error;
  }
};

// 导出数据为Excel（xlsx）功能已移除
// export const exportDataToExcelByIp = async ...

// 导出数据为Excel（xlsx），按测试类型分Sheet
export const exportDataToExcelByIp = async (
  ip: string,
  deviceAddress?: string
): Promise<Buffer> => {
  try {
    const data = await getBatteryDataByIp(ip, deviceAddress);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'WebBattery System';
    workbook.lastModifiedBy = 'WebBattery System';
    workbook.created = new Date();
    workbook.modified = new Date();

    // 定义列头：与数据库字段保持一致，完整导出 Bat1/Bat3/Bat4 阻抗数据
    const columns = [
      { header: 'IP地址', key: 'ip', width: 15 },
      { header: '设备地址', key: 'addr', width: 10 },
      { header: '时间', key: 'time', width: 22 },
      { header: '电池电压(mV)', key: 'voltage', width: 15 },
      { header: 'Bat1 R1(μΩ)', key: 'r1', width: 15 },
      { header: 'Bat1 R2(μΩ)', key: 'r2', width: 15 },
      { header: 'Bat1 R3(μΩ)', key: 'r3', width: 15 },
      { header: 'Bat3 R1(μΩ)', key: 'bat3_r1', width: 15 },
      { header: 'Bat3 R2(μΩ)', key: 'bat3_r2', width: 15 },
      { header: 'Bat3 R3(μΩ)', key: 'bat3_r3', width: 15 },
      { header: 'Bat4 R1(μΩ)', key: 'bat4_r1', width: 15 },
      { header: 'Bat4 R2(μΩ)', key: 'bat4_r2', width: 15 },
      { header: 'Bat4 R3(μΩ)', key: 'bat4_r3', width: 15 }
    ];

    // 兼容两种字段形态：{ actual } 对象或直接数值
    const pickActual = (value: any): number | string => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') {
        if (value.actual !== undefined && value.actual !== null) return value.actual;
        if (value.value !== undefined && value.value !== null) return value.value;
        return '';
      }
      return value;
    };

    // 分组数据
    // F1: CyclicTest (0xAA)
    // F2: FastTest (0xFA)
    const f1Data = data.filter(row =>
      row.testType === FrameType.CyclicTest ||
      (row.testType as any) === 'CyclicTest' ||
      (row.testType as any) === 'F1' ||
      (row.testType as any) === 0xAA
    );

    const f2Data = data.filter(row =>
      row.testType === FrameType.FastTest ||
      (row.testType as any) === 'FastTest' ||
      (row.testType as any) === 'F2' ||
      (row.testType as any) === 0xFA
    );

    const otherData = data.filter(row => !f1Data.includes(row) && !f2Data.includes(row));

    // 创建 Sheet 的辅助函数
    const createSheet = (sheetName: string, rows: BatteryData[]) => {
      const sheet = workbook.addWorksheet(sheetName);
      sheet.columns = columns;

      // 设置表头样式
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

      rows.forEach(row => {
        const ipText = row.ip_prefix || ((row.mac || '').split('_')[0] || row.mac || '');
        const addrRaw = row.device_address || ((row.mac || '').split('_')[1] || '');
        const addrText = String(addrRaw).padStart(2, '0');
        const date = new Date(row.timestamp || new Date());

        // 格式化时间
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        const milliseconds = String(Math.floor(date.getMilliseconds() / 100)).padStart(1, '0');
        const timeStr = `${year}/${month}/${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;

        sheet.addRow({
          ip: ipText,
          addr: addrText,
          time: timeStr,
          voltage: row.voltage,
          r1: pickActual((row as any).r1 ?? row.rOhm),
          r2: pickActual((row as any).r2 ?? row.rSei),
          r3: pickActual((row as any).r3 ?? row.rCt),
          bat3_r1: pickActual((row as any).bat3_r1),
          bat3_r2: pickActual((row as any).bat3_r2),
          bat3_r3: pickActual((row as any).bat3_r3),
          bat4_r1: pickActual((row as any).bat4_r1),
          bat4_r2: pickActual((row as any).bat4_r2),
          bat4_r3: pickActual((row as any).bat4_r3)
        });
      });
    };

    // 始终创建两个主要 Sheet，即使没有数据
    createSheet('周期测试数据(F1)', f1Data);
    createSheet('快速测试数据(F2)', f2Data);

    if (otherData.length > 0) {
      createSheet('其他数据', otherData);
    }

    return await workbook.xlsx.writeBuffer() as unknown as Buffer;
  } catch (error) {
    console.error('Error exporting data to Excel:', error);
    throw error;
  }
};

// 获取设备的测试统计信息
export const getDeviceTestStatistics = async (mac: string): Promise<any> => {
  const db = getDatabase();

  try {
    const stats = await db.get(`
      SELECT 
        COUNT(*) as total_tests,
        COUNT(CASE WHEN test_type = ? THEN 1 END) as high_low_tests,
        COUNT(CASE WHEN test_type = ? THEN 1 END) as high_tests,
        MIN(timestamp) as first_test,
        MAX(timestamp) as last_test,
        AVG(voltage) as avg_voltage,
        AVG(r_ohm) as avg_r_ohm,
        AVG(r_sei) as avg_r_sei,
        AVG(r_ct) as avg_r_ct
      FROM battery_data bd
      WHERE bd.mac = ? AND bd.dataready = 1
    `,
      FrameType.CyclicTest,
      FrameType.FastTest,
      mac);

    return {
      totalTests: stats.total_tests || 0,
      highLowTests: stats.high_low_tests || 0,
      highTests: stats.high_tests || 0,
      firstTest: stats.first_test ? new Date(stats.first_test) : null,
      lastTest: stats.last_test ? new Date(stats.last_test) : null,
      avgVoltage: stats.avg_voltage ? Math.round(stats.avg_voltage * 100) / 100 : null,
      avgROhm: stats.avg_r_ohm ? Math.round(stats.avg_r_ohm * 100) / 100 : null,
      avgRSei: stats.avg_r_sei ? Math.round(stats.avg_r_sei * 100) / 100 : null,
      avgRCt: stats.avg_r_ct ? Math.round(stats.avg_r_ct * 100) / 100 : null
    };
  } catch (error) {
    console.error('Error getting device test statistics:', error);
    throw error;
  }
};

// 清空所有数据库数据
export const clearAllDatabaseData = async (): Promise<boolean> => {
  try {
    const db = getDatabase();

    // 清空所有主要数据表
    await db.run('DELETE FROM battery_data');
    await db.run('DELETE FROM device_mappings');
    await db.run('DELETE FROM device_mapping');

    console.log('所有数据库数据已清空');
    return true;
  } catch (error) {
    console.error('清空数据库数据失败:', error);
    throw error;
  }
};