# Marki 真实照片接口契约审计

## 1. 审计范围

本报告仅研究 Marki 只读接口与照片身份，不修改产品运行时。审计基线为
`4522775fdebb5f6c5e56572f652defe90d37f7e7`，`origin/main` 固定为
`3992d0920b1cb05401ea6e51a0c7d31f50f8bb29`。

实际执行范围：

- Electron `31.7.7` 主进程；
- 现有 `markiCredentialService.cjs` 与 Windows `safeStorage`；
- `POST /marki/org/team`：1 次；
- `POST /marki/team/mem`：1 次；
- `POST /marki/moment`：5 次，其中 4 次为分页、1 次为 `markName` A/B；
- 候选照片只读 GET：20 次；
- 查询范围：北京时间 `2026-07-23 11:06:20` 至 `2026-07-26 11:06:20`；
- 唯一 moment 元数据：200 条；A/B 请求另返回相同的第一页 50 条；
- 照片样本：20 个 JPEG，全部位于仓库外临时证据目录。

没有执行导入、manifest、生命周期、批次、工作台、快照、OCR、归档或 Excel 操作。

关键结论标注规则：

- **代码证据**：仓库基线代码的静态事实；
- **接口证据**：本次真实只读响应；
- **文件证据**：下载样本的尺寸、大小、SHA-256 与像素比较；
- **置信等级**：高、中、低；
- **可进入生产**：是、有限、否。

## 2. 代码现状与待验证假设

| 假设 | 代码结论 | 真实接口结论 | 置信 | 可进入生产 |
| --- | --- | --- | --- | --- |
| `sanitizeMoment` 是严格有限字段白名单 | 已由代码确认 | 200 条原始记录恰好只有该 10 字段，没有发现被丢弃的额外字段 | 高 | 是，作为当前接口事实 |
| 会话 sourceKey 为 `marki_api:<orgId>:<momentId>` | 已由代码确认 | 10 组下载样本中两个实际文件均有不同 `moment.id` | 高 | 有限，见第 12 节 |
| 相同 sourceKey 时保留“水印等级”较高记录 | 已由代码确认 | 样本双版本的 ID 不同，因此未触发该分支 | 高 | 不能据此判断版本 |
| 导入只接受 `watermarked` | 已由代码确认 | 两个版本都带相同 `markName/content`，现有推断无法区分版本 | 高 | 否，当前判定依据错误 |
| 模板名称和图片版本混在同一筛选维度 | 已由代码确认 | `markName` 表现为模板信息，不是图片版本信息 | 高 | 否，应拆维度 |

代码风险假设的最终状态：

1. **已由代码确认**：有限字段 sanitize、momentId sourceKey、同 key 等级覆盖、
   仅 watermarked 导入、筛选维度混用。
2. **已由真实接口确认**：本次 moment 原始响应没有 sanitize 白名单之外字段；
   双文件使用不同 ID 和 URL；两侧 `markName/content` 相同。
3. **已被真实接口否定**：不能用 `markName` 是否存在判断图片是否带水印；
   不能把 `markName` 当图片版本字段。
4. **仍无法确认**：哪一个文件是水印版；ID 的跨长期稳定性；是否有未公开的配对接口。

## 3. 真实请求契约

### 团队

- 方法与路径：`POST /marki/org/team`
- body：无 body
- 响应顶层：`code`、`msg`、`traceId`、`data`
- `data`：`teamOrgList`
- 团队项字段：`teamId`、`teamName`、`createUID`、`manageUIDs`、`createTime`、
  `parentTeam`、`OrganizeId`
- 样本数量：3 个团队

### 成员

- 方法与路径：`POST /marki/team/mem`
- body：`teamId` 必填，`next` 可选
- 响应分页字段：`memberList`、`next`、`hasMore`、`regTotal`、`unRegTotal`、`total`
- 成员项原始字段：`uid`、`nickname`、`phone`、`joinTime`、`memberType`
- 样本数量：第一页 20 条
- 隐私处理：报告未保留昵称、手机号或任何成员字段值

### 照片

