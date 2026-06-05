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
