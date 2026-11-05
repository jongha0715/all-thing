'use strict';
/* POST /api/game  { action, ... }   (로그인 토큰 필요)
   주식게임에서 돈·주식·아이템이 바뀌는 일은 전부 여기서만 일어나요.
   데이터베이스 규칙상 친구들 기기는 게임 데이터를 읽기만 할 수 있어요. */
const fb = require('./_lib/fb');
const { handler, httpErr, requireUser, requireAdmin, txn, USERS } = require('./_lib/http');
const { hashPassword } = require('./_lib/pw');
const E = require('./_lib/engine');

const ENGINE = 'allthing-secret/game/engine';     // 정답이 들어 있는 진짜 시세 (아무도 못 읽음)
const FLOW = 'allthing-secret/game/flow';         // 30분 동안 쌓인 매수/매도 금액
const MARKET = 'allthing/allthing-game/market';   // 친구들이 보는 공개용 시세
const PLAYERS = 'allthing/allthing-game/players';
const CONTROL = 'allthing/allthing-game/control';
const LEGACY_FLOW = 'allthing/allthing-game/flow';
const EVENTS = 'allthing/allthing-events';
// 초기화 비밀번호는 코드에 없고, 해시만 있어요 (예전과 같은 비밀번호)
const GAME_RESET_KEY = { salt:'allthing-game-reset-7f3a91c2', hash:'9395d43da3e9079583b03489fee56475f9711a7a4cb752e4044824fe9996d31c' };

const fmtWon = n => Math.round(n || 0).toLocaleString('ko-KR') + '원';

async function loadCtrl(d){ return E.ctrlOf((await d.ref(CONTROL).once('value')).val()); }
// 일정 목록은 휴일 판단에만 필요해서, 정말 필요할 때(시세 진행·수업 중 매수 확인) 한 번만 읽어요
function lazyEvents(d){
  let p = null;
  return () => (p = p || d.ref(EVENTS).once('value').then(s => s.val() || []));
}
function logRef(d, ctrl){ return d.ref('allthing/allthing-game/log/' + (ctrl.season || 's1')); }
async function gameLog(d, ctrl, uid, entry){
  try{ await logRef(d, ctrl).push(Object.assign({ uid, at: Date.now() }, entry)); }catch(e){ console.error('log', e); }
}

function fromLegacy(m){
  return { tick: m.tick, ver: (m.ver || 0) + 1, prices: m.prices, prev: m.prev || m.prices, history: m.history || {},
           trend: m.trend || {}, news: m.news || [], arcs: m.arcs || {}, published: m.published || {} };
}
/* 공개용 시세 올리기 — 바뀐 부분만 보내요.
   (친구들 기기는 이 노드를 실시간으로 보고 있어서, 통째로 다시 쓰면 기사 본문까지 매번 전부 다시 받아요) */
async function publish(d, eng, newsChanged){
  if(!eng) return;
  const [verS, pvS] = await Promise.all([d.ref(MARKET + '/ver').once('value'), d.ref(MARKET + '/pv').once('value')]);
  const ver = verS.val(), pv = pvS.val();
  if(pv === 2 && typeof ver === 'number' && ver >= (eng.ver || 0)) return;
  const pub = Object.assign(E.publicMarket(eng), { pv: 2 });
  if(pv !== 2 || typeof ver !== 'number' || newsChanged !== false){ await d.ref(MARKET).set(pub); return; }
  const patch = Object.assign({}, pub);
  delete patch.news;                      // 기사 목록이 그대로면 다시 보내지 않아요
  if(!patch.active) patch.active = null;  // 진행 중인 뉴스가 없으면 지워요
  await d.ref(MARKET).update(patch);
}
function newsKey(m){ return m && m.news ? (Array.isArray(m.news) ? m.news : Object.values(m.news)).map(n => n && n.id).join(',') : ''; }
/* 시세를 지금 시각까지 진행해요. 여러 명이 동시에 불러도 한 번만 진행돼요.
   이미 최신이면 아주 작은 값(tick) 하나만 읽고 끝나요 — 대부분의 요청은 여기서 끝나요. */