- 方法与路径：`POST /marki/moment`
- 业务 body：
  - `teamId`：可选正整数；
  - `uid`：可选正整数，使用时需同时提供 `teamId`；
  - `start`：必填，`yyyy-MM-dd HH:mm:ss`，UTC+8；
  - `end`：必填，`yyyy-MM-dd HH:mm:ss`，UTC+8；
  - `next`：可选分页游标；
  - `momType`：固定为 `1`。
- 本次没有发送 `needLargePageSize`。
- 响应分页字段：`momList`、`next`、`hasMore`。
- 实际单页数量：50。
- 四个分页响应均为 `hasMore=true` 且具有 `next`；达到 200 条审计上限后停止。
- `postTime`：200/200 均为安全整数和秒级数量级，并全部落入请求时间范围。

证据来源：接口证据，团队 1 次、成员 1 次、照片 5 次。置信等级高，可进入生产。

## 4. 原始响应字段矩阵

`/marki/moment` 在进入 `sanitizeMoment` 前的 200 条原始记录字段完全一致：

| 字段 | 类型 | 出现数 | 出现率 |
| --- | --- | ---: | ---: |
| `id` | string | 200 | 100% |
| `uid` | number | 200 | 100% |
| `teamId` | number | 200 | 100% |
| `url` | string | 200 | 100% |
| `momentType` | number | 200 | 100% |
| `content` | string | 200 | 100% |
| `markName` | string | 200 | 100% |
| `lng` | number | 200 | 100% |
| `lat` | number | 200 | 100% |
| `postTime` | number | 200 | 100% |

以下候选字段在 200 条记录中均为**接口未返回**：

- `markId`
- `watermarkId`
- `templateId`
- `isWatermarked`
- `hasWatermark`
- `watermarkStatus`
- `markStatus`
- `mediaId`
- `fileId`
- `assetId`
- `originalId`
- `originId`
- `parentId`
- `parentMomentId`
- `variantId`
- `version`
- `variantType`
- `imageVariant`

补充统计：

- 200 个脱敏 `id` 哈希均唯一；
- 200 个去查询参数 URL 路径哈希均唯一；
- 10 个拍摄人员哈希；
- 1 个团队哈希；
- 3 个 `markName` 哈希；
- 200/200 `markName` 非空；
- 200/200 经纬度存在；
- `content` 可提取字段标签，但报告不保存字段值。

证据来源：接口证据，样本 200。置信等级高；只足以描述当前接口，不足以保证未来不会新增字段。

## 5. 水印版与无水印版样本

### 候选发现

在首次查询的 200 条记录中，以相同 `uid + teamId + postTime + lng + lat` 聚合：

- 得到 83 个恰好包含两条记录的候选拍摄组；
- 83/83 的 `id` 不同；
- 83/83 的 URL 不同；
- 83/83 的原始 `content` 完全相同；
- 83/83 的 `markName` 完全相同且两侧均非空；
- 83/83 的 URL 扩展名和路径层级相同；
- 0/83 的 URL 路径出现可识别的 watermark/original/variant 语义。

该模式与“同次拍摄同时保存两个文件”高度一致。审计从得分最高的 10 组下载了 20 个文件。

### 真实文件矩阵

以下共同字段对 10 组均成立：

- `id是否相同=false`
- `URL哈希是否相同=false`
- `文件SHA是否相同=false`
- `postTime差值=0`
- `uid是否相同=true`
- `teamId是否相同=true`
- `经纬度是否相同=true`
- `content字段集合是否相同=true`
- `markName` 两侧均存在且相同
- 显式水印状态、模板 ID、水印 ID、媒体 ID、原图 ID、父记录 ID、版本字段：
  **接口未返回**
- 人工确认：`false`

