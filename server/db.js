// server/db.js
// ------------------------------------------------------------
// SQLite 데이터베이스 관련 로직을 한 곳에 모아두는 파일입니다.
// - users 테이블: 닉네임별 보유 조각(실제 컬럼명은 chips)
// - game_history 테이블: 승자/패자/배팅액/시간 기록
// ------------------------------------------------------------

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// SQLite 파일 저장 위치입니다.
// 기본값은 프로젝트 루트의 database.db 이지만,
// 배포 환경(Railway Volume 등)에서는 DB_PATH 환경변수로 경로를 바꿀 수 있습니다.
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath);

/**
 * SQL run()을 Promise 형태로 감싸는 헬퍼입니다.
 * INSERT / UPDATE / DELETE 등에 사용합니다.
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        lastID: this.lastID,
        changes: this.changes,
      });
    });
  });
}

/**
 * SQL get()을 Promise 형태로 감싸는 헬퍼입니다.
 * 단일 행 조회에 사용합니다.
 */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

/**
 * SQL all()을 Promise 형태로 감싸는 헬퍼입니다.
 * 다중 행 조회에 사용합니다.
 */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

/**
 * 테이블 생성 및 기본 초기화.
 * 주의:
 * - 사용자 요청의 초기 명세에 맞춰 users 테이블 컬럼명은 chips로 유지합니다.
 * - 하지만 실제 게임 UI에서는 "조각"이라는 용어를 사용합니다.
 */
async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      chips INTEGER NOT NULL DEFAULT 1000
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      winner_id TEXT NOT NULL,
      loser_id TEXT NOT NULL,
      bet_amount INTEGER NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);
}

/**
 * 사용자가 없으면 자동 생성합니다.
 * 로그인/회원가입 없이 닉네임만 입력하므로,
 * 서버가 최초 접속 시 자동으로 계정을 만드는 구조입니다.
 */
async function ensureUser(userId) {
  const exists = await get('SELECT id, chips FROM users WHERE id = ?', [userId]);
  if (exists) {
    return exists;
  }

  await run('INSERT INTO users (id, chips) VALUES (?, 1000)', [userId]);
  return get('SELECT id, chips FROM users WHERE id = ?', [userId]);
}

/**
 * 사용자 1명의 현재 잔액 조회.
 */
async function getUser(userId) {
  return get('SELECT id, chips FROM users WHERE id = ?', [userId]);
}

/**
 * 현재 보유 조각(chips)을 원하는 숫자로 직접 설정합니다.
 * 관리자 기능에서 유용합니다.
 */
async function setChips(userId, amount) {
  await ensureUser(userId);
  await run('UPDATE users SET chips = ? WHERE id = ?', [amount, userId]);
  return getUser(userId);
}

/**
 * 현재 보유 조각(chips)을 증감합니다.
 * 음수를 넣으면 차감, 양수를 넣으면 지급입니다.
 */
async function adjustChips(userId, delta) {
  await ensureUser(userId);
  await run('UPDATE users SET chips = chips + ? WHERE id = ?', [delta, userId]);
  return getUser(userId);
}

/**
 * 사용자가 특정 금액 이상을 보유 중인지 확인합니다.
 */
async function hasEnoughChips(userId, requiredAmount) {
  const user = await ensureUser(userId);
  return user.chips >= requiredAmount;
}

/**
 * 게임 결과를 history에 여러 건 한 번에 저장합니다.
 * rows 예시:
 * [
 *   { winner_id: 'A', loser_id: 'B', bet_amount: 3, timestamp: '...' },
 *   ...
 * ]
 */
async function insertGameHistory(rows) {
  if (!rows || rows.length === 0) {
    return;
  }

  for (const row of rows) {
    await run(
      'INSERT INTO game_history (winner_id, loser_id, bet_amount, timestamp) VALUES (?, ?, ?, ?)',
      [row.winner_id, row.loser_id, row.bet_amount, row.timestamp]
    );
  }
}

/**
 * 특정 사용자 최근 전적 조회용 함수.
 * 현재 UI에서는 필수는 아니지만, 추후 확장 시 바로 쓸 수 있도록 남겨둡니다.
 */
async function getRecentHistoryForUser(userId, limit = 20) {
  return all(
    `
    SELECT winner_id, loser_id, bet_amount, timestamp
    FROM game_history
    WHERE winner_id = ? OR loser_id = ?
    ORDER BY id DESC
    LIMIT ?
    `,
    [userId, userId, limit]
  );
}

module.exports = {
  db,
  initDb,
  ensureUser,
  getUser,
  setChips,
  adjustChips,
  hasEnoughChips,
  insertGameHistory,
  getRecentHistoryForUser,
};
