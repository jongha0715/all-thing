'use strict';
/* 비밀번호 해시 — 예전 앱과 똑같은 방식(PBKDF2-SHA256, 10만 번)이라 기존 비밀번호가 그대로 맞아요.
   해시는 이제 allthing-secret/auth/<아이디> 에만 저장돼서, 친구들은 읽을 수 없어요. */
const crypto = require('crypto');
const fb = require('./fb');

const SECRET_AUTH = 'allthing-secret/auth';
const USERS = 'allthing/allthing-users';

function randomSalt(){ return crypto.randomBytes(16).toString('hex'); }
function hashPassword(pw, salt){
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(pw), Buffer.from(String(salt), 'utf8'), 100000, 32, 'sha256', (err, key) => err ? reject(err) : resolve(key.toString('hex')));
  });
}
function sameHex(a, b){
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function makeSecret(pw){ const salt = randomSalt(); return { hash: await hashPassword(pw, salt), salt }; }
async function verifySecret(sec, pw){
  if(!sec || !sec.hash || !sec.salt) return false;
  return sameHex(await hashPassword(pw, sec.salt), sec.hash);
}
/* 예전 구조에서 계정 목록(allthing-users) 안에 들어 있던 비밀번호/해시를 비밀 공간으로 옮겨요.
   로그인할 때마다 확인하지만, 한 번 옮기고 나면 할 일이 없어서 금방 끝나요. */
let migratedOnce = false;
async function migrateSecrets(){
  if(migratedOnce) return 0;
  const d = fb.db();
  const users = (await d.ref(USERS).once('value')).val() || {};
  const updates = {};
  let n = 0;
  for(const id of Object.keys(users)){
    const u = users[id];
    if(!u || typeof u !== 'object') continue;
    const hasHash = u.pwHash && u.pwSalt, hasPlain = typeof u.password === 'string' && u.password;
    if(!hasHash && !hasPlain && !('pwHash' in u) && !('pwSalt' in u) && !('password' in u)) continue;
    if(hasHash) updates[SECRET_AUTH + '/' + id] = { hash: u.pwHash, salt: u.pwSalt };
    else if(hasPlain) updates[SECRET_AUTH + '/' + id] = await makeSecret(u.password);
    updates[USERS + '/' + id + '/pwHash'] = null;
    updates[USERS + '/' + id + '/pwSalt'] = null;
    updates[USERS + '/' + id + '/password'] = null;
    if(hasPlain && !('pwDefault' in u)) updates[USERS + '/' + id + '/pwDefault'] = u.password === id;
    n++;
  }
  if(n) await d.ref().update(updates);
  migratedOnce = true;
  return n;
}
module.exports = { SECRET_AUTH, hashPassword, makeSecret, verifySecret, migrateSecrets, _resetMigrationFlag: () => { migratedOnce = false; } };
