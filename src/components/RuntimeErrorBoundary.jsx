import React from 'react';
import { recordRuntimeLog, serializeError } from '../utils/runtimeLogger.js';

export default class RuntimeErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    recordRuntimeLog({
      page: '全局页面',
      operation: 'React 渲染异常',
      errorType: 'React ErrorBoundary',
      summary: error?.message || 'React 页面渲染异常',
      technicalDetail: `${serializeError(error)}\n${info?.componentStack || ''}`
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="runtime-error-fallback">
          <h1>页面显示遇到问题</h1>
          <p>系统已自动记录运行日志。请尝试切换页面或重新打开软件，如仍无法恢复，请导出运行日志交给维护人员排查。</p>
        </div>
      );
    }
    return this.props.children;
  }
}
