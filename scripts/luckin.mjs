#!/usr/bin/env node
// luckin.mjs — 瑞幸小程序抽奖的固定流程执行器（Mika 通道）
// 只做瑞幸这一件事：核账号 → 进活动页 → 抽奖 → 查券。别的活动请用 mika-wechat-mini-program。

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const CFG_DIR = process.env.MIKA_CONFIG_DIR || join(homedir(), '.mika');
const CFG_FILE = join(CFG_DIR, 'config.json');
const PHONE_INFO = '/sdcard/Android/data/com.wangzan101.mika/files/mcp-usb.json';
const USB_START = '/sdcard/Android/data/com.wangzan101.mika/files/usb-start.sh';

const OFFICIAL = '瑞幸咖啡（北京）有限公司';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

function adb(args) {
  return execFileSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function adbOk(args) {
  try {
    return adb(args);
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

// ---------- MCP ----------

let reqId = 0;

async function rpc(cfg, method, params = {}) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++reqId, method, params }),
    signal: AbortSignal.timeout(70000),
  });
  if (res.status === 401) fail('Mika token 失效（手机重启过？）— 重新跑 `node scripts/luckin.mjs sync`');
  if (!res.ok) fail(`MCP HTTP ${res.status}`);
  const text = await res.text();
  const msg = (res.headers.get('content-type') || '').includes('text/event-stream')
    ? JSON.parse((text.split('\n').reverse().find((l) => l.startsWith('data:')) || 'data:{}').slice(5))
    : JSON.parse(text);
  if (msg.error) fail(`MCP 错误：${msg.error.message}`);
  return msg.result;
}

function unwrap(r) {
  if (r?.structuredContent) return r.structuredContent;
  const t = r?.content?.find((c) => c.type === 'text')?.text;
  try {
    return t ? JSON.parse(t) : r;
  } catch {
    return { text: t };
  }
}

async function call(cfg, name, args = {}) {
  const r = await rpc(cfg, 'tools/call', { name, arguments: args });
  if (r?.isError) fail(`${name} 失败：${JSON.stringify(unwrap(r)).slice(0, 400)}`);
  return unwrap(r);
}

// ---------- 通道 ----------

function check() {
  const out = { adb: false, device: null, mika: false, ios: false };
  try {
    out.adb = /^[0-9a-fA-F]{6,}/m.test(adbOk(['devices']).split('\n')[1] || '');
    out.device = (adbOk(['devices']).split('\n').find((l) => l.includes('\tdevice')) || '').split('\t')[0] || null;
    out.mika = /package:com\.wangzan101\.mika/.test(adbOk(['shell', 'pm', 'list', 'packages', 'com.wangzan101.mika']));
  } catch {}
  if (process.platform === 'darwin') {
    try {
      out.ios = !!execFileSync('pgrep', ['-f', 'iPhone Mirroring'], { encoding: 'utf8' }).trim();
    } catch {}
  }
  return out;
}

async function sync(cfg) {
  const c = check();
  if (!c.adb) fail('没有 adb 或没有设备：插线 → 打开 USB 调试 → 手机点「允许」');
  if (!c.mika) fail('这台安卓机没装 Mika：装好后再来（iOS 用 phone-harness，见 SKILL.md）');

  let info;
  for (let i = 0; i < 2 && !info; i++) {
    try {
      info = JSON.parse(adb(['shell', 'cat', PHONE_INFO]));
    } catch {
      adb(['shell', 'sh', USB_START]);
      await sleep(2500);
    }
  }
  if (!info?.token) fail('拿不到 Mika token：打开 Mika → 设置 → 电脑访问（MCP），确认 USB 已开启');

  const port = info.port || 8765;
  const localPort = Number(process.env.MIKA_LOCAL_PORT || cfg.localPort || 18765);
  adb(['forward', `tcp:${localPort}`, `tcp:${port}`]);
  if (!adb(['forward', '--list']).includes(`tcp:${localPort}`)) fail(`本机 ${localPort} 被占用，换 MIKA_LOCAL_PORT`);

  const next = { ...cfg, url: `http://127.0.0.1:${localPort}/mcp`, token: info.token, port, localPort };
  mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CFG_FILE, JSON.stringify(next, null, 2));
  chmodSync(CFG_FILE, 0o600);

  await rpc(next, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'luckin-lottery', version: '1.0.0' } });
  const st = await call(next, 'mika_device_state');
  if (!st.device?.helper_available) {
    adb(['shell', 'sh', USB_START]);
    await sleep(3000);
  }
  console.log(`✓ Mika 已连（${c.device}，boot ${info.boot ?? '?'}）`);
  return next;
}

