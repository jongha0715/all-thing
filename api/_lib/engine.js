'use strict';
/* ===================== 주식게임 엔진 (서버 전용) =====================
   예전에는 이 계산이 전부 브라우저에서 돌아서, 페이지를 열어 고치면 돈·로또 확률을 마음대로
   바꿀 수 있었어요. 이제 시세 진행, 매매, 로또, 아이템은 모두 이 파일(서버)에서만 계산해요.
   뉴스의 정답(호재/악재, 영향 %)도 서버에만 있고, 친구들 기기로는 기사 내용만 보내요.

   시간은 항상 한국 시간(KST) 기준으로 계산해요. Vercel 서버는 UTC로 돌기 때문이에요. */

const KST_OFFSET = 9 * 60 * 60 * 1000;
function kst(ms){
  const d = new Date(ms + KST_OFFSET);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
function pad2(n){ return n < 10 ? '0' + n : '' + n; }
function dateKeyMs(ms){ const k = kst(ms); return k.y + '-' + pad2(k.mo) + '-' + pad2(k.d); }
function todayStr(){ return dateKeyMs(Date.now()); }
function hmToMin(str){ const p = str.split(':').map(Number); return p[0] * 60 + p[1]; }

const GAME_TICK_MS = 30 * 60 * 1000;
const GAME_START_CASH = 1000000;
const GAME_DAILY_CASH = 30000;   // 2026-11 개편: 10만 → 3만 (출석만으로 순위가 정해지지 않게)
const GAME_HISTORY_LEN = 48;
const GAME_STOCKS = [
  { id:'meal',    name:'급식컴퍼니',     type:'안정형', sector:'식품',   vol:0.012, base:10000 },
  { id:'library', name:'도서관미디어',   type:'안정형', sector:'미디어', vol:0.016, base:15000 },
  { id:'store',   name:'매점전자',       type:'성장형', sector:'전자',   vol:0.026, base:20000, news:1.4 }, // 뉴스에 가장 민감
  { id:'gym',     name:'체육관건설',     type:'고위험', sector:'건설',   vol:0.034, base:8000 },
  { id:'break',   name:'쉬는시간게임즈', type:'테마형', sector:'게임',   vol:0.024, base:5000, jump:true }
];
const GAME_ITEMS = [
  { id:'autoOrder', name:'자동 손절·익절 예약권', price:30000, dailyLimit:3 },
  { id:'newsSummary', name:'뉴스 요약', price:10000, dailyLimit:5 },
  { id:'lotto', name:'로또', price:30000, dailyLimit:5, instant:true }
];
// 평균 당첨금 ≈ 28,400원 / 30,000원 (약 95%) — 100%를 넘으면 "로또만 하는 게 정답"이 돼서 넘기지 않아요
const LOTTO_PRIZES = [
  { tier:'jackpot', label:'🎉 대박!!',    amount:1000000, p:0.005 },
  { tier:'big',     label:'💰 거액 당첨', amount:300000,  p:0.035 },
  { tier:'mid',     label:'✨ 중액 당첨', amount:60000,   p:0.115 },
  { tier:'small',   label:'🙂 소액 당첨', amount:20000,   p:0.30 },
  { tier:'lose',    label:'😢 꽝',        amount:0,       p:0.545 }
];
/* ---- 배당 (안정형 종목) ----
   매일 16:30에 들고 있는 급식컴퍼니·도서관미디어 주식 가치의 0.3%를 현금으로 줘요.
   단, 어제 16:30과 오늘 16:30에 "둘 다" 들고 있던 수량에만 줘요 (잠깐 샀다 파는 꼼수 방지). */
const DIV_RATE = 0.003;
const DIV_STOCKS = ['meal', 'library'];
const DIV_MIN = 16 * 60 + 30;
const DIV_MAX_DAYS = 14;
function drawLotto(rand){
  let r = (rand || Math.random)();
  for(const pz of LOTTO_PRIZES){ if(r < pz.p) return pz; r -= pz.p; }
  return LOTTO_PRIZES[LOTTO_PRIZES.length - 1];
}
const LEGACY_ITEMS = { hintUp:{ name:'상승 힌트', price:50000 }, hintDown:{ name:'하락 경고', price:50000 } };
const CLASS_PERIODS = [['08:40','09:30'],['09:40','10:30'],['10:40','11:30'],['11:40','12:30'],['13:40','14:30'],['14:40','15:30'],['15:40','16:30']];
const PERIODS_BY_WEEKDAY = { 1:7, 2:7, 3:6, 4:7, 5:5 };

const GAME_NEWS_PROB = 0.3;
/* ---- 뉴스 정리 ----
   진행 중인 연재의 기사는 연재가 끝날 때까지 남겨둬요. 끝난 연재와 단독 기사는
   (1) 나온 지 24시간이 지나거나 (2) 그 뒤로 새 기사가 6개 이상 나오면 자동으로 지워져요. */
const NEWS_DONE_TTL_MS = 24 * 60 * 60 * 1000;
const NEWS_DONE_AFTER = 6;
const NEWS_MAX = 20;

const STORY_NODES = {
  m1:  { arc:'meal', part:1, stock:'meal', dir: 1, str:0.5, emoji:'🚚', title:'급식실에 낯선 트럭이…', next:['m2a','m2b'],
         body:'오늘 아침 급식실 뒷문으로 처음 보는 납품 트럭이 들어가는 모습이 목격됐다. 영양사 선생님은 "아직은 말씀드릴 수 없다"며 웃기만 했다.' },
  m2a: { arc:'meal', part:2, stock:'meal', dir: 1, str:1.2, emoji:'🍗', title:'"오늘 메뉴 실화냐"… 급식 줄 역대 최장', next:['m3a'],
         body:'새 납품업체와 손잡은 첫날, 점심 종이 울리자마자 급식실 앞 줄이 복도 끝까지 이어졌다. 매점은 이날 유난히 한산했다는 후문.' },
  m2b: { arc:'meal', part:2, stock:'meal', dir:-1, str:1.0, emoji:'🧾', title:'새 업체 단가 논란… "반찬이 하나 줄었다"', next:['m3b'],
         body:'납품 단가를 둘러싼 잡음이 이어지는 가운데, 오늘 식판을 받아 든 학생들 사이에서 "뭔가 허전하다"는 반응이 나왔다. 일부는 매점으로 발길을 돌렸다.' },
  m3a: { arc:'meal', part:3, stock:'meal', dir: 1, str:0.9, emoji:'🏆', title:'교육청 관계자, 급식실 깜짝 방문', next:[],
         body:'점심시간에 교육청 관계자들이 급식실을 둘러보고 사진을 여러 장 찍어 갔다. "다른 학교에도 소개하고 싶다"는 말이 들렸다고 한다.' },
  m3b: { arc:'meal', part:3, stock:'meal', dir:-1, str:0.7, emoji:'✍️', title:'학생회, 급식 관련 서명운동 시작', next:[],
         body:'학생회가 급식 관련 서명을 받기 시작했다. 첫날에만 수백 명이 이름을 올렸다. 학교 측은 "의견을 듣고 있다"고만 밝혔다.' },
  s1:  { arc:'store', part:1, stock:'store', dir: 1, str:0.5, emoji:'📦', title:'매점 창고에 쌓인 "비밀 박스"', next:['s2a','s2b'],
         body:'매점 창고에 테이프로 꽁꽁 감긴 상자들이 하루가 다르게 늘고 있다. 매점 사장님은 "곧 알게 될 거야"라는 말만 남겼다.' },
  s2a: { arc:'store', part:2, stock:'store', dir: 1, str:1.3, emoji:'📱', title:'베일 벗은 상자의 정체… 쉬는 시간마다 줄', next:['s3a'],
         body:'상자의 정체는 새로 나온 기기였다. 쉬는 시간 종이 칠 때마다 매점 앞에 줄이 생기고, 몇몇 반에서는 점심 대신 매점을 택했다는 이야기도 나온다.' },
  s2b: { arc:'store', part:2, stock:'store', dir:-1, str:1.0, emoji:'⏳', title:'진열대에 붙은 "입고 지연" 안내문', next:['s3b'],
         body:'오늘 아침 매점 진열대에 "입고가 늦어지고 있습니다"라는 안내문이 붙었다. 기다리던 학생들 사이에서 실망 섞인 한숨이 나왔다.' },
  s3a: { arc:'store', part:3, stock:'store', dir: 1, str:0.8, emoji:'🔋', title:'충전기까지 동났다… "다음 입고 언제예요?"', next:[],
         body:'기기에 이어 충전기와 케이스까지 바닥났다. 쉬는 시간마다 기기로 게임을 하는 학생들도 부쩍 늘었다.' },
  s3b: { arc:'store', part:3, stock:'store', dir:-1, str:0.9, emoji:'🔧', title:'"전원이 안 켜져요"… 매점에 문의 잇따라', next:[],
         body:'뒤늦게 들어온 물건을 산 학생 몇 명이 고장을 호소하고 있다. 매점 측은 "확인 중"이라는 입장이다.' },
  l1:  { arc:'library', part:1, stock:'library', dir: 1, str:0.5, emoji:'📖', title:'도서관에 걸린 의미심장한 포스터', next:['l2a','l2b'],
         body:'도서관 입구에 실루엣만 그려진 포스터가 붙었다. 날짜도 이름도 없다. 사서 선생님은 "유명한 분이 오실지도…"라며 말끝을 흐렸다.' },
  l2a: { arc:'library', part:2, stock:'library', dir: 1, str:1.2, emoji:'✍️', title:'사인회 신청 3분 만에 마감', next:['l3a'],
         body:'포스터의 주인공은 요즘 가장 인기 있는 작가였다. 사인회 신청은 3분 만에 끝났고, 그 작가의 책은 대출 대기만 수십 명이다. 쉬는 시간 게임 대신 책을 펴는 학생이 늘었다.' },
  l2b: { arc:'library', part:2, stock:'library', dir:-1, str:1.0, emoji:'🚫', title:'"부득이한 사정으로…" 행사 취소 공지', next:['l3b'],
         body:'기대를 모았던 도서관 행사가 갑자기 취소됐다. 공지문 앞에서 발길을 돌린 학생들은 휴대폰을 꺼내 들었다.' },
  l3a: { arc:'library', part:3, stock:'library', dir: 1, str:0.9, emoji:'🎬', title:'"그 소설, 영화로 나온대"', next:[],
         body:'사인회 이후 작가의 소설이 영화로 만들어진다는 이야기가 돌고 있다. 도서관 열람실은 오늘도 빈자리가 없다.' },
  l3b: { arc:'library', part:3, stock:'library', dir:-1, str:0.7, emoji:'💤', title:'텅 빈 열람실, 시끌벅적한 복도', next:[],
         body:'행사 취소 이후 열람실은 눈에 띄게 한산해졌다. 반대로 복도에서는 게임 이야기가 끊이지 않는다.' },
  g1:  { arc:'gym', part:1, stock:'gym', dir: 1, str:0.5, emoji:'📐', title:'운동장에 나타난 측량 장비', next:['g2a','g2b'],
         body:'오늘 운동장 한쪽에 측량 장비와 작업복 차림의 어른들이 보였다. 체육 선생님은 "좋은 소식이 있을 수도"라며 윙크했다.' },
  g2a: { arc:'gym', part:2, stock:'gym', dir: 1, str:1.3, emoji:'🏗️', title:'새 체육관 착공식 날짜 확정', next:['g3a'],
         body:'운동장 한편에 새 체육관이 들어선다는 소식이 공식 발표됐다. 운동부는 물론 점심시간 축구팀까지 들떴다. 급식을 서둘러 먹고 운동장으로 뛰어나가는 학생이 늘었다.' },
  g2b: { arc:'gym', part:2, stock:'gym', dir:-1, str:1.2, emoji:'🌧️', title:'"예산 심의 보류"… 공사 계획 표류', next:['g3b'],
         body:'기대를 모았던 공사 계획이 예산 문제로 미뤄졌다. 측량 장비는 운동장에서 자취를 감췄다.' },
  g3a: { arc:'gym', part:3, stock:'gym', dir: 1, str:1.0, emoji:'🏟️', title:'지역 체육대회 유치전에 뛰어들어', next:[],
         body:'새 체육관을 앞세워 지역 체육대회를 유치하자는 이야기가 오가고 있다. 학생회도 적극 돕겠다고 나섰다.' },
  g3b: { arc:'gym', part:3, stock:'gym', dir:-1, str:0.8, emoji:'⚠️', title:'자재 창고에서 빗물이 샌다', next:[],
         body:'미뤄진 공사에 쓰일 자재를 보관하던 창고에 빗물이 샌 것으로 확인됐다. 일부 자재는 다시 사야 할 수도 있다.' },
  b1:  { arc:'break', part:1, stock:'break', dir: 1, str:0.5, emoji:'🎮', title:'쉬는 시간마다 들리는 의문의 효과음', next:['b2a','b2b'],
         body:'요즘 쉬는 시간이면 어느 반에서든 똑같은 효과음이 들린다. 물어봐도 다들 "아직 비밀"이라며 화면을 가린다.' },
  b2a: { arc:'break', part:2, stock:'break', dir: 1, str:1.4, emoji:'🕹️', title:'신작 "교실 탈출", 반 전체 열풍', next:['b3a'],
         body:'효과음의 정체는 새 게임이었다. 반마다 랭킹 경쟁이 붙었고, 도서관 열람실은 평소보다 조용하다는 소식이다.' },
  b2b: { arc:'break', part:2, stock:'break', dir:-1, str:1.2, emoji:'📵', title:'생활지도부 "특별 점검" 예고', next:['b3b'],
         body:'생활지도부가 다음 주부터 휴대폰 사용을 특별히 살펴보겠다고 예고했다. 쉬는 시간 풍경이 달라질지 관심이 쏠린다.' },
  b3a: { arc:'break', part:3, stock:'break', dir: 1, str:1.0, emoji:'🏆', title:'학교 대항 게임 대회 개최 소식', next:[],
         body:'인기에 힘입어 학교 대항 대회가 열린다는 소식이다. 기기를 새로 장만하려는 학생도 늘고 있다.' },
  b3b: { arc:'break', part:3, stock:'break', dir:-1, str:0.9, emoji:'🐛', title:'점검 연장… "접속이 안 돼요"', next:[],
         body:'게임 서버 점검이 예정보다 길어지고 있다. 할 일이 없어진 학생들이 도서관과 운동장으로 흩어졌다.' },
  w1:  { arc:'exam', part:1, fx:{ library: 0.9, break:-0.9, store:-0.3 }, str:1, emoji:'📝', title:'시험 D-7, 교실이 조용해졌다', next:['w2a','w2b'],
         body:'시험이 일주일 앞으로 다가오자 교실 분위기가 확 바뀌었다. 쉬는 시간에도 문제집을 펴는 학생이 많아졌다.' },
  w2a: { arc:'exam', part:2, fx:{ break: 1.0, store: 0.8, meal: 0.5, library:-0.5 }, str:1, emoji:'🎉', title:'"시험 끝!" 축제 일정 발표', next:[],
         body:'시험이 끝나자마자 학교 축제 일정이 발표됐다. 학생들은 무엇을 하고 놀지, 무엇을 사고 먹을지 이야기하느라 바쁘다.' },
  w2b: { arc:'exam', part:2, fx:{ library: 0.8, break:-1.0, gym:-0.5 }, str:1, emoji:'😵', title:'시험 범위가 늘었다고?', next:[],
         body:'시험 범위가 예상보다 넓어졌다는 소식이 전해졌다. 점심시간 축구도, 쉬는 시간 게임도 당분간 쉬겠다는 학생이 늘었다.' },
  x1:  { stock:'meal', dir: 1, str:0.8, emoji:'🌾', title:'올해 쌀 농사, 들려오는 소식은?', next:[],
         body:'뉴스에서 올해 쌀 작황 이야기가 나왔다. "요 몇 년 중 최고"라는 평가가 많다.' },
  x2:  { stock:'store', dir:-1, str:1.0, emoji:'🔥', title:'전자부품 공장 화재 소식', next:[],
         body:'해외 전자부품 공장에서 큰불이 났다는 뉴스가 나왔다. 당분간 물건 구하기가 어려울 수 있다는 말도 나온다.' },
  x3:  { stock:'library', dir:-1, str:0.8, emoji:'📰', title:'종이값 이야기가 또 나왔다', next:[],
         body:'종이와 인쇄 비용이 계속 오른다는 기사가 나왔다. 출판사들이 신간 계획을 다시 살펴보고 있다고 한다.' },
  x4:  { stock:'gym', dir: 1, str:0.8, emoji:'🏃', title:'"체육 시간 늘려주세요" 건의 쏟아져', next:[],
         body:'학생회 건의함에 체육 시간과 시설에 대한 의견이 쏟아졌다. 학교도 긍정적으로 검토하겠다는 입장이다.' },
  x5:  { stock:'break', dir:-1, str:0.9, emoji:'💬', title:'게임 커뮤니티가 밤새 시끄러웠다', next:[],
         body:'어젯밤 한 게임 커뮤니티에서 운영 방식에 대한 불만 글이 수백 개 올라왔다. 회사는 아직 답이 없다.' },
  x6:  { fx:{ meal:1, library:1, store:1, gym:1, break:1 }, str:0.7, emoji:'💰', title:'학교 예산이 늘어난다', next:[],
         body:'내년 학교 예산이 크게 늘어난다는 소식이 전해졌다. 여기저기서 "이번엔 뭐가 바뀔까" 하는 기대가 나온다.' },
  x7:  { fx:{ meal:-1, library:-1, store:-1, gym:-1, break:-1 }, str:0.7, emoji:'🌀', title:'태풍 북상… "다음 주 휴업할 수도"', next:[],
         body:'큰 태풍이 올라오면서 다음 주 휴업 가능성까지 거론되고 있다. 학교 전체가 뒤숭숭하다.' },
  // 2026-11 개편: 종목마다 호재·악재가 비슷하게 나오도록 추가한 단독 기사
  y1:  { stock:'meal', dir:-1, str:1.4, emoji:'🧊', title:'급식실 냉장고가 멈췄다', next:[],
         body:'밤사이 급식실 대형 냉장고가 고장 났다는 소식이다. 오늘 메뉴 일부가 바뀔 수 있다는 안내가 붙었다.' },
  y2:  { stock:'store', dir:-1, str:0.6, emoji:'🔌', title:'"충전이 안 돼요"… 매점 충전기 불량 소문', next:[],
         body:'매점에서 산 충전기가 금방 고장 났다는 이야기가 반마다 돌고 있다. 매점은 "일부 제품만 그렇다"고 해명했다.' },
  y3:  { stock:'library', dir:-1, str:0.5, emoji:'🔨', title:'도서관, 다음 주 열람실 일부 공사', next:[],
         body:'다음 주부터 도서관 열람실 절반이 공사로 문을 닫는다는 공지가 붙었다. 자리가 부족해질 것 같다.' },
  y4:  { stock:'gym', dir:-1, str:1.05, emoji:'🚧', title:'"공사 소음 때문에 수업이 안 돼요"', next:[],
         body:'운동장 쪽 공사 소음에 대한 민원이 잇따르고 있다. 학교는 공사 시간을 줄이는 방안을 검토 중이라고 한다.' },
  y5:  { stock:'break', dir: 1, str:1.45, emoji:'📺', title:'유명 스트리머가 그 게임을 했다', next:[],
         body:'어젯밤 구독자 많은 스트리머가 방송에서 그 게임을 한참 동안 했다. 오늘 아침부터 반마다 그 이야기뿐이다.' },
  y6:  { stock:'meal', dir:-1, str:1.4, emoji:'🥬', title:'채소값이 크게 올랐다', next:[],
         body:'뉴스에서 채소와 과일값이 크게 올랐다는 소식이 나왔다. 급식 반찬이 바뀔 수도 있다는 이야기가 나온다.' }
};
const STORY_STARTS = ['m1','s1','l1','g1','b1','w1'];
const STORY_SINGLES = ['x1','x2','x3','x4','x5','x6','x7','y1','y2','y3','y4','y5','y6'];
const KR_PUBLIC_HOLIDAYS = new Set([
  '2026-10-05','2026-10-09','2026-12-25',
  '2027-01-01','2027-02-06','2027-02-07','2027-02-08','2027-02-09','2027-03-01',
  '2027-05-01','2027-05-03','2027-05-05','2027-05-13','2027-06-06','2027-07-17','2027-07-19',
  '2027-08-15','2027-08-16','2027-09-14','2027-09-15','2027-09-16','2027-10-03','2027-10-04',
  '2027-10-09','2027-10-11','2027-12-25','2027-12-27'
]);
// 일정 탭에서 "휴일"로 체크한 날도 휴일로 쳐요 (events = allthing-events 목록)
function holidayInfo(ms, events){
  const key = dateKeyMs(ms);
  if(KR_PUBLIC_HOLIDAYS.has(key)) return { kind:'holiday' };
  const list = Array.isArray(events) ? events : Object.values(events || {});
  const ev = list.find(e => e && e.holiday && e.date && e.date <= key && key <= (e.endDate || e.date));
  if(ev) return { kind:'holiday', title: ev.title };
  const wd = kst(ms).wd;
  if(wd === 0 || wd === 6) return { kind:'weekend' };
  return null;
}
const NIGHT_START = 23 * 60, NIGHT_END = 7 * 60;
function isNightMinute(mins){ return mins >= NIGHT_START || mins < NIGHT_END; }
function minuteOf(ms){ const k = kst(ms); return k.h * 60 + k.mi; }
function isFrozenTick(tickNo){ return isNightMinute(minuteOf(tickNo * GAME_TICK_MS)); }
function newsSlotTimes(ms, events){
  if(holidayInfo(ms, events)) return ['09:00','12:30','16:30','19:00','21:00'].map(hmToMin);
  const count = PERIODS_BY_WEEKDAY[kst(ms).wd] || 0;
  const breaks = CLASS_PERIODS.slice(0, count).map(p => hmToMin(p[1]));
  return [hmToMin('07:30')].concat(breaks, [hmToMin('19:00'), hmToMin('21:00')]);
}
function isNewsSlot(tickNo, events){
  const ms = tickNo * GAME_TICK_MS;
  return newsSlotTimes(ms, events).indexOf(minuteOf(ms)) !== -1;
}
function marketStatus(ms, events){
  const mins = minuteOf(ms), night = isNightMinute(mins), hol = holidayInfo(ms, events);
  if(hol) return { open:true, night, dayKind: hol.kind };
  const count = PERIODS_BY_WEEKDAY[kst(ms).wd] || 0;
  for(let i = 0; i < count; i++){
    if(mins >= hmToMin(CLASS_PERIODS[i][0]) && mins < hmToMin(CLASS_PERIODS[i][1])) return { open:false, period:i + 1, reopen:CLASS_PERIODS[i][1] };
  }
  return { open:true, night };
}
const STOCK_LINKS = {
  meal:    { store:-0.6, gym: 0.4 },
  store:   { meal:-0.6, break: 0.5 },
  library: { break:-0.6 },
  break:   { library:-0.6, store: 0.5, gym:-0.3 },
  gym:     { meal: 0.4, break:-0.3 }
};
const TYPE_IMPACT = { '안정형':0.6, '성장형':1.0, '고위험':1.6, '테마형':1.3 };
function stockInfo(id){ return GAME_STOCKS.find(s => s.id === id); }
function stockName(id){ const s = stockInfo(id); return s ? s.name : id; }
const ARC_MIN_GAP = 2;
const ARC_EXPIRE = 144;

function pickStory(tickNo, arcs, rand){
  rand = rand || Math.random;
  const ready = Object.keys(arcs).filter(k => tickNo - arcs[k].tick >= ARC_MIN_GAP);
  if(ready.length && rand() < 0.55){
    const key = ready[Math.floor(rand() * ready.length)];
    const nexts = (STORY_NODES[arcs[key].node] || {}).next || [];
    if(nexts.length) return nexts[Math.floor(rand() * nexts.length)];
  }
  const free = STORY_STARTS.filter(id => !arcs[STORY_NODES[id].arc]);
  if(free.length && rand() < 0.45) return free[Math.floor(rand() * free.length)];
  return STORY_SINGLES[Math.floor(rand() * STORY_SINGLES.length)];
}
const GAME_TREND_STEPS = 6;
const SHOCK_WEIGHTS = [0.45, 0.35, 0.2];
const FLOW_DEPTH = 50000000;
const TREND_K = 0.6;
const TREND_NOISE = 0.9;
function makeNewsEvent(tickNo, arcs, nodeIdOverride){
  arcs = arcs || {};
  const nodeId = nodeIdOverride || pickStory(tickNo, arcs), node = STORY_NODES[nodeId];
  const effects = [];
  if(node.fx){
    Object.keys(node.fx).forEach(id => {
      const w = node.fx[id], st = stockInfo(id), d = Math.sign(w);
      effects.push({ stock:id, dir:d, shock: d * (0.03 + Math.random() * 0.04) * Math.abs(w) * node.str * TYPE_IMPACT[st.type], k: TREND_K * Math.abs(w) * 0.9 });
    });
  } else {
    const main = stockInfo(node.stock);
    const mainShock = node.dir * (0.05 + Math.random() * 0.04) * node.str * TYPE_IMPACT[main.type];
    effects.push({ stock:main.id, dir:node.dir, shock:mainShock, k: TREND_K * Math.min(1.2, 0.6 + node.str * 0.4) });
    Object.keys(STOCK_LINKS[main.id] || {}).forEach(id => {
      const c = STOCK_LINKS[main.id][id];
      effects.push({ stock:id, dir: node.dir * Math.sign(c), shock: mainShock * c * 0.6, k: TREND_K * Math.abs(c) * 0.8 });
    });
  }
  const recId = 'n' + tickNo;
  // 연재 번호(run): 같은 연재에 속한 기사끼리 같은 값 — 연재가 끝났는지 알아내는 데 써요
  let run = null;
  if(node.arc) run = node.part === 1 ? recId : ((arcs[node.arc] || {}).run || null);
  const nextArcs = Object.assign({}, arcs);
  Object.keys(nextArcs).forEach(k => { if(tickNo - nextArcs[k].tick > ARC_EXPIRE) delete nextArcs[k]; });
  if(node.arc){
    if(node.next && node.next.length) nextArcs[node.arc] = { node: nodeId, tick: tickNo, run };
    else delete nextArcs[node.arc];
  }
  effects.forEach(e => { const st = stockInfo(e.stock); if(st && st.news) e.shock *= st.news; }); // 매점전자는 뉴스에 1.4배 민감
  return {
    effects, arcs: nextArcs,
    record: { id: recId, tick: tickNo, at: tickNo * GAME_TICK_MS, node: nodeId, emoji: node.emoji, title: node.title, body: node.body,
              arc: node.arc || null, part: node.part || null, run, more: !!(node.next && node.next.length),
              stocks: effects.map(e => e.stock), dir: node.dir || 0,
              fx: effects.map(e => ({ s: e.stock, d: e.dir, p: Math.round(e.shock * 1000) / 10 })) }
  };
}
function tickNow(){ return Math.floor(Date.now() / GAME_TICK_MS); }
function gaussRand(){ let u = 0, v = 0; while(!u) u = Math.random(); while(!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function clampPrice(stock, v){ return Math.max(10, Math.round(Math.max(stock.base * 0.1, v) / 10) * 10); }
function flowImpact(won){ return Math.max(-0.02, Math.min(0.02, (won || 0) / FLOW_DEPTH * 0.05)); }
function stepPrice(stock, price, trend, flowR){
  const drift = trend ? trend.d * trend.k * stock.vol : 0;
  const noise = gaussRand() * stock.vol * (trend ? TREND_NOISE : 1);
  const revert = ((stock.base - price) / stock.base) * (trend ? 0.004 : 0.02);
  let r = noise + drift + revert + (flowR || 0);
  if(trend && trend.sh && trend.w) r += trend.sh * trend.w; // 뉴스 충격이 나눠서 반영되는 부분
  if(stock.jump && !trend && Math.random() < 0.04) r += (Math.random() < 0.5 ? -1 : 1) * (0.06 + Math.random() * 0.08);
  return clampPrice(stock, price * (1 + r));
}

/* ---- 뉴스 정리 ---- */
function newsIsRunning(n, arcs){
  if(!n || !n.arc) return false;
  const a = (arcs || {})[n.arc];
  if(!a) return false;
  if(n.run || a.run) return n.run === a.run; // 같은 연재일 때만 '진행 중'
  return true; // 연재 번호가 생기기 전 기사: 같은 종류의 연재가 진행 중이면 일단 남겨둬요
}
function pruneNews(news, arcs, nowMs){
  const list = (Array.isArray(news) ? news : []).filter(Boolean);
  const keep = list.filter((n, i) => {
    if(newsIsRunning(n, arcs)) return true;
    const age = nowMs - (n.at || (n.tick || 0) * GAME_TICK_MS);
    const newer = list.length - 1 - i;
    return age < NEWS_DONE_TTL_MS && newer < NEWS_DONE_AFTER;
  });
  return keep.slice(-NEWS_MAX);
}

function freshEngine(target){
  const prices = {}, history = {};
  GAME_STOCKS.forEach(s => { prices[s.id] = s.base; history[s.id] = [s.base]; });
  return { tick: target, ver: 1, prices, prev: Object.assign({}, prices), history, trend: {}, news: [], arcs: {}, published: {} };
}
/* 30분 단위로 시세를 진행해요. 이미 최신이면 undefined(아무것도 안 씀). */
function advanceMarket(m, target, extFlow, events, nowMs){
  nowMs = nowMs || Date.now();
  if(!m || !m.prices) return freshEngine(target);
  if(m.tick >= target) return undefined;
  const steps = Math.min(target - m.tick, GAME_HISTORY_LEN);
  let prices = Object.assign({}, m.prices), prev = Object.assign({}, m.prev || m.prices);
  const history = {};
  GAME_STOCKS.forEach(s => {
    if(!prices[s.id]) prices[s.id] = s.base;
    history[s.id] = (m.history && Array.isArray(m.history[s.id])) ? m.history[s.id].slice() : [prices[s.id]];
  });
  const trend = {};
  Object.keys(m.trend || {}).forEach(k => { const t = m.trend[k]; if(t && typeof t.d === 'number') trend[k] = Object.assign({}, t); });
  let news = Array.isArray(m.news) ? m.news.slice() : Object.values(m.news || {});
  const flow = {};
  Object.keys(extFlow || {}).forEach(id => { flow[id] = (flow[id] || 0) + (Number(extFlow[id]) || 0); });
  let arcs = Object.assign({}, m.arcs || {});
  const base = target - steps;
  for(let i = 0; i < steps; i++){
    const tickNo = base + i + 1;
    if(isFrozenTick(tickNo)){
      GAME_STOCKS.forEach(s => { history[s.id].push(prices[s.id]); if(history[s.id].length > GAME_HISTORY_LEN) history[s.id].shift(); });
      continue;
    }
    prev = prices;
    const next = {};
    // 뉴스 충격은 기사가 나온 뒤 30분마다 45% → 35% → 20%로 나눠서 반영돼요 (뉴스를 먼저 읽은 사람이 이득)
    GAME_STOCKS.forEach(s => { const t = trend[s.id]; if(t && t.sh){ t.w = SHOCK_WEIGHTS[t.step || 0] || 0; t.step = (t.step || 0) + 1; } });
    GAME_STOCKS.forEach(s => { next[s.id] = stepPrice(s, prev[s.id], trend[s.id], flowImpact(flow[s.id])); });
    GAME_STOCKS.forEach(s => { const t = trend[s.id]; if(t && t.sh){ delete t.w; if(t.step >= SHOCK_WEIGHTS.length){ delete t.sh; delete t.step; } } });
    Object.keys(flow).forEach(k => delete flow[k]);
    Object.keys(trend).forEach(k => { trend[k].left -= 1; trend[k].k *= 0.8; if(trend[k].left <= 0) delete trend[k]; });
    if(isNewsSlot(tickNo, events) && Math.random() < GAME_NEWS_PROB){
      const ev = makeNewsEvent(tickNo, arcs);
      arcs = ev.arcs;
      ev.effects.forEach(ef => {
        // 앞 뉴스의 충격이 아직 남아 있으면 이어서 반영해요
        const old = trend[ef.stock], rest = (old && old.sh) ? old.sh * SHOCK_WEIGHTS.slice(old.step || 0).reduce((a, b) => a + b, 0) : 0;
        trend[ef.stock] = { d: ef.dir, k: ef.k, left: GAME_TREND_STEPS + SHOCK_WEIGHTS.length, n: ev.record.id, sh: ef.shock + rest, step: 0 };
      });
      news.push(ev.record);
    }
    GAME_STOCKS.forEach(s => { history[s.id].push(next[s.id]); if(history[s.id].length > GAME_HISTORY_LEN) history[s.id].shift(); });
    prices = next;
  }
  // 오래 멈춰 있던 연재도 만료 처리 (뉴스가 안 나온 날이 이어져도 정리되게)
  Object.keys(arcs).forEach(k => { if(target - arcs[k].tick > ARC_EXPIRE) delete arcs[k]; });
  const seen = new Set();
  news = news.filter(n => n && !seen.has(n.id) && seen.add(n.id));
  news = pruneNews(news, arcs, nowMs);
  return { tick: target, ver: (m.ver || 0) + 1, prices, prev, history, trend, news, arcs, published: Object.assign({}, m.published || {}) };
}
// 멈춰 있던 동안의 시간은 가격 변동 없이 건너뛰어요 (셧다운 후 다시 열 때)
function fastForward(m, target){
  if(!m || !m.prices || m.tick >= target) return undefined;
  const pad = Math.min(target - m.tick, GAME_HISTORY_LEN), history = {};
  GAME_STOCKS.forEach(s => {
    const h = ((m.history || {})[s.id] || [m.prices[s.id]]).slice();
    for(let i = 0; i < pad; i++){ h.push(m.prices[s.id]); if(h.length > GAME_HISTORY_LEN) h.shift(); }
    history[s.id] = h;
  });
  return Object.assign({}, m, { tick: target, ver: (m.ver || 0) + 1, history, prev: m.prices, trend: {} });
}

/* ---- 친구들 기기로 보내는 공개용 시세 ----
   기사 본문·제목·시간·연재 이름/편만 보내고, 정답(방향, 영향 %, 관련 종목, 다음 편 여부)은 빼요. */
function publicMarket(eng){
  if(!eng) return null;
  const active = {};
  Object.keys(eng.trend || {}).forEach(k => { const t = eng.trend[k]; if(t && t.n) active[t.n] = true; });
  const news = (Array.isArray(eng.news) ? eng.news : Object.values(eng.news || {})).filter(Boolean).map(n => {
    const o = { id: n.id, tick: n.tick, at: n.at || n.tick * GAME_TICK_MS, emoji: n.emoji || '', title: n.title || '', body: n.body || '' };
    if(n.arc){ o.arc = n.arc; o.part = n.part || 1; }
    if(n.node) o.sum = true; // 요약권을 쓸 수 있는 기사
    return o;
  });
  return { tick: eng.tick, ver: eng.ver || 1, prices: eng.prices, prev: eng.prev || eng.prices, history: eng.history, news, active };
}
function newsEffects(n){ return Array.isArray(n.fx) ? n.fx : (n.stocks || []).map(id => ({ s:id, d:n.dir, p:0 })); }
function strengthLabel(stockId, pct){
  const st = stockInfo(stockId), rel = Math.abs(pct) / (TYPE_IMPACT[(st || {}).type] || 1);
  return rel >= 6 ? '강함' : rel >= 3 ? '보통' : '약함';
}
// 뉴스 요약권으로 알려주는 내용 (좋은 소식인지 나쁜 소식인지는 절대 안 알려줘요)
function newsAnalysis(n){
  const fx = newsEffects(n);
  const node = STORY_NODES[n.node] || {};
  let about, also = [];
  if(node.stock){ about = { kind:'stock', id: node.stock }; also = fx.filter(e => e.s !== node.stock).map(e => e.s); }
  else if(fx.length >= GAME_STOCKS.length) about = { kind:'all' };
  else about = { kind:'multi', ids: fx.map(e => e.s) };
  const mainFx = node.stock ? fx.find(e => e.s === node.stock) : fx.reduce((a, e) => Math.abs(e.p) > Math.abs(a.p) ? e : a, fx[0]);
  const lvl = mainFx && mainFx.p ? strengthLabel(mainFx.s, mainFx.p) : '보통';
  const size = lvl === '강함' ? '큰 소식' : lvl === '보통' ? '보통 소식' : '작은 소식';
  return { about, also, size, more: !!n.more, stocks: fx.map(e => e.s) };
}

/* ---- 지갑 ---- */
function playerDefaults(){
  const t = todayStr();
  return { cash: GAME_START_CASH, holdings:{}, cost:{}, items:{}, lastAllowance: t, daily:{ date: t }, joined: Date.now() };
}
function execPrice(side, price, qty){
  const half = Math.abs(flowImpact(price * qty)) / 2;
  return Math.max(10, Math.round(price * (side === 'buy' ? 1 + half : 1 - half) / 10) * 10);
}
function findOrderTriggers(orders, m){
  const out = [];
  if(!orders || !m || !m.history) return out;
  Object.keys(orders).forEach(id => {
    const o = orders[id], arr = m.history[o.stock];
    if(!o || !arr || !arr.length) return;
    const first = m.tick - (arr.length - 1);
    for(let t = Math.max((o.tick || 0) + 1, first); t <= m.tick; t++){
      const price = arr[arr.length - 1 - (m.tick - t)];
      if((o.kind === 'stop' && price <= o.trigger) || (o.kind === 'take' && price >= o.trigger)){ out.push({ id, price, tick: t }); break; }
    }
  });
  return out;
}

const GAME_CTRL_DEFAULT = { open:true, test:false, testers:{}, season:'s1' };
function ctrlOf(raw){ return Object.assign({}, GAME_CTRL_DEFAULT, raw || {}); }
function marketRunning(c){ return !!(c.open || c.test); }
function canPlay(c, uid, isAdmin){ if(c.open) return true; return !!c.test && (isAdmin || !!(c.testers || {})[uid]); }

/* ---- 배당 정산 ----
   보유 수량은 서버에서만 바뀌니까, 수량이 바뀌기 직전(매매·자동 매도)과 접속할 때마다 이 함수를 먼저 불러요.
   그러면 "지난 정산 이후 지나간 16:30마다 들고 있던 수량 = 지금 수량"이라서 정확하게 계산할 수 있어요. */
function divSnapIndex(ms){ return Math.floor((ms + KST_OFFSET - DIV_MIN * 60000) / 86400000); }
function settleDividend(p, prices, nowMs){
  const cur = divSnapIndex(nowMs || Date.now());
  const h = {}; DIV_STOCKS.forEach(id => { h[id] = ((p.holdings || {})[id]) || 0; });
  const d = p.div;
  if(!d || typeof d.s !== 'number'){ p.div = { s: cur, q: h }; return { amount: 0, days: 0 }; }
  if(cur <= d.s) return { amount: 0, days: 0 };
  let amount = 0, prevQ = Object.assign({}, d.q || {});
  const days = Math.min(cur - d.s, DIV_MAX_DAYS);
  for(let i = 0; i < days; i++){
    DIV_STOCKS.forEach(id => { const q = Math.min(prevQ[id] || 0, h[id]); amount += q * ((prices || {})[id] || 0) * DIV_RATE; });
    prevQ = h;
  }
  amount = Math.floor(amount);
  if(amount > 0) p.cash = (p.cash || 0) + amount;
  p.div = { s: cur, q: h };
  return { amount, days };
}

module.exports = {
  KST_OFFSET, kst, pad2, todayStr, dateKeyMs, GAME_TICK_MS, GAME_START_CASH, GAME_DAILY_CASH, GAME_HISTORY_LEN,
  GAME_STOCKS, GAME_ITEMS, LOTTO_PRIZES, drawLotto, LEGACY_ITEMS, STORY_NODES, NEWS_DONE_TTL_MS, NEWS_DONE_AFTER, NEWS_MAX,
  holidayInfo, isFrozenTick, isNewsSlot, marketStatus, stockInfo, stockName, makeNewsEvent, tickNow, clampPrice,
  flowImpact, advanceMarket, fastForward, pruneNews, newsIsRunning, publicMarket, newsAnalysis, playerDefaults,
  execPrice, findOrderTriggers, GAME_TREND_STEPS, ctrlOf, marketRunning, canPlay, freshEngine,
  DIV_RATE, DIV_STOCKS, settleDividend, divSnapIndex, SHOCK_WEIGHTS
};
