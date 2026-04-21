// server/server.js
// -----------------------------------------------------------------------------
// 섯다 멀티플레이 서버 진입점입니다.
// - Express: 정적 파일 서비스(public 폴더)
// - Socket.IO: 실시간 멀티플레이 / 룸 관리
// - sqlite3: 사용자 조각(실제 DB 컬럼명 chips) 저장
// - 권위적 서버 모델: 카드/족보/배팅/승패/조각 정산을 서버가 전부 결정
// -----------------------------------------------------------------------------

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const {
  initDb,
  ensureUser,
  getUser,
  adjustChips,
  hasEnoughChips,
  insertGameHistory,
} = require('./db');

const {
  createDeck,
  shuffleDeck,
  drawCards,
  evaluateHand,
  findWinners,
  formatCard,
  summarizeHand,
} = require('./game-logic');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const BASE_ANTE = 1; // 매 판 참가비 1조각
const AUTO_RESTART_DELAY_MS = 5000; // 판 종료 후 5초 뒤 자동 재시작

// 개발자/관리자 설정.
// .env 또는 Glitch의 환경 변수에서 바꿀 수 있습니다.
const DEV_NICK = process.env.DEV_NICK || 'DEV_MASTER';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'CHANGE_ME';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Express 정적 파일 서비스
app.use(express.static(path.join(__dirname, '..', 'public')));

// 아주 간단한 상태 확인용 라우트
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 메모리 기반 룸 상태 저장소
// 실제 영구 저장이 필요한 것은 조각 잔액(users)이므로,
// 게임 중 임시 상태(방, 카드, 턴, 판돈)는 메모리에 둡니다.
const rooms = new Map();

// 같은 닉네임의 중복 접속을 막기 위한 맵
// key: nickname, value: socket.id
const onlineNicknameToSocketId = new Map();

/**
 * 닉네임 유효성 검사.
 * - 한글/영문/숫자/밑줄 허용
 * - 2~12자 제한
 */
function validateNickname(rawNickname) {
  const nickname = String(rawNickname || '').trim();
  const regex = /^[0-9A-Za-z가-힣_]{2,12}$/;

  if (!regex.test(nickname)) {
    return {
      ok: false,
      message: '닉네임은 2~12자의 한글/영문/숫자/밑줄만 사용할 수 있습니다.',
    };
  }

  return { ok: true, nickname };
}

/**
 * 6자리 방 코드를 생성합니다.
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  do {
    code = '';
    for (let i = 0; i < 6; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

/**
 * 룸 메세지 로그를 남깁니다.
 * 최근 메세지만 유지하여 상태 패킷이 과도하게 커지지 않게 합니다.
 */
function addRoomMessage(room, text) {
  room.messages.push({
    text,
    timestamp: new Date().toISOString(),
  });

  if (room.messages.length > 20) {
    room.messages = room.messages.slice(-20);
  }
}


function clearAutoRestart(room) {
  if (room.autoRestartTimer) {
    clearTimeout(room.autoRestartTimer);
    room.autoRestartTimer = null;
  }
  room.autoRestartAt = null;
}

function scheduleAutoRestart(room) {
  clearAutoRestart(room);
  room.autoRestartAt = Date.now() + AUTO_RESTART_DELAY_MS;
  room.autoRestartTimer = setTimeout(async () => {
    room.autoRestartTimer = null;
    room.autoRestartAt = null;

    try {
      if (!rooms.has(room.code)) return;
      if (room.status !== 'lobby') return;
      if (room.players.length < MIN_PLAYERS) return;
      await startGame(room);
    } catch (error) {
      addRoomMessage(room, `자동 재시작에 실패했습니다: ${error.message}`);
      emitRoomState(room);
    }
  }, AUTO_RESTART_DELAY_MS);
}

/**
 * 현재 룸에 남아 있는 플레이어 id 배열을 반환합니다.
 */
function getRoomPlayerIds(room) {
  return room.players.map((p) => p.id);
}

/**
 * 특정 룸에서 플레이어 객체를 찾습니다.
 */
function getPlayerFromRoom(room, playerId) {
  return room.players.find((player) => player.id === playerId) || null;
}

/**
 * DB의 현재 조각(chips) 값을 룸 캐시에 동기화합니다.
 */
