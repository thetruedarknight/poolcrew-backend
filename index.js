const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

app.get('/players', async (req, res) => {
  try {
    const playersSheet = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Players!A2:G', // adjust if your range differs
    });

    const historySheet = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'ELO History!A2:C',
    });

    const players = (playersSheet.data.values || []).map(row => ({
      id: row[0],
      name: row[1],
      nickname: row[2],
      photo: row[3],
      cue: row[4],
      favoriteGame: row[5],
      elo: 1200 // fallback
    }));

    const eloHistory = historySheet.data.values || [];

    // Build latest ELO map with normalized player names
    const latestEloMap = {};

    for (const row of eloHistory) {
      const [dateRaw, playerRaw, eloStr] = row;
      const player = playerRaw?.trim().toLowerCase();
      const date = new Date(dateRaw);
      const elo = parseFloat(eloStr);

      if (!player || isNaN(date) || isNaN(elo)) continue;

      if (!latestEloMap[player] || date > latestEloMap[player].date) {
        latestEloMap[player] = { elo, date };
      }
    }

    // Merge latest ELOs into the player list
    players.forEach(p => {
      const nameKey = p.name?.trim().toLowerCase();
      console.log(`Checking ${nameKey} →`, latestEloMap[nameKey]);
      p.elo = latestEloMap[nameKey]?.elo || 1200;
    });

    res.json(players);
  } catch (err) {
    console.error('Error fetching players:', err);
    res.status(500).send('Failed to fetch players');
  }
});



async function getPlayerELOs() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Players!A2:G',
  });
  const rows = response.data.values || [];
  const eloMap = {};
  rows.forEach(row => {
    const id = row[1];
    const elo = parseFloat(row[6]) || 1200;
    eloMap[id] = elo;
  });
  return { eloMap, rows };
}

function calculateELO(winnerELO, loserELO, netVictory, k = 32) {
  let newWinnerELO = winnerELO;
  let newLoserELO = loserELO;
  for (let i = 0; i < netVictory; i++) {
    const expectedWin = 1 / (1 + Math.pow(10, (newLoserELO - newWinnerELO) / 400));
    newWinnerELO += k * (1 - expectedWin);
    newLoserELO += k * (0 - (1 - expectedWin));
  }
  return [Math.round(newWinnerELO), Math.round(newLoserELO)];
}

async function updatePlayerELOs(player1, player2, winnerName, netVictory) {
  const { eloMap, rows } = await getPlayerELOs();
  const winner = winnerName;
  const loser = winner === player1 ? player2 : player1;
  const [newWinnerELO, newLoserELO] = calculateELO(
    eloMap[winner],
    eloMap[loser],
    netVictory
  );

  const updatedRows = rows.map(row => {
    if (row[1] === winner) row[6] = newWinnerELO.toString();
    if (row[1] === loser) row[6] = newLoserELO.toString();
    return row;
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Players!A2:G',
    valueInputOption: 'USER_ENTERED',
    resource: { values: updatedRows },
  });

  return { newWinnerELO, newLoserELO };
}

async function logELOHistory(date, gameType, matchType, winner, winnerELO, loser, loserELO) {
  const rows = [
    [date, winner, winnerELO, gameType, matchType, loser],
    [date, loser, loserELO, gameType, matchType, winner],
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'ELO History!A2:G',
    valueInputOption: 'USER_ENTERED',
    resource: { values: rows },
  });
}

app.post('/match', async (req, res) => {
  const { player1, player2, p1Score, p2Score, gameType, notes } = req.body;
  const date = new Date().toISOString().split('T')[0];
  const winner = parseInt(p1Score) > parseInt(p2Score) ? player1 : player2;
  const netVictory = Math.abs(parseInt(p1Score) - parseInt(p2Score));

  const newRow = [
    date, player1, player2, '', p1Score, p2Score, winner, gameType, notes || ''
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: '2-Player Races!A2:I',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] },
    });

    const { newWinnerELO, newLoserELO } = await updatePlayerELOs(player1, player2, winner, netVictory);
    const loser = winner === player1 ? player2 : player1;
    await logELOHistory(date, gameType || 'unknown', 'Race', winner, newWinnerELO, loser, newLoserELO);

    res.status(200).json({ message: 'Match recorded' });
  } catch (err) {
    console.error('Error writing match:', err);
    res.status(500).json({ error: 'Failed to record match' });
  }
});

