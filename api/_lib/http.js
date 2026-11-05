'use strict';
const fb = require('./fb');

const USERS = 'allthing/allthing-users';

function httpErr(status, message){ const e = new Error(message); e.status = status; return e; }
function send(res, status, obj){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
async function readBody(req){
  if(req.body && typeof req.body === 'object') return req.body;
  if(typeof req.body === 'string'){ try{ return JSON.parse(req.body); }catch(e){ return {}; } }
  const chunks = [];
  let size = 0;
  for await (const c of req){ size += c.length; if(size > 64 * 1024) throw httpErr(413, '요청이 너무 커요.'); chunks.push(c); }
  try{ return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }catch(e){ return {}; }
}
// 로그인한 사람 확인: Firebase 로그인 토큰을 검사하고, 계정 정보를 서버에서 다시 읽어요.
async function requireUser(req){
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if(!m) throw httpErr(401, '로그인이 필요해요.');
  let decoded;
  try{ decoded = await fb.auth().verifyIdToken(m[1]); }
  catch(e){ throw httpErr(401, '로그인이 만료됐어요. 다시 로그인해주세요.'); }
  const uid = decoded.uid;
  const user = (await fb.db().ref(USERS + '/' + uid).once('value')).val();
  if(!user) throw httpErr(401, '계정을 찾을 수 없어요. 다시 로그인해주세요.');
  return { uid, user, isAdmin: !!user.isAdmin };
}
function requireAdmin(ctx){ if(!ctx.isAdmin) throw httpErr(403, '관리자만 할 수 있어요.'); }
// Firebase 경로에 쓸 수 없는 글자(. # $ [ ] /)가 든 아이디는 거절
function validId(id){ return typeof id === 'string' && id.length > 0 && id.length <= 40 && !/[.#$\[\]\/\s]/.test(id); }
function handler(fn){
  return async (req, res) => {
    if(req.method !== 'POST') return send(res, 405, { ok:false, error:'POST only' });
    try{
      const body = await readBody(req);
      const out = await fn(req, body || {});
      send(res, 200, Object.assign({ ok:true }, out || {}));
    }catch(e){
      const status = e.status || 500;
      if(status >= 500) console.error(e);
      send(res, status, { ok:false, error: e.status ? e.message : '서버에서 문제가 생겼어요. 잠시 후 다시 시도해주세요.' });
    }
  };
}
/* 트랜잭션 도우미: fn이 undefined를 돌려주면 '아무것도 안 바꿈'.
   (Firebase는 처음에 값을 모른 채 null로 한 번 불러요. 그때 그냥 멈추면 실제 값을 못 보고 끝나서,
    null일 때는 null을 써 보도록 해서 서버의 진짜 값으로 다시 시도하게 해요.) */
function txn(ref, fn){
  return ref.transaction(cur => {
    const out = fn(cur);
    if(out === undefined) return cur === null ? null : undefined;
    return out;
  });
}
module.exports = { httpErr, send, readBody, requireUser, requireAdmin, validId, handler, txn, USERS };