async function syncPlayerPieces(room, playerId) {
  const user = await getUser(playerId);
  const player = getPlayerFromRoom(room, playerId);
  if (player && user) {
    player.pieces = user.chips;
  }
}

/**
 * DB와 룸 캐시를 동시에 조정하는 헬퍼.
 */
async function changePlayerPieces(room, playerId, delta) {
  const updatedUser = await adjustChips(playerId, delta);
  const player = getPlayerFromRoom(room, playerId);
  if (player) {
    player.pieces = updatedUser.chips;
  }
  return updatedUser;
}

/**
 * 룸 상태를 클라이언트에 보내기 전에 가공합니다.
 * 각 플레이어는 '자기 카드만' 보고,
 * 쇼다운/마지막 결과 화면에서는 공개 가능한 카드만 보도록 설계했습니다.
 */
function buildStateForPlayer(room, viewerId) {
  const isHost = room.hostId === viewerId;
  const isDeveloper = viewerId === DEV_NICK;

  const state = {
    roomCode: room.code,
    roomStatus: room.status,
    hostId: room.hostId,
    myId: viewerId,
    isHost,
    isDeveloper,
    baseAnte: BASE_ANTE,
    players: room.players.map((player) => {
      const gameState = room.game?.playerStates?.[player.id];
      const lastResultState = room.lastResult?.players?.find((p) => p.id === player.id) || null;

      return {
        id: player.id,
        pieces: player.pieces,
        folded: gameState ? !!gameState.folded : !!lastResultState?.folded,
        currentBet: gameState ? gameState.currentBet : 0,
        totalContribution: gameState ? gameState.totalContribution : lastResultState?.totalContribution || 0,
        cardCount: gameState?.cards?.length || 0,
        revealedCards:
          room.game?.phase === 'showdown'
            ? (gameState?.cards || []).map(formatCard)
            : (lastResultState?.cards || []).map(formatCard),
        handName:
          room.game?.phase === 'showdown'
            ? gameState?.hand?.name || null
            : lastResultState?.handName || null,
      };
    }),
    game: room.game
      ? {
          phase: room.game.phase,
          pot: room.game.pot,
          currentBet: room.game.currentBet,
          currentTurnPlayerId: room.game.currentTurnPlayerId,
          needResponseFrom: Array.from(room.game.needResponseFrom),
          myCards: (room.game.playerStates[viewerId]?.cards || []).map(formatCard),
          myFolded: !!room.game.playerStates[viewerId]?.folded,
          myCurrentBet: room.game.playerStates[viewerId]?.currentBet || 0,
          myTotalContribution: room.game.playerStates[viewerId]?.totalContribution || 0,
          myHandSummary: room.game.playerStates[viewerId]?.cards?.length === 2
            ? summarizeHand(room.game.playerStates[viewerId].cards)
            : null,
        }
      : null,
    lastResult: room.lastResult,
    nextAutoStartAt: room.autoRestartAt,
    messages: room.messages,
    controls: {
      canStart: isHost && room.status === 'lobby' && room.players.length >= MIN_PLAYERS,
      canAct: room.status === 'playing' && room.game?.currentTurnPlayerId === viewerId,
    },
    developerTools: {
      enabled: isDeveloper,
      devNick: DEV_NICK,
    },
  };

  return state;
}

/**
 * 룸에 있는 모든 소켓에 각자 맞춤형 상태를 전송합니다.
 */
function emitRoomState(room) {
  for (const player of room.players) {
    io.to(player.socketId).emit('roomState', buildStateForPlayer(room, player.id));
  }
}

/**
 * 특정 소켓에만 에러 전달.
 */
function emitError(socket, message) {
  socket.emit('errorMessage', message);
}

/**
 * 배열을 특정 인덱스 기준으로 회전합니다.
 * 예: [A,B,C,D], startIndex=2 => [C,D,A,B]
 */
function rotateArray(arr, startIndex) {
  if (arr.length === 0) return [];
  const index = ((startIndex % arr.length) + arr.length) % arr.length;
  return [...arr.slice(index), ...arr.slice(0, index)];
}

/**
 * 현재 게임에서 아직 살아 있는(폴드하지 않은) 플레이어 ID 목록.
 */
function getActivePlayerIds(room) {
  if (!room.game) return [];
  return room.game.turnOrder.filter((playerId) => !room.game.playerStates[playerId].folded);
}

