# Tornado (龙卷)

虚拟伴侣聊天应用。基于 LLM 的角色扮演对话系统，支持多用户、情绪感知、图片生成、长期记忆、主动发消息等功能。

## 技术栈

- Node.js >= 20（ES Modules）
- better-sqlite3 — 会话与消息持久化
- OpenAI SDK — 兼容 DashScope / DeepSeek 等 OpenAI 协议的 API
- [Memory-AI](../README.md) — 长期记忆服务（可选）

## 快速开始

```bash
cd tornado
npm install
npm run dev
```

浏览器打开 `http://localhost:3011`，首次访问会跳转到登录页。

## 环境变量

在上级目录 `.env` 中配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENAI_API_KEY` | — | LLM API Key（必填） |
| `TORNADO_PORT` | `3011` | 服务端口 |
| `TORNADO_DB` | `./tornado.db` | SQLite 数据库路径 |
| `TORNADO_API_URL` | DashScope | LLM API 地址 |
| `TORNADO_MODEL` | `deepseek-v3.2` | 模型名称 |
| `IMAGE_API_URL` | — | 生图 API 地址 |
| `IMAGE_API_KEY` | — | 生图 API Key |
| `MEMORY_API` | `http://localhost:8880` | Memory-AI 服务地址 |
| `DEFAULT_INVITE_CODE` | `tornado2025` | 初始邀请码（首次启动写入 DB） |
| `PASSWORD_SALT` | 内置默认值 | 密码哈希盐，生产环境务必设置 |

## 用户系统

- 注册需要邀请码，邀请码可复用（多人共用一个码）
- 每个用户的角色、会话、记忆、设置完全独立
- 基于 HttpOnly Cookie 的 session 鉴权，无需额外依赖
- 启动时若 `invite_codes` 表为空，自动写入 `DEFAULT_INVITE_CODE` 并打印到控制台
- 管理员账号：在 DB 中执行 `UPDATE users SET is_admin = 1 WHERE username = 'xxx';`，之后可访问 `/admin`

## 功能

### 对话
- 流式 SSE 响应，打字动画
- 多会话管理，自动命名
- 消息重新生成（hover 气泡显示刷新按钮）
- 长对话折叠，按需加载历史消息
- 气泡 hover 显示时间戳
- 全文搜索，跳转到对应消息

### 角色系统
- 每用户独立管理角色，支持多角色切换
- 角色人设支持结构化字段（外貌、性格、人物说明）+ 自由文本
- 情绪持久化：每轮对话后 LLM 判断当前情绪（neutral/shy/annoyed/soft/flustered/playful/cold/happy/angry）
- 情绪头像：每种情绪单独生成头像，情绪变化时自动切换
- 心动值系统：LLM 根据对话内容判断好感度变化，影响角色行为
- 话题摘要：每 6 轮更新一次当前话题
- 主动发消息：用户空闲超过配置时长时，角色通过 SSE 主动发起对话
- 勿扰时段：可设置不希望被主动打扰的时间段

### 图片
- 角色可通过 `[IMG: 描述]` 标记主动发图
- 自动识别拍照意图，LLM 生成图片描述
- 静默插图：AI 判断适合配图时自动生成，不打断对话
- 场景连续性：图片之间保持地点、服装、时段一致
- 图片画廊：集中查看所有生成过的图片
- 可设置是否默认展开图片

### 记忆
- 集成 Memory-AI 长期记忆服务，按用户+角色隔离（source: `tornado-{userId}-{characterName}`）
- 对话结束时可选择存入记忆库
- 每轮对话自动查询历史记忆注入 system prompt

### 其他
- 对话导出为 txt 文件
- 暗色主题，移动端适配
- 半自动模式：生成回复建议供用户选择
- 全自动模式：自动生成用户消息并触发角色回复

### 管理后台（`/admin`）
- 仪表盘：用户数、会话数、消息数等统计
- 用户管理：查看所有用户，设置/取消管理员，删除用户
- 邀请码管理：新增、删除邀请码
- 公告管理：发布公告，用户登录后弹窗展示，关闭后不再显示
- 系统设置：全局生图开关（覆盖所有用户设置）、soul.md 在线编辑

## API

