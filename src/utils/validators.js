export function validateArchiveReady(form, photos, archiveRoot, photoFolder = '') {
  const requiredFields = [
    [photoFolder, '请先选择照片文件夹。'],
    [archiveRoot, '请先选择归档根目录。'],
    [form.project, '请选择项目。'],
    [form.department, '请选择部门。'],
    [form.watermarkCategory, '请选择水印分类。'],
    [form.workContent, '请选择工作内容。'],
    [form.date, '请选择日期。'],
    [form.location, '请填写具体位置。'],
    [form.workItem, '请填写工作事项。'],
    [form.photoStage, '请选择照片阶段。']
  ];

  const missing = requiredFields.find(([value]) => !String(value || '').trim());
  if (missing) return { valid: false, message: missing[1] };
  if (!photos.length) return { valid: false, message: '请先扫描照片。' };
  if (form.watermarkCategory === '时间地点水印' && !form.remark.trim()) {
    return { valid: false, message: '时间地点水印需要填写清楚工作事项、具体位置和备注，避免后期无法检索。' };
  }
  return { valid: true, message: '' };
}
