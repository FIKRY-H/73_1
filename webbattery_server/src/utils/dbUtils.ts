import { getDatabase } from '../config/database';
import fs from 'fs';
import path from 'path';

// Export database to CSV file
export async function exportDatabaseToCSV(
  tableName: string, 
  outputPath: string
): Promise<string> {
  const db = getDatabase();
  
  try {
    // Get all rows from table
    const rows = await db.all(`SELECT * FROM ${tableName}`);
    
    if (rows.length === 0) {
      return `No data found in table ${tableName}`;
    }
    
    // Create CSV header
    const headers = Object.keys(rows[0]);
    let csvContent = headers.join(',') + '\n';
    
    // Add data rows
    rows.forEach(row => {
      const values = headers.map(header => {
        const value = row[header];
        
        // Handle different data types
        if (value === null || value === undefined) {
          return '';
        } else if (typeof value === 'string') {
          // Escape quotes and wrap in quotes
          return `"${value.replace(/"/g, '""')}"`;
        } else {
          return value;
        }
      });
      
      csvContent += values.join(',') + '\n';
    });
    
    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Write to file
    fs.writeFileSync(outputPath, csvContent);
    
    return `Exported ${rows.length} rows to ${outputPath}`;
  } catch (error) {
    console.error(`Error exporting ${tableName} to CSV:`, error);
    throw error;
  }
}

// Import data from CSV file
export async function importDataFromCSV(
  tableName: string, 
  filePath: string
): Promise<number> {
  const db = getDatabase();
  
  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    // Read file content
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
      return 0; // No data or only header
    }
    
    // Parse header
    const headers = lines[0].split(',').map(header => header.trim());
    
    // Begin transaction
    await db.run('BEGIN TRANSACTION');
    
    let importedRows = 0;
    
    // Process data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      
      // Parse CSV line (simple implementation, doesn't handle quoted values with commas)
      const values = parseCSVLine(line);
      
      if (values.length !== headers.length) {
        console.warn(`Skipping line ${i + 1}: column count mismatch`);
        continue;
      }
      
      // Create placeholders and parameters
      const placeholders = headers.map(() => '?').join(',');
      
      // Insert row
      await db.run(
        `INSERT INTO ${tableName} (${headers.join(',')}) VALUES (${placeholders})`,
        ...values
      );
      
      importedRows++;
    }
    
    // Commit transaction
    await db.run('COMMIT');
    
    return importedRows;
  } catch (error) {
    // Rollback on error
    try {
      await db.run('ROLLBACK');
    } catch (rollbackError) {
      console.error('Error during rollback:', rollbackError);
    }
    
    console.error(`Error importing data to ${tableName}:`, error);
    throw error;
  }
}

// 已移除：字符串形式的CSV导入函数（不再需要）

// Parse CSV line handling quoted values
function parseCSVLine(line: string): any[] {
  const values: any[] = [];
  let inQuotes = false;
  let currentValue = '';
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        // Escaped quote
        currentValue += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of value
      values.push(currentValue);
      currentValue = '';
    } else {
      // Add character to current value
      currentValue += char;
    }
  }
  
  // Add the last value
  values.push(currentValue);
  
  return values;
}

// Backup database
export async function backupDatabase(backupPath: string): Promise<string> {
  const db = getDatabase();
  
  try {
    // Ensure directory exists
    const dir = path.dirname(backupPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Get all tables
    const tables = await db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    
    // Create backup file
    const backupFile = fs.createWriteStream(backupPath);
    
    // Write schema and data for each table
    for (const table of tables) {
      const tableName = table.name;
      
      // Get table schema
      const schema = await db.get(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
        tableName
      );
      
      backupFile.write(`-- Table: ${tableName}\n`);
      backupFile.write(`${schema.sql};\n\n`);
      
      // Get table data
      const rows = await db.all(`SELECT * FROM ${tableName}`);
      
      if (rows.length > 0) {
        backupFile.write(`-- Data for table: ${tableName}\n`);
        
        for (const row of rows) {
          const columns = Object.keys(row).join(', ');
          const values = Object.values(row).map(value => {
            if (value === null) return 'NULL';
            if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
            return value;
          }).join(', ');
          
          backupFile.write(`INSERT INTO ${tableName} (${columns}) VALUES (${values});\n`);
        }
        
        backupFile.write('\n');
      }
    }
    
    backupFile.end();
    
    return `Database backed up to ${backupPath}`;
  } catch (error) {
    console.error('Error backing up database:', error);
    throw error;
  }
}