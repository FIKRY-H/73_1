import React, { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Grid,
  Alert,
  CircularProgress,
  TextField,
  MenuItem
} from '@mui/material';
// 移除连接状态依赖，导出功能仅依赖数据库
 

interface QueryParams {
  ip?: string;
  deviceAddress?: string;
}

interface DataQueryProps {
  isVisible?: boolean;
}

const DataQuery: React.FC<DataQueryProps> = ({ isVisible = true }) => {
  const [queryParams, setQueryParams] = useState<QueryParams>({
    ip: '',
    deviceAddress: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ipOptions, setIpOptions] = useState<string[]>([]);
  const [deviceAddressOptions, setDeviceAddressOptions] = useState<string[]>([]);
  
  
  

  const handleExport = async (format: 'xlsx' = 'xlsx') => {
    try {
      // 校验IP参数
      if (!queryParams.ip) {
        setError('缺少IP参数，请先选择IP地址');
        return;
      }

      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ format });
      if (queryParams.ip) params.append('ip', queryParams.ip);
      if (queryParams.deviceAddress) params.append('deviceAddress', queryParams.deviceAddress);

      const url = `/api/battery/export/ip?${params.toString()}`;
      
      const response = await fetch(url);
      
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const devText = queryParams.deviceAddress ? `_${queryParams.deviceAddress}` : '';
        a.download = `battery_data_${queryParams.ip}${devText}_${new Date().toISOString().slice(0, 10)}.${format}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      } else {
        const result = await response.json();
        setError(result.message || '导出失败');
      }
    } catch (err) {
      setError('导出请求失败');
      console.error('导出失败:', err);
    } finally {
      setLoading(false);
    }
  };

  // 移除测试状态监听，导出与选择不受测试/连接影响

  // 加载IP下拉选项
  useEffect(() => {
    let active = true;
    const loadIps = async () => {
      try {
        const res = await fetch('/api/battery/ips');
        const json = await res.json();
        const ips: string[] = (json?.success && Array.isArray(json?.ips)) ? json.ips : [];

        if (!active) return;
        setIpOptions(ips);
        // 自动选择首个可用IP，提升可用性
        if (!queryParams.ip && ips.length > 0) {
          setQueryParams(prev => ({ ...prev, ip: ips[0], deviceAddress: '' }));
        }
      } catch (e) {
        // 静默失败，不阻塞界面
      }
    };
    if (isVisible) {
      loadIps();
    }
    return () => { active = false; };
  }, [isVisible]);

  // 移除连接列表监听，仅依赖数据库下拉数据

  // 当IP变化时加载设备号下拉选项
  useEffect(() => {
    let active = true;
    const loadDeviceAddresses = async () => {
      if (!queryParams.ip) {
        setDeviceAddressOptions([]);
        return;
      }
      try {
        const res = await fetch(`/api/battery/device-addresses?ip=${encodeURIComponent(queryParams.ip)}`);
        const json = await res.json();
        if (!active) return;
        if (json?.success && Array.isArray(json?.deviceAddresses)) {
          setDeviceAddressOptions(json.deviceAddresses);
        } else {
          setDeviceAddressOptions([]);
        }
      } catch (e) {
        setDeviceAddressOptions([]);
      }
    };
    loadDeviceAddresses();
    return () => { active = false; };
  }, [queryParams.ip]);

  

  

  return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h5" gutterBottom>
          数据导出
        </Typography>

        {/* 查询条件 */}
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              导出条件
            </Typography>
            <Grid container spacing={2}>
              
              <Grid item xs={12} md={2.5}>
                <TextField
                  select
                  fullWidth
                  label="设备IP地址"
                  value={queryParams.ip || ''}
                  onChange={(e) => setQueryParams({ ...queryParams, ip: e.target.value, deviceAddress: '' })}
                  // 不依赖测试/连接状态
                  helperText={''}
                >
                  {ipOptions.length === 0 && (
                    <MenuItem value="">
                      <em>暂无IP数据</em>
                    </MenuItem>
                  )}
                  {ipOptions.map((ip) => (
                    <MenuItem key={ip} value={ip}>{ip}</MenuItem>
                  ))}
                </TextField>
              </Grid>
              
              
              <Grid item xs={12} md={2.0}>
                <TextField
                  select
                  fullWidth
                  label="设备地址"
                  value={queryParams.deviceAddress || ''}
                  onChange={(e) => setQueryParams({ ...queryParams, deviceAddress: e.target.value })}
                  disabled={!queryParams.ip}
                  helperText={!queryParams.ip ? '请选择IP后再选择设备地址' : ''}
                >
                  {/* 始终提供“全部设备”选项以导出该IP下所有记录 */}
                  <MenuItem value="">
                    <em>全部设备</em>
                  </MenuItem>
                  {deviceAddressOptions.map((addr) => (
                    <MenuItem key={addr} value={addr}>{String(addr)}</MenuItem>
                  ))}
                </TextField>
              </Grid>
              
            </Grid>
          </CardContent>
        </Card>

        {/* 操作按钮 */}
        <Box sx={{ mb: 3, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          
          <Button
            variant="contained"
            color="success"
            onClick={() => handleExport('xlsx')}
            disabled={loading || !queryParams.ip}
          >
            导出Excel (XLSX)
          </Button>
          
        </Box>

        

        {/* 错误提示 */}
        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {/* 加载指示器 */}
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 3 }}>
            <CircularProgress />
          </Box>
        )}

        

        
      </Box>
  );
};

export default DataQuery;