| 候选 | A ID 哈希 | B ID 哈希 | A 尺寸/字节 | B 尺寸/字节 | 64×64 像素相似度 | 配对置信 |
| --- | --- | --- | --- | --- | ---: | --- |
| pair-001 | `b3cb12ad8b1d29d8` | `f8d0d6e1f6a9b381` | 3024×4032 / 6653395 | 3024×4032 / 5570885 | 0.984746 | 高 |
| pair-002 | `cf6d12e7bd8df0cd` | `2031e144099ffa7b` | 1920×2560 / 3539331 | 1920×2560 / 3980559 | 0.986391 | 高 |
| pair-003 | `9bb3b4d26190dcec` | `c6e43317acfbd60f` | 1920×2560 / 3505344 | 1920×2560 / 3929267 | 0.982707 | 高 |
| pair-004 | `cdee3d4fa59eb8a4` | `da20c474bb50f0cb` | 1920×2560 / 3592686 | 1920×2560 / 4034812 | 0.988572 | 高 |
| pair-005 | `8419fc8c7c8ffeac` | `47a793c711b1ce5d` | 1920×2560 / 3862439 | 1920×2560 / 4379312 | 0.988593 | 高 |
| pair-006 | `0a927a7fa91ce2ac` | `8b91282ad7829e92` | 1920×2560 / 3883151 | 1920×2560 / 4381572 | 0.984020 | 高 |
| pair-007 | `ed00264f4651b716` | `e2fad79b55f76fd4` | 1920×2560 / 3867533 | 1920×2560 / 4368481 | 0.982446 | 高 |
| pair-008 | `a07abee99f88a33b` | `b60531e063bb22a6` | 1920×2560 / 3395989 | 1920×2560 / 3825804 | 0.982101 | 高 |
| pair-009 | `ea625d55484efa52` | `b367e0bcd8baf7b3` | 1920×2560 / 3675889 | 1920×2560 / 4101671 | 0.987389 | 高 |
| pair-010 | `430d460691d4d5ef` | `bcc7621752781878` | 1920×2560 / 3900918 | 1920×2560 / 4375728 | 0.987525 | 高 |

结论：

- 已找到高置信的同次拍摄双文件候选，样本 10 组、20 个文件；
- 两个文件具有不同 `moment.id`、不同 URL、不同 SHA-256；
- API 没有提供哪一侧是水印版的可靠字段；
- 两侧 `markName/content` 相同，因此不能用这两个字段区分图片版本；
- 不能把 A 或 B 自动标记为 `watermarked` 或 `original_unwatermarked`。

“双文件属于同次拍摄”的置信等级高，可用于确认身份风险；“哪一侧是哪种版本”的置信等级低，不足以进入生产自动分类。

## 6. 服务端筛选 A/B 结果

只有原始响应真实出现的候选参数才发起 A/B 请求。

| 参数 | 是否发起 | HTTP/API code | 结果集合 | 结论 |
| --- | --- | --- | --- | --- |
| `markId` | 否 | 接口未返回候选值 | - | 未证明支持 |
| `watermarkId` | 否 | 接口未返回候选值 | - | 未证明支持 |
| `templateId` | 否 | 接口未返回候选值 | - | 未证明支持 |
| `markName` | 是 | 200 / 0 | 与基线 50 条完全相同，且并非全部匹配参数 | 参数被静默忽略或未证明支持 |
| `isWatermarked` | 否 | 接口未返回候选值 | - | 未证明支持 |
| `hasWatermark` | 否 | 接口未返回候选值 | - | 未证明支持 |
| `watermarkStatus` | 否 | 接口未返回候选值 | - | 未证明支持 |

服务端模板筛选：**不支持或未证明支持**。
服务端水印状态筛选：**不支持或未证明支持**。

证据来源：接口 A/B，样本为同一查询第一页 50 条。置信等级高；足以禁止把这些参数加入生产请求，不足以断言服务端永远没有其他未公开能力。

## 7. 照片身份与去重风险

真实证据表明：

1. 同一候选拍摄的两个实际 JPEG 使用不同 `moment.id`。
2. 两个文件的 URL 路径和 SHA-256 均不同。
3. `markName/content/postTime/uid/teamId/经纬度` 可以完全相同，不能单独作为文件身份。
4. API 没有返回 `mediaId`、`variantId`、`parentMomentId` 等更强身份字段。
5. URL 含短期查询参数，完整 URL 不能作为稳定身份。

因此，在本次样本中，`moment.id` 更接近“一个展示/媒体记录”，不是“一次拍摄”。当前
`marki_api:<orgId>:<momentId>` 不会合并这 10 组双文件。

