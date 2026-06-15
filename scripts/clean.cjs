const fs = require('node:fs');
const path = require('node:path');

const targets = [
  'dist',
  'release',
  'out',
  '.vite',
  'node_modules/.vite'
];

for (const target of targets) {
  const fullPath = path.join(process.cwd(), target);
  if (fs.existsSync(fullPath)) {
    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`已清理：${target}`);
  }
}

console.log('清理完成。');