/**
 * 다음 행동할 플레이어를 찾습니다.
 * needResponseFrom 집합에 포함되고, 아직 폴드하지 않은 사람 중에서
 * 현재 사람 다음 순서의 플레이어를 찾습니다.
 */
function findNextTurnPlayer(room, afterPlayerId) {
  const game = room.game;
  if (!game) return null;

  const order = game.turnOrder;
  if (order.length === 0 || game.needResponseFrom.size === 0) {
    return null;
  }

  const startIndex = Math.max(order.indexOf(afterPlayerId), 0);

  for (let step = 1; step <= order.length; step += 1) {
    const index = (startIndex + step) % order.length;
    const candidateId = order[index];
    const candidateState = game.playerStates[candidateId];

    if (!candidateState.folded && game.needResponseFrom.has(candidateId)) {
      return candidateId;
    }
  }

  // 혹시 기준 플레이어를 못 찾은 경우를 대비한 fallback
  for (const playerId of order) {
    const state = game.playerStates[playerId];
    if (!state.folded && game.needResponseFrom.has(playerId)) {
      return playerId;
    }
  }

  return null;
}

/**
 * 룸이 비었으면 삭제합니다.
 */
function cleanupEmptyRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.players.length === 0) {
    clearAutoRestart(room);
    rooms.delete(roomCode);
  }
}

/**
 * 플레이어가 룸에서 나가거나 연결이 끊겼을 때 처리합니다.
 */
async function removePlayerFromRoom(socket, reasonText = '방을 나갔습니다.') {
  const roomCode = socket.data.roomCode;
  const playerId = socket.data.nickname;

  if (!roomCode || !playerId) {
    return;
  }

  const room = rooms.get(roomCode);
  if (!room) {
    onlineNicknameToSocketId.delete(playerId);
    delete socket.data.roomCode;
    delete socket.data.nickname;
    return;
  }

  const existingPlayer = getPlayerFromRoom(room, playerId);
  if (!existingPlayer) {
    onlineNicknameToSocketId.delete(playerId);
    delete socket.data.roomCode;
    delete socket.data.nickname;
    return;
  }

  // 게임 중 퇴장이라면, 해당 플레이어는 자동 폴드 처리합니다.
  if (room.status === 'playing' && room.game?.playerStates?.[playerId]) {
    room.game.playerStates[playerId].folded = true;
    room.game.needResponseFrom.delete(playerId);
    addRoomMessage(room, `${playerId}님이 연결 종료로 자동 다이 처리되었습니다.`);
  }

  room.players = room.players.filter((player) => player.id !== playerId);
  socket.leave(roomCode);
  onlineNicknameToSocketId.delete(playerId);

  delete socket.data.roomCode;
  delete socket.data.nickname;

  // 방장이 나가면 남은 첫 번째 플레이어를 새 방장으로 지정합니다.
  if (room.hostId === playerId && room.players.length > 0) {
    room.hostId = room.players[0].id;
    addRoomMessage(room, `방장이 나가 새 방장이 ${room.hostId}님으로 변경되었습니다.`);
  }

  // 게임 도중 인원이 1명만 남으면 남은 사람이 자동 승리합니다.
  if (room.status === 'playing' && room.players.length <= 1) {
    if (room.players.length === 1) {
      await finishRound(room, [room.players[0].id], '상대가 모두 나가 자동 승리했습니다.');
    }
  } else if (room.status === 'playing') {
    await resolveGameProgress(room, playerId);
  }

  if (room.players.length > 0 && room.status !== 'playing') {
    if (room.players.length < MIN_PLAYERS) {
      clearAutoRestart(room);
    }
    addRoomMessage(room, `${playerId}님이 ${reasonText}`);
    emitRoomState(room);
  }

  cleanupEmptyRoom(roomCode);
}

/**
 * 판 종료 후 결과 정산.
 */
