import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

// 扩展Process接口以支持pkg属性
declare global {
  namespace NodeJS {
    interface Process {
      pkg?: any;
    }
  }
}

// Database instance
let db: Database | null = null;

// Initialize database
export async function initializeDatabase(): Promise<void> {
  try {
    // Ensure data directory exists
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Open database connection
    db = await open({
      filename: path.join(dataDir, 'battery.db'),
      driver: sqlite3.Database
    });

    // Enable foreign keys
    await db.exec('PRAGMA foreign_keys = ON');

    // Create tables
    await createTables();

    // Migrate existing data to remove temperature and use MAC address
    await migrateDatabase();

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

// Create required tables
async function createTables(): Promise<void> {
  if (!db) throw new Error('Database not initialized');
  
  // Create device_mappings table (maps UID to device number)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS device_mappings (
      uid TEXT PRIMARY KEY,
      device_number TEXT NOT NULL,
      create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // For backward compatibility, keep uid field but also add mac field
  await db.exec(`
    CREATE TABLE IF NOT EXISTS device_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT,
      mac TEXT,
      device_number TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(mac),
      UNIQUE(uid)
    )
  `);

  // Create battery_data table without temperature, using MAC address
  await db.exec(`
    CREATE TABLE IF NOT EXISTS battery_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_number INTEGER NOT NULL,
      mac TEXT NOT NULL,
      ip_prefix TEXT,
      device_address TEXT,
      r_ohm INTEGER,
      r_sei INTEGER,
      r_ct INTEGER,
      bat3_r1 INTEGER,
      bat3_r2 INTEGER,
      bat3_r3 INTEGER,
      bat4_r1 INTEGER,
      bat4_r2 INTEGER,
      bat4_r3 INTEGER,
      voltage INTEGER,
      test_type INTEGER,
      dataready INTEGER DEFAULT 1,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add dataready column if it doesn't exist (for existing databases)
  try {
    await db.exec('ALTER TABLE battery_data ADD COLUMN dataready INTEGER DEFAULT 1');
    console.log('Added dataready column to battery_data table');
  } catch (error) {
    // Column already exists, ignore error
  }

  // Add new impedance columns if they don't exist
  const newColumns = ['bat3_r1', 'bat3_r2', 'bat3_r3', 'bat4_r1', 'bat4_r2', 'bat4_r3'];
  for (const col of newColumns) {
    try {
      await db.exec(`ALTER TABLE battery_data ADD COLUMN ${col} INTEGER`);
      console.log(`Added ${col} column to battery_data table`);
    } catch (error) {
      // Column already exists, ignore error
    }
  }



  // Create indexes for better performance
  await db.exec('CREATE INDEX IF NOT EXISTS idx_mac ON battery_data(mac)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_ip_prefix ON battery_data(ip_prefix)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_device_address ON battery_data(device_address)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_ip_dev ON battery_data(ip_prefix, device_address)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_timestamp ON battery_data(timestamp)');

  console.log('Database tables created successfully');
}

// Migrate existing database to remove temperature and use MAC address
async function migrateDatabase(): Promise<void> {
  if (!db) throw new Error('Database not initialized');
  
  try {
    // Check if tables exist and have data
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table'");
    const hasData = tables.length > 3; // More than just our created tables
    
    if (!hasData) {
      console.log('New installation detected, no data migration needed');
      return;
    }
    
    // Migrate battery_data table if it has old structure
    const batteryTableInfo = await db.all("PRAGMA table_info(battery_data)");
    const hasTemperature = batteryTableInfo.some(col => col.name === 'temperature');
    const hasUid = batteryTableInfo.some(col => col.name === 'uid');
    const hasMac = batteryTableInfo.some(col => col.name === 'mac');
    const hasIpPrefix = batteryTableInfo.some(col => col.name === 'ip_prefix');
    const hasDeviceAddress = batteryTableInfo.some(col => col.name === 'device_address');
    const hasBat3R1 = batteryTableInfo.some(col => col.name === 'bat3_r1');
    
    if (hasTemperature || (hasUid && !hasMac)) {
      console.log('Migrating battery_data table structure...');
      
      // Create new table structure without temperature, using MAC address
      await db.exec(`
        CREATE TABLE battery_data_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          device_number INTEGER NOT NULL,
          mac TEXT NOT NULL,
          ip_prefix TEXT,
          device_address TEXT,
          r_ohm INTEGER,
          r_sei INTEGER,
          r_ct INTEGER,
          b2_voltage INTEGER,
          voltage INTEGER,
          test_type INTEGER,
          dataready INTEGER DEFAULT 1,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Copy data from old table, converting uid to mac
      if (hasUid) {
        await db.exec(`
          INSERT INTO battery_data_new (id, device_number, mac, ip_prefix, device_address, r_ohm, r_sei, r_ct, b2_voltage, voltage, test_type, dataready, timestamp)
          SELECT id, device_number, uid,
                 CASE WHEN instr(uid, '_') > 0 THEN substr(uid, 1, instr(uid, '_') - 1) ELSE uid END AS ip_prefix,
                 CASE WHEN instr(uid, '_') > 0 THEN substr(uid, instr(uid, '_') + 1) ELSE NULL END AS device_address,
                 r_ohm, r_sei, r_ct, NULL, voltage, test_type, 1, timestamp 
          FROM battery_data
        `);
      }
      
      // Replace old table
      await db.exec('DROP TABLE battery_data');
      await db.exec('ALTER TABLE battery_data_new RENAME TO battery_data');
      
      // Create indices for better performance
      await db.exec('CREATE INDEX IF NOT EXISTS idx_mac ON battery_data(mac)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_ip_prefix ON battery_data(ip_prefix)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_device_address ON battery_data(device_address)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_ip_dev ON battery_data(ip_prefix, device_address)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_timestamp ON battery_data(timestamp)');
      
      console.log('Battery_data table migration completed');
    }

    // If table already has mac but lacks ip_prefix/device_address, add and backfill
    if (hasMac && (!hasIpPrefix || !hasDeviceAddress)) {
      console.log('Adding ip_prefix and device_address columns and backfilling from mac...');
      try {
        if (!hasIpPrefix) await db.exec('ALTER TABLE battery_data ADD COLUMN ip_prefix TEXT');
      } catch (e) { /* ignore */ }
      try {
        if (!hasDeviceAddress) await db.exec('ALTER TABLE battery_data ADD COLUMN device_address TEXT');
      } catch (e) { /* ignore */ }
      // Backfill values from mac
      await db.exec(`
        UPDATE battery_data
        SET ip_prefix = CASE WHEN instr(mac, '_') > 0 THEN substr(mac, 1, instr(mac, '_') - 1) ELSE mac END,
            device_address = CASE WHEN instr(mac, '_') > 0 THEN substr(mac, instr(mac, '_') + 1) ELSE NULL END
        WHERE mac IS NOT NULL AND (ip_prefix IS NULL OR device_address IS NULL)
      `);
      // Create indexes if missing
      await db.exec('CREATE INDEX IF NOT EXISTS idx_ip_prefix ON battery_data(ip_prefix)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_device_address ON battery_data(device_address)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_ip_dev ON battery_data(ip_prefix, device_address)');
      console.log('ip_prefix/device_address backfill completed');
    }

    // Add new impedance columns if missing
    if (!hasBat3R1) {
      console.log('Adding new impedance columns to battery_data...');
      const newColumns = ['bat3_r1', 'bat3_r2', 'bat3_r3', 'bat4_r1', 'bat4_r2', 'bat4_r3'];
      for (const col of newColumns) {
        try {
          await db.exec(`ALTER TABLE battery_data ADD COLUMN ${col} INTEGER`);
          console.log(`${col} column added`);
        } catch (e) {
          console.log(`${col} column already exists or failed to add, continuing...`);
        }
      }
    }
    
    // Clean up any old tables
    await db.exec('DROP TABLE IF EXISTS client_connections');
    
  } catch (error) {
    console.error('Error during database migration:', error);
    console.log('Continuing with fresh database setup...');
  }
}

// Get database instance
export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

// Close database connection
export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.close();
    console.log('Database connection closed');
  }
}