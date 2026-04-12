import React from 'react';
import { Box, Button, Typography, CircularProgress } from '@mui/material';
import { useSocket } from '../contexts/SocketContext';

const ConnectionStatus: React.FC = () => {
  const { isConnected, reconnect } = useSocket();
  const [isReconnecting, setIsReconnecting] = React.useState(false);

  const handleReconnect = () => {
    setIsReconnecting(true);
    reconnect();
    
    // 3秒后重置状态
    setTimeout(() => {
      setIsReconnecting(false);
    }, 3000);
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <Box
          sx={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            bgcolor: isConnected ? 'success.main' : 'error.main',
            mr: 1
          }}
        />
        <Typography variant="body2">
          {isConnected ? '服务器连接正常' : '服务器连接断开'}
        </Typography>
      </Box>

      {!isConnected && (
        <Button
          variant="outlined"
          size="small"
          onClick={handleReconnect}
          disabled={isReconnecting}
          startIcon={isReconnecting ? <CircularProgress size={16} /> : null}
        >
          {isReconnecting ? '重连中...' : '重新连接'}
        </Button>
      )}
    </Box>
  );
};

export default ConnectionStatus;