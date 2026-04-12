import { exec } from 'child_process';
import { getLocalNetworkInterfaces } from './arpUtils';

export interface PingResult {
  ip: string;
  isReachable: boolean;
  responseTime?: number;
  error?: string;
  sequence?: number; // 用于单IP轮询检测的序列号
}

/**
 * Ping单个IP地址（优化版本，减少数据包数量）
 * @param ip IP地址
 * @param timeout 超时时间（毫秒）
 * @returns Promise<PingResult>
 */
export async function pingIP(ip: string, timeout: number = 1500): Promise<PingResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    // Windows使用ping命令，Linux/Mac使用ping命令
    // 优化：减少数据包大小和超时时间，提高检测速度
    const isWindows = process.platform === 'win32';
    const pingCommand = isWindows 
      ? `ping -n 1 -w ${timeout} -l 32 ${ip}` // 减少数据包大小到32字节
      : `ping -c 1 -W ${Math.ceil(timeout / 1000)} -s 32 ${ip}`; // 减少数据包大小到32字节
    
    exec(pingCommand, { timeout: timeout + 500 }, (error, stdout, stderr) => {
      const responseTime = Date.now() - startTime;
      
      if (error) {
        resolve({
          ip,
          isReachable: false,
          responseTime: responseTime,
          error: error.message
        });
      } else {
        // 检查ping输出是否表示成功
        const isReachable = isWindows 
          ? !stdout.includes('请求超时') && !stdout.includes('无法访问目标主机') && stdout.includes('TTL=')
          : stdout.includes('1 received') || stdout.includes('1 packets received');
        
        resolve({
          ip,
          isReachable,
          responseTime: responseTime
        });
      }
    });
  });
}

/**
 * 生成子网IP列表（限制扫描范围为192.168.1.2-192.168.1.15）
 * @param gateway 网关IP地址 (例如: 192.168.1.1)
 * @returns IP地址数组
 */
export function generateSubnetIPs(gateway: string): string[] {
  const parts = gateway.split('.');
  if (parts.length !== 4) {
    throw new Error('Invalid gateway IP format');
  }
  
  const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const ips: string[] = [];
  
  // 限制扫描范围为192.168.1.2到192.168.1.15
  // 这样可以减少扫描时间，专注于常用的设备IP范围
  const startIP = 2;
  const endIP = 15;
  
  for (let i = startIP; i <= endIP; i++) {
    ips.push(`${subnet}.${i}`);
  }
  
  console.log(`生成IP列表: ${subnet}.${startIP} 到 ${subnet}.${endIP}，共 ${ips.length} 个IP`);
  
  return ips;
}

/**
 * Ping指定网关的整个子网（优化版本）
 * @param gateway 网关IP地址
 * @param concurrency 并发数量（提高默认并发数）
 * @param timeout 超时时间（减少默认超时时间）
 * @returns Promise<PingResult[]>
 */
export async function pingSubnet(
  gateway: string, 
  concurrency: number = 50, // 提高默认并发数
  timeout: number = 1500    // 减少默认超时时间
): Promise<PingResult[]> {
  const ips = generateSubnetIPs(gateway);
  const results: PingResult[] = [];
  
  console.log(`开始ping子网 ${gateway}，共 ${ips.length} 个IP，并发数: ${concurrency}，超时: ${timeout}ms`);
  
  // 分批处理，控制并发数量
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    const batchPromises = batch.map(ip => pingIP(ip, timeout));
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    // 输出进度
    const progress = Math.min(i + concurrency, ips.length);
    console.log(`子网 ${gateway} ping进度: ${progress}/${ips.length}`);
  }
  
  const reachableCount = results.filter(r => r.isReachable).length;
  console.log(`子网 ${gateway} ping完成，发现 ${reachableCount} 个可达设备`);
  
  return results;
}

/**
 * 自动发现本地网络的网关
 * @returns Promise<string[]> 网关IP列表
 */
