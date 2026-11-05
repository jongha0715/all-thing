'use strict';
/* Firebase 관리자(Admin) 연결 — 서버에서만 써요.
   Vercel 환경 변수 FIREBASE_SERVICE_ACCOUNT 에 서비스 계정 키(JSON 전체)를 넣어야 해요.
   이 키는 절대 index.html이나 GitHub에 올리면 안 돼요. */
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');

const DEFAULT_DB_URL = 'https://all-thing-fbac5-default-rtdb.firebaseio.com';
let app = null;
function fbApp(){
  if(app) return app;
  if(getApps().length){ app = getApps()[0]; return app; }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT 환경 변수가 없어요.');
  const sa = JSON.parse(raw);
  app = initializeApp({ credential: cert(sa), databaseURL: process.env.FIREBASE_DATABASE_URL || DEFAULT_DB_URL });
  return app;
}
module.exports = {
  db: () => getDatabase(fbApp()),
  auth: () => getAuth(fbApp())
};
