import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

export interface ArpEntry {
  ip: string;
  mac: string;
  type: string;
}

export interface NetworkInterface {
  name: string;
  address: string;
  mac: string;
  family: string;
}

// 获取本机网络接口信息
export const getLocalNetworkInterfaces = (): NetworkInterface[] => {
  const interfaces = os.networkInterfaces();
  const result: NetworkInterface[] = [];
  
  for (const [name, ifaces] of Object.entries(interfaces)) {
    if (!ifaces) continue;
    
    for (const iface of ifaces) {
      // 只处理IPv4接口，且不是内部接口
      if (iface.family === 'IPv4' && !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        result.push({
          name,
          address: iface.address,
          mac: iface.mac.replace(/:/g, '').toUpperCase(),
          family: iface.family
        });
      }
    }
  }
  
  return result;
};

// 检查IP是否为本地地址
export const isLocalAddress = (ip: string): boolean => {
  if (!ip || ip === 'unknown') return false;
  
  // 清理IPv6前缀
  const cleanIp = ip.replace(/^::ffff:/, '');
  
  // 检查是否为回环地址
  if (cleanIp === '127.0.0.1' || cleanIp === 'localhost') {
    return true;
  }
  
  // 检查是否为本机IP
  const localInterfaces = getLocalNetworkInterfaces();
  return localInterfaces.some(iface => iface.address === cleanIp);
};

// 根据本地IP获取对应网卡的MAC地址
export const getLocalMacByIp = (ip: string): string | null => {
  const cleanIp = ip.replace(/^::ffff:/, '');
  
  // 如果是回环地址，返回第一个有效网卡的MAC
  if (cleanIp === '127.0.0.1' || cleanIp === 'localhost') {
    const interfaces = getLocalNetworkInterfaces();
    return interfaces.length > 0 ? interfaces[0].mac : null;
  }
  
  // 查找匹配IP的网卡
  const localInterfaces = getLocalNetworkInterfaces();
  const matchedInterface = localInterfaces.find(iface => iface.address === cleanIp);
  
  return matchedInterface ? matchedInterface.mac : null;
};

// 解析Windows ARP表输出
const parseWindowsArp = (output: string): ArpEntry[] => {
  const lines = output.split('\n');
  const entries: ArpEntry[] = [];
  
  for (const line of lines) {
    // Windows ARP输出格式: IP地址 物理地址 类型
    // 示例: 10.206.0.1            90-17-3f-23-23-01     动态
    // 使用更宽松的正则表达式匹配，忽略中文字符编码问题
    const trimmedLine = line.trim();
    
    // 查找IP地址模式
    const ipMatch = trimmedLine.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (!ipMatch) continue;
    
    // 查找MAC地址模式（Windows格式：aa-bb-cc-dd-ee-ff）
    const macMatch = trimmedLine.match(/([a-fA-F0-9]{2}-[a-fA-F0-9]{2}-[a-fA-F0-9]{2}-[a-fA-F0-9]{2}-[a-fA-F0-9]{2}-[a-fA-F0-9]{2})/);
    if (!macMatch) continue;
    
    const ip = ipMatch[1];
    const mac = macMatch[1];
    
    // 将Windows格式的MAC地址转换为标准格式
    const standardMac = mac.replace(/\-/g, '').toUpperCase();
    
    // 确定类型（根据IP地址判断，避免中文编码问题）
    let type = 'dynamic';
    if (ip.endsWith('.255') || ip === '255.255.255.255' || ip.startsWith('224.') || ip.startsWith('239.')) {
      type = 'static';
    }
    
    entries.push({
      ip,
      mac: standardMac,
      type
    });
  }
  
  return entries;
};

// 解析Linux ARP表输出
const parseLinuxArp = (output: string): ArpEntry[] => {
  const lines = output.split('\n');
  const entries: ArpEntry[] = [];
  
  for (const line of lines) {
    // Linux ARP输出格式: Address HWtype HWaddress Flags Mask Iface
    // 示例: 192.168.1.100 ether aa:bb:cc:dd:ee:ff C eth0
    const match = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+\w+\s+([a-fA-F0-9:]{17})\s+/);
    if (match) {
      const [, ip, mac] = match;
      // 将Linux格式的MAC地址转换为标准格式
      const standardMac = mac.replace(/:/g, '').toUpperCase();
      entries.push({
        ip,
        mac: standardMac,
        type: 'dynamic'
      });
    }
  }
  
  return entries;
};

// 获取完整ARP表
export const getArpTable = async (): Promise<ArpEntry[]> => {
  try {
    const platform = os.platform();
    let command: string;
    
    if (platform === 'win32') {
      command = 'arp -a';
    } else {
      command = 'arp -a';
    }
    
    const { stdout } = await execAsync(command);
    
    if (platform === 'win32') {
      return parseWindowsArp(stdout);
    } else {
      return parseLinuxArp(stdout);
    }
  } catch (error) {
    console.error('获取ARP表失败:', error);
    return [];
  }
};

// 根据IP地址查询MAC地址（支持本地地址）
export const getMacByIp = async (ip: string): Promise<string | null> => {
  try {
    // 首先检查是否为本地地址
    if (isLocalAddress(ip)) {
      const localMac = getLocalMacByIp(ip);
      if (localMac) {
        console.log(`🏠 检测到本地连接: ${ip} -> ${formatMacAddress(localMac)} (本机网卡)`);
        return localMac;
      }
    }
    
    // 如果不是本地地址，查询ARP表
    const arpTable = await getArpTable();
    const entry = arpTable.find(entry => entry.ip === ip);
    
    if (entry) {
      console.log(`🌐 ARP查询成功: ${ip} -> ${formatMacAddress(entry.mac)} (网络设备)`);
      return entry.mac;
    }
    
    console.log(`❌ 未找到MAC地址: ${ip} (不在ARP表中，且非本地地址)`);
    return null;
  } catch (error) {
    console.error(`查询IP ${ip} 的MAC地址失败:`, error);
    return null;
  }
};

// 批量查询多个IP的MAC地址
export const getMacsByIps = async (ips: string[]): Promise<Map<string, string>> => {
  try {
    const result = new Map<string, string>();
    
    // 先处理本地地址
    const localInterfaces = getLocalNetworkInterfaces();
    for (const ip of ips) {
      if (isLocalAddress(ip)) {
        const localMac = getLocalMacByIp(ip);
        if (localMac) {
          result.set(ip, localMac);
        }
      }
    }
    
    // 再查询ARP表处理远程地址
    const arpTable = await getArpTable();
    for (const ip of ips) {
      if (!result.has(ip)) { // 如果还没有找到（非本地地址）
        const entry = arpTable.find(entry => entry.ip === ip);
        if (entry) {
          result.set(ip, entry.mac);
        }
      }
    }
    
    return result;
  } catch (error) {
    console.error('批量查询MAC地址失败:', error);
    return new Map();
  }
};

// 格式化MAC地址显示
export const formatMacAddress = (mac: string): string => {
  if (!mac || mac.length !== 12) {
    return mac;
  }
  
  // 转换为 AA:BB:CC:DD:EE:FF 格式
  return mac.match(/.{2}/g)?.join(':') || mac;
};

// 验证MAC地址格式
export const isValidMac = (mac: string): boolean => {
  const cleanMac = mac.replace(/[:\-]/g, '');
  return /^[A-Fa-f0-9]{12}$/.test(cleanMac);
};

// 获取连接类型描述
export const getConnectionType = (ip: string, mac: string | null): string => {
  if (!mac) return '未知';
  
  if (isLocalAddress(ip)) {
    return '本地测试';
  }
  
  return '网络设备';
}; 