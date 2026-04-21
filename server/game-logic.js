// server/game-logic.js
// -------------------------------------------------------------------
// 섯다 게임 규칙을 전담하는 파일입니다.
// 요구사항에 맞춰 서버 권위(authoritative server) 모델로 작성합니다.
// 즉, 카드 생성 / 셔플 / 분배 / 족보 판정 / 승패 비교는 모두 서버가 처리합니다.
// 클라이언트는 서버가 전달한 결과만 화면에 그립니다.
// -------------------------------------------------------------------

/**
 * 섯다 카드 덱 생성.
 * 일반적인 단순 20장(1월~10월, 각 월 2장) 구조로 만듭니다.
 * 광 카드는 1월, 3월, 8월에만 1장씩 배정합니다.
 */
function createDeck() {
  const deck = [];

  for (let month = 1; month <= 10; month += 1) {
    // copy=1 카드
    deck.push({
      id: `${month}-A`,
      month,
      copy: 'A',
      isKwang: month === 1 || month === 3 || month === 8,
    });

    // copy=2 카드
    deck.push({
      id: `${month}-B`,
      month,
      copy: 'B',
      isKwang: false,
    });
  }

  return deck;
}

/**
 * Fisher-Yates 셔플.
 */
function shuffleDeck(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 덱에서 n장 꺼냅니다.
 */
function drawCards(deck, count) {
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    const card = deck.shift();
    if (!card) break;
    cards.push(card);
  }
  return cards;
}

/**
 * 카드 2장의 월 숫자를 오름차순으로 정렬한 배열로 반환.
 */
function getSortedMonths(cards) {
  return cards.map((c) => c.month).sort((a, b) => a - b);
}

/**
 * 특정 월 조합인지 확인하는 헬퍼.
 */
function isExactPair(cards, a, b) {
  const months = getSortedMonths(cards);
  return months[0] === Math.min(a, b) && months[1] === Math.max(a, b);
}

/**
 * 같은 월 2장인지(땡) 확인.
 */
function isDdang(cards, month) {
  return cards[0].month === month && cards[1].month === month;
}

/**
 * 광땡인지 확인.
 * 1/3 광땡, 1/8 광땡, 3/8 광땡만 인정합니다.
 * 두 카드 모두 광이어야 합니다.
 */
function getKwangDdangName(cards) {
  const allKwang = cards.every((c) => c.isKwang);
  if (!allKwang) return null;

  if (isExactPair(cards, 3, 8)) return '3·8광땡';
  if (isExactPair(cards, 1, 8)) return '1·8광땡';
  if (isExactPair(cards, 1, 3)) return '1·3광땡';

  return null;
}

/**
 * 섯다 족보 판정.
 * 반환 예시:
 * {
 *   rankValue: 100,
 *   name: '3·8광땡',
 *   type: 'special'
 * }
 *
 * rankValue가 클수록 더 강한 패입니다.
 */