仍有两个限制：

- 本次只证明同一审计窗口内重复请求集合稳定，未证明跨长期、迁移或服务端重建后的稳定性；
- 没有接口字段可自动建立两个版本之间的父子关系。

## 8. 当前代码中已证实的错误假设

1. **`markName` 非空等于图片带水印**
   错误。83 组双文件两侧的 `markName` 都非空且相同。

2. **`content` 可用于区分水印版与原图版**
   错误。83/83 候选组的原始 `content` 完全相同。

3. **图片版本状态可以和模板名称放在一个筛选枚举中**
   错误。真实证据表明模板与实际文件版本是两个独立问题。

4. **仅允许推断为 watermarked 就能排除无水印版本**
   错误。当前推断会把候选组两侧都视为 watermarked。

5. **服务端接受未知参数且 code=0 就表示筛选生效**
   错误。`markName` 请求 code=0，但返回集合没有变化。

证据来源：代码、接口 200 条、候选 83 组、文件 10 组。置信等级高，可进入下一阶段修复设计。

## 9. 当前代码中仍成立的设计

1. `momType=1` 固定查询照片，真实响应 `momentType` 均为数字照片类型。
2. start/end 使用 UTC+8 格式化字符串，`postTime` 为秒级时间戳。
3. 分页游标只应保留在主进程，响应真实具有 `next/hasMore`。
4. renderer 不应获得远程 URL、原始 content、orgId、签名或请求头。
5. `moment.id` 在当前样本中能够区分两个实际文件。
6. 生命周期状态应继续由本地 manifest/lifecycle 管理，而不是从 Marki 模板或版本推断。

证据来源：代码与真实接口。置信等级高，可继续保留。

## 10. 推荐产品数据模型

模板与图片版本必须拆为独立字段：

```text
templateIdentity:
  templateKey
  templateName
  evidence: marki_mark_name | structured_content | manual
  confidence

imageVariant:
  watermarked
  original_unwatermarked
  variant_unknown
  evidence
  confidence
```

本次接口能安全提供：

- `templateIdentity`：可由 `markName` 及结构化字段形成模板候选；
- `imageVariant`：只能是 `variant_unknown`；
- `momentIdentity`：使用 `moment.id`；
- `captureRelationship`：没有可靠接口字段，不自动建立。

不得：

- 用 `markName` 推断 `imageVariant`；
- 用 content 是否为空推断无水印；
- 用相同时间、地点直接写入永久配对关系；
- 把候选配对当作已确认父子关系。

## 11. 推荐筛选模型

查询页应拆为三个正交维度：

1. **业务水印模板**
   - 具体 `markName`/模板候选；
   - 模板未知。

2. **图片版本**
   - 已确认水印版；
   - 已确认无水印原图版；
   - 版本待确认。

3. **导入生命周期**
   - new；
   - discovered；
   - downloading；
   - download_failed；
   - imported。

当前服务端没有证明支持模板或版本筛选，第一阶段应在主进程可信会话中做本地安全摘要筛选。不能继续把具体模板、“无水印”和“状态待确认”放在同一个选项列表。

## 12. 推荐 sourceKey 模型

在给定方案中，当前唯一有真实证据支持的是：

```text
marki_api:<orgId>:<momentId>
```

理由：

- 一个实际文件对应一个不同 `moment.id`；
- 10/10 候选双文件没有发生 ID 合并；
- 200/200 ID 唯一；
- A/B 重复查询的第一页身份集合稳定；
- 没有 `variantId` 或 `mediaId` 可用；
- URL 查询参数不稳定，不能纳入主身份；
- 文件名、postTime 和经纬度都不足以唯一标识文件。

结论：当前 sourceKey 对本次样本是安全的，不会合并水印版/无水印版两个文件。置信等级中高，可有限进入生产；应保留遥测/迁移能力，以应对未来接口 ID 语义变化。

不推荐：

- `momentId:variantId`：接口未返回 variantId；
- `mediaId`：接口未返回；
- `momentId:urlHash`：URL 路径目前唯一，但没有稳定性契约；
- postTime 拼接：同次两个文件完全相同。