export async function discoverLocalGateways(): Promise<string[]> {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  const gateways = new Set<string>();

  // 名称过滤：仅保留物理有线/无线接口，排除虚拟/桥接/VPN等
  const isAllowedInterfaceName = (name: string): boolean => {
    const n = (name || '').toLowerCase();
    const blocked = [
      'virtual', 'vmware', 'vethernet', 'hyper-v', 'loopback', 'docker',
      'bridge', 'tap', 'vpn', 'bluetooth'
    ];
    if (blocked.some(b => n.includes(b))) return false;

    const allowedHints = [
      // Windows常见
      'ethernet', 'wi-fi', 'wlan', 'lan', '以太网', '无线',
      // *nix常见前缀
      'eth', 'en', 'wlan', 'wl'
    ];
    return allowedHints.some(h => n.includes(h));
  };

  // 地址过滤：排除APIPA等非有效扫描地址
  const isAllowedIPv4Address = (ip: string): boolean => {
    if (!ip) return false;
    // 排除169.254.* 的链路本地地址
    if (ip.startsWith('169.254.')) return false;
    return true;
  };

  // 遍历所有网络接口
  for (const interfaceName in networkInterfaces) {
    const interfaces = networkInterfaces[interfaceName];
    if (!interfaces || !isAllowedInterfaceName(interfaceName)) continue;
    
    for (const iface of interfaces) {
      // 只处理IPv4地址，且不是回环地址，且地址有效
      if (iface.family === 'IPv4' && !iface.internal && isAllowedIPv4Address(iface.address)) {
        const ip = iface.address;
        const netmask = iface.netmask;
        
        // 计算网关地址（通常是网段的第一个地址）
        const ipParts = ip.split('.').map(Number);
        const maskParts = netmask.split('.').map(Number);
        
        // 计算网络地址
        const networkParts = ipParts.map((part: number, index: number) => part & maskParts[index]);
        
        // 网关通常是网络地址 + 1
        const gateway = `${networkParts[0]}.${networkParts[1]}.${networkParts[2]}.1`;
        
        // 验证网关是否在同一网段
        if (isInSameSubnet(ip, gateway, netmask)) {
          gateways.add(gateway);
        }
      }
    }
  }

  return Array.from(gateways);
}

/**
 * 检查两个IP是否在同一子网
 */
function isInSameSubnet(ip1: string, ip2: string, netmask: string): boolean {
  const ip1Parts = ip1.split('.').map(Number);
  const ip2Parts = ip2.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);

  for (let i = 0; i < 4; i++) {
    if ((ip1Parts[i] & maskParts[i]) !== (ip2Parts[i] & maskParts[i])) {
      return false;
    }
  }
  return true;
}

/**
 * 过滤ping结果，排除网关和本机IP，返回可连接的设备IP列表
 * @param pingResults ping结果数组
 * @param gateway 网关IP地址
 * @returns 可连接的设备IP列表
 */
export function filterConnectableDevices(pingResults: PingResult[], gateway: string): string[] {
  // 获取本机网络接口IP地址
  const localInterfaces = getLocalNetworkInterfaces();
  const localIPs = new Set(localInterfaces.map(iface => iface.address));
  
  // 过滤条件：
  // 1. ping成功的IP
  // 2. 不是网关IP
  // 3. 不是本机IP
  // 4. 不是广播地址（.255）
  // 5. 不是网络地址（.0）
  return pingResults
    .filter(result => {
      if (!result.isReachable) return false;
      if (result.ip === gateway) return false;
      if (localIPs.has(result.ip)) return false;
      
      // 检查是否为广播地址或网络地址
      const lastOctet = parseInt(result.ip.split('.')[3]);
      if (lastOctet === 0 || lastOctet === 255) return false;
      
      return true;
    })
    .map(result => result.ip);
}

/**
 * 从ping结果中提取所有可连接的设备IP（排除网关和本机）
 * @param subnetResults 子网ping结果数组
 * @returns 按网关分组的可连接设备IP列表
 */
export function extractConnectableDevices(
  subnetResults: Array<{ gateway: string; results: PingResult[] }>
): Array<{ gateway: string; connectableIPs: string[] }> {
  return subnetResults.map(subnetResult => ({
    gateway: subnetResult.gateway,
    connectableIPs: filterConnectableDevices(subnetResult.results, subnetResult.gateway)
  }));
}

/**
 * 从连接列表中提取网关IP并ping对应子网
 * @param connections 连接列表
 * @param concurrency 并发数量
 * @param timeout 超时时间
 * @returns Promise<{ gateway: string, results: PingResult[] }[]>
 */
export async function pingConnectedGateways(
  connections: Array<{ host: string; isConnected: boolean }>,
  concurrency: number = 20,
  timeout: number = 3000
): Promise<Array<{ gateway: string; results: PingResult[] }>> {
  // 提取已连接设备的网关
  const gateways = new Set<string>();
  
  connections
    .filter(conn => conn.isConnected)
    .forEach(conn => {
      const parts = conn.host.split('.');
      if (parts.length === 4) {
        const gateway = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
        gateways.add(gateway);
      }
    });
  
  const results = [];
  
  for (const gateway of gateways) {
    try {
      const pingResults = await pingSubnet(gateway, concurrency, timeout);
      results.push({
        gateway,
        results: pingResults
      });
    } catch (error) {
      console.error(`Failed to ping subnet for gateway ${gateway}:`, error);
      results.push({
        gateway,
        results: []
      });
    }
  }
  
  return results;
}