function evaluateHand(cards) {
  if (!cards || cards.length !== 2) {
    throw new Error('evaluateHand에는 반드시 카드 2장이 필요합니다.');
  }

  // ------------------------------
  // 1) 광땡 판정
  // 강도 순서: 3·8광땡 > 1·8광땡 > 1·3광땡
  // ------------------------------
  const kwangDdang = getKwangDdangName(cards);
  if (kwangDdang) {
    const valueMap = {
      '3·8광땡': 100,
      '1·8광땡': 99,
      '1·3광땡': 98,
    };

    return {
      rankValue: valueMap[kwangDdang],
      name: kwangDdang,
      type: '광땡',
      note: '최상급 광땡 패입니다.',
      cards,
    };
  }

  // ------------------------------
  // 2) 땡 판정
  // 장땡(10땡) > 9땡 > ... > 1땡
  // ------------------------------
  for (let month = 10; month >= 1; month -= 1) {
    if (isDdang(cards, month)) {
      return {
        rankValue: 80 + month, // 10땡=90, 9땡=89, ..., 1땡=81
        name: month === 10 ? '장땡' : `${month}땡`,
        type: '땡',
        note: '같은 월 두 장으로 만든 땡 패입니다.',
        cards,
      };
    }
  }

  // ------------------------------
  // 3) 특수 족보 판정
  // 순서: 알리 > 독사 > 구삥 > 장삥 > 장사 > 세륙
  // ------------------------------
  const specialHands = [
    { pair: [1, 2], name: '알리', rankValue: 79, note: '강한 특수 족보입니다.' },
    { pair: [1, 4], name: '독사', rankValue: 78, note: '강한 특수 족보입니다.' },
    { pair: [1, 9], name: '구삥', rankValue: 77, note: '강한 특수 족보입니다.' },
    { pair: [1, 10], name: '장삥', rankValue: 76, note: '강한 특수 족보입니다.' },
    { pair: [4, 10], name: '장사', rankValue: 75, note: '강한 특수 족보입니다.' },
    { pair: [4, 6], name: '세륙', rankValue: 74, note: '강한 특수 족보입니다.' },
    // 일부 섯다 룰에서 9·4는 '구사'로 부르며 재경기 패로 취급하기도 합니다.
    // 이번 프로젝트에서는 우선 현재 패 설명용으로 노출되도록 특수 족보에 포함합니다.
    { pair: [4, 9], name: '구사(재경기)', rankValue: 73, note: '하우스 룰에 따라 재경기 패로 쓰이기도 합니다.' },
  ];

  for (const hand of specialHands) {
    if (isExactPair(cards, hand.pair[0], hand.pair[1])) {
      return {
        rankValue: hand.rankValue,
        name: hand.name,
        type: '특수',
        note: hand.note,
        cards,
      };
    }
  }

  // ------------------------------
  // 4) 끗 판정
  // 갑오(9끗) ~ 망통(0끗)
  // ------------------------------
  const points = (cards[0].month + cards[1].month) % 10;

  return {
    rankValue: 60 + points, // 9끗=69, 8끗=68, ... 0끗=60
    name: points === 9 ? '갑오' : points === 0 ? '망통' : `${points}끗`,
    type: '끗',
    points,
    note: points === 9 ? '끗 패 중 가장 높은 갑오입니다.' : `${points}끗 상태입니다.`,
    cards,
  };
}

/**
 * 두 패를 비교합니다.
 * 반환값:
 *  1  => a가 강함
 *  0  => 동률
 * -1  => b가 강함
 */
function compareHands(a, b) {
  if (a.rankValue > b.rankValue) return 1;
  if (a.rankValue < b.rankValue) return -1;
  return 0;
}

/**
 * 여러 명의 패 중 가장 강한 패(들)를 찾습니다.
 * playerHands 예시:
 * [
 *   { playerId: 'A', hand: {...} },
 *   { playerId: 'B', hand: {...} },
 * ]
 */
function findWinners(playerHands) {
  if (!playerHands || playerHands.length === 0) {
    return [];
  }

  let best = playerHands[0].hand;
  for (let i = 1; i < playerHands.length; i += 1) {
    if (compareHands(playerHands[i].hand, best) === 1) {
      best = playerHands[i].hand;
    }
  }

  return playerHands.filter((entry) => compareHands(entry.hand, best) === 0);
}

/**
 * 화면 출력을 위해 카드 라벨을 만들어 줍니다.
 */
function formatCard(card) {
  return {
    id: card.id,
    month: card.month,
    label: `${card.month}월`,
    isKwang: card.isKwang,
    copy: card.copy,
  };
}



/**
 * 현재 2장 패를 사람이 읽기 쉬운 문장으로 요약합니다.
 * 예: 6월 + 7월 = 3끗
 */
function summarizeHand(cards) {
  const hand = evaluateHand(cards);
  const months = cards.map((card) => `${card.month}월`).join(' + ');
  return {
    name: hand.name,
    type: hand.type,
    note: hand.note || '',
    text: `${months} = ${hand.name}`,
  };
}

module.exports = {
  createDeck,
  shuffleDeck,
  drawCards,
  evaluateHand,
  compareHands,
  findWinners,
  formatCard,
  summarizeHand,
};