async function advance(d, ev){
  const target = E.tickNow();
  const tick = (await d.ref(ENGINE + '/tick').once('value')).val();
  if(typeof tick === 'number' && tick >= target) return null;
  const [flowS, events] = await Promise.all([d.ref(FLOW).once('value'), ev()]);
  const flow = flowS.val() || {};
  let seed = null;
  if(tick == null){
    const legacy = (await d.ref(MARKET).once('value')).val();
    if(legacy && legacy.prices) seed = legacy; // 예전 구조(정답이 공개돼 있던 시세)에서 옮겨오기
  }
  let baseNews = null;
  const res = await txn(d.ref(ENGINE), cur => {
    let base = cur, fromSeed = false;
    if(!base && seed){ base = fromLegacy(seed); fromSeed = true; }
    baseNews = newsKey(base);
    const out = E.advanceMarket(base, target, flow, events);
    if(out === undefined) return fromSeed ? base : undefined;
    return out;
  });
  const eng = res.snapshot.val();
  if(res.committed && eng){
    await Promise.all(Object.keys(flow).map(id => txn(d.ref(FLOW + '/' + id), c => {
      const v = (c || 0) - (Number(flow[id]) || 0); return Math.abs(v) < 1 ? null : v;
    })));
  }
  if(seed) await d.ref(LEGACY_FLOW).set(null);
  await publish(d, eng, (seed || !res.committed) ? true : newsKey(eng) !== baseNews);
  return eng;
}
async function readEngine(d){ return (await d.ref(ENGINE).once('value')).val(); }
async function readEnginePart(d, sub){ return (await d.ref(ENGINE + '/' + sub).once('value')).val(); }
// 지금 가격 하나만 필요할 때: 방금 진행했으면 그 값, 아니면 그 종목 가격만 읽어요
async function currentPrice(d, eng, stockId){
  if(eng && eng.prices) return eng.prices[stockId];
  return readEnginePart(d, 'prices/' + stockId);
}
function recordFlow(d, stockId, won){
  return txn(d.ref(FLOW + '/' + stockId), cur => (cur || 0) + Math.round(won));
}
function playerRef(d, uid){ return d.ref(PLAYERS + '/' + uid); }