## 13. 无水印版本导入规则

不能继续统一拒绝所有非 watermarked，也不能把所有 unknown 自动批量导入。

推荐规则：

1. `watermarked`
   - 只有显式可信证据或人工确认后才进入该状态；
   - 可按普通选择导入。

2. `original_unwatermarked`
   - 只有显式可信证据或人工确认后才进入该状态；
   - 允许作为独立文件导入，保留独立 sourceKey。

3. `variant_unknown`
   - 本次真实接口的默认状态；
   - 不进入“全选全部版本”或自动批量选择；
   - 可以在受控本地预览/人工确认后选择；
   - 不因 `markName` 非空自动改为 watermarked。

4. 高置信候选双文件
   - 可以显示“疑似同次拍摄的两个版本”提示；
   - 不自动决定哪一个是水印版；
   - 不自动创建 `pairedSourceKey`；
   - 用户明确选择后仍分别按各自 momentId 导入。

## 14. 尚未确认的问题

1. 双文件中哪一侧是 watermarked，哪一侧是 original_unwatermarked。
2. `moment.id` 是否跨长期、账号迁移和服务端重建保持稳定。
3. 是否存在未公开的媒体详情或父子关系接口。
4. 图片像素差异能否形成足够可靠且可解释的本地版本分类器。
5. 其他组织、设备型号和 Marki 客户端版本是否返回不同字段。
6. URL 路径是否长期稳定；本报告不将其作为身份契约。
7. 服务端是否存在文档未覆盖的其他模板/版本筛选参数。

这些问题均不得靠现有样本猜测定版。

## 15. 下一阶段最小实施范围

下一阶段只建议：

1. 将可信查询摘要中的 `templateIdentity` 与 `imageVariant` 拆分。
2. 保留 `marki_api:<orgId>:<momentId>`，停止同 key “水印等级覆盖”对版本语义的推断。
3. 将 `markName` 仅作为模板候选，不再作为 watermarked 证据。
4. 查询筛选拆为模板、版本、生命周期三个维度。
5. 服务端请求不增加未经证明的模板/状态参数；必要筛选在主进程会话内完成。
6. `variant_unknown` 默认不参加批量全选，提供受控预览与人工确认。
7. 候选配对只作提示，不持久化伪造的 `captureGroupKey/parentMomentId/pairedSourceKey`。
8. 增加同一 momentId 重复查询、跨天查询与人工版本确认的模拟测试。

本报告不实施上述业务修改。

## 16. 证据目录与脱敏说明

开发版凭据路径：

`E:\Users\Administrator\Documents\物业工作照片归档助手\.runtime\userData\marki-credentials.json`

凭据文件存在且为普通文件。审计通过 Electron `31.7.7`、同一开发版
`user-data-dir`、现有 `loadMarkiCredentials()` 和 `safeStorage` 成功解密。解密结果只在内存中使用。

临时证据目录：

`C:\Users\ADMINI~1\AppData\Local\Temp\property-photo-marki-contract-audit-2026-07-26T03-06-19-884Z-1ccbcb97`

目录内容：

- `raw-responses/`：未脱敏原始响应和请求 body，不含请求头、key 或 sign；
- `photo-samples/`：20 个候选二进制样本；
- `sanitized-summary.json`：脱敏字段矩阵、哈希和配对结果；
- `member-supplement-sanitized.json`：成员响应字段矩阵，不含成员值；
- `audit-metadata.json`：证据用途与禁止提交说明。

Git 仅包含本报告和独立审计脚本。原始响应、照片、凭据、完整签名 URL、组织 ID、人员、小区、地址、备注值、请求头和签名均不进入 Git。

普通 Node 阻塞的真实原因不是“未配置”，而是普通 Node 不提供 Electron `safeStorage`，且独立脚本入口没有完整复现开发版 Electron 的项目身份与 Chromium userData 初始化。最终审计通过一次性 Electron preload 以真实项目身份运行，并精确阻止生产 `electron/main.cjs`、窗口和业务服务启动。

