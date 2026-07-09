# 部署到 Hugging Face Spaces（免费 · 无需信用卡 · 7×24）

目标：把斗地主跑在 Hugging Face 的免费容器上，**无需绑卡**，获得永久网址
`https://你的用户名-doudizhu.hf.space`，你关机、电脑不在，朋友也能随时打开一起玩。

> 说明：原先计划用 Render，但 Render 现在要求绑定信用卡（即使是免费档也要验证付款方式），所以改走 Hugging Face Spaces——**免费且真正无需信用卡**。

---

## 前提
- 代码已在 GitHub：`https://github.com/NoWorriesForever/doudizhu`
- 需要一个 Hugging Face 账号（免费，**不用填信用卡**，可用 GitHub 直接注册）

---

## 第 1 步：注册 Hugging Face
1. 打开 **https://huggingface.co/** ，点 **Sign Up**
2. 可用 **GitHub** 账号直接注册登录（全程不要求信用卡）
3. 登录后进入控制台

---

## 第 2 步：新建 Space（选 Docker）
1. 点右上角头像 → **New Space**（或直接打开 https://huggingface.co/new-space ）
2. Owner 选你自己（`NoWorriesForever`）
3. **Space name** 填 `doudizhu`
4. **SDK 选 `Docker`**（不要选 Gradio / Streamlit / 其他模板）
5. 若页面出现 **「Import from GitHub repo」** 输入框，直接粘贴
   `https://github.com/NoWorriesForever/doudizhu`
   → 这样一键把仓库（含 `Dockerfile`）导入 Space，自动开始构建，跳到第 4 步
6. **Visibility** 选 **Public**
7. 点 **Create Space**

> 如果没有「Import from GitHub」选项，就正常创建空 Space，再用下面的「第 3 步（git 推送）」把代码推上去。

---

## 第 3 步（仅当没用 Import 时才需要）：用 git 推代码到 Space
HF 的 Space 本质是一个 git 仓库。推送需要一个 HF 访问令牌：

1. HF 右上角头像 → **Settings → Access Tokens** → **New token**
   - 名字随意（如 `doudizhu`）
   - 权限（Role / Scope）选 **write**
   - 生成后**复制**令牌（形似 `hf_xxxxxxxx`，只显示一次）
2. 在本机 Git Bash（先进入 doudizhu 目录）执行，把 `你的HF令牌` 换成刚复制的：
   ```bash
   git remote add hf https://NoWorriesForever:你的HF令牌@huggingface.co/spaces/NoWorriesForever/doudizhu
   git push -u hf main
   ```
   （令牌只填在你自己电脑，不用发我。）

---

## 第 4 步：等构建完成
- Space 页面会显示状态：`Building…` → `Running`（首次构建约 1~3 分钟）
- 构建完成后，页面顶部给出网址：
  ```
  https://NoWorriesForever-doudizhu.hf.space
  ```
- 点开即可进大厅、建房间、加机器人、出牌。这就是 7×24 地址。

---

## 注意事项
- **免费档会休眠**：空闲约 15 分钟后实例暂停，下次有人访问自动唤醒（冷启动约 30~60 秒），网址永久有效。
- 我们的前端已用 **HTTP 轮询兜底**（不依赖 SSE），所以即使 HF 的反向代理缓冲 SSE，出牌/状态也照常实时刷新，手机电脑都能用。
- **以后更新代码**：
  - 若用 Import 导入：改完在 GitHub `git push` 后，到 Space 页面点 **Settings → Repository** 里的重新同步 / 或重新触发构建。
  - 若用 git 推送：直接 `git push hf main` 即自动重建。

## 常见问题
**Q：构建失败 / 报红？**
A：把 Space 页面 **Logs** 里的报错发我。最常见是 Dockerfile 构建问题或监听端口不对（本项目已确保监听 `process.env.PORT`，HF 会给 7860）。

**Q：能彻底不休眠吗？**
A：HF 免费档会休眠；要常驻需升级到付费 Space。需要的话告诉我。