/* ---------- 접속할 때·30분마다: 지원금, 예전 아이템 환불, 자동 손절·익절 ---------- */
async function doSync(d, ctx, ctrl, ev){
  const messages = [];
  const advanced = await advance(d, ev);
  const today = E.todayStr();
  // 지갑을 먼저 보고, 꼭 필요한 시세 정보만 읽어요
  const pNow = (await playerRef(d, ctx.uid).once('value')).val();
  const sums = (pNow && pNow.summaries) || {};
  const needNews = Object.keys(sums).length > 0 && (advanced || Object.keys(sums).some(k => typeof sums[k] !== 'object'));
  const news = advanced ? advanced.news : (needNews ? await readEnginePart(d, 'news') : null);
  const newsById = {};
  ((news) ? (Array.isArray(news) ? news : Object.values(news)) : []).forEach(n => { if(n && n.node) newsById[n.id] = n; });
  let created = false, granted = false, refund = 0;
  const r1 = await txn(playerRef(d, ctx.uid), cur => {
    created = false; granted = false; refund = 0;
    if(!cur){ created = true; return E.playerDefaults(); }
    let changed = false;
    // 예전 버전에서 연 요약(값이 1)은 새 형식으로 바꿔 주고, 정리된 기사의 요약은 지워요
    if(cur.summaries && news){
      const next = {};
      Object.keys(cur.summaries).forEach(k => {
        const v = cur.summaries[k];
        if(!newsById[k]){ changed = true; return; }
        if(v && typeof v === 'object') next[k] = v;
        else { next[k] = E.newsAnalysis(newsById[k]); changed = true; }
      });
      cur.summaries = next;
    }
    if(cur.lastAllowance !== today){ cur.cash = (cur.cash || 0) + E.GAME_DAILY_CASH; cur.lastAllowance = today; granted = true; changed = true; }
    if(cur.items){
      Object.keys(E.LEGACY_ITEMS).forEach(k => { if(k in cur.items){ refund += (cur.items[k] || 0) * E.LEGACY_ITEMS[k].price; delete cur.items[k]; changed = true; } });
      if(refund) cur.cash = (cur.cash || 0) + refund;
    }
    return changed ? cur : undefined;
  });
  if(r1.committed && r1.snapshot.val()){
    if(created){ messages.push('주식게임 시작! 시작 자금 ' + fmtWon(E.GAME_START_CASH) + '을 받았어요.'); await gameLog(d, ctrl, ctx.uid, { type:'start', amount: E.GAME_START_CASH }); }
    else if(granted){ messages.push('오늘의 지원금 ' + fmtWon(E.GAME_DAILY_CASH) + '을 받았어요.'); await gameLog(d, ctrl, ctx.uid, { type:'allowance', amount: E.GAME_DAILY_CASH }); }
    if(refund){ messages.push('힌트 아이템이 사라져서, 안 쓴 힌트 값 ' + fmtWon(refund) + '을 돌려드렸어요.'); await gameLog(d, ctrl, ctx.uid, { type:'refund', amount: refund }); }
  }
  // 자동 손절·익절: 조건을 처음 만족한 30분 칸의 가격으로 팔아요 (앱을 늦게 열어도 결과가 같아요)
  let eng = advanced;
  if(!eng && pNow && pNow.orders){
    const [tick, history] = await Promise.all([readEnginePart(d, 'tick'), readEnginePart(d, 'history')]);
    if(tick != null && history) eng = { tick, history };
  }
  if(eng){
    const done = [];
    const r2 = await txn(playerRef(d, ctx.uid), cur => {
      done.length = 0;
      if(!cur || !cur.orders) return undefined;
      const hits = E.findOrderTriggers(cur.orders, eng);
      if(!hits.length) return undefined;
      cur.holdings = cur.holdings || {}; cur.cost = cur.cost || {}; cur.items = cur.items || {};
      hits.forEach(h => {
        const o = cur.orders[h.id]; delete cur.orders[h.id];
        const have = cur.holdings[o.stock] || 0, q = Math.min(o.qty || 0, have);
        if(q <= 0){ cur.items.autoOrder = (cur.items.autoOrder || 0) + 1; done.push({ stock:o.stock, kind:o.kind, qty:0 }); return; }
        cur.cash = (cur.cash || 0) + h.price * q;
        cur.holdings[o.stock] = have - q;
        if(cur.holdings[o.stock] === 0){ delete cur.holdings[o.stock]; delete cur.cost[o.stock]; }
        done.push({ stock:o.stock, kind:o.kind, qty:q, price:h.price, tick:h.tick });
      });
      return cur;
    });
    if(r2.committed){
      for(const x of done){
        if(x.qty > 0){
          await recordFlow(d, x.stock, -x.price * x.qty);
          await gameLog(d, ctrl, ctx.uid, { type:'auto', stock:x.stock, kind:x.kind, qty:x.qty, price:x.price, tick:x.tick });
          messages.push('⚡ 자동 ' + (x.kind === 'stop' ? '손절' : '익절') + ': ' + E.stockName(x.stock) + ' ' + x.qty + '주를 ' + fmtWon(x.price) + '에 팔았어요.');
        } else messages.push(E.stockName(x.stock) + '을(를) 더 이상 갖고 있지 않아 예약이 취소됐어요. 예약권은 돌려드렸어요.');
      }
    }
  }
  return { messages };
}

