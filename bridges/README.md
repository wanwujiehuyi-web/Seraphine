# 微信接入

微信没有官方个人号群消息 API。`group-digest` 的做法是：**把「读/发微信」留给你的桥，其余全部复用同一套摘要、审核、日程流程。**

```
微信自动化库 ──你的采集循环──> POST /ingest ──> Hub
Hub ──报告批准后──> POST /send ──> 你的发送函数
```

---

## 1. 入站：采集器 → Hub

直接调 Hub（推荐经由中继，便于统一 token）：

```bash
curl -X POST "http://127.0.0.1:8791/api/ingest/wechat?token=$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "roomId": "123@chatroom",
    "roomName": "项目群",
    "senderId": "wxid_abc",
    "senderName": "老王",
    "content": "下周三上午10点开会，地点：3 楼会议室",
    "timestamp": 1792291200000
  }'
```

也支持一次 POST 一个数组。字段别名见主 README。

去重键是 `platform + chatId + msgId`（没有 msgId 时用发送者+时间+正文哈希），重复上报不会产生重复消息。

---

## 2. 出站：Hub → 发送器

`config.json`：

```json
{
  "delivery": {
    "wechat": {
      "enabled": true,
      "sendUrl": "http://127.0.0.1:8899/send",
      "token": "与中继一致的 token",
      "to": "默认接收人/群",
      "maxChars": 1500
    }
  }
}
```

Hub 的请求：

```
POST /send
Authorization: Bearer <token>
Content-Type: application/json

{"to": "...", "text": "报告正文（已按 maxChars 截断）", "reportId": "rep_..."}
```

返回 2xx 视为成功；非 2xx 会把响应体写进报告的 delivery 结果，报告保留 `approved` 状态，修好后可重试。

---

## 3. 中继

```powershell
$env:GROUPDIGEST_TOKEN='<config.json 的 server.token>'
$env:RELAY_TOKEN='<可留空，默认同上>'
$env:WECHAT_SEND_CMD='python C:\path\to\send_wechat.py'
node bridges/wechat-relay.mjs
```

- 默认监听 `127.0.0.1:8899`；
- `POST /ingest` 转发到 Hub；
- `POST /send` 把文本从 **stdin** 交给 `WECHAT_SEND_CMD`；
- 未配置发送命令时只打印，方便先跑通审核流程。

发送脚本只需从 stdin 读 UTF-8 文本并调用你选定的库，例如：

```python
# send_wechat.py（示意，具体 API 取决于你的库）
import sys
text = sys.stdin.read()
# wxauto: wx.SendMsg(text, who="项目群")
# WeChatFerry: wcf.send_text(text, "项目群")
print("sent", len(text))
```

---

## 4. 选型与风险

| 方案 | 能读群 | 合规性 | 成本/风险 |
|---|---|---|---|
| 企业微信「会话内容存档」 | 能 | 官方接口 | 需企业资质、付费、员工授权 |
| WeChatFerry / 类似 hook | 能 | 第三方侵入 | 有封号风险，版本敏感 |
| wxauto / UI 自动化 | 能（窗口在前台） | 第三方自动化 | 不稳定，依赖微信版本与界面 |
| 微信公众号 | 不能读群 | 官方 | 只能收用户发给公众号的消息 |

无论选哪个，**只在本机运行、不要暴露公网**；采集器崩溃不应影响 Hub，消息可以稍后补报（去重会兜住）。

---

## 5. 最小自测

```powershell
curl -X POST http://127.0.0.1:8899/ingest ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer $env:RELAY_TOKEN" ^
  -d "{\"roomId\":\"test-room\",\"roomName\":\"测试群\",\"senderId\":\"u1\",\"senderName\":\"甲\",\"content\":\"明天下午3点开会\",\"timestamp\":1792291200000}"
```

然后在 DSH 里 `group_list`、`group_digest`，或 `node src/cli.js messages --hours 1`。
