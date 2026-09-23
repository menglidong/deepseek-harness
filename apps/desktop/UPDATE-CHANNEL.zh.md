# Fork 轻量打包层 · Windows 更新通道

> 定位：本 fork 不改产品代码，只在上游之上做「构建 + 分发」薄层。
> 版本不手动 bump——上游合并进什么版本，构建就发布什么版本；
> 各机器应用内的「检查更新」在下次上游发版后自然可用。

## 更新链路

```
上游合并新版本 → GH Actions 构建（unsigned NSIS）
  → publish-qiniu.mjs 发布 4 个对象到七牛 CDN + 刷新 CDN 缓存
  → 各机器 app（构建时已烙入 feed 地址）检查 nightly.yml
  → 用户点「下载」→ 下载 NSIS → 点「安装」→ --updated 原地静默升级 → 自动重启
```

- feed 地址在**打包时**烙入 `resources/app-update.yml`（electron-builder `publish: generic`），运行时只认该文件。
- 策略门 `GET <CDN>/api/v0/check_client_update` 是七牛上的**静态 JSON**（`code:0` 无强更）；
  返回 200 而非 401，故 test 部署的飞书登录流永远不会触发（`authentication` 为 production 的 anonymous）。

## 薄层内容（上游同步后须核对/恢复这 6 处）

| # | 文件 | 内容 | 冲突恢复标记 |
|---|------|------|--------------|
| 1 | `scripts/electron-builder-config.mjs` | ~L76：`DSH_DESKTOP_UNSIGNED_UPDATE_FEED=1` 时 unsigned 构建烙入 feed | grep `DSH_DESKTOP_UNSIGNED_UPDATE_FEED` |
| 2 | `scripts/desktop-package-environment.mjs` | `.env.windows` 白名单 `SHARED_SETTING` / `AMBIENT_RELEASE_SETTING` 含 `UNSIGNED_UPDATE_FEED`（缺失会报 "unsupported setting"） | grep `UNSIGNED_UPDATE_FEED` |
| 3 | `scripts/desktop-auto-update-environment.mjs` | `resolveDesktopAutoUpdateConfig` 内 production origin 可被 `DOWNLOAD_PROD_ORIGIN` 覆盖（白名单本就预置该变量名，补丁只是让代码读它） | grep `DOWNLOAD_PROD_ORIGIN` |
| 4 | `.github/workflows/build-desktop-exe-win-x64-unsigned.yml` | settings 加 3 行（FEED=1 / 两个 origin 指向 `$CDN_HOST`）+ `Publish update feed to Qiniu` step | grep `publish-qiniu` |
| 5 | `scripts/publish-qiniu.mjs` | 版本双校验 → sha512/size → 生成 nightly.yml → 上传 4 对象（**不做 CDN 刷新**，用户决策 2026-09-22） | fork 新增文件，上游不会删 |
| 6 | `src/main.ts` | `dsh-app://` 协议处理补 `shell` host 分支（服务 `renderer/` 目录）——缺失时更新对话框页 404 → 透明覆盖层变隐形模态框卡死整个应用 | grep `hostname === 'shell'` |

补丁 1/2 均为**加法式**小改（env 门控 + 可选覆盖），不改变上游默认行为：
不设 `DSH_DESKTOP_UNSIGNED_UPDATE_FEED` 的构建行为与上游一致；
不设 `DOWNLOAD_PROD_ORIGIN` 时 production 仍指向 `download.deepseek.com`。

## 同步后核对清单

1. 上表 3 个 grep 标记仍在（`UNSIGNED_UPDATE_FEED` 同时覆盖表内 1、2 两文件）；缺失即按标记处重新应用（补丁极小）。
2. 触发一次构建验证整链：
   - GH 的 `Publish update feed to Qiniu` step 成功；
   - `https://<CDN_HOST>/dsh-desk/feeds/win-x64/nightly.yml` 返回 200 且版本 = 构建版本；
   - 装新 NSIS 后 `resources\app-update.yml` 存在且 `url` 指向自家 CDN。
3. 若上游改了 `electron-builder-config.mjs` 的结构（不只是加行），人工比对重放补丁 1/2 的**语义**（不是文本）。

## GH Secrets（repo 设置）

| Secret | 含义 |
|--------|------|
| `ACCESS_KEY` / `SECRET_KEY` | 七牛 AK/SK（需 Kodo 上传 + CDN 刷新权限） |
| `BUCKET_NAME` | Kodo 桶名，**必须公有读** |
| `CDN_HOST` | 加速域名（如 `updates.example.com`），HTTPS 已启用。纯域名最佳；误带 `https://` 前缀或尾部斜杠会自动剥离；**不要带路径**（会被拒绝） |

