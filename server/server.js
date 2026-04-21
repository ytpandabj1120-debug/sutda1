// server/server.js
// -----------------------------------------------------------------------------
// 섯다 멀티플레이 서버 진입점입니다.
// - Express: 정적 파일 서비스(public 폴더)
// - Socket.IO: 실시간 멀티플레이 / 룸 관리
// - sqlite3: 사용자 조각(실제 DB 컬럼명 chips) 저장
// - 권위적 서버 모델: 카드/족보/배팅/승패/조각 정산을 서버가 전부 결정
//
// 이번 수정 핵심
// 1) 올인(All-in) 지원
//    - 상대 베팅이 너무 커도 "조각 부족"으로 막지 않고,
//      내가 가진 전부만큼은 낼 수 있게 변경했습니다.
// 2) 사이드팟(부분 판돈) 정산 지원
//    - 예: 내가 100, 상대가 1000이면 내가 이겨도 최대 200만 획득
//    - 남는 초과 금액은 실제 승부 가능한 범위에 맞춰 자동 정산됩니다.
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
const DEV_NICK = process.env.DEV_NICK || 'DEV_MASTER';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'CHANGE_ME';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 메모리 기반 룸 상태 저장소
const rooms = new Map();

// 같은 닉네임 중복 접속 방지
const onlineNicknameToSocketId = new Map();

/**
 * 닉네임 유효성 검사.
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
 * 6자리 방 코드 생성
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
 * 룸 내 최근 로그 메세지 저장
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

function getRoomPlayerIds(room) {
  return room.players.map((p) => p.id);
}

function getPlayerFromRoom(room, playerId) {
  return room.players.find((player) => player.id === playerId) || null;
}

async function syncPlayerPieces(room, playerId) {
  const user = await getUser(playerId);
  const player = getPlayerFromRoom(room, playerId);
  if (player && user) {
    player.pieces = user.chips;
  }
}

async function changePlayerPieces(room, playerId, delta) {
  const updatedUser = await adjustChips(playerId, delta);
  const player = getPlayerFromRoom(room, playerId);
  if (player) {
    player.pieces = updatedUser.chips;
  }
  return updatedUser;
}

/**
 * 상태를 각 플레이어에 맞게 가공
 */
function buildStateForPlayer(room, viewerId) {
  const isHost = room.hostId === viewerId;
  const isDeveloper = viewerId === DEV_NICK;
  const myState = room.game?.playerStates?.[viewerId] || null;

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
        allIn: gameState ? !!gameState.allIn : !!lastResultState?.allIn,
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
          myCards: (myState?.cards || []).map(formatCard),
          myFolded: !!myState?.folded,
          myAllIn: !!myState?.allIn,
          myCurrentBet: myState?.currentBet || 0,
          myTotalContribution: myState?.totalContribution || 0,
          myHandSummary: myState?.cards?.length === 2 ? summarizeHand(myState.cards) : null,
        }
      : null,
    lastResult: room.lastResult,
    nextAutoStartAt: room.autoRestartAt,
    messages: room.messages,
    controls: {
      canStart: isHost && room.status === 'lobby' && room.players.length >= MIN_PLAYERS,
      canAct:
        room.status === 'playing' &&
        room.game?.currentTurnPlayerId === viewerId &&
        !myState?.folded &&
        !myState?.allIn,
    },
    developerTools: {
      enabled: isDeveloper,
      devNick: DEV_NICK,
    },
  };

  return state;
}

function emitRoomState(room) {
  for (const player of room.players) {
    io.to(player.socketId).emit('roomState', buildStateForPlayer(room, player.id));
  }
}

function emitError(socket, message) {
  socket.emit('errorMessage', message);
}

function rotateArray(arr, startIndex) {
  if (arr.length === 0) return [];
  const index = ((startIndex % arr.length) + arr.length) % arr.length;
  return [...arr.slice(index), ...arr.slice(0, index)];
}

/**
 * 아직 살아 있는 플레이어(다이하지 않은 플레이어)
 * - 올인은 했어도 살아있으면 showdown 대상이므로 포함됩니다.
 */
function getActivePlayerIds(room) {
  if (!room.game) return [];
  return room.game.turnOrder.filter((playerId) => !room.game.playerStates[playerId].folded);
}

/**
 * 실제로 추가 행동이 가능한 플레이어
 * - 다이 아님
 * - 올인 아님
 */
function getActionablePlayerIds(room) {
  if (!room.game) return [];
  return room.game.turnOrder.filter((playerId) => {
    const state = room.game.playerStates[playerId];
    return !state.folded && !state.allIn;
  });
}

