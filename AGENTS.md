# AGENTS.md

## 项目名称

物业工作照片归档助手

## 技术栈

- Electron
- React
- Vite
- Node.js 20
- npm
- Windows 优先
- PowerShell 优先

## 项目定位

本项目用于物业场景下的马克水印相机工作照片归档。

核心功能：

1. 扫描照片文件夹。
2. 根据项目、部门、分类、工作内容、日期、位置、阶段、状态、关键词等字段生成归档信息。
3. 复制照片到规范目录。
4. 自动重命名照片。
5. 追加 Excel 台账。
6. 导出归档资料包。

## 稳定规则

- 不得删除用户原始照片。
- 不得移动用户原始照片。
- 不得压缩用户原始照片。
- 归档操作只允许复制。
- Excel 台账必须追加，不得覆盖旧数据。
- Electron 主进程文件使用 .cjs。
- Electron 服务层文件放在 electron/services/。
- 修改 IPC 时，必须同时检查 electron/main.cjs、electron/preload.cjs 和前端页面调用。

## 常用命令

```bash
npm install
npm run env:check
npm run build
npm run verify

开发前检查：

git status --short
npm run env:check

开发后检查：

npm run build

禁止行为：
不得擅自重构整个项目结构。
不得删除历史功能。
不得改动已稳定的归档规则。
不得引入大型 UI 框架。
不得把真实业主信息、本地隐私路径写入代码。