### 鉴权

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/register` | 注册（需邀请码） |
| POST | `/auth/login` | 登录 |
| POST | `/auth/logout` | 登出 |
| GET | `/auth/me` | 当前登录用户信息 |

### 会话

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sessions` | 会话列表 |
| POST | `/sessions` | 新建会话 |
| PATCH | `/sessions/:id` | 重命名 |
| DELETE | `/sessions/:id` | 删除会话 |
| GET | `/sessions/:id/messages` | 消息历史 |
| POST | `/sessions/:id/chat` | 发送消息（SSE 流式） |
| POST | `/sessions/:id/ingest` | 存入长期记忆 |
| GET | `/sessions/:id/mood` | 当前情绪状态 |
| PATCH | `/sessions/:id/settings` | 更新勿扰时段等设置 |
| GET | `/sessions/:id/events` | SSE 推送（主动消息、生图通知） |
| GET | `/sessions/:id/export` | 导出对话为 txt |
| POST | `/sessions/:id/image` | 用户发图 |

### 角色

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/characters` | 角色列表 |
| POST | `/characters` | 新建角色 |
| PATCH | `/characters/:id` | 更新角色 / 切换激活 |
| DELETE | `/characters/:id` | 删除角色 |
| GET | `/character` | 当前激活角色信息 |
| GET/PATCH | `/character/soul` | 读写角色人设 |
| GET | `/character/affection-log` | 心动值变化历史 |
| PATCH | `/character/affection` | 手动设置心动值 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/gallery` | 所有生成图片 |
| GET | `/search?q=` | 全文搜索消息 |
| GET/PATCH | `/settings` | 用户设置 |
| GET | `/announcements/unread` | 未读公告列表 |
| POST | `/announcements/:id/read` | 标记公告已读 |

### 管理员（需 is_admin = 1）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/stats` | 统计数据 |
| GET | `/admin/users` | 用户列表 |
| PATCH | `/admin/users/:id` | 修改用户（is_admin） |
| DELETE | `/admin/users/:id` | 删除用户 |
| GET/POST | `/admin/invite-codes` | 邀请码列表 / 新增 |
| DELETE | `/admin/invite-codes/:code` | 删除邀请码 |
| GET/POST | `/admin/announcements` | 公告列表 / 发布 |
| DELETE | `/admin/announcements/:id` | 删除公告 |
| GET/PATCH | `/admin/global-settings` | 全局设置 |
| GET/PATCH | `/admin/soul` | 读写 soul.md |

## 项目结构

```
tornado/
├── server.js        # HTTP 服务、路由、LLM 调用、生图、记忆
├── db.js            # SQLite 初始化与迁移
├── soul.md          # 默认角色人设（可选）
├── package.json
└── public/
    ├── index.html   # 主页面
    ├── auth.html    # 登录/注册页
    ├── admin.html   # 管理后台
    ├── app.js       # 前端逻辑
    ├── styles.css   # 暗色主题样式
    └── uploads/     # 用户上传图片
```

## 数据库

SQLite WAL 模式，主要表：

**users** — 用户账号

**sessions** — 聊天会话（含 `user_id` 隔离）

**messages** — 消息记录

**characters** — 角色（含 `user_id` 隔离）

**character_cards** — 角色立绘历史

**mood_avatars** — 情绪头像缓存

**affection_log** — 心动值变化记录

**user_settings** — 每用户独立设置

**announcements** — 公告

**announcement_reads** — 公告已读记录（user_id + announcement_id）

**global_settings** — 全局配置（key/value）

**invite_codes** — 邀请码


## 技术栈

- Node.js >= 20（ES Modules）
- better-sqlite3 — 会话与消息持久化
- OpenAI SDK — 兼容 DashScope / DeepSeek 等 OpenAI 协议的 API
- [Memory-AI](../README.md) — 长期记忆服务（可选）

## 快速开始

```bash
cd tornado
npm install
npm run dev
```

浏览器打开 `http://localhost:3011`。

## 环境变量

在上级目录 `.env` 中配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENAI_API_KEY` | — | LLM API Key（必填） |
| `TORNADO_PORT` | `3011` | 服务端口 |
| `TORNADO_DB` | `./tornado.db` | SQLite 数据库路径 |
| `TORNADO_API_URL` | DashScope | LLM API 地址 |
| `TORNADO_MODEL` | `deepseek-v3.2` | 模型名称 |
| `IMAGE_API_URL` | — | 生图 API 地址 |
| `IMAGE_API_KEY` | — | 生图 API Key |
| `MEMORY_API` | `http://localhost:8880` | Memory-AI 服务地址 |

