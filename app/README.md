# Tornado App

Expo (React Native) 客户端，配合根目录后端 `tornado/server.js`（端口 3011）使用。

## 安装与启动

```bash
cd app
npm install
npx expo start --dev-client
```

第一次跑需要 EAS Build 出 Dev Client，因为依赖 `expo-secure-store` / `expo-av` 等原生模块：

```bash
npx eas-cli@latest build --profile development --platform ios
```

## 配置 API 地址

`app.json` 里 `expo.extra.apiBaseUrl` 默认 `http://localhost:3011`。
真机或局域网调试改为电脑 IP，例如 `http://192.168.1.10:3011`。

## 版本更新（Android）

版本号统一走语义化，单一数据源 = `app.json` 的 `expo.version`（如 `0.2.0`）。
App 启动时请求 `GET /app/latest-version?platform=android`，与本机 `expo.version`
做语义化比较，决定是否提示 / 强制更新。每个 API 请求也会带上 UA
（`tornadoApp/<version> (<os> <osVersion>)`），服务端中间件据此拦截过低版本（426）。

**发版步骤**：
1. 改 `app.json` 的 `expo.version`（唯一要改的版本号）。
2. 后台「App 版本」板块上传新 APK，版本号填**相同的** `version`。

强制更新有两种方式（都基于语义化比较）：
- 后台发布该版本时勾选「强制更新」（针对单个版本）。
- 后台系统设置里设「App 最低可用版本」`app_min_version`（全局闸，砍掉所有低于它的客户端）。
两者用的是同一套阈值，UpdateGate 与服务端中间件行为一致。

> 注：Google Play 上架需要的原生 `android.versionCode`（整数）由 EAS `autoIncrement`
> 自动管理，与此处的更新逻辑无关。

## 阶段 1 已实现

- 鉴权（登录/注册，Bearer token 存 `expo-secure-store`）
- 会话列表 + 新建会话
- 聊天页：文字流式收发（基于 `react-native-sse`）

## 阶段 2 已实现

- WebSocket 推送：affection_update / mood_update / proactive / tts
- TTS 音频播放：`expo-av` 单例，避免切会话串台
- 服务端识别请求头 `X-Stream-TTS: 0` 时跳过 cosyvoice 流式 PCM，统一发 `audio_url`

## 待完成（按计划文档）

阶段 3：画廊 / 心动历程 / 成就
阶段 4：角色管理 / 里程碑 / 来电
阶段 5：发布