async function finishRound(room, winnerIds, reason) {
  const game = room.game;
  if (!game) return;

  const timestamp = new Date().toISOString();
  const resultPlayers = [];

  // 쇼다운이 필요한 경우(2명 이상 살아남음) 패 계산
  for (const playerId of game.turnOrder) {
    const state = game.playerStates[playerId];

    if (!state.folded) {
      state.hand = evaluateHand(state.cards);
    }

    resultPlayers.push({
      id: playerId,
      folded: state.folded,
      totalContribution: state.totalContribution,
      cards: state.folded ? [] : state.cards,
      handName: state.folded ? null : state.hand?.name || null,
    });
  }

  // 판돈 분배(동률 시 균등 분배 + 나머지는 앞쪽 승자부터 1조각씩)
  const payouts = {};
  let base = Math.floor(game.pot / winnerIds.length);
  let remainder = game.pot % winnerIds.length;

  for (const winnerId of winnerIds) {
    payouts[winnerId] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }

  for (const winnerId of winnerIds) {
    await changePlayerPieces(room, winnerId, payouts[winnerId]);
  }

  // 전적 기록 저장
  // 패자의 잃은 금액을 승자 수만큼 나눠서 기록합니다.
  const historyRows = [];
  const losers = game.turnOrder.filter((playerId) => !winnerIds.includes(playerId));

  for (const loserId of losers) {
    const lostAmount = game.playerStates[loserId].totalContribution;
    const shareBase = Math.floor(lostAmount / winnerIds.length);
    let shareRemainder = lostAmount % winnerIds.length;

    for (const winnerId of winnerIds) {
      const share = shareBase + (shareRemainder > 0 ? 1 : 0);
      if (shareRemainder > 0) shareRemainder -= 1;

      if (share > 0) {
        historyRows.push({
          winner_id: winnerId,
          loser_id: loserId,
          bet_amount: share,
          timestamp,
        });
      }
    }
  }

  await insertGameHistory(historyRows);

  room.lastResult = {
    reason,
    pot: game.pot,
    timestamp,
    winners: winnerIds.map((winnerId) => ({
      id: winnerId,
      payout: payouts[winnerId],
      handName: game.playerStates[winnerId]?.hand?.name || '자동 승리',
    })),
    players: resultPlayers,
  };

  addRoomMessage(
    room,
    winnerIds.length === 1
      ? `${winnerIds[0]}님이 승리하여 ${payouts[winnerIds[0]]}조각을 획득했습니다. (${reason})`
      : `${winnerIds.join(', ')}님이 공동 승리했습니다. (${reason})`
  );

  room.game = null;
  room.status = 'lobby';

  if (room.players.length >= MIN_PLAYERS) {
    addRoomMessage(room, '5초 후 자동으로 다음 판이 시작됩니다.');
    scheduleAutoRestart(room);
  } else {
    clearAutoRestart(room);
  }

  emitRoomState(room);
}

/**
 * 쇼다운 처리.
 */
async function showdown(room) {
  const activePlayerIds = getActivePlayerIds(room);

  const playerHands = activePlayerIds.map((playerId) => {
    const hand = evaluateHand(room.game.playerStates[playerId].cards);
    room.game.playerStates[playerId].hand = hand;
    return { playerId, hand };
  });

  const winnerEntries = findWinners(playerHands);
  const winnerIds = winnerEntries.map((entry) => entry.playerId);
  await finishRound(room, winnerIds, '배팅 라운드 종료 후 패를 비교했습니다.');
}

/**
 * 액션 이후 게임 진행 상태를 판단합니다.
 * - 1명만 남으면 즉시 승리
 * - 모두 콜/체크 완료면 쇼다운
 * - 아니면 다음 차례 지정
 */
async function resolveGameProgress(room, actorId) {
  if (!room.game) return;

  const activePlayerIds = getActivePlayerIds(room);

  if (activePlayerIds.length === 1) {
    await finishRound(room, [activePlayerIds[0]], '상대가 모두 다이했습니다.');
    return;
  }

  if (room.game.needResponseFrom.size === 0) {
    await showdown(room);
    return;
  }

  const nextPlayerId = findNextTurnPlayer(room, actorId);
  room.game.currentTurnPlayerId = nextPlayerId;
  emitRoomState(room);
}

/**
 * 게임 시작.
 */
