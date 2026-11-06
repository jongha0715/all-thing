'use strict';
/* GET /api/widget?k=<위젯 열쇠>
   홈 화면 위젯(아이폰 Scriptable, 갤럭시 위젯 앱)이 30분마다 부르는 주소예요.
   - 로그인 대신 "위젯 열쇠"로 누구인지 알아내요. 열쇠는 내 정보 탭에서 만들고, 언제든 새로 바꿀 수 있어요.
   - 이 주소로는 읽기만 할 수 있어요 (돈·주식은 절대 못 바꿔요).
   - 꼭 필요한 작은 값만 읽어서 Firebase 사용량이 아주 적어요. */
const fb = require('./_lib/fb');
const { send, USERS } = require('./_lib/http');
const E = require('./_lib/engine');

const KEYS = 'allthing-secret/widgetKeys';
const DAYS = ['일','월','화','수','목','금','토'];
const SCHOOL_END_MIN = 17 * 60;          // 이 시각이 지나면 다음 등교일 시간표를 보여줘요
const LUNCH_END_MIN = 13 * 60 + 30;      // 이 시각이 지나면 석식, 저녁 7시 이후엔 내일 중식

function kstParts(ms){ return E.kst(ms); }
function keyOf(ms){ return E.dateKeyMs(ms); }
function asLines(v){
  if(Array.isArray(v)) return v.map(x => String(x || '').trim()).filter(Boolean);
  if(typeof v === 'string') return v.split(/\n|,/).map(x => x.trim()).filter(Boolean);
  return [];
}
function dayLabel(ms){ const k = kstParts(ms); return k.mo + '/' + k.d + ' (' + DAYS[k.wd] + ')'; }
function daysBetween(fromKey, toKey){ return Math.round((Date.parse(toKey + 'T00:00:00Z') - Date.parse(fromKey + 'T00:00:00Z')) / 86400000); }
const won = n => Math.round(n || 0).toLocaleString('ko-KR') + '원';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if(req.method !== 'GET') return send(res, 405, { ok:false, error:'GET only' });
  const k = String((req.query && req.query.k) || new URL(req.url, 'http://x').searchParams.get('k') || '');
  if(!/^[a-f0-9]{40}$/.test(k)) return send(res, 401, { ok:false, error:'위젯 주소가 올바르지 않아요. 앱의 내 정보 탭에서 주소를 다시 복사해주세요.' });
  try{
    const d = fb.db();
    const ent = (await d.ref(KEYS + '/' + k).once('value')).val();
    if(!ent || !ent.uid) return send(res, 401, { ok:false, error:'위젯 주소가 바뀌었거나 없어졌어요. 앱의 내 정보 탭에서 새 주소를 복사해주세요.' });
    const uid = ent.uid;
    const now = Date.now(), kp = kstParts(now), mins = kp.h * 60 + kp.mi;
    const today = keyOf(now), tomorrow = keyOf(now + 86400000);

    // 시간표를 보여줄 날: 평일 17시 전이면 오늘, 아니면 다음 평일
    let ttMs = now;
    if(kp.wd === 0 || kp.wd === 6 || mins >= SCHOOL_END_MIN){
      ttMs = now + 86400000;
      while([0, 6].includes(kstParts(ttMs).wd)) ttMs += 86400000;
    }
    const ttDay = DAYS[kstParts(ttMs).wd];

    const [userS, mealsS, examsS, playerS, pricesS, prevS, ctrlS] = await Promise.all([
      d.ref(USERS + '/' + uid).once('value'),
      d.ref('allthing/allthing-meals').orderByChild('date').startAt(today).endAt(tomorrow).once('value'),
      d.ref('allthing/allthing-exams').once('value'),
      d.ref('allthing/allthing-game/players/' + uid).once('value'),
      d.ref('allthing/allthing-game/market/prices').once('value'),
      d.ref('allthing/allthing-game/market/prev').once('value'),
      d.ref('allthing/allthing-game/control').once('value')
    ]);
    const user = userS.val();
    if(!user) return send(res, 401, { ok:false, error:'계정을 찾을 수 없어요.' });

    /* 급식: 점심 전엔 중식, 점심 후엔 석식, 저녁 7시 이후엔 내일 중식 */
    const meals = Object.values(mealsS.val() || {}).filter(Boolean);
    const mToday = meals.find(m => m.date === today), mTomorrow = meals.find(m => m.date === tomorrow);
    let mealTitle = '오늘 중식', mealList = asLines(mToday && mToday.lunch);
    if(mins >= 19 * 60){ mealTitle = '내일 중식'; mealList = asLines(mTomorrow && mTomorrow.lunch); }
    else if(mins >= LUNCH_END_MIN){
      const dinner = asLines(mToday && mToday.dinner);
      if(dinner.length){ mealTitle = '오늘 석식'; mealList = dinner; }
      else { mealTitle = '내일 중식'; mealList = asLines(mTomorrow && mTomorrow.lunch); }
    }
    const mealText = mealList.length ? mealList.join(' · ') : '급식 정보가 없어요';

    /* 시간표: 내 학번 것만 읽어요 */
    let ttList = [], ttText = '';
    if(user.studentNo && /^[^.#$\[\]\/]+$/.test(String(user.studentNo))){
      const grid = (await d.ref('allthing/allthing-timetables/' + user.studentNo).once('value')).val();
      const row = grid && grid[ttDay] ? (Array.isArray(grid[ttDay]) ? grid[ttDay] : Object.values(grid[ttDay])) : [];
      ttList = row.map((s, i) => ({ p: i + 1, s: String(s || '').trim() })).filter(x => x.s);
      ttText = ttList.length ? ttList.map(x => x.p + ' ' + x.s).join('  ') : '등록된 수업이 없어요';
    } else ttText = '내 정보에서 학번을 설정해주세요';
    const ttTitle = (ttMs === now ? '오늘' : (keyOf(ttMs) === tomorrow ? '내일' : DAYS[kstParts(ttMs).wd] + '요일')) + ' 시간표';

    /* 다가오는 수행평가·시험 (2주 안, 최대 3개) */
    const exams = (Array.isArray(examsS.val()) ? examsS.val() : Object.values(examsS.val() || {})).filter(x => x && x.date && (x.endDate || x.date) >= today)
      .sort((a, b) => a.date.localeCompare(b.date)).filter(x => daysBetween(today, x.date) <= 14).slice(0, 3)
      .map(x => {
        const dd = daysBetween(today, x.date);
        const label = dd > 0 ? 'D-' + dd : (dd === 0 ? 'D-DAY' : '진행 중');
        return { dday: label, subject: x.subject || '', title: x.title || '', kind: x.kind === 'exam' ? '시험' : '수행' };
      });
    const examText = exams.length ? exams.map(x => x.dday + ' ' + x.subject + ' ' + x.title).join('\n') : '2주 안에 수행평가·시험이 없어요';

    /* 내 주식: 총자산과 최근 30분 변동 */
    let stock = null, stockText = '주식게임 정보가 없어요', stockUp = null;
    const player = playerS.val(), prices = pricesS.val() || {}, prev = prevS.val() || prices;
    const ctrl = E.ctrlOf(ctrlS.val());
    if(player && E.canPlay(ctrl, uid, !!user.isAdmin)){
      let value = 0, change = 0;
      Object.keys(player.holdings || {}).forEach(id => {
        const q = player.holdings[id] || 0;
        value += q * (prices[id] || 0);
        change += q * ((prices[id] || 0) - (prev[id] || prices[id] || 0));
      });
      const total = (player.cash || 0) + value;
      const base = total - change;
      const pct = base > 0 ? (change / base) * 100 : 0;
      stock = { total, cash: player.cash || 0, value, change, pct: Math.round(pct * 100) / 100 };
      stockUp = change > 0 ? true : change < 0 ? false : null;
      stockText = '총자산 ' + won(total) + (change ? ' (' + (change > 0 ? '▲' : '▼') + Math.abs(stock.pct).toFixed(2) + '%)' : '');
    } else if(!E.canPlay(ctrl, uid, !!user.isAdmin)) stockText = '주식게임이 잠겨 있어요';

    res.setHeader('Cache-Control', 'private, max-age=120');
    return send(res, 200, {
      ok: true,
      name: user.displayName || uid,
      date: dayLabel(now),
      updated: E.pad2(kp.h) + ':' + E.pad2(kp.mi) + ' 기준',
      mealTitle, meal: mealList, mealText,
      ttTitle, timetable: ttList, ttText,
      exams, examText,
      stock, stockText, stockUp,
      url: 'https://ali-thing.vercel.app/'
    });
  }catch(e){
    console.error(e);
    return send(res, 500, { ok:false, error:'잠시 후 다시 시도해주세요.' });
  }
};
