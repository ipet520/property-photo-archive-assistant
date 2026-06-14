import ArchiveForm from '../components/ArchiveForm.jsx';
import PhotoPreviewTable from '../components/PhotoPreviewTable.jsx';
import SceneHintBox from '../components/SceneHintBox.jsx';
import SmartAssistPanel from '../components/SmartAssistPanel.jsx';

export default function QuickArchivePage({ archiveState }) {
  const selectedCategoryConfig = archiveState.configs?.watermarkCategories?.[archiveState.form.watermarkCategory];

  return (
    <div className="page-stack">
      <section className="page-hero compact">
        <div>
          <p className="eyebrow">快速批量归档</p>
          <h1>同一批照片，一次填写，批量归档</h1>
          <p>适用于同一批照片属于同一项目、同一工作内容的快速归档场景。</p>
        </div>
      </section>

      <section className="path-grid">
        <div className="path-card">
          <span>照片文件夹</span>
          <strong>{archiveState.photoFolder || '尚未选择'}</strong>
          <div className="path-actions">
            <button onClick={archiveState.selectPhotoFolder}>选择照片文件夹</button>
            <button className="ghost" onClick={() => archiveState.useSavedPhotoFolder(archiveState.settings?.lastPhotoFolder)} disabled={!archiveState.settings?.lastPhotoFolder}>使用上次照片文件夹</button>
            <button className="ghost" onClick={() => archiveState.photoFolder && window.archiveAssistant.openPath(archiveState.photoFolder)} disabled={!archiveState.photoFolder}>打开当前照片文件夹</button>
          </div>
          <select className="path-select" value="" onChange={(event) => event.target.value && archiveState.useSavedPhotoFolder(event.target.value)}>
            <option value="">最近照片文件夹</option>
            {(archiveState.settings?.recentPhotoFolders || []).map((folderPath) => (
              <option key={folderPath} value={folderPath}>{folderPath}</option>
            ))}
          </select>
        </div>
        <div className="path-card">
          <span>归档根目录</span>
          <strong>{archiveState.archiveRoot || '尚未选择'}</strong>
          <div className="path-actions">
            <button onClick={archiveState.selectArchiveRoot} className="secondary">选择归档根目录</button>
            <button className="ghost" onClick={() => archiveState.useSavedArchiveRoot(archiveState.settings?.defaultArchiveRoot, '默认归档根目录')} disabled={!archiveState.settings?.defaultArchiveRoot}>使用默认归档根目录</button>
            <button className="ghost" onClick={() => archiveState.archiveRoot && window.archiveAssistant.openPath(archiveState.archiveRoot)} disabled={!archiveState.archiveRoot}>打开当前归档根目录</button>
            <button className="ghost" onClick={archiveState.setCurrentArchiveRootAsDefault} disabled={!archiveState.archiveRoot}>设为默认归档根目录</button>
          </div>
          <select className="path-select" value="" onChange={(event) => event.target.value && archiveState.useSavedArchiveRoot(event.target.value, '最近归档根目录')}>
            <option value="">最近归档根目录</option>
            {(archiveState.settings?.recentArchiveRoots || []).map((folderPath) => (
              <option key={folderPath} value={folderPath}>{folderPath}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="workspace-grid">
        <ArchiveForm configs={archiveState.configs} form={archiveState.form} updateForm={archiveState.updateForm} />
        <SceneHintBox form={archiveState.form} categoryConfig={selectedCategoryConfig} sceneExamples={archiveState.configs?.sceneExamples || []} />
      </section>

      <SmartAssistPanel
        configs={archiveState.configs}
        form={archiveState.form}
        updateForm={archiveState.updateForm}
        recentRecords={archiveState.recentRecords}
        onApplyScene={archiveState.applyScene}
        onApplyRecent={archiveState.applyRecentRecord}
        onClearRecent={archiveState.clearRecentRecordList}
      />

      <section className="action-strip">
        <button onClick={archiveState.scanPhotos} disabled={archiveState.isBusy || !archiveState.photoFolder}>扫描照片</button>
        <button onClick={archiveState.buildPreview} disabled={archiveState.isBusy || archiveState.photos.length === 0}>生成归档预览</button>
        <button onClick={archiveState.archivePhotos} disabled={archiveState.isBusy || archiveState.previewItems.length === 0} className="primary">确认归档</button>
        <button onClick={archiveState.openArchiveRoot} disabled={!archiveState.archiveRoot} className="ghost">打开归档文件夹</button>
        <button onClick={archiveState.openLedger} disabled={!archiveState.archiveRoot} className="ghost">打开照片台账</button>
      </section>

      <PhotoPreviewTable
        items={archiveState.previewItems}
        photos={archiveState.photos}
        photoStages={archiveState.configs?.photoStages || []}
        onChangeItem={archiveState.updatePreviewItem}
      />
    </div>
  );
}
