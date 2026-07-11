const fs = require('fs');
const path = require('path');

// Debug: parse a single CurseForge TOML
const filePath = 'C:\\Users\\fortn\\AppData\\Roaming\\PrismLauncher\\instances\\26.1.2 Hermes Please Help\\minecraft\\mods\\.index\\chat-heads.pw.toml';

const content = fs.readFileSync(filePath, 'utf-8');
console.log("=== RAW CONTENT ===");
console.log(content);
console.log("=== END RAW ===");

function parseTomlImproved(text) {
  const result = {};
  let currentKeys = []; // path of section keys
  const lines = text.split('\n');
  
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    
    // Section header
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentKeys = sectionMatch[1].split('.');
      continue;
    }
    
    // Key-value
    const kv = line.match(/^(\w[\w.-]*)\s*=\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
      if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
        val = val.slice(1, -1);
      }
      
      if (currentKeys.length === 0) {
        result[kv[1]] = val;
      } else {
        // Navigate to nested section
        let obj = result;
        for (const key of currentKeys) {
          if (!obj[key]) obj[key] = {};
          obj = obj[key];
        }
        obj[kv[1]] = val;
      }
    }
  }
  return result;
}

const parsed = parseTomlImproved(content);
console.log("=== PARSED ===");
console.log(JSON.stringify(parsed, null, 2));
