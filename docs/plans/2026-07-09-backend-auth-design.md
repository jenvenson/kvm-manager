# 后端认证与 CORS 收敛设计

日期：2026-07-09
状态：已确认，待实现

## 背景

KVM Manager 目前后端 API（`/api/*`）无任何鉴权，前端「登录」仅为界面装饰：
`LoginPage.tsx` 硬编码凭证 `admin/admin@123`，登录态只是 `localStorage` 标志位，可被
轻易绕过。任何能访问 API 的人都能启停/删除虚拟机、编辑 domain XML、挂载宿主设备，
等同暴露宿主机高权限。这是开源发布前的首要阻断项。

本设计仅覆盖：**后端认证** 与 **CORS 收敛**。XML 注入校验、路径穿越等其余 P0 问题
另行处理。

## 目标

- 后端所有 `/api/*` 接口需携带有效凭证方可访问，`/api/login` 除外。
- 凭证与密钥来自环境变量，不硬编码（遵循全局 CLAUDE.md：安全优先、密钥注入）。
- 不引入新依赖，使用 Python 标准库实现签名 Token。
- 前端登录改为真实调用后端，请求自动携带凭证。
- CORS 从通配 `*` 收敛为可配置来源。

非目标：多用户/RBAC、密码找回、审计增强、httpOnly cookie（单管理员内网工具，YAGNI）。

## 认证机制：密码登录 + 签名 Token

### 环境变量

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `KVM_ADMIN_USER` | 否 | `admin` | 管理员用户名 |
| `KVM_ADMIN_PASSWORD` | 是 | 无 | 管理员密码；未设置则后端启动即报错退出 |
| `KVM_AUTH_SECRET` | 否 | 启动时随机生成 | Token 签名密钥；未设置则随机生成并打 warning（重启后需重新登录） |
| `KVM_TOKEN_TTL_HOURS` | 否 | `168`（7 天） | Token 有效期 |
| `CORS_ORIGINS` | 否 | 空（同源） | 允许的跨域来源，逗号分隔 |

### Token 格式

自包含签名 Token，纯标准库 `hmac` + `hashlib` + `base64` + `json`：

```
token = b64url(payload_json) + "." + b64url(HMAC_SHA256(payload_json, secret))
payload = {"user": <username>, "exp": <unix_ts>}
```

- 签发：登录校验通过后生成，`exp = now + TTL`。
- 校验：拆分 → 用 `hmac.compare_digest` 比对签名 → 检查 `exp` 未过期。
- 密码比对同样用 `hmac.compare_digest` 防时序攻击。

### 组件

- 新增 `backend/app/auth.py`：
  - `issue_token(user) -> str`
  - `verify_token(token) -> dict`（失败抛异常）
  - `require_auth`：FastAPI 依赖，从 `Authorization: Bearer <token>` 提取并校验，
    失败返回 `401`。
  - `check_credentials(user, password) -> bool`
  - 启动时校验 `KVM_ADMIN_PASSWORD` 存在。

### 接入点

- `main.py` 新增 `POST /api/login`，body `{username, password}`，成功返回
  `{token, expires_at}`，失败 `401`。
- 现有各 router 通过
  `app.include_router(r.router, prefix="/api", dependencies=[Depends(require_auth)])`
  统一挂鉴权，`/api/login` 直接定义在 app 上不受影响。

### CORS

`allow_origins=["*"]` → 读取 `CORS_ORIGINS`（逗号分隔）；为空时同源部署无需 CORS。

## 前端改造

- `LoginPage.tsx`：删除硬编码凭证，改为 `POST /kvm/api/login`，成功存 `token` 与
  `expires_at` 到 `localStorage`。
- `client.ts`：axios 请求拦截器自动加 `Authorization: Bearer`；响应拦截器遇 `401`
  清除 token 并跳登录。
- `isLoggedIn()` 改为基于 token 是否存在且未过期。

## 数据流

```
用户输入密码 → POST /api/login → 后端 check_credentials
  → issue_token → 前端存 localStorage
后续请求 → axios 拦截器加 Bearer 头 → require_auth 校验 → 放行/401
```

## 错误处理

- `KVM_ADMIN_PASSWORD` 缺失：启动抛 `RuntimeError`，进程退出，日志明确原因。
- 登录失败：`401`，不区分「用户名错」与「密码错」，避免用户枚举。
- Token 缺失/签名错/过期：统一 `401`。

## 测试

- 无 token 访问 `/api/vms` → 401。
- 错误密码登录 → 401。
- 正确密码登录 → 拿到 token；带 token 访问 → 200。
- 伪造/篡改签名 token → 401。
- 过期 token → 401。

## 验收标准

- 未登录无法调用任何业务接口。
- 硬编码凭证从代码中移除。
- 密钥/密码全部来自环境变量。
- 不新增 Python 依赖。
