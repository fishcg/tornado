# Tornado

虚拟伴侣聊天系统，核心亮点是持续演化的长期记忆。

- 主界面
<img width="1165" height="808" alt="image" src="https://github.com/user-attachments/assets/506e10ae-3de2-46a2-b4b6-79403a4b1d3a" />

- 
成就玩法
<img width="1143" height="710" alt="image" src="https://github.com/user-attachments/assets/84f19bee-22af-43c6-ac19-e6fcc5540314" />

- 心动值玩法
<img width="869" height="537" alt="image" src="https://github.com/user-attachments/assets/3a9aae56-a383-4dec-bb83-5e534960e460" />



大多数 AI 聊天都有"失忆"问题：每次对话从零开始，处理完就忘。这个项目在聊天之外运行一个独立的记忆服务，持续摄取、整理、压缩并关联信息，让角色真正"记得"你。

---

## 两个服务

| 服务 | 端口     | 职责 |
|---|--------|---|
| **tornado** | `3011` | 虚拟伴侣聊天，角色扮演，心动值，成就系统，图片生成 |
| **memory** | `8880` | 长期记忆摄取、巩固、查询 |

两个服务共用同一个 MySQL 数据库，通过 `MEMORY_API` 互通。用 `npm run all` 一键启动。

---

## 核心功能

### 虚拟伴侣聊天（tornado）

- **角色扮演**：可配置角色聊天灵魂设定（`soul.md`），角色会根据关系阶段调整态度和边界
- **心动值系统**：0–100 的关系进度，影响角色对话风格和容忍度，由 LLM 根据对话内容自动评估
- **成就系统**：达成消息数、心动值、连续聊天天数等里程碑时，触发成就弹窗，附带 AI 生成的角色自拍和心理独白
- **场景插图**：手动或自动触发，根据当前对话内容生成场景图片，保持场景连续性
- **情绪头像**：角色根据当前情绪实时更新头像
- **主动消息**：空闲超时后角色会主动发起对话（可配置免打扰时段）
- **多用户隔离**：邀请码注册，每个用户独立的角色、对话、心动值数据
- **管理后台**：角色配置、成就管理、全局参数（心动频次、每日插图上限等）

### 长期记忆（memory）

- **多格式摄取**：文本、图片、音频、视频、PDF，共 27 种文件类型
- **结构化存储**：LLM 将原始输入整理为摘要、实体、主题、重要性
- **记忆巩固**：定时（默认 30 分钟）发现跨记忆联系，提炼更高层洞察
- **记忆查询**：基于记忆库回答问题，返回带来源引用的答案
- **自动监听**：把文件丢进 `./inbox`，服务自动摄取

---

## 快速开始

### 1. 安装依赖

```bash
npm install
cd tornado && npm install && cd ..
```

### 2. 配置环境变量

在项目根目录创建 `.env`：

```bash
# 数据库
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=tornado

# 聊天 LLM（tornado）
OPENAI_API_KEY=your_key
TORNADO_API_URL=https://api.openai.com/v1
TORNADO_MODEL=deepseek-v3.2

# 图片生成
IMAGE_API_URL=https://your-image-api/generate
IMAGE_API_KEY=your_key

# 记忆 LLM（memory）
OPENAI_MODEL=qwen3.5-plus

# 其他
MEMORY_API=http://localhost:8880
PASSWORD_SALT=your_salt
DEFAULT_INVITE_CODE=your_code
```

### 3. 启动

```bash
npm run all
```

- 聊天界面：`http://localhost:3011/`
- 管理后台：`http://localhost:3011/admin.html`
- 记忆仪表盘：`http://localhost:8880/`

---

## 环境变量

### tornado（聊天服务）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TORNADO_PORT` | `3011` | 服务端口 |
| `OPENAI_API_KEY` | — | 聊天 LLM API Key |
| `TORNADO_API_URL` | `https://api.openai.com/v1` | 聊天 LLM 接口地址 |
| `TORNADO_MODEL` | `deepseek-v3.2` | 聊天模型 |
| `IMAGE_API_URL` | — | 图片生成接口 |
| `IMAGE_API_KEY` | — | 图片生成 API Key |
| `MEMORY_API` | `http://localhost:8880` | 记忆服务地址 |
| `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` | — | 数据库连接 |
| `PASSWORD_SALT` | `tornado-default-salt-2025` | 密码加盐 |
| `DEFAULT_INVITE_CODE` | `tornado2025` | 初始邀请码 |
| `PROACTIVE_IDLE_MINUTES` | `30` | 主动消息空闲阈值（分钟） |

### memory（记忆服务）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8880` | 服务端口 |
| `OPENAI_API_KEY` | — | LLM API Key |
| `OPENAI_API_URL` | dashscope 兼容地址 | LLM 接口地址 |
| `OPENAI_MODEL` | `qwen3.5-plus` | 摄取/巩固/查询模型 |
| `CONSOLIDATE_EVERY_MIN` | `30` | 记忆巩固间隔（分钟） |
| `WATCH_DIR` | `./inbox` | 文件监听目录 |
| `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` | — | 数据库连接 |

---

## 部署

### Docker

```bash
docker build -t memory-ai .
docker run -p 8880:8880 -p 3011:3011 \
  -e NODE_ENV=production \
  -e MYSQL_HOST=your_host \
  -e OPENAI_API_KEY=your_key \
  # ... 其他环境变量
  memory-ai
```

### Kubernetes

```bash
# 创建 Secret（首次部署）
kubectl create secret generic memory-ai-secret \
  --from-literal=mysql_host=127.0.0.1 \
  --from-literal=mysql_password=your_password \
  # ... 参考 k8s.yaml 末尾注释

kubectl apply -f k8s.yaml
```

CI/CD 由 `.woodpecker.yml` 驱动，推送到主分支后自动构建镜像并滚动更新。

---

## 技术栈

- **Node.js** — 两个服务均为纯 Node，无额外运行时依赖
- **MySQL** — 持久化存储（对话、记忆、角色、成就等）
- **Fastify** — memory 服务 HTTP 框架
- **SSE** — tornado 实时推送（消息流、图片生成、成就解锁）
- **OpenAI-compatible API** — 支持任意兼容接口（DeepSeek、Qwen 等）

## License

本项目基于 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议开源。

- 个人学习、研究、非商业用途：免费使用
- **商业用途（含 SaaS、付费产品、内部商业系统等）需获得授权并付费**，请联系作者

> 未经授权将本项目用于商业目的，视为侵权。
