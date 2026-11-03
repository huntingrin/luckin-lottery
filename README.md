# luckin-lottery

瑞幸咖啡那场抽奖的专用 Skill：**进公众号/小程序 → 核对账号 → 抽一次 → 查那张券**。

不是通用的「活动规则解析」，也不是多品牌模板。这里写死的都是瑞幸的实际情况：

- 主体名「瑞幸咖啡（北京）有限公司」
- 活动页文案「🎁送你1万杯免费咖啡」、按钮「立即抽奖 ›」→「活动已参与」
- 0 元券的坑：**7 天有效、仅限自提、新品不可用、不抵扣配送费**
- 89% 的人抽到的是 8.3 折券，不是 0 元券

## 为什么要有闸门

抽奖一天一次，点下去就没了；0 元券和 8.3 折券差别很大；领了不用会过期。
所以这个 skill 的核心不是「点得快」，是**在不可逆动作前停下来，先把页面证据摆出来**：

```bash
node scripts/luckin.mjs reach       # 到抽奖按钮前，可反复跑
node scripts/luckin.mjs draw --yes  # 确认后才点这一次
node scripts/luckin.mjs coupons     # 到券，停在「去使用」前，不领取
```

## 通道

| 通道 | 命令 | 说明 |
|---|---|---|
| 安卓 + Mika | `check` → `sync` → `reach` | MCP over USB，虚拟屏执行，不抢手机 |
| iPhone 镜像 | 见 [mika-wechat-mini-program](https://github.com/huntingrin/mika-wechat-mini-program) 的 `ios_bridge.py` | 截图 + OCR + 坐标；小程序登录页点不动，要人工 |

`check` 会打印 `adb=… device=… mika=… iphone_mirroring=…`，按结果选路。

## 实测（2026-11-03）

- 安卓：公众号发「立冬第一杯」→ 小程序卡片 → 抽奖 → **8.3 折饮品券**（11:39 发放，有效期至 11-10，仅限自提）
- iOS：微信 → 搜索 → 小程序 → 我的 → 我的优惠券（停在「去使用」前）

详见 `references/verified-run.md`。

## 目录

```
SKILL.md                  正文：铁律、命令、入口、页面、券规则、坑、失败处置
scripts/luckin.mjs        Mika 通道执行器（check/sync/reach/draw/coupons）
references/luckin-rules.md  规则表 + 券规则原文（含完整排除清单）
references/verified-run.md  两次实测的时间线、task_id、页面原文
```

## 边界

- 只服务瑞幸，别拿它套别的品牌
- 不做批量、多账号、绕过验证码
- 不代付款、不代同意条款、不代登录
- Mika 是第三方 App，装不装由你自己决定

## 许可

未附许可证，保留所有权利。
