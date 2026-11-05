'use strict';
/* POST /api/login  { id, pw }  →  { token }
   비밀번호는 서버에서만 확인하고, 맞으면 Firebase 로그인용 토큰을 줘요.
   같은 아이디로 10분 안에 5번 틀리면 5분 동안 막아요. */
const fb = require('./_lib/fb');
const { handler, httpErr, validId, txn, USERS } = require('./_lib/http');
const { SECRET_AUTH, verifySecret, migrateSecrets } = require('./_lib/pw');

const FAILS = 'allthing-secret/fails';
const FAIL_WINDOW = 10 * 60 * 1000, FAIL_LIMIT = 5, FAIL_LOCK = 5 * 60 * 1000;

module.exports = handler(async (req, b) => {
  const id = String(b.id || '').trim(), pw = String(b.pw || '').trim();
  if(!id || !pw) throw httpErr(400, '아이디와 비밀번호를 입력해주세요.');
  if(!validId(id) || pw.length > 200) throw httpErr(401, '아이디 또는 비밀번호가 올바르지 않아요.');
  const d = fb.db();
  await migrateSecrets();
  const [uSnap, sSnap, fSnap] = await Promise.all([
    d.ref(USERS + '/' + id).once('value'),
    d.ref(SECRET_AUTH + '/' + id).once('value'),
    d.ref(FAILS + '/' + id).once('value')
  ]);
  const user = uSnap.val(), sec = sSnap.val(), f = fSnap.val(), now = Date.now();
  if(f && f.until && f.until > now){
    throw httpErr(429, '비밀번호를 여러 번 틀려서 잠시 막혔어요. ' + Math.ceil((f.until - now) / 60000) + '분 뒤에 다시 시도해주세요.');
  }
  const ok = !!user && await verifySecret(sec, pw);
  if(!ok){
    if(user){
      await txn(d.ref(FAILS + '/' + id), c => {
        const t = Date.now();
        let x = (c && t - (c.first || 0) < FAIL_WINDOW) ? Object.assign({}, c) : { n:0, first:t };
        delete x.until;
        x.n = (x.n || 0) + 1;
        if(x.n >= FAIL_LIMIT) x = { n:0, first:t, until: t + FAIL_LOCK };
        return x;
      });
    }
    throw httpErr(401, '아이디 또는 비밀번호가 올바르지 않아요.');
  }
  if(f) await d.ref(FAILS + '/' + id).set(null);
  const token = await fb.auth().createCustomToken(id);
  return { token, id };
});