本桶在**华南（z2）**：publish step 已固定 `QINIU_ZONE: z2`（由 Qiniu "incorrect region, please use up-z2.qiniup.com" 报错确定）。迁移桶后如需改 zone，改这一行即可（可选值 z0|z1|z2|na0|as0）。

**CDN 刷新：不做**（用户决策 2026-09-22，脚本只上传）。代价：清单/策略是**同 key 覆盖**上传，边缘缓存未过期前客户端可能短暂看到旧清单。如需即时生效，改在七牛控制台「CDN → HTTP 响应头规则」给 `/dsh-desk/feeds/*` 与 `/api/v0/*` 配 `Cache-Control: no-store`（一次性配置，脚本零参与）。

## 七牛对象布局

```
<CDN_HOST>/
├── dsh-desk/feeds/win-x64/nightly.yml              版本清单（electron-updater generic 格式，绝对 URL）
├── dsh-desk/bin/win-x64/deepseek-harness-<ver>-win-x64.exe          NSIS 安装包
├── dsh-desk/bin/win-x64/deepseek-harness-<ver>-win-x64.exe.blockmap 差分块映射（electron-builder 生成时）
└── api/v0/check_client_update                       策略门静态 JSON
```

强制全机更新：把 `api/v0/check_client_update` 覆盖为
`{"code":40005,"data":{"show_content":{"title":"需要更新","detail":"…"},"desktop_app_link":"https://<CDN_HOST>/…"}}`
（`desktop_app_link` 必须在构建时 `allowedPageOrigins` 内，即自家域）。

## 验证记录

- 2026-07-21：本地探针通过（feed origin 覆盖、policy anonymous、无覆盖时回归原域名、nightly.yml 合法 YAML、`createElectronBuilderConfig` 输出 publish 配置正确）。
- 2026-09-22：首建 35752846884 在 Package step 失败——`.env.windows` 白名单拒绝 `DSH_DESKTOP_UNSIGNED_UPDATE_FEED`（漏了第 2 处补丁）。补白名单后本地探针（含负向 + 环境泄漏过滤）全绿。
- 2026-09-22：二建 35754348542 在 policy origin 校验失败——`CDN_HOST` secret 值带 scheme/路径，拼出的不是纯 HTTPS origin。全链加归一化（workflow 两个 step + `scripts/qiniu-host.mjs`：自动剥离 scheme/尾斜杠，路径仍明确报错），归一化用例探针全绿。
- 2026-09-22：三建 35755102344 打包通过（17 分钟），发布 step 死于 import 笔误（`createRequire` 属 `node:module`）；修后本地冒烟至上传边界全绿（假密钥被七牛 `401 bad token` 拒，证明链路通）。
- 2026-09-22：四建 35757644091 打包通过，发布 step 上传 293MB 后报 `incorrect region, please use up-z2.qiniup.com`——桶在 z2（华南）。publish step 固定 `QINIU_ZONE: z2`。
- 2026-09-22：五建 35761516420 **全链成功**（30 分钟）：4 对象上传（exe 307MB / blockmap / nightly.yml / 策略 JSON）+ CDN 刷新 200（配额 500/天）。AK 同时具备 Kodo 上传与 CDN 刷新权限，链路验证完毕。
- 2026-09-22（晚）：按用户决策**移除 CDN 刷新**（只上传）；同一发现域名 `qiniu.mldong.com` **尚未激活**——DNSPod 侧 CNAME 已配（→ qiniu.mldong.com.qiniudns.com），但 qiniudns.com 无 A 记录（AliDNS DoH 交叉验证 Status=3）。影响：直连下载与 App 内检查更新暂时不可达（检查静默降级，属预期行为），等七牛域名激活（证书签发/状态置为已生效）后自动恢复，无需重传。
- 2026-09-22（夜）：域名随后激活（CNAME 更新为 `qiniu-mldong-com-idvs1mw.qiniudns.com` 新目标，全链解析到 120.226.20.41，直连下载恢复）。用户报告**新构建**点「检查更新」模糊卡住（与早期登录冻结同款表象）。根因：`dsh-app://` 协议只服务 `app` host，`shell` host（更新对话框页 `update-dialog.html`）404 → 透明覆盖层无任何内容 + 主窗口 blur = 隐形模态框永久拦截输入。修：`src/main.ts` 协议处理加 `shell` 分支（`serveWebDocument` 服务 `renderer/`），本地测试 html/js/mandatory 均 200 + 缺失/穿越 404。因版本号不变（0.1.6-alpha.2），各机器需**手动重装**新构建（应用内不会提示同版本更新）。