/**
 * 레이즈 후 누가 다시 응답해야 하는지 계산
 * - 현재 최고 베팅보다 적게 넣은 사람만 다시 응답 대상
 * - 올인 플레이어는 더 이상 응답 대상에 넣지 않음
 */
function rebuildNeedResponseFrom(room, actorId) {
  const ids = getActionablePlayerIds(room).filter((id) => {
    if (id === actorId) return false;
    const state = room.game.playerStates[id];
    return state.currentBet < room.game.currentBet;
  });

  room.game.needResponseFrom = new Set(ids);
}

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

    if (!candidateState.folded && !candidateState.allIn && game.needResponseFrom.has(candidateId)) {
      return candidateId;
    }
  }

  for (const playerId of order) {
    const state = game.playerStates[playerId];
    if (!state.folded && !state.allIn && game.needResponseFrom.has(playerId)) {
      return playerId;
    }
  }

  return null;
}

function cleanupEmptyRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.players.length === 0) {
    clearAutoRestart(room);
    rooms.delete(roomCode);
  }
}

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

  if (room.hostId === playerId && room.players.length > 0) {
    room.hostId = room.players[0].id;
    addRoomMessage(room, `방장이 나가 새 방장이 ${room.hostId}님으로 변경되었습니다.`);
  }

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
 * 사이드팟 포함 정산 계산
 *
 * 예시
 * - A 100 올인, B 1000 베팅
 * - 실승부 판돈은 100 vs 100 = 200
 * - 나머지 900은 B 혼자 만든 상단 티어라 B에게 돌아감
 */
function calculatePayoutsAndHistory(room, timestamp) {
  const game = room.game;
  const payouts = {};
  const historyRows = [];

  for (const playerId of game.turnOrder) {
    payouts[playerId] = 0;
  }

  const contributionLevels = [...new Set(
    game.turnOrder
      .map((playerId) => game.playerStates[playerId].totalContribution)
      .filter((value) => value > 0)
  )].sort((a, b) => a - b);

  let previousLevel = 0;

  for (const level of contributionLevels) {
    const tierAmountPerPlayer = level - previousLevel;
    previousLevel = level;

    if (tierAmountPerPlayer <= 0) continue;

    const contributors = game.turnOrder.filter(
      (playerId) => game.playerStates[playerId].totalContribution >= level
    );

    if (contributors.length === 0) continue;

    const potAmount = tierAmountPerPlayer * contributors.length;
    const eligibleIds = contributors.filter((playerId) => !game.playerStates[playerId].folded);

    // 드물지만 이 티어에 살아남은 플레이어가 없으면, 넣은 사람들에게 그대로 반환
    if (eligibleIds.length === 0) {
      for (const contributorId of contributors) {
        payouts[contributorId] += tierAmountPerPlayer;
      }
      continue;
    }

    const winnerEntries = eligibleIds.map((playerId) => ({
      playerId,
      hand: game.playerStates[playerId].hand,
    }));
    const winners = findWinners(winnerEntries).map((entry) => entry.playerId);

    const shareBase = Math.floor(potAmount / winners.length);
    let shareRemainder = potAmount % winners.length;

    for (const winnerId of winners) {
      payouts[winnerId] += shareBase + (shareRemainder > 0 ? 1 : 0);
      if (shareRemainder > 0) shareRemainder -= 1;
    }

    // 전적 기록용 행 생성
    // 각 패자는 이번 티어에서 tierAmountPerPlayer 만큼 잃었습니다.
    const losers = contributors.filter((playerId) => !winners.includes(playerId));

    for (const loserId of losers) {
      const lostThisTier = tierAmountPerPlayer;
      const rowBase = Math.floor(lostThisTier / winners.length);
      let rowRemainder = lostThisTier % winners.length;

      for (const winnerId of winners) {
        const betAmount = rowBase + (rowRemainder > 0 ? 1 : 0);
        if (rowRemainder > 0) rowRemainder -= 1;

        if (betAmount > 0) {
          historyRows.push({
            winner_id: winnerId,
            loser_id: loserId,
            bet_amount: betAmount,
            timestamp,
          });
        }
      }
    }
  }

  return { payouts, historyRows };
}

/**
 * 판 종료 후 결과 정산
 */
