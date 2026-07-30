import { useEffect, useState } from 'react';
import { APP_NAME, VERSION_SUMMARY } from '../constants/app.js';
import appIconUrl from '../assets/app-icon.svg';

export default function HeaderBar({ archiveState }) {
  const archiveRoot = archiveState.runtimeConfiguration?.archiveRootDirectory || '';
  const activeProject = archiveState.activeProject;
  const [switching, setSwitching] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState('');
  const [switchError, setSwitchError] = useState('');

  useEffect(() => {
    if (!switching) setTargetProjectId('');
  }, [switching]);

  async function confirmProjectSwitch() {
    const target = archiveState.projectOptions.find((item) => item.id === targetProjectId);
    if (!target || !activeProject) return;
    if (!window.confirm(
      `即将从“${activeProject.projectName}”切换到“${target.name}”。\n当前项目工作台将先保存，切换后只显示目标项目数据。`
    )) return;
    const result = await archiveState.switchActiveProject(target.id);
    if (!result?.success) {
      setSwitchError(result?.message || '项目切换失败。');
      return;
    }
    setSwitchError('');
    setSwitching(false);
  }

  return (
    <header className="header-bar">
      <div className="brand-block">
        <img className="brand-mark" src={appIconUrl} alt="" aria-hidden="true" />
        <div>
          <strong>{APP_NAME}</strong>
          <small>{VERSION_SUMMARY}</small>
        </div>
      </div>
      <div className="header-current-path">
        <span>
          当前项目：<strong>{activeProject?.projectName || '未选择'}</strong>
          {activeProject && (
            <button type="button" onClick={() => setSwitching((value) => !value)}>
              切换项目
            </button>
          )}
        </span>
        {switching && (
          <span>
            <select
              aria-label="目标项目"
              value={targetProjectId}
              onChange={(event) => setTargetProjectId(event.target.value)}
            >
              <option value="">请选择目标项目</option>
              {archiveState.projectOptions
                .filter((item) => item.id !== activeProject?.projectId)
                .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <button type="button" disabled={!targetProjectId} onClick={confirmProjectSwitch}>确认切换</button>
            <button type="button" onClick={() => setSwitching(false)}>取消</button>
            {switchError && <small>{switchError}</small>}
          </span>
        )}
        <span>归档根目录：<strong title={archiveRoot}>{archiveRoot || '未设置'}</strong></span>
      </div>
    </header>
  );
}
