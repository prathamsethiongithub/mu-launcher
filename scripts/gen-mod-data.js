const fs = require('fs');
const data = JSON.parse(fs.readFileSync('tmp_mod_data_full.json', 'utf-8'));

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

let out = '// Auto-generated from Prism Launcher instance 26.1.2 Hermes Please Help\n';
out += '// Run: node scripts/extract-mods.js "<prism-instance-path>" | node scripts/gen-mod-data.js\n\n';
out += 'export interface ModEntry {\n';
out += '  filename: string;\n';
out += '  name: string;\n';
out += '  url: string;\n';
out += '  hash: string;\n';
out += '  hashFormat: string;\n';
out += '  source: string;\n';
out += '  type: "mod" | "resourcepack";\n';
out += '}\n\n';

out += 'export const MODS: ModEntry[] = [\n';
for (const m of data.mods) {
  out += `  { filename: \`${esc(m.filename)}\`, name: \`${esc(m.name)}\`, url: \`${esc(m.url)}\`, hash: \`${m.hash}\`, hashFormat: "${m.hashFormat}", source: "${m.source}", type: "mod" },\n`;
}
out += '];\n\n';

out += 'export const RESOURCE_PACKS: ModEntry[] = [\n';
for (const m of data.resourcepacks) {
  out += `  { filename: \`${esc(m.filename)}\`, name: \`${esc(m.name)}\`, url: \`${esc(m.url)}\`, hash: \`${m.hash}\`, hashFormat: "${m.hashFormat}", source: "${m.source}", type: "resourcepack" },\n`;
}
out += '];\n';

fs.writeFileSync('src/main/mod-data.ts', out);
console.log('Written src/main/mod-data.ts');