app.post('/1v1', async (req, res) => {
  const { date, playerA, playerB, winner, gameType, sessionId, notes } = req.body;
  const newRow = [date, playerA, playerB, winner, gameType, sessionId, notes || ''];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: '1v1 Games!A2:G',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] },
    });

    const { newWinnerELO, newLoserELO } = await updatePlayerELOs(playerA, playerB, winner, 1);
    const loser = winner === playerA ? playerB : playerA;
    await logELOHistory(date, gameType || 'unknown', '1v1', winner, newWinnerELO, loser, newLoserELO);

    res.status(200).json({ message: '1v1 game recorded and ELO updated' });
  } catch (err) {
    console.error('Error saving 1v1 game:', err);
    res.status(500).json({ error: 'Failed to record 1v1 game' });
  }
});

app.get('/h2h', async (req, res) => {
  const playerA = req.query.playerA;
  const playerB = req.query.playerB;

  if (!playerA || !playerB) {
    return res.status(400).json({ error: 'Both playerA and playerB are required' });
  }

  try {
    const [races, games] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: '2-Player Races!A2:I' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: '1v1 Games!A2:G' }),
    ]);

    const allMatches = [];

    for (let row of races.data.values || []) {
      const [date, p1, p2, , , , winner, gameType] = row;
      if ([p1, p2].includes(playerA) && [p1, p2].includes(playerB)) {
        allMatches.push({ date, winner, gameType, source: 'Race' });
      }
    }

    for (let row of games.data.values || []) {
      const [date, pA, pB, winner, gameType] = row;
      if ([pA, pB].includes(playerA) && [pA, pB].includes(playerB)) {
        allMatches.push({ date, winner, gameType, source: '1v1' });
      }
    }

    allMatches.sort((a, b) => new Date(b.date) - new Date(a.date));

    let winsA = 0, winsB = 0;
    let streaks = { [playerA]: 0, [playerB]: 0 };
    let longest = { [playerA]: 0, [playerB]: 0 };
    let currentStreak = { player: null, count: 0 };
    let lastWinner = null;

    for (let match of allMatches) {
      const winner = match.winner;
      if (winner === playerA) winsA++;
      else if (winner === playerB) winsB++;

      // longest streak logic
      streaks[winner]++;
      if (streaks[winner] > longest[winner]) longest[winner] = streaks[winner];
      const other = winner === playerA ? playerB : playerA;
      streaks[other] = 0;
    }

    // current streak logic (strict)
    for (let match of allMatches) {
      const winner = match.winner;
      if (!lastWinner) {
        lastWinner = winner;
        currentStreak = { player: winner, count: 1 };
      } else if (winner === lastWinner) {
        currentStreak.count += 1;
      } else {
        break;
      }
    }

    const lastMatch = allMatches[0];

    const summary = {
      playerA,
      playerB,
      totalGames: allMatches.length,
      winsA,
      winsB,
      lastMatchDate: lastMatch?.date || null,
      lastWinner: lastMatch?.winner || null,
      gameTypes: [...new Set(allMatches.map(m => m.gameType))],
      currentStreak,
      longestStreaks: longest,
      matchDetails: allMatches,
    };

    res.json(summary);
  } catch (err) {
    console.error('Error calculating head-to-head stats:', err);
    res.status(500).json({ error: 'Failed to fetch H2H data' });
  }
});
const crypto = require('crypto');

