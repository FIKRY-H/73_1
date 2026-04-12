// Convert hex string to byte array
export function hexStringToByteArray(hexString: string): number[] {
  const bytes: number[] = [];
  
  // Remove spaces and ensure even length
  const cleanedHexString = hexString.replace(/\s+/g, '');
  const paddedHexString = cleanedHexString.length % 2 === 0 
    ? cleanedHexString 
    : '0' + cleanedHexString;
  
  for (let i = 0; i < paddedHexString.length; i += 2) {
    bytes.push(parseInt(paddedHexString.substring(i, i + 2), 16));
  }
  
  return bytes;
}

// Convert byte array to hex string
export function byteArrayToHexString(bytes: number[]): string {
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join(' ');
}

// Check if a frame is valid
export function isValidFrame(frame: number[]): boolean {
  // Frame must have at least 3 bytes (header and command)
  if (frame.length < 3) {
    return false;
  }
  
  // First two bytes should be 0xFF (header)
  if (frame[0] !== 0xFF || frame[1] !== 0xFF) {
    return false;
  }
  
  // Check if frame has the expected length based on command type
  const command = frame[2];
  
  switch (command) {
    case 0x7A: // High and low frequency
      return frame.length >= 16;
    case 0x7B: // High frequency
      return frame.length >= 16;
    case 0x7C: // Low frequency
      return frame.length >= 16;
    default:
      // Unknown command type
      return false;
  }
}

// Extract client ID from socket
export function extractClientId(socket: any): string {
  try {
    const address = socket.handshake.address;
    const port = socket.handshake.port || socket.id.substring(0, 4);
    return `${address}:${port}`;
  } catch (error) {
    console.error('Error extracting client ID:', error);
    return socket.id;
  }
}

// Extract IP address from client ID
export function extractIpAddress(clientId: string): string {
  try {
    return clientId.split(':')[0];
  } catch (error) {
    console.error('Error extracting IP address:', error);
    return clientId;
  }
} 