async function startGame(room) {
  clearAutoRestart(room);

  if (room.status === 'playing') {
    throw new Error('이미 게임이 진행 중입니다.');
  }

  if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) {
    throw new Error('게임은 2명 이상 6명 이하일 때만 시작할 수 있습니다.');
  }

  // 참가비 확인
  for (const player of room.players) {
    const enough = await hasEnoughChips(player.id, BASE_ANTE);
    if (!enough) {
      throw new Error(`${player.id}님의 조각이 부족하여 게임을 시작할 수 없습니다.`);
    }
  }

  // 참가비 차감
  for (const player of room.players) {
    await changePlayerPieces(room, player.id, -BASE_ANTE);
  }

  const rawDeck = createDeck();
  const deck = shuffleDeck(rawDeck);

  // 라운드 시작 위치를 매 판 한 칸씩 밀어 공정성을 조금 더 확보합니다.
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  const turnOrder = rotateArray(getRoomPlayerIds(room), room.dealerIndex + 1);

  const playerStates = {};
  for (const playerId of turnOrder) {
    playerStates[playerId] = {
      cards: drawCards(deck, 2),
      folded: false,
      currentBet: 0,
      totalContribution: BASE_ANTE,
      hand: null,
    };
  }

  room.game = {
    phase: 'betting',
    deck,
    pot: room.players.length * BASE_ANTE,
    currentBet: 0,
    turnOrder,
    currentTurnPlayerId: turnOrder[0],
    needResponseFrom: new Set(turnOrder),
    playerStates,
  };

  room.lastResult = null;
  room.status = 'playing';
  addRoomMessage(room, `새 게임이 시작되었습니다. 참가비 ${BASE_ANTE}조각이 차감되었습니다.`);
  emitRoomState(room);
}

/**
 * 배팅 입력값을 안전하게 정수로 변환.
 */
function parsePositiveInteger(rawValue) {
  const value = Number(rawValue);
  if (!Number.isInteger(value)) return null;
  if (value <= 0) return null;
  return value;
}

/**
 * 전체 룸 중 특정 플레이어가 있는 룸을 찾습니다.
 * 개발자 지급 기능에서 사용합니다.
 */
function findRoomContainingPlayer(playerId) {
  for (const room of rooms.values()) {
    if (room.players.some((player) => player.id === playerId)) {
      return room;
    }
  }
  return null;
}

