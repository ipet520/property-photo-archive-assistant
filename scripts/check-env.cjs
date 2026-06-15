const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function exists(file) {
  return fs.existsSync(path.join(process.cwd(), file));
}

let hasError = false;

function check(condition, okMessage, failMessage) {
  if (condition) {
    console.log(`✅ ${okMessage}`);
  } else {
    hasError = true;
    console.log(`❌ ${failMessage}`);
  }
}

console.log('\n=== 基础环境 ===');

const nodeVersion = process.version;
const npmVersion = run('npm -v');
const gitVersion = run('git --version');

console.log(`Node: ${nodeVersion}`);
console.log(`npm: ${npmVersion || '未检测到'}`);
console.log(`Git: ${gitVersion || '未检测到'}`);

check(/^v20\./.test(nodeVersion), 'Node 版本符合要求：20.x', '建议使用 Node.js 20 LTS');
check(Boolean(npmVersion), 'npm 可用', 'npm 不可用，请检查 Node.js 安装');
check(Boolean(gitVersion), 'Git 可用', 'Git 不可用，请安装 Git');

console.log('\n=== 项目文件 ===');

check(exists('package.json'), 'package.json 存在', '缺少 package.json');
check(exists('package-lock.json'), 'package-lock.json 存在', '缺少 package-lock.json');
check(exists('electron/main.cjs'), 'electron/main.cjs 存在', '缺少 electron/main.cjs');
check(exists('electron/preload.cjs'), 'electron/preload.cjs 存在', '缺少 electron/preload.cjs');
check(exists('src'), 'src 目录存在', '缺少 src 目录');

console.log('\n=== Electron 服务文件 ===');

check(
  exists('electron/services/archivePackageService.cjs'),
  '资料包导出服务文件存在',
  '缺少 electron/services/archivePackageService.cjs'
);

console.log('\n=== 依赖状态 ===');

check(exists('node_modules'), 'node_modules 已存在', 'node_modules 不存在，请先运行 npm install');

console.log('\n=== Git 状态 ===');

const gitStatus = run('git status --short');

if (gitStatus === null) {
  console.log('⚠️ 当前目录可能不是 Git 仓库');
} else if (gitStatus.length === 0) {
  console.log('✅ Git 工作区干净');
} else {
  console.log('⚠️ Git 工作区存在未提交变更：');
  console.log(gitStatus);
}

if (hasError) {
  console.log('\n环境检查未完全通过，请先处理上面的 ❌ 项。');
  process.exit(1);
}

console.log('\n✅ 环境检查通过，可以继续开发、构建或交给 Codex。');