## 功能

### 对话
- 流式 SSE 响应，打字动画
- 多会话管理，自动命名
- 消息重新生成（hover 气泡显示刷新按钮）
- 长对话折叠，按需加载历史消息
- 气泡 hover 显示时间戳
- 全文搜索，跳转到对应消息

### 角色系统
- 角色人设通过 `soul.md` 定义，热重载
- 情绪持久化：每轮对话后 LLM 判断当前情绪（平静/害羞/不耐烦/温柔/慌乱/俏皮/冷淡），注入下一轮 system prompt
- 情绪头像：可为每种情绪单独设置头像，情绪变化时自动切换
- 话题摘要：每 6 轮更新一次当前话题，帮助角色感知对话分支
- 主动发消息：用户空闲超过 30 分钟时，角色通过 SSE 主动发起对话
- 勿扰时段：可设置不希望被主动打扰的时间段

### 图片
- 角色可通过 `[IMG: 描述]` 标记主动发图
- 自动识别拍照意图，LLM 生成图片描述
- 静默插图：AI 判断适合配图时自动生成，不打断对话
- 场景连续性：图片之间保持地点、服装、时段一致，基于上一张图的实际画面描述
- 生图失败时前端显示错误提示
- 图片画廊：集中查看所有生成过的图片

### 记忆
- 集成 Memory-AI 长期记忆服务
- 对话结束时可选择存入记忆库
- 每轮对话自动判断是否需要查询历史记忆

### 其他
- 对话导出为 txt 文件
- 自定义用户/角色头像（支持裁剪）
- 暗色主题，移动端适配

## API

### 会话

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sessions` | 会话列表 |
| POST | `/sessions` | 新建会话 |
| PATCH | `/sessions/:id` | 重命名 |
| DELETE | `/sessions/:id` | 删除会话 |
| GET | `/sessions/:id/messages` | 消息历史 |
| POST | `/sessions/:id/chat` | 发送消息（SSE 流式） |
| POST | `/sessions/:id/ingest` | 存入长期记忆 |
| GET | `/sessions/:id/mood` | 当前情绪状态 |
| PATCH | `/sessions/:id/settings` | 更新勿扰时段等设置 |
| GET | `/sessions/:id/events` | SSE 推送（主动消息、生图失败通知） |
| GET | `/sessions/:id/export` | 导出对话为 txt |
| POST | `/sessions/:id/image` | 用户发图 |

### 消息

| 方法 | 路径 | 说明 |
|------|------|------|
| DELETE | `/messages/:id` | 删除该消息及之后的所有消息 |
| GET | `/messages/:id/image` | 轮询图片生成状态 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/gallery` | 所有生成图片（最近 200 张） |
| GET | `/search?q=` | 全文搜索消息 |

## 项目结构

```
tornado/
├── server.js        # HTTP 服务、路由、LLM 调用、生图、记忆
├── db.js            # SQLite 初始化与迁移
├── soul.md          # 角色人设定义
├── package.json
└── public/
    ├── index.html   # 页面结构
    ├── app.js       # 前端逻辑
    ├── styles.css   # 暗色主题样式
    └── uploads/     # 用户上传图片
```

## 数据库

SQLite WAL 模式，两张表：

**sessions**

| 字段 | 说明 |
|------|------|
| `id` | 主键 |
| `title` | 会话标题 |
| `mood` | 当前情绪（neutral/shy/annoyed/soft/flustered/playful/cold） |
| `topic_summary` | 当前话题摘要 |
| `last_user_at` | 用户最后发消息时间，用于主动发消息判断 |
| `dnd_start` / `dnd_end` | 勿扰时段（HH:MM 格式） |
| `created_at` / `updated_at` | 时间戳 |

**messages**

| 字段 | 说明 |
|------|------|
| `id` | 主键 |
| `session_id` | 关联会话（级联删除） |
| `role` | user / assistant / system |
| `content` | 消息内容 |
| `image_url` | 关联图片 URL |
| `image_prompt` | 生图描述（用于场景连续性） |
| `created_at` | 时间戳 |