async function finishRound(room, winnerIdsForMessage, reason) {
  const game = room.game;
  if (!game) return;

  const timestamp = new Date().toISOString();
  const resultPlayers = [];

  // 살아남은 플레이어들의 패 계산
  for (const playerId of game.turnOrder) {
    const state = game.playerStates[playerId];

    if (!state.folded && state.cards.length === 2) {
      state.hand = evaluateHand(state.cards);
    }

    resultPlayers.push({
      id: playerId,
      folded: state.folded,
      allIn: state.allIn,
      totalContribution: state.totalContribution,
      cards: state.folded ? [] : state.cards,
      handName: state.folded ? null : state.hand?.name || null,
    });
  }

  const { payouts, historyRows } = calculatePayoutsAndHistory(room, timestamp);

  for (const playerId of Object.keys(payouts)) {
    if (payouts[playerId] > 0) {
      await changePlayerPieces(room, playerId, payouts[playerId]);
    }
  }

  if (historyRows.length > 0) {
    await insertGameHistory(historyRows);
  }

  // 메세지용 승자 목록이 없으면, 실제 수익이 가장 큰 플레이어(들)를 사용
  let finalWinnerIds = winnerIdsForMessage;
  if (!Array.isArray(finalWinnerIds) || finalWinnerIds.length === 0) {
    const maxPayout = Math.max(...Object.values(payouts));
    finalWinnerIds = Object.keys(payouts).filter((playerId) => payouts[playerId] === maxPayout);
  }

  room.lastResult = {
    reason,
    pot: game.pot,
    timestamp,
    winners: finalWinnerIds.map((winnerId) => ({
      id: winnerId,
      payout: payouts[winnerId] || 0,
      handName: game.playerStates[winnerId]?.hand?.name || '자동 승리',
    })),
    players: resultPlayers,
  };

  if (finalWinnerIds.length === 1) {
    addRoomMessage(
      room,
      `${finalWinnerIds[0]}님이 승리했습니다. 최종 획득 ${payouts[finalWinnerIds[0]] || 0}조각 (${reason})`
    );
  } else {
    addRoomMessage(
      room,
      `${finalWinnerIds.join(', ')}님이 공동 승리했습니다. (${reason})`
    );
  }

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

async function resolveGameProgress(room, actorId) {
  if (!room.game) return;

  const activePlayerIds = getActivePlayerIds(room);

  if (activePlayerIds.length === 1) {
    await finishRound(room, [activePlayerIds[0]], '상대가 모두 다이했습니다.');
    return;
  }

  // 더 이상 행동 가능한 사람이 없으면 바로 쇼다운
  const actionableIds = getActionablePlayerIds(room);
  if (actionableIds.length === 0 || room.game.needResponseFrom.size === 0) {
    await showdown(room);
    return;
  }

  const nextPlayerId = findNextTurnPlayer(room, actorId);
  room.game.currentTurnPlayerId = nextPlayerId;
  emitRoomState(room);
}

async function startGame(room) {
  clearAutoRestart(room);

  if (room.status === 'playing') {
    throw new Error('이미 게임이 진행 중입니다.');
  }

  if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) {
    throw new Error('게임은 2명 이상 6명 이하일 때만 시작할 수 있습니다.');
  }

  for (const player of room.players) {
    const enough = await hasEnoughChips(player.id, BASE_ANTE);
    if (!enough) {
      throw new Error(`${player.id}님의 조각이 부족하여 게임을 시작할 수 없습니다.`);
    }
  }

  for (const player of room.players) {
    await changePlayerPieces(room, player.id, -BASE_ANTE);
  }

  const rawDeck = createDeck();
  const deck = shuffleDeck(rawDeck);

  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  const turnOrder = rotateArray(getRoomPlayerIds(room), room.dealerIndex + 1);

  const playerStates = {};
  for (const playerId of turnOrder) {
    const roomPlayer = getPlayerFromRoom(room, playerId);
    playerStates[playerId] = {
      cards: drawCards(deck, 2),
      folded: false,
      allIn: roomPlayer ? roomPlayer.pieces === 0 : false,
      currentBet: 0,
      totalContribution: BASE_ANTE,
      hand: null,
    };
  }

  const initialActionableIds = turnOrder.filter((playerId) => !playerStates[playerId].allIn);

  room.game = {
    phase: 'betting',
    deck,
    pot: room.players.length * BASE_ANTE,
    currentBet: 0,
    turnOrder,
    currentTurnPlayerId: initialActionableIds[0] || null,
    needResponseFrom: new Set(initialActionableIds),
    playerStates,
  };

  room.lastResult = null;
  room.status = 'playing';
  addRoomMessage(room, `새 게임이 시작되었습니다. 참가비 ${BASE_ANTE}조각이 차감되었습니다.`);

  // 참가비를 내자마자 올인이 된 사람들만 있으면 바로 쇼다운
  if (room.game.needResponseFrom.size === 0) {
    await showdown(room);
    return;
  }

  emitRoomState(room);
}