app.post('/players/add', async (req, res) => {
  const { name, nickname, photo, cue, favoriteGame } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const id = crypto.randomUUID(); // Unique player ID
  const elo = 1200;
  const newRow = [id, name, nickname || '', photo || '', cue || '', favoriteGame || '', elo];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Players!A2:G',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [newRow],
      },
    });

    res.status(200).json({ message: 'Player added', id });
  } catch (err) {
    console.error('Error adding player:', err);
    res.status(500).json({ error: 'Failed to add player' });
  }
});
app.get('/player/:name/stats', async (req, res) => {
  const playerName = req.params.name;

  try {
    // Load all required tabs
    const [playerRes, racesRes, gamesRes] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Players!A2:G' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: '2-Player Races!A2:I' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: '1v1 Games!A2:G' }),
    ]);

    const playerRow = playerRes.data.values.find(row => row[1] === playerName);
    if (!playerRow) return res.status(404).json({ error: 'Player not found' });

    const playerData = {
      id: playerRow[0],
      name: playerRow[1],
      nickname: playerRow[2],
      photo: playerRow[3],
      cue: playerRow[4],
      favoriteGame: playerRow[5],
      elo: parseFloat(playerRow[6]) || 1200,
    };

    const allMatches = [];

    // Extract matches
    for (const row of racesRes.data.values || []) {
      const [date, p1, p2, , , , winner, gameType] = row;
      if ([p1, p2].includes(playerName)) {
        const opponent = p1 === playerName ? p2 : p1;
        allMatches.push({ date, winner, opponent, source: 'Race', gameType });
      }
    }

    for (const row of gamesRes.data.values || []) {
      const [date, pA, pB, winner, gameType] = row;
      if ([pA, pB].includes(playerName)) {
        const opponent = pA === playerName ? pB : pA;
        allMatches.push({ date, winner, opponent, source: '1v1', gameType });
      }
    }

    // Sort by date desc
    allMatches.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Stats
    let wins = 0, losses = 0;
    let streak = 0, longestStreak = 0;
    let lastWinner = null;
    const opponentMap = {};

    for (const match of allMatches) {
      const isWin = match.winner === playerName;
      const opp = match.opponent;

      if (isWin) {
        wins++;
        streak = lastWinner === playerName ? streak + 1 : 1;
      } else {
        losses++;
        streak = 0;
      }

      if (streak > longestStreak) longestStreak = streak;

      if (!opponentMap[opp]) opponentMap[opp] = { wins: 0, losses: 0 };
      if (isWin) opponentMap[opp].wins++;
      else opponentMap[opp].losses++;

      lastWinner = match.winner;
    }

    const totalGames = wins + losses;
    const winRate = totalGames ? Math.round((wins / totalGames) * 100) : 0;

    const mostWinsAgainst = Object.entries(opponentMap)
      .sort((a, b) => b[1].wins - a[1].wins)[0]?.[0] || null;

    const mostLossesAgainst = Object.entries(opponentMap)
      .sort((a, b) => b[1].losses - a[1].losses)[0]?.[0] || null;

    res.json({
      ...playerData,
      totalGames,
      wins,
      losses,
      winRate,
      longestStreak,
      mostWinsAgainst,
      mostLossesAgainst,
      recentMatches: allMatches.slice(0, 10),
    });
  } catch (err) {
    console.error('Error fetching player stats:', err);
    res.status(500).json({ error: 'Failed to get player stats' });
  }
});
app.get('/elo-history', async (req, res) => {
  try {
    const historyRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'ELO History!A2:G',
    });

    const rows = historyRes.data.values || [];

    // Structure: { playerName: [{ date, elo }, ...] }
    const historyMap = {};

    for (const row of rows) {
      const [date, name, elo] = row;
      if (!date || !name || !elo) continue;

      if (!historyMap[name]) {
        historyMap[name] = [];
      }

      historyMap[name].push({
        date,
        elo: parseFloat(elo),
      });
    }

    // Sort each player's history by date ascending
    for (const player in historyMap) {
      historyMap[player].sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    res.json(historyMap);
  } catch (err) {
    console.error('Error fetching ELO history:', err);
    res.status(500).json({ error: 'Failed to fetch ELO history' });
  }
});
app.get('/match-history', async (req, res) => {
  try {
    const [oneVOneRes, racesRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: '1v1 Games!A2:H',
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: '2-Player Races!A2:J',
      }),
    ]);

const oneVOneGames = (oneVOneRes.data.values || []).map((row, index) => ({
  source: '1v1',
  id: `1v1-${index}`,
  date: row[0],
  playerA: row[1],
  playerB: row[2],
  winner: row[3],
  gameType: row[4],
  sessionId: row[5],
  notes: row[6],
  ignore: (row[7] || '').trim().toLowerCase() === 'yes'
}));

const races = (racesRes.data.values || []).map((row, index) => ({
  source: 'Race',
  id: `race-${index}`,
  date: row[0],
  playerA: row[1],
  playerB: row[2],
  raceTo: row[3],
  scoreA: row[4],
  scoreB: row[5],
  winner: row[6],
  gameType: row[7],
  notes: row[8],
  ignore: (row[9] || '').trim().toLowerCase() === 'yes'
}));

    const combined = [...oneVOneGames, ...races].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    res.json(combined);
  } catch (err) {
    console.error('Error fetching match history:', err);
    res.status(500).send('Failed to fetch match history');
  }
});
app.post('/ignore-match', async (req, res) => {
  const { source, rowIndex, ignore } = req.body;

  if (!['1v1', 'Race'].includes(source)) {
    return res.status(400).json({ error: 'Invalid source type' });
  }

  const range = source === '1v1'
    ? `1v1 Games!H${rowIndex + 2}`  // Column H = Ignore?, +2 for header + 0-based index
    : `2-Player Races!J${rowIndex + 2}`; // Column J = Ignore?

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[ignore ? 'yes' : '']]
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating ignore status:', err);
    res.status(500).json({ error: 'Failed to update ignore status' });
  }
});
app.post('/rebuild-elo', async (req, res) => {
  try {
    await rebuildEloHistory();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to rebuild ELO:', err);
    res.status(500).json({ error: 'ELO rebuild failed' });
  }
});