io.on('connection', (socket) => {
  // ---------------------------------------------------------
  // 방 생성
  // ---------------------------------------------------------
  socket.on('createRoom', async ({ nickname }) => {
    try {
      if (socket.data.roomCode) {
        emitError(socket, '이미 방에 들어와 있습니다. 먼저 나가기를 해주세요.');
        return;
      }

      const validation = validateNickname(nickname);
      if (!validation.ok) {
        emitError(socket, validation.message);
        return;
      }

      const finalNickname = validation.nickname;

      if (onlineNicknameToSocketId.has(finalNickname)) {
        emitError(socket, '이미 접속 중인 닉네임입니다. 다른 닉네임을 사용해 주세요.');
        return;
      }

      const user = await ensureUser(finalNickname);
      const roomCode = generateRoomCode();

      const room = {
        code: roomCode,
        hostId: finalNickname,
        dealerIndex: -1,
        status: 'lobby',
        players: [
          {
            id: finalNickname,
            socketId: socket.id,
            pieces: user.chips,
          },
        ],
        game: null,
        lastResult: null,
        messages: [],
        createdAt: new Date().toISOString(),
        autoRestartTimer: null,
        autoRestartAt: null,
      };

      rooms.set(roomCode, room);
      onlineNicknameToSocketId.set(finalNickname, socket.id);

      socket.data.nickname = finalNickname;
      socket.data.roomCode = roomCode;
      socket.join(roomCode);

      addRoomMessage(room, `${finalNickname}님이 방을 만들었습니다.`);
      emitRoomState(room);
    } catch (error) {
      console.error('createRoom error:', error);
      emitError(socket, '방 생성 중 오류가 발생했습니다.');
    }
  });

  // ---------------------------------------------------------
  // 방 참가
  // ---------------------------------------------------------
  socket.on('joinRoom', async ({ nickname, roomCode }) => {
    try {
      if (socket.data.roomCode) {
        emitError(socket, '이미 방에 들어와 있습니다. 먼저 나가기를 해주세요.');
        return;
      }

      const validation = validateNickname(nickname);
      if (!validation.ok) {
        emitError(socket, validation.message);
        return;
      }

      const finalNickname = validation.nickname;
      const finalRoomCode = String(roomCode || '').trim().toUpperCase();
      const room = rooms.get(finalRoomCode);

      if (!room) {
        emitError(socket, '존재하지 않는 방 코드입니다.');
        return;
      }

      if (onlineNicknameToSocketId.has(finalNickname)) {
        emitError(socket, '이미 접속 중인 닉네임입니다. 다른 닉네임을 사용해 주세요.');
        return;
      }

      if (room.status === 'playing') {
        emitError(socket, '게임 진행 중인 방에는 새로 참가할 수 없습니다.');
        return;
      }

      if (room.players.length >= MAX_PLAYERS) {
        emitError(socket, '이 방은 정원이 가득 찼습니다.');
        return;
      }

      if (room.players.some((player) => player.id === finalNickname)) {
        emitError(socket, '같은 닉네임이 이미 이 방에 있습니다.');
        return;
      }

      const user = await ensureUser(finalNickname);

      room.players.push({
        id: finalNickname,
        socketId: socket.id,
        pieces: user.chips,
      });

      onlineNicknameToSocketId.set(finalNickname, socket.id);
      socket.data.nickname = finalNickname;
      socket.data.roomCode = finalRoomCode;
      socket.join(finalRoomCode);

      addRoomMessage(room, `${finalNickname}님이 방에 참가했습니다.`);
      emitRoomState(room);
    } catch (error) {
      console.error('joinRoom error:', error);
      emitError(socket, '방 참가 중 오류가 발생했습니다.');
    }
  });

  // ---------------------------------------------------------
  // 방 나가기
  // ---------------------------------------------------------
  socket.on('leaveRoom', async () => {
    try {
      await removePlayerFromRoom(socket, '방을 나갔습니다.');
      socket.emit('leftRoom');
    } catch (error) {
      console.error('leaveRoom error:', error);
      emitError(socket, '방 나가기 중 오류가 발생했습니다.');
    }
  });

  // ---------------------------------------------------------
  // 게임 시작 (방장만 가능)
  // ---------------------------------------------------------
  socket.on('startGame', async () => {
    try {
      const roomCode = socket.data.roomCode;
      const playerId = socket.data.nickname;
      const room = rooms.get(roomCode);

      if (!room || !playerId) {
        emitError(socket, '현재 참가 중인 방이 없습니다.');
        return;
      }

      if (room.hostId !== playerId) {
        emitError(socket, '방장만 게임을 시작할 수 있습니다.');
        return;
      }

      await startGame(room);
    } catch (error) {
      console.error('startGame error:', error);
      emitError(socket, error.message || '게임 시작 중 오류가 발생했습니다.');
    }
  });

  // ---------------------------------------------------------
  // 게임 액션 처리: call / bet / fold
  // ---------------------------------------------------------
  socket.on('gameAction', async ({ type, amount }) => {
    try {
      const roomCode = socket.data.roomCode;
      const playerId = socket.data.nickname;
      const room = rooms.get(roomCode);

      if (!room || !room.game || room.status !== 'playing') {
        emitError(socket, '현재 진행 중인 게임이 없습니다.');
        return;
      }

      if (room.game.currentTurnPlayerId !== playerId) {
        emitError(socket, '지금은 당신의 차례가 아닙니다.');
        return;
      }

      const player = getPlayerFromRoom(room, playerId);
      const state = room.game.playerStates[playerId];

      if (!player || !state) {
        emitError(socket, '플레이어 상태를 찾을 수 없습니다.');
        return;
      }

      if (state.folded) {
        emitError(socket, '이미 다이한 상태입니다.');
        return;
      }

      const toCall = room.game.currentBet - state.currentBet;

      if (type === 'call') {
        if (toCall > player.pieces) {
          emitError(socket, '콜할 조각이 부족합니다. 다이를 선택하거나 적은 판에서 다시 시작해 주세요.');
          return;
        }

        if (toCall > 0) {
          await changePlayerPieces(room, playerId, -toCall);
          state.currentBet += toCall;
          state.totalContribution += toCall;
          room.game.pot += toCall;
          addRoomMessage(room, `${playerId}님이 콜(${toCall}조각) 했습니다.`);
        } else {
          addRoomMessage(room, `${playerId}님이 체크했습니다.`);
        }

        room.game.needResponseFrom.delete(playerId);
        await resolveGameProgress(room, playerId);
        return;
      }

      if (type === 'bet') {
        const raiseAmount = parsePositiveInteger(amount);
        if (!raiseAmount) {
          emitError(socket, '베팅 금액은 1 이상의 정수여야 합니다.');
          return;
        }

        const totalNeed = toCall + raiseAmount;
        if (totalNeed > player.pieces) {
          emitError(socket, '베팅할 조각이 부족합니다.');
          return;
        }

        await changePlayerPieces(room, playerId, -totalNeed);
        state.currentBet += totalNeed;
        state.totalContribution += totalNeed;
        room.game.pot += totalNeed;
        room.game.currentBet = state.currentBet;

        // 레이즈가 발생했으므로, 본인을 제외한 살아있는 플레이어가 다시 응답해야 합니다.
        room.game.needResponseFrom = new Set(
          getActivePlayerIds(room).filter((id) => id !== playerId)
        );

        addRoomMessage(
          room,
          `${playerId}님이 ${raiseAmount}조각 추가 베팅했습니다. (총 맞춰야 할 현재 베팅: ${room.game.currentBet})`
        );

        await resolveGameProgress(room, playerId);
        return;
      }

      if (type === 'fold') {
        state.folded = true;
        room.game.needResponseFrom.delete(playerId);
        addRoomMessage(room, `${playerId}님이 다이했습니다.`);
        await resolveGameProgress(room, playerId);
        return;
      }

      emitError(socket, '알 수 없는 액션입니다.');
    } catch (error) {
      console.error('gameAction error:', error);
      emitError(socket, error.message || '게임 액션 처리 중 오류가 발생했습니다.');
    }
  });

  // ---------------------------------------------------------
  // 개발자 전용 조각 지급 기능
  // 사용 조건:
  // 1) 접속한 닉네임이 DEV_NICK 이어야 함
  // 2) secret 값이 ADMIN_SECRET 과 일치해야 함
  // ---------------------------------------------------------
  socket.on('adminGrantPieces', async ({ targetNickname, amount, secret }) => {
    try {
      const sender = socket.data.nickname;
      if (sender !== DEV_NICK) {
        emitError(socket, '개발자 닉네임으로 접속한 사용자만 사용할 수 있습니다.');
        return;
      }

      if (secret !== ADMIN_SECRET) {
        emitError(socket, '관리자 비밀키가 올바르지 않습니다.');
        return;
      }

      const validation = validateNickname(targetNickname);
      if (!validation.ok) {
        emitError(socket, '지급 대상 닉네임 형식이 올바르지 않습니다.');
        return;
      }

      const parsedAmount = Number(amount);
      if (!Number.isInteger(parsedAmount) || parsedAmount === 0) {
        emitError(socket, '지급/차감 금액은 0이 아닌 정수여야 합니다.');
        return;
      }

      await ensureUser(validation.nickname);
      await adjustChips(validation.nickname, parsedAmount);

      const targetRoom = findRoomContainingPlayer(validation.nickname);
      if (targetRoom) {
        await syncPlayerPieces(targetRoom, validation.nickname);
        addRoomMessage(
          targetRoom,
          `관리자 기능으로 ${validation.nickname}님의 조각이 ${parsedAmount > 0 ? '+' : ''}${parsedAmount} 변경되었습니다.`
        );
        emitRoomState(targetRoom);
      }

      const updated = await getUser(validation.nickname);
      socket.emit('adminGrantResult', {
        targetNickname: validation.nickname,
        amount: parsedAmount,
        totalPieces: updated?.chips || 0,
      });
    } catch (error) {
      console.error('adminGrantPieces error:', error);
      emitError(socket, '관리자 조각 지급 중 오류가 발생했습니다.');
    }
  });

  // ---------------------------------------------------------
  // 연결 해제
  // ---------------------------------------------------------
  socket.on('disconnect', async () => {
    try {
      await removePlayerFromRoom(socket, '연결이 종료되었습니다.');
    } catch (error) {
      console.error('disconnect cleanup error:', error);
    }
  });
});

(async () => {
  try {
    await initDb();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`섯다 서버가 포트 ${PORT}에서 실행 중입니다.`);
      console.log(`개발자 닉네임(DEV_NICK): ${DEV_NICK}`);
    });
  } catch (error) {
    console.error('서버 시작 실패:', error);
    process.exit(1);
  }
})();