function parsePositiveInteger(rawValue) {
  const value = Number(rawValue);
  if (!Number.isInteger(value)) return null;
  if (value <= 0) return null;
  return value;
}

function findRoomContainingPlayer(playerId) {
  for (const room of rooms.values()) {
    if (room.players.some((player) => player.id === playerId)) {
      return room;
    }
  }
  return null;
}

io.on('connection', (socket) => {
  // 방 생성
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

  // 방 참가
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

  // 방 나가기
  socket.on('leaveRoom', async () => {
    try {
      await removePlayerFromRoom(socket, '방을 나갔습니다.');
      socket.emit('leftRoom');
    } catch (error) {
      console.error('leaveRoom error:', error);
      emitError(socket, '방 나가기 중 오류가 발생했습니다.');
    }
  });

  // 게임 시작 (방장만 가능)
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

  // 게임 액션 처리: call / bet / fold
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

      if (state.allIn) {
        emitError(socket, '이미 올인 상태라 추가 행동을 할 수 없습니다.');
        return;
      }

      const toCall = Math.max(0, room.game.currentBet - state.currentBet);

      // -----------------------------------------------------
      // 콜 / 체크
      // -----------------------------------------------------
      if (type === 'call') {
        // 상대가 더 많이 걸었더라도, 내 조각이 부족하면 가능한 만큼만 넣고 올인 처리
        const actualCall = Math.min(toCall, player.pieces);

        if (toCall === 0) {
          addRoomMessage(room, `${playerId}님이 체크했습니다.`);
        } else if (actualCall > 0) {
          await changePlayerPieces(room, playerId, -actualCall);
          state.currentBet += actualCall;
          state.totalContribution += actualCall;
          room.game.pot += actualCall;

          if (player.pieces === 0) {
            state.allIn = true;
            addRoomMessage(room, `${playerId}님이 ${actualCall}조각 콜하고 올인했습니다.`);
          } else {
            addRoomMessage(room, `${playerId}님이 콜(${actualCall}조각) 했습니다.`);
          }
        } else {
          emitError(socket, '베팅할 조각이 없습니다.');
          return;
        }

        room.game.needResponseFrom.delete(playerId);
        await resolveGameProgress(room, playerId);
        return;
      }

      // -----------------------------------------------------
      // 베팅 / 레이즈 / 올인 레이즈
      // -----------------------------------------------------
      if (type === 'bet') {
        const raiseAmount = parsePositiveInteger(amount);
        if (!raiseAmount) {
          emitError(socket, '베팅 금액은 1 이상의 정수여야 합니다.');
          return;
        }

        const wantedTotalSpend = toCall + raiseAmount;
        const actualTotalSpend = Math.min(wantedTotalSpend, player.pieces);

        if (actualTotalSpend <= 0) {
          emitError(socket, '베팅할 조각이 없습니다.');
          return;
        }

        const actualCall = Math.min(toCall, actualTotalSpend);
        const actualRaise = Math.max(0, actualTotalSpend - actualCall);
        const previousCurrentBet = room.game.currentBet;

        await changePlayerPieces(room, playerId, -actualTotalSpend);
        state.currentBet += actualTotalSpend;
        state.totalContribution += actualTotalSpend;
        room.game.pot += actualTotalSpend;

        // 이번 행동으로 현재 최고 베팅이 더 높아졌다면 갱신
        if (state.currentBet > room.game.currentBet) {
          room.game.currentBet = state.currentBet;
        }

        if (player.pieces === 0) {
          state.allIn = true;
        }

        // 실제로 currentBet이 올라간 경우만 다른 사람들의 추가 응답이 필요함
        if (room.game.currentBet > previousCurrentBet) {
          rebuildNeedResponseFrom(room, playerId);
        } else {
          room.game.needResponseFrom.delete(playerId);
        }

        if (state.allIn) {
          addRoomMessage(
            room,
            `${playerId}님이 ${actualTotalSpend}조각 올인했습니다.` +
              (actualRaise > 0 ? ` (콜 ${actualCall} + 추가 ${actualRaise})` : '')
          );
        } else {
          addRoomMessage(
            room,
            `${playerId}님이 ${actualTotalSpend}조각 베팅했습니다.` +
              (actualRaise > 0 ? ` (콜 ${actualCall} + 추가 ${actualRaise})` : '') +
              ` 현재 최고 베팅: ${room.game.currentBet}`
          );
        }

        await resolveGameProgress(room, playerId);
        return;
      }

      // -----------------------------------------------------
      // 다이
      // -----------------------------------------------------
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

  // 개발자 전용 조각 지급 기능
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

  // 연결 해제
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
