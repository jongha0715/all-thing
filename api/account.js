'use strict';
/* POST /api/account  { action, ... }   (로그인 토큰 필요)
   비밀번호가 관련된 일과, 여러 곳을 한꺼번에 바꿔야 하는 계정 작업을 서버에서 처리해요.
   - changePassword {pw}                         : 내 비밀번호 바꾸기
   - setPassword {id, pw} / resetPassword {id}   : (관리자) 다른 사람 비밀번호 설정/초기화
   - create {id, name, no}                       : (관리자) 계정 추가 — 처음 비밀번호는 아이디와 같아요
   - rename {id, newId, name, isAdmin, pw?}      : (관리자) 아이디 바꾸기 — 게임 기록·비밀번호도 같이 옮겨요
   - delete {id}                                 : (관리자) 계정 삭제 — 게임 기록·안 쓰는 시간표도 같이 지워요 */
const fb = require('./_lib/fb');
const { handler, httpErr, requireUser, requireAdmin, validId, USERS } = require('./_lib/http');
// 관리자 계정(다른 관리자)의 비밀번호·아이디·삭제는 최고 관리자만 할 수 있어요
function guardTarget(ctx, target){
  if(target && target.isSuper && !ctx.isSuper) throw httpErr(403, '최고 관리자 계정은 바꿀 수 없어요.');
  if(target && target.isAdmin && !ctx.isSuper) throw httpErr(403, '관리자 계정은 최고 관리자만 바꿀 수 있어요.');
}
const { SECRET_AUTH, makeSecret } = require('./_lib/pw');
const crypto = require('crypto');
const WKEYS = 'allthing-secret/widgetKeys', WKEY_OF = 'allthing-secret/widgetKeyOf';

const PLAYERS = 'allthing/allthing-game/players';
const TIMETABLES = 'allthing/allthing-timetables';

function cleanPw(pw){ return String(pw == null ? '' : pw).trim(); }
function needPw(pw){ if(pw.length < 6) throw httpErr(400, '비밀번호는 6자 이상으로 입력해주세요.'); if(pw.length > 100) throw httpErr(400, '비밀번호가 너무 길어요.'); }
function cleanName(s, fallback){ s = String(s == null ? '' : s).trim().slice(0, 20); return s || fallback; }

