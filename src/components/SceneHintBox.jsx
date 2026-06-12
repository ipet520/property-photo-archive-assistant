export default function SceneHintBox({ form, categoryConfig, sceneExamples }) {
  const matchedScenes = sceneExamples.filter((scene) => scene.watermarkCategory === form.watermarkCategory).slice(0, 3);
  const isTimeLocation = form.watermarkCategory === '时间地点水印';
  const isEngineeringFallback = form.watermarkCategory === '工程类专用' && form.workContent === '公共设施设备维修';
  const isInspectionFallback = form.watermarkCategory === '巡查检查类' && form.workContent === '公共设施设备巡检';

  return (
    <aside className="panel hint-panel">
      <p className="eyebrow">归档提示</p>
      <h2>{form.watermarkCategory || '选择水印分类'}</h2>
      <p>{categoryConfig?.description || '选择分类后，这里会显示使用建议。'}</p>

      {isTimeLocation && (
        <div className="warning-box">请填写清楚工作事项、具体位置和备注，避免后期无法检索。</div>
      )}
      {isEngineeringFallback && <div className="warning-box">这是工程维修兜底项，适用于无法明确归入水电、土建、门窗、消防、电梯的公共设施设备维修。</div>}
      {isInspectionFallback && <div className="warning-box">这是巡查检查兜底项，适用于无法明确归入具体设备类别的公共设施设备巡查。</div>}

      <h3>常见场景</h3>
      {matchedScenes.length === 0 ? (
        <p className="muted">暂无匹配示例。</p>
      ) : (
        matchedScenes.map((scene) => (
          <div className="scene-card" key={scene.title}>
            <strong>{scene.title}</strong>
            <span>{scene.workContent}</span>
            <small>推荐关键词：{scene.keywords.join('、')}</small>
          </div>
        ))
      )}
    </aside>
  );
}