async function waitTask(cfg, id) {
  for (;;) {
    const s = await call(cfg, 'mika_wait_task', { task_id: id, timeout_s: 50 });
    if (s.note) console.log(`[${s.status}] ${s.note}`);
    if (['done', 'failed', 'cancelled', 'error', 'waiting_for_answer', 'waiting_on_phone'].includes(s.status)) return s;
  }
}

async function run(cfg, goal, { conversation } = {}) {
  const r = await call(cfg, 'mika_run_task', { goal, ...(conversation ? { conversation } : {}) });
  console.log(`→ task ${r.task_id}`);
  const s = await waitTask(cfg, r.task_id);
  const body = s.answer || s.result || s.text || s.note || '';
  console.log(`\n${s.status === 'done' ? '✓' : '·'} ${s.status}\n${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}`);
  if (s.conversation) console.log(`\nconversation: ${s.conversation}`);
  return s;
}

// ---------- 瑞幸专用任务 ----------

const GOAL_REACH = `打开微信，进入「luckincoffee瑞幸咖啡」小程序（微信搜索这个全名，或点「瑞幸咖啡」公众号里的历史小程序卡片）。进活动页之前先核对：公众号名称「瑞幸咖啡」，主体「${OFFICIAL}」，带蓝色认证标。进小程序后打开「🎁送你1万杯免费咖啡」活动页，停在「立即抽奖」按钮前面，不要点抽奖、不要领券、不要下单、不要付款。如果小程序弹隐私提示或要求登录，先停下告诉我弹窗原文，不要自己点同意。完成后告诉我：页面标题、抽奖按钮当前文案、中奖记录里有没有券、页面上还有哪些入口。`;

const GOAL_DRAW = `继续刚才那个瑞幸活动页。确认按钮是「立即抽奖」且中奖记录为空，然后点一次抽奖，等结果弹窗。把弹窗原文告诉我：券名、折扣或面额、按钮文案、有没有「库存不足」之类提示。只读结果：不要点「去喝一杯」，不要领取，不要下单，不要付款。`;

const GOAL_COUPONS = `进「luckincoffee瑞幸咖啡」小程序的「我的」→「优惠券」，或者活动页右侧「中奖记录」。找到最近发放的那张券，读它的有效期、适用饮品和排除项、是否限自提、门店限制。停在「去使用」按钮前面，不要点它，不要领取，不要下单。如果优惠券列表里有多张同折扣券，按发放时间和「新获得」标记区分，别搞混。`;

// ---------- CLI ----------

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  let cfg = existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, 'utf8')) : { url: 'http://127.0.0.1:18765/mcp' };

  switch (cmd) {
    case 'check': {
      const c = check();
      console.log(`adb=${c.adb} device=${c.device || '-'} mika=${c.mika} iphone_mirroring=${c.ios}`);
      console.log(c.mika ? '→ 走 Mika' : c.ios ? '→ 走 iPhone 镜像（phone-harness）' : '→ 没有可用通道');
      process.exitCode = c.mika || c.ios ? 0 : 2;
      return;
    }
    case 'sync':
      await sync(cfg);
      return;
    case 'reach': {
      if (!cfg.token) cfg = await sync(cfg);
      await run(cfg, GOAL_REACH);
      return;
    }
    case 'draw': {
      if (!args.includes('--yes')) fail('抽奖一天一次、不可撤销。先跑 reach 看页面，确认后再加 --yes');
      if (!cfg.token) cfg = await sync(cfg);
      await run(cfg, GOAL_DRAW, { conversation: args.find((a) => a.startsWith('mcp-')) });
      return;
    }
    case 'coupons': {
      if (!cfg.token) cfg = await sync(cfg);
      await run(cfg, GOAL_COUPONS, { conversation: args.find((a) => a.startsWith('mcp-')) });
      return;
    }
    case 'do': {
      if (!cfg.token) cfg = await sync(cfg);
      await run(cfg, args.join(' '));
      return;
    }
    default:
      console.log(`luckin.mjs — 瑞幸小程序抽奖

  check                看通道（adb / Mika / iPhone 镜像）
  sync                 连 Mika（取 token、adb forward、起助手）
  reach                进活动页并停在抽奖按钮前（可反复跑）
  draw --yes           点一次抽奖（不带 --yes 不执行）
  coupons [conversation]  读中奖记录/优惠券，停在「去使用」前
  do "<自由指令>"       兜底
`);
  }
}

main().catch((e) => fail(e?.stack?.split('\n').slice(0, 3).join('\n') || String(e)));
