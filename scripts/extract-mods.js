const fs = require('fs');
const path = require('path');

const base = process.argv[2];
if (!base) { process.stderr.write('Need path arg\n'); process.exit(1); }

function parseToml(text) {
  const result = {};
  let currentKeys = [];
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentKeys = sectionMatch[1].split('.');
      continue;
    }
    const kv = line.match(/^(\w[\w.-]*)\s*=\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
      if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
        val = val.slice(1, -1);
      }
      if (currentKeys.length === 0) {
        result[kv[1]] = val;
      } else {
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

function curseForgeUrl(fileId, filename) {
  if (!fileId || !filename) return '';
  const prefix = Math.floor(fileId / 1000);
  const suffix = String(fileId % 1000).padStart(3, '0');
  return `https://mediafilez.forgecdn.net/files/${prefix}/${suffix}/${encodeURIComponent(filename)}`;
}

function extractFrom(dir, type) {
  const indexDir = path.join(base, dir, '.index');
  const items = [];
  if (!fs.existsSync(indexDir)) return items;
  const files = fs.readdirSync(indexDir);
  for (const f of files) {
    if (!f.endsWith('.pw.toml')) continue;
    const content = fs.readFileSync(path.join(indexDir, f), 'utf-8');
    const parsed = parseToml(content);
    const dl = parsed.download || {};
    const fileName = parsed.filename || f.replace('.pw.toml', '.jar');
    const modName = parsed.name || f.replace('.pw.toml', '');

    let source = 'unknown';
    let url = dl.url || '';
    let hash = dl.hash || '';
    let hashFormat = dl['hash-format'] || 'sha1';

    if (parsed.update && parsed.update.modrinth) {
      source = 'modrinth';
      if (!url) url = '';
    } else if (parsed.update && parsed.update.curseforge) {
      source = 'curseforge';
      const fileId = parseInt(parsed.update.curseforge['file-id'], 10);
      if (fileId && fileName) {
        url = curseForgeUrl(fileId, fileName);
      }
    }

    items.push({
      filename: fileName,
      name: modName,
      url: url,
      hash: hash,
      hashFormat: hashFormat,
      source: source,
      type: type
    });
  }
  return items;
}

const mods = extractFrom('mods', 'mod');
const rps = extractFrom('resourcepacks', 'resourcepack');
process.stdout.write(JSON.stringify({ mods, resourcepacks: rps }));