/* ---------- 매수·매도 ---------- */
async function doTrade(d, ctx, ctrl, ev, b){
  const side = b.side === 'sell' ? 'sell' : 'buy';
  const stock = E.stockInfo(String(b.stock || ''));
  if(!stock) throw httpErr(400, '없는 종목이에요.');
  const qty = Math.floor(Number(b.qty));
  if(!(qty > 0) || qty > 100000000) throw httpErr(400, '수량을 입력해주세요.');
  if(side === 'buy'){
    const st = E.marketStatus(Date.now(), await ev());
    if(!st.open) throw httpErr(400, '수업 시간에는 매수할 수 없어요 (매도는 가능해요). ' + st.reopen + '에 다시 열려요.');
  }
  const eng = await advance(d, ev);
  const price = await currentPrice(d, eng, stock.id);
  if(!(price > 0)) throw httpErr(503, '시세를 확인할 수 없어요.');
  const fill = E.execPrice(side, price, qty);
  let err = '';
  const res = await txn(playerRef(d, ctx.uid), cur => {
    err = '';
    if(!cur) cur = E.playerDefaults();
    cur.holdings = cur.holdings || {}; cur.cost = cur.cost || {};
    const have = cur.holdings[stock.id] || 0;
    if(side === 'buy'){
      const total = fill * qty;
      if((cur.cash || 0) < total){ err = '현금이 부족해요.'; return undefined; }
      cur.cash -= total;
      cur.cost[stock.id] = Math.round(((cur.cost[stock.id] || 0) * have + total) / (have + qty));
      cur.holdings[stock.id] = have + qty;
    } else {
      if(have < qty){ err = '보유한 수량보다 많이 팔 수 없어요.'; return undefined; }
      cur.cash = (cur.cash || 0) + fill * qty;
      cur.holdings[stock.id] = have - qty;
      if(cur.holdings[stock.id] === 0){
        delete cur.holdings[stock.id]; delete cur.cost[stock.id];
        Object.keys(cur.orders || {}).forEach(oid => {
          if(cur.orders[oid].stock === stock.id){ delete cur.orders[oid]; cur.items = cur.items || {}; cur.items.autoOrder = (cur.items.autoOrder || 0) + 1; }
        });
      }
    }
    return cur;
  });
  if(err) throw httpErr(400, err);
  if(!res.committed) throw httpErr(409, '거래하지 못했어요. 잠시 후 다시 시도해주세요.');
  await recordFlow(d, stock.id, (side === 'buy' ? 1 : -1) * fill * qty);
  await gameLog(d, ctrl, ctx.uid, { type: side, stock: stock.id, qty, price: fill });
  return { message: stock.name + ' ' + qty + '주 ' + (side === 'buy' ? '매수' : '매도') + ' 완료 · 체결가 ' + fmtWon(fill) };
}

/* ---------- 상점 (로또 추첨도 서버에서) ---------- */
async function doBuyItem(d, ctx, ctrl, b){
  const item = E.GAME_ITEMS.find(x => x.id === b.item);
  if(!item) throw httpErr(400, '없는 아이템이에요.');
  const today = E.todayStr();
  let err = '', won = null;
  const res = await txn(playerRef(d, ctx.uid), cur => {
    err = ''; won = null;
    if(!cur) cur = E.playerDefaults();
    cur.items = cur.items || {};
    if(!cur.daily || cur.daily.date !== today) cur.daily = { date: today };
    const bought = cur.daily[item.id] || 0;
    if(bought >= item.dailyLimit){ err = item.name + '은(는) 하루에 ' + item.dailyLimit + '개까지만 살 수 있어요.'; return undefined; }
    if((cur.cash || 0) < item.price){ err = '현금이 부족해요.'; return undefined; }
    cur.cash -= item.price;
    cur.daily[item.id] = bought + 1;
    if(item.instant){ won = E.drawLotto(); cur.cash += won.amount; }
    else cur.items[item.id] = (cur.items[item.id] || 0) + 1;
    return cur;
  });
  if(err) throw httpErr(400, err);
  if(!res.committed) throw httpErr(409, '구매하지 못했어요. 잠시 후 다시 시도해주세요.');
  if(item.instant && won){
    await gameLog(d, ctrl, ctx.uid, { type:'lotto', price: item.price, prize: won.amount, tier: won.tier });
    return { lotto: { tier: won.tier, label: won.label, amount: won.amount } };
  }
  await gameLog(d, ctrl, ctx.uid, { type:'item', item: item.id, price: item.price });
  return { message: item.name + '을(를) 샀어요.' };
}

