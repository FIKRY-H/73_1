// Server configuration
export const SERVER_CONFIG = {
  PORT: process.env.PORT || 8080,  // 统一使用8080端口，适合局域网应用
  HOST: process.env.HOST || '0.0.0.0'
};

// Database configuration
export const DB_CONFIG = {
  DB_PATH: process.env.DB_PATH || 'local_database.db'
};

// Socket configuration
export const SOCKET_CONFIG = {
  // Heartbeat interval in milliseconds (reduced from 5000 to 3000)
  HEARTBEAT_INTERVAL: 3000,
  
  // Connection timeout in milliseconds (reduced from 30 seconds to 15 seconds)
  CONNECTION_TIMEOUT: 15000,
  
  // Command timeout in milliseconds (reduced from 5 seconds to 3 seconds)
  COMMAND_TIMEOUT: 3000,
  
  // Maximum concurrent connections
  MAX_CONNECTIONS: 100,
  
  // Socket.io ping interval (ms)
  PING_INTERVAL: 2000,
  
  // Socket.io ping timeout (ms)
  PING_TIMEOUT: 5000
};



// Frame validation
export const FRAME_VALIDATION = {
  // Header bytes
  HEADER_BYTES: [0xFF, 0xFF],
  
  // Minimum frame length
  MIN_FRAME_LENGTH: 3,
  
  // Standard data frame length
  STANDARD_FRAME_LENGTH: 16
};