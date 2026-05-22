import React, { useState } from 'react';
import { Box, Container, Tabs, Tab } from '@mui/material';
import DataDisplay from './components/DataDisplay';
// Settings组件已移除
import ConnectionStatus from './components/ConnectionStatus';
import DataQuery from './components/DataQuery';
import { SocketProvider } from './contexts/SocketContext';
import { BatteryDataProvider } from './contexts/BatteryDataContext';
import { FrameType } from './types/batteryTypes';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`simple-tabpanel-${index}`}
      aria-labelledby={`simple-tab-${index}`}
      style={{ display: value === index ? 'block' : 'none' }}
      {...other}
    >
      <Box sx={{ p: 3 }}>
        {children}
      </Box>
    </div>
  );
}

function App() {
  const [tabValue, setTabValue] = useState(0);
  const [displayMode, setDisplayMode] = useState<FrameType>(FrameType.CyclicTest);
  // 系统现在仅支持Modbus TCP协议

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  const handleDisplayModeChange = (mode: FrameType) => {
    setDisplayMode(mode);
  };

  // 协议模式切换功能已移除，系统仅支持Modbus TCP

  return (
    <SocketProvider>
      <BatteryDataProvider>
        <Box sx={{ flexGrow: 1 }}>
          <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
            <Tabs value={tabValue} onChange={handleTabChange} aria-label="基本选项卡示例">
              <Tab label="数据监控与Modbus管理" />
              <Tab label="数据查询" />
            </Tabs>
          </Box>
          <Container maxWidth="lg">
            <Box sx={{ mt: 2 }}>
              <ConnectionStatus />
            </Box>
            <TabPanel value={tabValue} index={0}>
              <DataDisplay displayMode={displayMode} onDisplayModeChange={handleDisplayModeChange} />
            </TabPanel>
            <TabPanel value={tabValue} index={1}>
              <DataQuery isVisible={tabValue === 1} />
            </TabPanel>
            {/* 系统设置页面已移除 */}
          </Container>
        </Box>
      </BatteryDataProvider>
    </SocketProvider >
  );
}

export default App;