const rebuildEloHistory = async () => {
  const getSheet = async (range) => {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });
    return res.data.values || [];
  };

  const oneVOneRows = await getSheet('1v1 Games!A2:G');
  const raceRows = await getSheet('2-Player Races!A2:I');

  const eloHistory = [];
  const eloMap = {};
  const baseELO = 1200;
  const matches = [];

  for (const row of oneVOneRows) {
    const [date, pA, pB, winner, gameType, sessionId, notes] = row;
    matches.push({
      date,
      playerA: pA,
      playerB: pB,
      winner,
      type: '1v1',
      gameType,
    });
  }

  for (const row of raceRows) {
    const [date, pA, pB, raceTo, scoreA, scoreB, winner, gameType, notes] = row;
    matches.push({
      date,
      playerA: pA,
      playerB: pB,
      winner,
      type: 'race',
      scoreA: parseInt(scoreA),
      scoreB: parseInt(scoreB),
      gameType,
    });
  }

  matches.sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const match of matches) {
    const { playerA, playerB, winner } = match;
    if (!eloMap[playerA]) eloMap[playerA] = baseELO;
    if (!eloMap[playerB]) eloMap[playerB] = baseELO;

    const eloA = eloMap[playerA];
    const eloB = eloMap[playerB];

    const expectedA = 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
    const expectedB = 1 - expectedA;

    let scoreA = winner === playerA ? 1 : 0;
    let scoreB = 1 - scoreA;

    let weight = 1;
    if (match.type === 'race') {
      const net = Math.abs(match.scoreA - match.scoreB);
      weight = Math.min(1 + net / 10, 2);
    }

    const K = match.type === '1v1' ? 16 : 32;
    eloMap[playerA] += K * weight * (scoreA - expectedA);
    eloMap[playerB] += K * weight * (scoreB - expectedB);

    eloHistory.push([match.date, playerA, Math.round(eloMap[playerA])]);
    eloHistory.push([match.date, playerB, Math.round(eloMap[playerB])]);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'ELO History!A2:C',
    valueInputOption: 'RAW',
    requestBody: {
      values: eloHistory
    }
    
  });
  if (eloHistory.length === 0) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: 'ELO History!A2:F'
  });
  return;
}

};

app.delete('/last-match', async (req, res) => {
  try {
    const getRows = async (range) => {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range,
      });
      return res.data.values || [];
    };

    const oneVOne = await getRows('1v1 Games!A2:G');
    const races = await getRows('2-Player Races!A2:I');

    const last1v1 = oneVOne.length > 0 ? oneVOne[oneVOne.length - 1] : null;
    const lastRace = races.length > 0 ? races[races.length - 1] : null;

    const date1v1 = last1v1 ? new Date(last1v1[0]) : null;
    const dateRace = lastRace ? new Date(lastRace[0]) : null;

    let deleteRange = null;

    if (date1v1 && (!dateRace || date1v1 > dateRace)) {
      deleteRange = `1v1 Games!A${oneVOne.length + 1}:G${oneVOne.length + 1}`;
    } else if (dateRace) {
      deleteRange = `2-Player Races!A${races.length + 1}:I${races.length + 1}`;
    } else {
      return res.status(400).json({ error: 'No matches to delete' });
    }

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: deleteRange,
    });

    await rebuildEloHistory();

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete last match:', err);
    res.status(500).json({ error: 'Failed to delete match' });
  }
});

app.get('/drills', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Drills!A2:C',
    });

    const drills = (response.data.values || []).map(row => ({
      name: row[0],
      skill: row[1],
      maxScore: parseInt(row[2])
    }));

    res.json(drills);
  } catch (err) {
    console.error('Error fetching drills:', err);
    res.status(500).send('Failed to fetch drills');
  }
});
app.post('/drills', async (req, res) => {
  const { name, skill, maxScore } = req.body;

  if (!name || !skill || isNaN(maxScore)) {
    return res.status(400).send('Invalid drill data');
  }

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Drills!A2:C',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[name, skill, maxScore]]
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error adding drill:', err);
    res.status(500).send('Failed to add drill');
  }
});
app.post('/training-log', async (req, res) => {
  const { entries } = req.body; // array of { date, player, drill, score, notes }

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).send('Invalid entries');
  }

  const values = entries.map(e => [
    e.date, e.player, e.drill, e.score, e.notes || ''
  ]);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Training Logs!A2:E',
      valueInputOption: 'RAW',
      requestBody: { values }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error logging training data:', err);
    res.status(500).send('Failed to log training data');
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