/* ---------- 자동 손절·익절 예약 ---------- */
async function doPlaceOrder(d, ctx, ctrl, ev, b){
  const stock = E.stockInfo(String(b.stock || ''));
  if(!stock) throw httpErr(400, '없는 종목이에요.');
  const eng = await advance(d, ev);
  const now = await currentPrice(d, eng, stock.id);
  const engTick = eng ? eng.tick : await readEnginePart(d, 'tick');
  if(!(now > 0)) throw httpErr(503, '시세를 확인할 수 없어요.');
  const kind = b.kind === 'take' ? 'take' : 'stop';
  const trigger = Math.round(Number(b.trigger || 0) / 10) * 10;
  const sellAll = b.qty == null || String(b.qty).trim() === '';
  const qty = sellAll ? null : Math.floor(Number(b.qty));
  if(!(trigger > 0)) throw httpErr(400, '가격을 입력해주세요.');
  if(kind === 'stop' && trigger >= now) throw httpErr(400, '손절 가격은 지금 가격(' + fmtWon(now) + ')보다 낮아야 해요.');
  if(kind === 'take' && trigger <= now) throw httpErr(400, '익절 가격은 지금 가격(' + fmtWon(now) + ')보다 높아야 해요.');
  if(!sellAll && !(qty > 0)) throw httpErr(400, '수량을 확인해주세요.');
  let err = '', placed = 0;
  const res = await txn(playerRef(d, ctx.uid), cur => {
    err = ''; placed = 0;
    if(!cur || !cur.items || !(cur.items.autoOrder > 0)){ err = '예약권이 없어요. 상점에서 살 수 있어요.'; return undefined; }
    const held = (cur.holdings || {})[stock.id] || 0, q = sellAll ? held : qty;
    if(!(q > 0) || q > held){ err = held ? '보유한 수량(' + held + '주)보다 많이 걸 수 없어요.' : '이 주식을 더 이상 갖고 있지 않아요.'; return undefined; }
    placed = q;
    cur.items.autoOrder -= 1;
    cur.orders = cur.orders || {};
    cur.orders['o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)] = { stock: stock.id, kind, trigger, qty: q, tick: engTick, at: Date.now() };
    return cur;
  });
  if(err) throw httpErr(400, err);
  if(!res.committed) throw httpErr(409, '예약하지 못했어요. 잠시 후 다시 시도해주세요.');
  await gameLog(d, ctrl, ctx.uid, { type:'orderSet', stock: stock.id, kind, trigger, qty: placed });
  return { message: stock.name + ' ' + (kind === 'stop' ? '손절' : '익절') + ' 예약 완료 · ' + fmtWon(trigger) + (kind === 'stop' ? ' 이하' : ' 이상') };
}
async function doCancelOrder(d, ctx, ctrl, b){
  const oid = String(b.orderId || '');
  let stock = '';
  const res = await txn(playerRef(d, ctx.uid), cur => {
    stock = '';
    if(!cur || !cur.orders || !cur.orders[oid]) return undefined;
    stock = cur.orders[oid].stock;
    delete cur.orders[oid];
    cur.items = cur.items || {}; cur.items.autoOrder = (cur.items.autoOrder || 0) + 1;
    return cur;
  });
  if(!res.committed || !stock) throw httpErr(404, '이미 없어진 예약이에요.');
  await gameLog(d, ctrl, ctx.uid, { type:'orderCancel', stock });
  return { message: '예약을 취소했어요. 예약권은 돌려드렸어요.' };
}

/* ---------- 뉴스 요약 ---------- */
async function doUseSummary(d, ctx, ctrl, b){
  const newsId = String(b.newsId || '');
  const raw = await readEnginePart(d, 'news');
  const news = raw ? (Array.isArray(raw) ? raw : Object.values(raw)).filter(Boolean) : [];
  const n = news.find(x => x.id === newsId);
  if(!n || !n.node) throw httpErr(404, '요약할 수 없는 기사예요. (이미 정리된 기사일 수 있어요)');
  const liveIds = new Set(news.map(x => x.id));
  const analysis = E.newsAnalysis(n);
  let err = '', already = false;
  const res = await txn(playerRef(d, ctx.uid), cur => {
    err = ''; already = false;
    if(cur && cur.summaries && cur.summaries[newsId] && typeof cur.summaries[newsId] === 'object'){ already = true; return undefined; }
    if(!cur || !cur.items || !(cur.items.newsSummary > 0)){ err = '뉴스 요약이 없어요. 상점에서 살 수 있어요.'; return undefined; }
    cur.items.newsSummary -= 1;
    const keep = {};
    Object.keys(cur.summaries || {}).forEach(k => { if(liveIds.has(k) && typeof cur.summaries[k] === 'object') keep[k] = cur.summaries[k]; });
    keep[newsId] = analysis;
    cur.summaries = keep;
    return cur;
  });
  if(already) return {};
  if(err) throw httpErr(400, err);
  if(!res.committed) throw httpErr(409, '요약을 열지 못했어요. 잠시 후 다시 시도해주세요.');
  await gameLog(d, ctrl, ctx.uid, { type:'use', item:'newsSummary' });
  return {};
}

/* ---------- 운영자 기능 ---------- */
async function doControl(d, ctrl, ev, b){
  const op = String(b.op || '');
  const id = String(b.id || '');
  const before = ctrl;
  const res = await d.ref(CONTROL).transaction(cur => {
    const c = E.ctrlOf(cur);
    if(op === 'open'){ c.open = true; c.test = false; }
    else if(op === 'shutdown'){ c.open = false; }
    else if(op === 'test'){ if(!c.open) c.test = !c.test; }
    else if(op === 'tester'){ if(!id) return; c.testers = Object.assign({}, c.testers || {}); if(c.testers[id]) delete c.testers[id]; else c.testers[id] = true; }
    else return;
    return c;
  });
  if(!res.committed) throw httpErr(400, '변경하지 못했어요.');
  const after = E.ctrlOf(res.snapshot.val());
  if(!E.marketRunning(before) && E.marketRunning(after)){
    const r = await d.ref(ENGINE).transaction(cur => cur === null ? null : E.fastForward(cur, E.tickNow()));
    const eng = r.snapshot.val();
    if(eng) await publish(d, eng, false);
    else await advance(d, ev);
  }
  return { control: after };
}
async function doReset(d, ctrl, b){
  const pw = String(b.password || '');
  let ok = false;
  try{ ok = pw && (await hashPassword(pw, GAME_RESET_KEY.salt)) === GAME_RESET_KEY.hash; }catch(e){}
  if(!ok){ await new Promise(r => setTimeout(r, 1200)); throw httpErr(403, '비밀번호가 맞지 않아요.'); }
  const n = parseInt(String(ctrl.season || 's1').replace(/\D/g, ''), 10) || 1;
  await d.ref().update({ [PLAYERS]: null, [MARKET]: null, [ENGINE]: null, [FLOW]: null, [LEGACY_FLOW]: null, [CONTROL + '/season']: 's' + (n + 1) });
  return { season: n + 1 };
}
async function findOrphans(d){
  const [u, p] = await Promise.all([d.ref(USERS).once('value'), d.ref(PLAYERS).once('value')]);
  const users = u.val() || {};
  if(!Object.keys(users).length) throw httpErr(503, '계정 목록을 확인할 수 없어 정리하지 않았어요.');
  return Object.keys(p.val() || {}).filter(id => !users[id]);
}

module.exports = handler(async (req, b) => {
  const ctx = await requireUser(req);
  const d = fb.db();
  const action = String(b.action || '');
  const ctrl = await loadCtrl(d);

  if(action === 'control' || action === 'reset' || action === 'orphans' || action === 'cleanup'){
    requireAdmin(ctx);
    if(action === 'control') return doControl(d, ctrl, lazyEvents(d), b);
    if(action === 'reset') return doReset(d, ctrl, b);
    const orphans = await findOrphans(d);
    if(action === 'orphans') return { orphans };
    const want = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
    const del = orphans.filter(id => want.has(id));
    if(del.length){ const up = {}; del.forEach(id => { up[PLAYERS + '/' + id] = null; }); await d.ref().update(up); }
    return { removed: del.length };
  }

  if(!E.canPlay(ctrl, ctx.uid, ctx.isAdmin)) throw httpErr(403, '게임이 잠겨 있어요.');
  if(action === 'sync') return doSync(d, ctx, ctrl, lazyEvents(d));
  if(action === 'trade') return doTrade(d, ctx, ctrl, lazyEvents(d), b);
  if(action === 'buyItem') return doBuyItem(d, ctx, ctrl, b);
  if(action === 'placeOrder') return doPlaceOrder(d, ctx, ctrl, lazyEvents(d), b);
  if(action === 'cancelOrder') return doCancelOrder(d, ctx, ctrl, b);
  if(action === 'useSummary') return doUseSummary(d, ctx, ctrl, b);
  throw httpErr(400, '알 수 없는 요청이에요.');
});