凭据与隐私检查：通过。组织 KEY 和完整签名 URL 从未输出到终端、脱敏摘要、报告或 Git 差异。

## 17. 开放接口 needMark 能力验证

### 背景与范围

用户通过浏览器抓包确认，Marki 管理后台内部接口使用：

- `needMark=0`：所有照片；
- `needMark=1`：有水印照片；
- `needMark=2`：无水印照片。

本节不推定内部接口与开放接口共享参数契约，而是直接验证开放接口
`POST /marki/moment`。

测试从上一轮真实证据中选择一组高置信双文件候选，并固定：

- 同一个 teamId；
- 同一个 uid；
- 北京时间 `2026-07-23 13:40:39` 至 `2026-07-23 13:50:39`；
- `momType=1`；
- 每组上限 200 条；
- 每组独立维护自己的 `next`；
- 不下载新照片。

teamId、uid 和 moment.id 在证据中只保存审计作用域哈希。

### 四组请求

| 组 | 请求差异 | 调用次数 | HTTP/API code | 记录数 | hasMore | 是否截断 |
| --- | --- | ---: | --- | ---: | --- | --- |
| A | 不传 `needMark` | 1 | 200 / 0 | 2 | false | 否 |
| B | `needMark=0` | 1 | 200 / 0 | 2 | false | 否 |
| C | `needMark=1` | 1 | 200 / 0 | 2 | false | 否 |
| D | `needMark=2` | 1 | 200 / 0 | 2 | false | 否 |

四组各自只需一页，因此没有后续 cursor，但分页状态和 cursor 容器彼此独立。

### 脱敏 ID 集合

四组返回的完整 ID 集合均为：

```text
hash:e4a618fe4dea53c6
hash:aa0d5ee6a840f4e3
```

集合关系：

- 不传参数 = `needMark=0`：true；
- 不传参数 = `needMark=1`：true；
- 不传参数 = `needMark=2`：true；
- `needMark=0` = `needMark=1`：true；
- `needMark=0` = `needMark=2`：true；
- `needMark=1` = `needMark=2`：true。

`needMark=1` 与 `needMark=2`：

- 交集数量：2；
- 是否互斥：false；
- 并集是否等于不传参数集合：true；
- 并集是否等于 `needMark=0` 集合：true。

并集相等不代表筛选成功，因为两个子集合本身都等于全集。

### 已知双文件候选分布

已知候选 A/B 具有：

- postTime 差值 0；
- uid 相同；
- teamId 相同；
- content 相同；
- markName 相同；
- 两个不同 moment.id。

分布结果：

| 请求组 | 候选 A | 候选 B |
| --- | --- | --- |
| 不传 `needMark` | 返回 | 返回 |
| `needMark=0` | 返回 | 返回 |
| `needMark=1` | 返回 | 返回 |
| `needMark=2` | 返回 | 返回 |

`needMark=1` 没有只返回其中一侧，`needMark=2` 也没有只返回另一侧。

### 结论

固定结论等级：**C. 被静默忽略**。

证据：

- 四组均返回 HTTP 200、API code 0；
- 四组完整 ID 集合完全相同；
- 结果未截断；
- 时间范围真实包含上一轮已验证的双文件候选；
- `needMark=1/2` 都返回候选两侧。

置信等级：高。样本范围为一个团队、一个人员、一个 10 分钟窗口、2 个已知候选记录。

是否足以进入正式产品实现：

- **不足以将 `needMark` 加入开放接口生产请求**；
- **足以明确禁止把后台内部接口参数直接复用到开放接口**；
- 产品仍应把模板、图片版本和导入生命周期拆成三个维度；
- 图片版本筛选仍需主进程可信数据、受控预览或人工确认，不能依赖开放接口 `needMark`。

补充证据文件：

`C:\Users\ADMINI~1\AppData\Local\Temp\property-photo-marki-contract-audit-2026-07-26T03-06-19-884Z-1ccbcb97\need-mark-sanitized.json`

本次新增真实调用仅为 4 次 `/marki/moment` POST；新增照片下载数为 0。未执行导入、OCR、工作台追加、归档或 Excel 写入。
