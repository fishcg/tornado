# Tornado App

Expo (React Native) 客户端，配合根目录后端 `tornado/server.js`（端口 3011）使用。

## 安装与启动

```bash
cd app
npm install
npx expo start --dev-client
```

第一次跑需要 EAS Build 出 Dev Client，因为依赖 `expo-secure-store` / `expo-audio` / `expo-notifications` 等原生模块：

```bash
npx eas-cli@latest build --profile development --platform ios
# 或 Android
npx eas-cli@latest build --profile development --platform android
```

## 配置 API 地址

`app.json` 里 `expo.extra.apiBaseUrl`。调试时改为电脑局域网 IP：

```json
"extra": {
  "apiBaseUrl": "http://192.168.1.10:3011"
}
```

> 生产构建前确认已改为实际服务器地址。

---

## 已实现功能

### 鉴权与账户
- 登录 / 注册（邀请码），Bearer token 存 `expo-secure-store`
- 启动自动水合 token，验证 `/auth/me`，未登录跳转登录页

### 聊天
- 会话列表 + 新建会话（按角色分组，展开/折叠）
- 文字流式收发（`react-native-sse`）
- 发送图片（拍照 / 相册选择，上传到服务端）
- 重新生成回复、长按删除消息
- 自动模式 + 半自动模式
- 旁白文字折叠开关

### 角色系统
- 创建 / 编辑 / 删除角色
- 激活角色（切换当前聊天对象）
- 角色卡片展示 + 重生成卡片图
- 情绪头像（多情绪独立头像，支持上传替换或 AI 重生成，批量一键重生成）
- 语音配音（上传音频克隆音色，支持多个 TTS 渠道）

### 心动值 & 情绪
- 心动值实时展示（数字 + 飘字动画 + 闪烁），页面跳转心动历程
- 情绪指示器（当前情绪色点 + 飘字标签，负面情绪抖动）
- 心动历程页：变化日志列表，带情绪标签和变化量

### 关系里程碑
- 关系阶段升级弹窗演出（卡片式，展示阶段名）
- 里程碑列表 + 详情页（漫画/视频两种展示形式）

### 成就
- 成就列表页（FlatList + 下拉刷新 + 进度条）
- 成就解锁弹窗（角色自拍 + 内心独白 + 动画演出）
- 成就详情页（大图 + 解锁时间 + 独白）

### 来电
- WebSocket 推送来电，全屏来电界面（系统电话风格 UI）
- 铃声播放（带电量/时间模拟）
- 接听 / 挂断，语音留言记录
- 未接听自动留语音留言，可回听

### 画廊
- 聊天中生成的场景插图自动汇集到画廊
- 大图浏览、保存到相册

### 版本更新
- 版本号统一走语义化，单一数据源 = `app.json` 的 `expo.version`（如 `0.2.0`）
- 启动时请求 `GET /app/latest-version`，语义化比较，可选 / 强制更新弹窗
- 所有 API 请求带 UA（`tornadoApp/<version> (<os> <osVersion>)`），服务端中间件拦截过低版本（426）
- 强制更新时全屏 Modal 挡住使用，点击跳转下载

### 全局通知
- WebSocket 全局监听（跨会话），接收主动消息、来电等
- 本地通知推送（`expo-notifications`），点击通知跳转对应聊天

---

## 打包与发布

项目使用 EAS Build，配置文件 `eas.json` 包含三个 profile：

| Profile | 用途 | 分发方式 | channel |
|---------|------|---------|---------|
| `development` | 本地调试 | 内部分发（Dev Client） | — |
| `preview` | 内部测试 | 内部分发（APK/IPA 直链） | `preview` |
| `production` | 正式发布 | 应用商店 / 直链 | `production` |

### Android

```bash
# 内部测试包（APK）
npx eas build --profile preview --platform android

# 正式发布包（AAB/APK，autoIncrement 自动递增原生 versionCode）
npx eas build --profile production --platform android
```

构建完成后会得到安装包下载链接。将 APK 上传到后台「App 版本」板块即可发布更新。

### iOS

```bash
# 开发调试（Simulator）
npx eas build --profile development --platform ios

# 正式发布（需 Apple Developer 账号，走 TestFlight / App Store）
npx eas build --profile production --platform ios
npx eas submit --platform ios
```

> iOS 构建需要在 Apple Developer 后台配置好 bundleIdentifier（`com.tornado.app`）和证书。

### 不依赖 OTA 更新

当前 App **未使用** `expo-updates`（无 `runtimeVersion`），所有更新走**整包替换**（下载新 APK/IPA 安装）。版本号比较在 App 启动时请求服务端 `/app/latest-version` 完成。 

google play 需要的原生 `android.versionCode` 由 EAS `autoIncrement` 自动管理，与更新逻辑无关。

---

## 发版步骤

1. 改 `app.json` 的 `expo.version`（如 `0.1.0` → `0.2.0`）
2. 跑 EAS Build（`preview` 或 `production`）
3. 将构建产物（APK 链接）上传到后台「App 版本」板块，版本号填与 `app.json` 相同的 `version`
4. 若该版本需强制升级：勾选「强制更新」，或在系统设置里设「App 最低可用版本」
5. 旧客户端下次启动或调 API 时会被拦截（426），引导下载新包

---

## 技术栈

- Expo SDK 55 + React Native
- Expo Router（文件路由，typed routes）
- Zustand（状态管理：auth、avatars、ui）
- `react-native-sse`（流式聊天）
- `expo-audio`（TTS 播放）
- `expo-notifications`（本地通知）
- `expo-secure-store`（Token 存储）
- `expo-linking`（跳转下载）
- `expo-image-picker` / `expo-media-library`（图片选择与保存）