module.exports = handler(async (req, b) => {
  const ctx = await requireUser(req);
  const d = fb.db();
  const action = String(b.action || '');

  if(action === 'changePassword'){
    const pw = cleanPw(b.pw); needPw(pw);
    await d.ref().update({ [SECRET_AUTH + '/' + ctx.uid]: await makeSecret(pw), [USERS + '/' + ctx.uid + '/pwDefault']: false });
    return {};
  }

  /* 홈 화면 위젯 열쇠: 내 것 보기 / 새로 만들기(예전 열쇠는 바로 막혀요) */
  if(action === 'widgetKeyGet'){
    return { key: (await d.ref(WKEY_OF + '/' + ctx.uid).once('value')).val() || null };
  }
  if(action === 'widgetKeyNew'){
    const old = (await d.ref(WKEY_OF + '/' + ctx.uid).once('value')).val();
    const key = crypto.randomBytes(20).toString('hex');
    const up = { [WKEYS + '/' + key]: { uid: ctx.uid, at: Date.now() }, [WKEY_OF + '/' + ctx.uid]: key };
    if(old) up[WKEYS + '/' + old] = null;
    await d.ref().update(up);
    return { key };
  }
  if(action === 'widgetKeyDelete'){
    const old = (await d.ref(WKEY_OF + '/' + ctx.uid).once('value')).val();
    const up = { [WKEY_OF + '/' + ctx.uid]: null };
    if(old) up[WKEYS + '/' + old] = null;
    await d.ref().update(up);
    return {};
  }

  requireAdmin(ctx);
  const id = String(b.id || '').trim();
  if(!validId(id)) throw httpErr(400, '아이디가 올바르지 않아요.');

  if(action === 'setPassword' || action === 'resetPassword'){
    const user = (await d.ref(USERS + '/' + id).once('value')).val();
    if(!user) throw httpErr(404, '없는 계정이에요.');
    if(id !== ctx.uid) guardTarget(ctx, user);
    const reset = action === 'resetPassword';
    const pw = reset ? id : cleanPw(b.pw);
    if(!reset) needPw(pw);
    await d.ref().update({ [SECRET_AUTH + '/' + id]: await makeSecret(pw), [USERS + '/' + id + '/pwDefault']: reset });
    return {};
  }

  if(action === 'create'){
    const exists = (await d.ref(USERS + '/' + id).once('value')).val();
    if(exists) throw httpErr(409, '이미 사용 중인 아이디예요.');
    const record = { displayName: cleanName(b.name, id), studentNo: String(b.no || id).trim().slice(0, 10) || id, isAdmin: false, pwDefault: true };
    await d.ref().update({ [USERS + '/' + id]: record, [SECRET_AUTH + '/' + id]: await makeSecret(id) });
    return { record };
  }

  if(action === 'rename'){
    const newId = String(b.newId || '').trim();
    if(!validId(newId)) throw httpErr(400, '새 아이디가 올바르지 않아요.');
    if(newId === id) throw httpErr(400, '아이디가 그대로예요.');
    const [uS, nS, sS, pS, npS] = await Promise.all([
      d.ref(USERS + '/' + id).once('value'), d.ref(USERS + '/' + newId).once('value'),
      d.ref(SECRET_AUTH + '/' + id).once('value'), d.ref(PLAYERS + '/' + id).once('value'), d.ref(PLAYERS + '/' + newId).once('value')
    ]);
    const user = uS.val();
    if(!user) throw httpErr(404, '없는 계정이에요.');
    if(nS.val()) throw httpErr(409, '이미 사용 중인 아이디예요.');
    if(id !== ctx.uid) guardTarget(ctx, user);
    const record = Object.assign({}, user, { displayName: cleanName(b.name, user.displayName || newId) });
    if(typeof b.isAdmin === 'boolean' && ctx.isSuper) record.isAdmin = b.isAdmin; // 관리자 권한은 최고 관리자만
    if(id === ctx.uid) record.isAdmin = true; // 스스로 관리자 권한을 잃지 않게
    if(!record.isAdmin) delete record.isSuper;
    delete record.pwHash; delete record.pwSalt; delete record.password;
    const updates = { [USERS + '/' + newId]: record, [USERS + '/' + id]: null, [SECRET_AUTH + '/' + id]: null, [SECRET_AUTH + '/' + newId]: sS.val() };
    const pw = cleanPw(b.pw);
    if(pw){ needPw(pw); updates[SECRET_AUTH + '/' + newId] = await makeSecret(pw); updates[USERS + '/' + newId].pwDefault = false; }
    if(pS.val() && !npS.val()){ updates[PLAYERS + '/' + newId] = pS.val(); updates[PLAYERS + '/' + id] = null; }
    const wk = (await d.ref(WKEY_OF + '/' + id).once('value')).val(); // 위젯 열쇠도 새 아이디로 옮겨요
    if(wk){ updates[WKEY_OF + '/' + id] = null; updates[WKEY_OF + '/' + newId] = wk; updates[WKEYS + '/' + wk + '/uid'] = newId; }
    await d.ref().update(updates);
    return { self: id === ctx.uid };
  }

  if(action === 'delete'){
    if(id === ctx.uid) throw httpErr(400, '현재 로그인한 계정은 삭제할 수 없어요.');
    const users = (await d.ref(USERS).once('value')).val() || {};
    const user = users[id];
    if(!user) throw httpErr(404, '없는 계정이에요.');
    guardTarget(ctx, user);
    const updates = { [USERS + '/' + id]: null, [SECRET_AUTH + '/' + id]: null, [PLAYERS + '/' + id]: null, ['allthing-secret/fails/' + id]: null, [WKEY_OF + '/' + id]: null };
    const wk = (await d.ref(WKEY_OF + '/' + id).once('value')).val();
    if(wk) updates[WKEYS + '/' + wk] = null;
    const no = user.studentNo;
    if(no && validId(String(no)) && !Object.keys(users).some(k => k !== id && (users[k] || {}).studentNo === no)) updates[TIMETABLES + '/' + no] = null;
    await d.ref().update(updates);
    return {};
  }

  throw httpErr(400, '알 수 없는 요청이에요.');
});
