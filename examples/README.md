# 接口请求示例（演示用，非正式数据）

```bash
BASE=http://127.0.0.1:8080
# 1. 登录（保存 Cookie）
curl -c cj -H 'x-bidding-client: 1' -H 'content-type: application/json' \
  -d '{"username":"admin","password":"你的密码"}' $BASE/api/v1/auth/admin/login

# 2. 校验首轮数据（示例文件中的数值仅用于说明字段）
curl -b cj -H 'x-bidding-client: 1' -H 'content-type: application/json' \
  -d @examples/first-round-import.example.json \
  $BASE/api/v1/admin/events/<活动ID>/first-round/imports/validate

# 3. 提交（validationId、draftVersion 取自上一步返回）
curl -b cj -H 'x-bidding-client: 1' -H 'content-type: application/json' \
  -d '{"validationId":"…","expectedDraftVersion":0,"idempotencyKey":"import-20261010-001"}' \
  $BASE/api/v1/admin/events/<活动ID>/first-round/imports/commit
```

`示例` JSON 中的 `_说明` 字段会被服务端忽略（只读取 `mode` 与 `rows`）。
