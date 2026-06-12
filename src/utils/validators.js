export function validateArchiveReady(form, photos, archiveRoot) {
  if (!archiveRoot) return { valid: false, message: '请先选择归档根目录。' };
  if (!photos.length) return { valid: false, message: '请先扫描照片。' };
  if (!form.location.trim()) return { valid: false, message: '请填写具体位置。' };
  if (!form.workItem.trim()) return { valid: false, message: '请填写工作事项。' };
  if (form.watermarkCategory === '时间地点水印' && !form.remark.trim()) {
    return { valid: false, message: '时间地点水印需要填写备注，说明处理动作或现场情况。' };
  }
  return { valid: true, message: '' };
}
