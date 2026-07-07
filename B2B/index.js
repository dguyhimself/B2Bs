require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
// NEW SOLANA IMPORTS:
const { TronWeb } = require('tronweb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const BigNumber = require('bignumber.js');

const safeAdd = (a, b) => new BigNumber(a || 0).plus(b || 0).decimalPlaces(6, BigNumber.ROUND_DOWN).toNumber();
const safeSub = (a, b) => new BigNumber(a || 0).minus(b || 0).decimalPlaces(6, BigNumber.ROUND_DOWN).toNumber();
const safeMul = (a, b) => new BigNumber(a || 0).multipliedBy(b || 0).decimalPlaces(6, BigNumber.ROUND_DOWN).toNumber();
const safeDiv = (a, b) => new BigNumber(a || 0).dividedBy(b || 0).decimalPlaces(6, BigNumber.ROUND_DOWN).toNumber();

// --- Security: AES-256 Wallet Encryption ---
// We hash your JWT_SECRET to ensure we have a mathematically perfect 32-byte key for AES-256
const ENCRYPTION_KEY = crypto.createHash('sha256').update(process.env.JWT_SECRET || 'emergency_fallback_key').digest();

function encryptPrivateKey(plainTextKey) {
    const iv = crypto.randomBytes(16); // Unique Initialization Vector per wallet
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(plainTextKey);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    // Store as "ivHex:encryptedHex"
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptPrivateKey(encryptedString) {
    const parts = encryptedString.split(':');
    // Backward compatibility: If it doesn't have a colon, it's an old plaintext key from testing
    if (parts.length !== 2) return encryptedString; 

    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

const tronWeb = new TronWeb({
    fullHost: process.env.TRON_RPC_URL || 'https://api.trongrid.io',
    privateKey: process.env.HOT_WALLET_PRIVATE_KEY
});
const USDT_CONTRACT = process.env.USDT_CONTRACT_ADDRESS;

const depositCooldowns = {};
const chatCooldowns = {};
// --- SECURITY: IP TRACKERS ---
const ipRegTracker = {}; // Tracks last registration time per IP
const ipLoginFails = {}; // Tracks failed logins per IP (Brute force protection)

// Helper function to get the real IP, even if behind Cloudflare or a Proxy
function getClientIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return socket.handshake.address || 'unknown_ip';
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. NOW ADD YOUR ROUTES
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the dedicated authentication page
app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'auth.html'));
});

// --- Game Constants & State ---
// --- Game Constants & State ---
const GAME_STATE = { WAITING: 'WAITING', PLAYING: 'PLAYING', CRASHED: 'CRASHED' };
const WAIT_TIME_MS = 6000;
const GROWTH_RATE = 0.00006; 
const HOUSE_EDGE = 0.05;
const MAX_PAYOUT_USD = 5000.00; // NEW: Max profit per round


let currentState = GAME_STATE.WAITING;
let currentCrashPoint = 1.00;
let gameStartTime = 0;
let gameTicker = null; // NEW
let gameCrashTimeMs = 0;
let crashHistory = [];
const chatHistory = []; // Stores the last 50 messages
let currentServerSeed = '';
let currentHash = '';

// In-Memory Database (Will be replaced by Supabase in Phase 2)
const players = {}; 
let activeBets = {}; 

// --- Affiliate Commission Batcher ---
const pendingCommissions = {};

// --- BOT SYSTEM (FAKE USERS & ACTIVITY) ---
// --- BOT SYSTEM (FAKE USERS & ACTIVITY) ---

const botAdjectives = [
    // Original & Retro
    "Crypto", "Lucky", "Moon", "Degen", "Diamond", "Based", "Neon", "Golden", "Alpha", "Satoshi", 
    "Hyper", "Toxic", "Swift", "Quiet", "Magic", "Dark", "Crazy",
    // Trading & Market states
    "Bullish", "Bearish", "Rekt", "Leveraged", "Liquidated", "Pumped", "Dumped", "Short", "Long", "Broke",
    // Tech & Web3
    "Giga", "Cyber", "Meta", "Quantum", "Astro", "Stellar", "Cosmic", "Stealth", "Node", "Hash",
    // Aesthetic & Attitude
    "Savage", "Elite", "Prime", "Turbo", "Blaze", "Frost", "Shadow", "Rogue", "Ghost", "Sleek", 
    "Shady", "Smug", "Heavy", "Hype", "Doubtful", "Based", "Glow", "Static", "Pixel", "Vintage"
];

const botNouns = [
    // Original & Jargon
    "Whale", "Ape", "King", "God", "Bull", "Bear", "Chad", "Hands", "Roller", "Shark", 
    "Ninja", "Trader", "Sniper", "Baron", "Lord", "Fox", "Wolf",
    // Jargon & Culture
    "HODLer", "Miner", "Farmer", "Bagholder", "Wojak", "Pepe", "Yoloer", "Flipper", "Degen", "Gambler",
    // Animals (Casino Slang)
    "Shrimp", "Crab", "Fish", "Cobra", "Viper", "Badger", "Lion", "Tiger", "Falcon", "Eagle",
    // Tech & Items
    "Rocket", "Ledger", "Coin", "Token", "Gas", "Swap", "Node", "Stake", "Pool", "Wallet",
    // Archetypes
    "Goddess", "Samurai", "Knight", "Boss", "Guru", "Wizard", "Witch", "Spectre", "Pharaoh", "Baroness"
];

const botNames = [
    // Original
    "Alex", "Mike", "Sarah", "David", "Chris", "John", "Tom", "Sam", "Jake", "Kevin", 
    "Leo", "Max", "Mia", "Zack", "Eli", "Ruby", "Josh",
    // Global & Common Username Names
    "Nick", "Ryan", "Emma", "Luke", "Sophia", "Jack", "James", "Olivia", "Liam", "Noah", 
    "Chloe", "Tony", "Marcus", "Elena", "Victor", "Vlad", "Yuri", "Yuki", "Kenji", "Hans",
    // Famous Crypto Figures & Memes
    "Vitalik", "Satoshi", "Pavel", "Charles", "Elon", "Justin", "Dan", "Matt", "Ben", "Tyler", 
    "Grace", "Anna", "Lisa", "Gavin", "Arthur", "Craig", "Michael", "Hal", "NickSzabo", "Winklevoss"
];

function generateRealisticBotName() {
    const rand = Math.random();
    let name = "";

    if (rand < 0.35) {
        // 35% Chance: Crypto Slang (e.g., CryptoWhale, DegenApe)
        name = botAdjectives[Math.floor(Math.random() * botAdjectives.length)] + botNouns[Math.floor(Math.random() * botNouns.length)];
    } else if (rand < 0.65) {
        // 30% Chance: Normal human names (e.g., Alex, Sarah)
        name = botNames[Math.floor(Math.random() * botNames.length)];
    } else if (rand < 0.85) {
        // 20% Chance: Just a random cool word
        name = botAdjectives[Math.floor(Math.random() * botAdjectives.length)];
    } else {
        // 15% Chance: Lazy burner accounts (e.g., user84932)
        return "user" + Math.floor(10000 + Math.random() * 90000);
    }

    // 60% chance to append numbers at the end (like real people do)
    if (Math.random() < 0.6) {
        const numberTypes = [
            Math.floor(Math.random() * 99), // 1-99
            Math.floor(1980 + Math.random() * 25), // Birth years (1980-2005)
            69, 420, 777, 88, 999 // Meme/Lucky numbers
        ];
        name += numberTypes[Math.floor(Math.random() * numberTypes.length)];
    }

    // 20% chance for the user to have typed their name entirely in lowercase
    if (Math.random() < 0.2) name = name.toLowerCase();

    return name;
}
let fakeOnlineCount = 250;

// Fluctuate online users randomly every 5 seconds
setInterval(() => {
    fakeOnlineCount += Math.floor(Math.random() * 11) - 5; // changes by -5 to +5
    if (fakeOnlineCount < 200) fakeOnlineCount = 200;
    if (fakeOnlineCount > 300) fakeOnlineCount = 300;
    io.emit('online_count', io.engine.clientsCount + fakeOnlineCount);
}, 5000);

// Function to generate a realistic bot bet
function placeBotBet(index) {
    if (currentState !== GAME_STATE.WAITING) return; // Prevent betting if game already started

    const botId = 'BOT_' + index + '_' + Date.now();
    const username = generateRealisticBotName();

    // --- HIGHLY REALISTIC HUMAN BET AMOUNTS ---
    let amount = 0;
    const rand = Math.random();

    if (rand < 0.35) {
        // 35% Chance: Micro-bets ($1.00 - $15.00)
        // Lots of players doing very small test bets
        amount = parseFloat((Math.random() * 14 + 1).toFixed(2));

    } else if (rand < 0.70) {
        // 35% Chance: Standard Small Round Numbers ($10 - $50)
        // The absolute most common human inputs
        const coreRounds = [10, 15, 20, 25, 30, 40, 50];
        amount = coreRounds[Math.floor(Math.random() * coreRounds.length)];

    } else if (rand < 0.92) {
        // 22% Chance: Organic messy numbers ($15.00 - $60.00)
        // Looks like real players hitting "Half" or betting random balances
        amount = parseFloat((Math.random() * 45 + 15).toFixed(2));

    } else if (rand < 0.985) {
        // 6.5% Chance: Medium-High Rollers ($75 - $150)
        const upperTiers = [75, 100, 120, 150];
        amount = upperTiers[Math.floor(Math.random() * upperTiers.length)];

    } else if (rand < 0.998) {
        // 1.3% Chance: High Rollers ($200 - $300)
        const highTiers = [200, 250, 300];
        amount = highTiers[Math.floor(Math.random() * highTiers.length)];

    } else {
        // 0.2% Chance: True Whales (Extremely rare 500, 777, or 1000)
        const whales = [500, 777, 1000];
        amount = whales[Math.floor(Math.random() * whales.length)];
    }

    // Random wagered amount to give them varying VIP badges
    const wagered = Math.random() * 15000;

    // Target cashout multiplier (Behavior)
    let target = 1.01;
    const tRand = Math.random();
    if (tRand < 0.3) target = 1.1 + Math.random() * 0.4; // Safe players (1.1x - 1.5x)
    else if (tRand < 0.7) target = 1.5 + Math.random() * 1.5; // Normal players (1.5x - 3.0x)
    else if (tRand < 0.9) target = 3.0 + Math.random() * 7.0; // Risky players (3.0x - 10.0x)
    else target = 10.0 + Math.random() * 90.0; // Moonboys (10.0x - 100.0x)

    // Store in active bets but flag as Bot so it doesn't touch the Database!
    activeBets[botId] = {
        isBot: true,
        username: username,
        amountUsd: amount,
        targetMult: target,
        cashedOut: false,
        wagered: wagered
    };

    io.emit('player_bet', { id: botId, username: username, amount: amount, wagered: wagered });
}

// Function to handle bot cashout
function processBotCashout(botId, mult) {
    if (currentState !== GAME_STATE.PLAYING) return;
    const bet = activeBets[botId];
    if (!bet || bet.cashedOut) return;

    bet.cashedOut = true;
    bet.cashoutMult = mult;
    const winAmountUsd = bet.amountUsd * mult;

    io.emit('player_cashed_out', {
        id: botId,
        username: bet.username,
        multiplier: mult.toFixed(2),
        winAmount: winAmountUsd.toFixed(2)
    });
}
// --- END BOT SYSTEM ---

// --- BOT CHAT SYSTEM (HIGHLY REALISTIC & DEGEN UPGRADE) ---
const botChatPhrases = {
    general: [
        "LFG!!!", 
        "anyone winning today or we all getting rekt?", 
        "this game is addictive as fuck", 
        "W", 
        "GG", 
        "bruh", 
        "lol", 
        "gl all", 
        "yo", 
        "let's get this bread", 
        "any active promo codes or rains?", 
        "green day today boys",
        "down 300 bucks fml",
        "this site is actually clean",
        "TRX pumping wtf",
        "tip me $1 for luck? literally broke lmao",
        "who is that high roller in the list?",
        "chat is quiet as shit today",
        "road to diamond rank is painful",
        "how long have you guys been playing here?",
        "ez money today, love to see it",
        "don't play with rent money kids",
        "i was down so bad yesterday but we back",
        "anyone else just watching the rocket?",
        "based dev team tbh"
    ],
    waiting: [
        "skipping this one, looks sketchy", 
        "ALL IN FUCK IT", 
        "feeling a massive 10x coming here", 
        "here we go again", 
        "don't get greedy you greedy bastards", 
        "red or green?", 
        "send it!!!", 
        "betting max, watch me blow up", 
        "my balance is fucking crying", 
        "let it ride!",
        "fuck it, we ball",
        "easy 2x incoming trust me",
        "please don't crash at 1.00x i beg",
        "loading up a fat bet",
        "holding until 5x minimum",
        "just put my last $20 on this, wish me luck",
        "watch this go to 100x since i didn't bet big",
        "ready for take off",
        "let's print some usdt boys"
    ],
    crash_early: [
        "rigged as fuck", 
        "lmao rekt", 
        "of course, standard bullshit", 
        "gg", 
        "wtf", 
        "rip my balance", 
        "unlucky as shit", 
        "always crashes early when i bet", 
        "brooo", 
        "F", 
        "fucking scammed", 
        "i hate this fucking game", 
        "bruhhhhh",
        "1.02x? are you kidding me",
        "instant crash is crazy",
        "fuck my life",
        "back to working 9-5",
        "unbelievable shit right here",
        "paper hands saved me there",
        "crashed right before i clicked cashout, fuck lag"
    ],
    crash_late: [
        "omg who held??? absolute gigachad", 
        "insane run", 
        "I cashed out way too fucking early...", 
        "holy shit!!!", 
        "huge massive W", 
        "damn that was beautiful", 
        "what a multiplier", 
        "to the fucking moon!!!", 
        "wow", 
        "easy fucking money",
        "my hands were shaking so bad",
        "wish i bet more than 2 bucks on that ffs",
        "congrats to anyone who held past 50x",
        "absolute legendary multiplier",
        "that was printing money",
        "fucking massive",
        "insane hand"
    ]
};
function triggerBotChat(type) {
    // 50% chance a bot actually decides to type something so it's not robotic/spammy
    if (Math.random() > 0.5) return; 

    const phrases = botChatPhrases[type] || botChatPhrases.general;
    const text = phrases[Math.floor(Math.random() * phrases.length)];

    // Generate a random bot player profile
    const username = generateRealisticBotName();
    const wagered = Math.random() * 20000; // Gives them random Bronze/Silver/Gold/Diamond badges

    const msgData = {
        id: Date.now() + Math.random(),
        username: username,
        text: text,
        timestamp: Date.now(),
        wagered: wagered,
        isBot: true
    };

    // Save to memory so new tabs can see it, and broadcast to everyone
    chatHistory.push(msgData);
    if (chatHistory.length > 50) chatHistory.shift();

    io.emit('chat_message', msgData);
}

// Background idle chatter every 8-15 seconds
setInterval(() => {
    if (currentState === GAME_STATE.WAITING || currentState === GAME_STATE.PLAYING) {
        if (Math.random() < 0.4) triggerBotChat('general');
    }
}, 10000);
// --- END BOT CHAT SYSTEM ---

function generateUsername(socketId) {
    return 'PLYR_' + socketId.substring(0, 4).toUpperCase();
}
function generateUsername(socketId) {
    return 'PLYR_' + socketId.substring(0, 4).toUpperCase();
}

// --- NEW HELPER: Standardize the UI Payload ---
function getInitPayload(player) {
    return {
        player: player,
        state: currentState,
        history: crashHistory.slice(-50),
        startTime: gameStartTime, // Always send the start time of the current phase
        elapsed: Date.now() - gameStartTime, // Works for both WAITING and PLAYING
        activeBets: activeBets,
        hash: currentHash,
        seed: currentState === GAME_STATE.CRASHED ? currentServerSeed : null,
        chatHistory: chatHistory,
        waitTime: WAIT_TIME_MS // Tell frontend how long the wait is
    };
}

/**
 * PROVABLY FAIR RNG LOGIC
 */
function generateCrashPoint(seed) {
    // Take the first 8 characters of the hex seed and convert to a number
    const h = parseInt(seed.substring(0, 8), 16);

    // Convert it to a secure float between 0 and 1
    const r = h / (2**32 - 1);

    if (r <= HOUSE_EDGE) return 1.00;

    const result = 0.95 / (1 - r); // <-- Changed 0.99 to 0.95
    return Math.max(1.00, Math.min(result, 1000000.00));
}

// Helper to calculate exact multiplier at any given millisecond
function getMultiplierAtTime(elapsedMs) {
    return Math.pow(Math.E, GROWTH_RATE * elapsedMs);
}

function startWaiting() {
    clearInterval(gameTicker); 
    currentState = GAME_STATE.WAITING;
    activeBets = {};
    gameStartTime = Date.now(); // <-- ADD THIS TO SYNC THE COUNTDOWN

    currentServerSeed = crypto.randomBytes(32).toString('hex');
    currentHash = crypto.createHash('sha256').update(currentServerSeed).digest('hex');

    // Spawn 50 to 230 fake bots every single round
    const numBots = Math.floor(Math.random() * (230 - 50 + 1)) + 50;
    for(let i = 0; i < numBots; i++) {
        let delay;
        if (Math.random() < 0.4) {
            // 40% of players rush to bet in the first 1.5 seconds
            delay = Math.random() * 1500;
        } else {
            // 60% of players casually place bets throughout the wait time
            delay = Math.random() * (WAIT_TIME_MS - 500); 
        }
        setTimeout(() => placeBotBet(i), delay);
    }
    // Bots chatting during the wait time
    setTimeout(() => triggerBotChat('waiting'), 1500 + Math.random() * 1000);
    setTimeout(() => triggerBotChat('waiting'), 3500 + Math.random() * 1000);

    io.emit('game_waiting', { 
        waitTime: WAIT_TIME_MS,
        history: crashHistory.slice(-50),
        hash: currentHash 
    });

    setTimeout(startGame, WAIT_TIME_MS);
}

function startGame() {
    clearInterval(gameTicker); // Ensure previous loop is dead
    currentState = GAME_STATE.PLAYING;
    currentCrashPoint = generateCrashPoint(currentServerSeed); // Use the seed here!

    gameCrashTimeMs = Math.log(currentCrashPoint) / GROWTH_RATE;
    gameStartTime = Date.now();

    console.log(`[GAME] Round Started. Secret Crash Point: ${currentCrashPoint.toFixed(2)}x`);

    io.emit('game_start', { startTime: gameStartTime });

    // Evaluate Auto-Cashouts & MAX PAYOUT Limits
    for (const userId in activeBets) {
        const bet = activeBets[userId];

        // --- BOT CASHOUT LOGIC ---
        if (bet.isBot) {
            // If the bot's target is lower than the crash point, schedule their cashout!
            if (bet.targetMult <= currentCrashPoint) {
                const autoTimeMs = Math.log(bet.targetMult) / GROWTH_RATE;
                setTimeout(() => processBotCashout(userId, bet.targetMult), autoTimeMs);
            }
            // Skip the rest of the loop so bots don't use real user logic
            continue; 
        }
        // -------------------------

        // Calculate at what multiplier this user hits the $5,000 Max Payout
        const maxPayoutMultiplier = MAX_PAYOUT_USD / bet.amountUsd;

        // Decide which comes first: The user's Auto-Out, or the Casino's Max Payout
        let targetMultiplier = maxPayoutMultiplier;
        let reason = 'MAX_PAYOUT';

        if (bet.autoCashout > 1.00 && bet.autoCashout < maxPayoutMultiplier) {
            targetMultiplier = bet.autoCashout;
            reason = 'AUTO';
        }

        // Only schedule the cashout if it happens BEFORE the system crashes
        if (targetMultiplier <= currentCrashPoint) {
            const autoTimeMs = Math.log(targetMultiplier) / GROWTH_RATE;
            setTimeout(() => processCashout(userId, targetMultiplier, reason), autoTimeMs);
        }
    }

// --- PRECISION GAME LOOP ---
    // Instead of a single timeout that drifts, we check the exact time every 30 milliseconds.
    // This ensures the backend crashes precisely on time, preventing visual overshoots on the frontend.
    gameTicker = setInterval(() => {
        const elapsed = Date.now() - gameStartTime;
        if (elapsed >= gameCrashTimeMs) {
            clearInterval(gameTicker);
            crashGame();
        }
    }, 30);
}

async function crashGame() {
    currentState = GAME_STATE.CRASHED;
    // NEW: Store rich history objects instead of just numbers
    crashHistory.push({ 
        mult: currentCrashPoint, 
        hash: currentHash, 
        seed: currentServerSeed 
    });

    if (crashHistory.length > 50) crashHistory.shift(); // Keep last 50 rounds

    // 1. Gather all losing players into a list and update server RAM instantly
    const lossUpdates = [];
    for(const id in activeBets) {
        if (activeBets[id].isBot) continue; // SECURITY: Ignore bots so they don't touch the DB!

        if(!activeBets[id].cashedOut && players[id]) {
            // SECURE MATH
            players[id].netProfit = safeSub(players[id].netProfit, activeBets[id].amountUsd);
            lossUpdates.push({ id: id, netProfit: players[id].netProfit });
        }
    }

    // 2. Reveal the seed to the players instantly!
    // We do this BEFORE the database updates so the players experience ZERO lag on their screens.
    io.emit('game_crashed', { crashPoint: currentCrashPoint, seed: currentServerSeed });
    activeBets = {}; 

    // --- SECURITY: BATCHED DATABASE UPDATES ---
    // Instead of blasting the DB with 200 concurrent connections, we chunk them into groups of 10.
    // This perfectly respects Supabase connection limits and prevents API rate-limiting!
    const BATCH_SIZE = 10;
    for (let i = 0; i < lossUpdates.length; i += BATCH_SIZE) {
        const batch = lossUpdates.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(u => 
            supabase.from('users').update({ 
                net_profit: u.netProfit,
                active_bet_amount: 0 // Bet resolved (loss finalized, unlock the funds!)
            }).eq('id', u.id)
        )).catch(err => console.error("Batch DB Update Error:", err));
    }

    // --- BOT CHAT REACTION LOGIC ---
    // Bots read the crash multiplier and react like real humans
    let crashReactionType = 'general';
    if (currentCrashPoint < 2.0) {
        crashReactionType = 'crash_early'; // Rage, rigged, F
    } else if (currentCrashPoint > 10.0) {
        crashReactionType = 'crash_late'; // OMG, massive W, insane
    }

    // Stagger their typing speed so it looks like humans typing after the explosion
    setTimeout(() => triggerBotChat(crashReactionType), 800 + Math.random() * 1000);
    setTimeout(() => triggerBotChat(crashReactionType), 1500 + Math.random() * 1500);
    setTimeout(() => triggerBotChat('general'), 2500 + Math.random() * 1500);
    // --------------------------------

    // --- SECURITY: POST-ROUND RAM SWEEP ---
    // Now that all bets are resolved and safely saved to the DB, sweep the RAM for offline users
    for (const pid in players) {
        const connectedTabs = io.sockets.adapter.rooms.get(pid)?.size || 0;
        if (connectedTabs === 0) {
            delete players[pid];
            delete depositCooldowns[pid];
            console.log(`[GC] Post-round sweep cleared offline user: ${pid}`);
        }
    }

    // Start the next round
    setTimeout(startWaiting, 4000); 
}

// Add `reason` as the third parameter
async function processCashout(userId, forcedMultiplier = null, reason = 'MANUAL') {
    if (currentState !== GAME_STATE.PLAYING) return false;

    const bet = activeBets[userId];
    if (!bet || bet.cashedOut) return false;

    const elapsedMs = Date.now() - gameStartTime;
    let multiplier = forcedMultiplier || getMultiplierAtTime(elapsedMs);

    // --- SECURITY: THE HARD CAP ---
    // Mathematically prevent the multiplier from EVER exceeding the Casino Max Payout, 
    // completely neutralizing any setTimeout lag or manual click exploits.
    const maxAllowedMultiplier = safeDiv(MAX_PAYOUT_USD, bet.amountUsd);

    if (multiplier >= maxAllowedMultiplier) {
        multiplier = maxAllowedMultiplier;
        reason = 'MAX_PAYOUT'; // Force the UI to show the Trophy toast
    }

    // Security check: Ensure they didn't cash out after the crash
    if (multiplier > currentCrashPoint) return false; 

    bet.cashedOut = true;
    bet.cashoutMult = multiplier;

    // SECURE MATH (Everything is USD now)
    const winAmountUsd = safeMul(bet.amountUsd, multiplier);
    const profitUsd = safeSub(winAmountUsd, bet.amountUsd);

    if (players[userId]) {
        players[userId].balance = safeAdd(players[userId].balance, winAmountUsd);
        players[userId].lifetimeWon = safeAdd(players[userId].lifetimeWon, winAmountUsd);
        players[userId].netProfit = safeAdd(players[userId].netProfit, profitUsd);

        // AWAIT the database update before telling the frontend it succeeded
        try {
            await supabase.from('users').update({
                balance: players[userId].balance,
                lifetime_won: players[userId].lifetimeWon,
                net_profit: players[userId].netProfit,
                active_bet_amount: 0 // Bet resolved successfully!
            }).eq('id', userId);
        } catch (dbErr) {
            console.error("DB Update Error (Win):", dbErr);
        }
    }

    io.to(userId).emit('cashout_success', { 
        multiplier: multiplier.toFixed(2), 
        winAmount: winAmountUsd.toFixed(2), 
        balance: players[userId] ? players[userId].balance : 0,
        stats: players[userId],
        reason: reason 
    });

    io.emit('player_cashed_out', {
        id: userId,
        username: players[userId].username,
        multiplier: multiplier.toFixed(2),
        winAmount: winAmountUsd.toFixed(2)
    });

    return true;
}

// --- Socket Handling & Authentication ---
// --- Socket Handling & Authentication ---
io.on('connection', async (socket) => {
    const clientToken = socket.handshake.auth.token;
    let userId = null;

    // --- REAL-TIME TELEMETRY ---
    // Instantly tell everyone the new exact number of connected devices
    io.emit('online_count', io.engine.clientsCount + fakeOnlineCount);

    // Respond to Ping Requests instantly with the exact timestamp received
    socket.on('ping_req', (timestamp) => {
        socket.emit('pong_res', timestamp);
    });

    // 1. VERIFY JWT TOKEN SECURELY
    if (clientToken) {
        // If they have the old insecure 'USR_' token from our testing, force them to clear it
        if (clientToken.startsWith('USR_')) {
            return socket.emit('force_logout');
        }

        try {
            // Cryptographically verify the token using our secret
            const decoded = jwt.verify(clientToken, process.env.JWT_SECRET);
            userId = decoded.userId; 
        } catch (err) {
            // If the token is fake, tampered with, or expired, reject them
            console.log("Invalid token attempt blocked.");
            return socket.emit('force_logout');
        }
    }

    // --- AUTHENTICATION ROUTES (Open to unauthenticated users) ---

    socket.on('register', async (data) => {
        // --- 1. IP RATE LIMITER (1 Account per 15 Minutes per IP) ---
        const ip = getClientIp(socket);
        const REG_COOLDOWN_MS = 15 * 60 * 1000; // 15 Minutes

        if (ipRegTracker[ip] && Date.now() - ipRegTracker[ip] < REG_COOLDOWN_MS) {
            const minsLeft = Math.ceil((REG_COOLDOWN_MS - (Date.now() - ipRegTracker[ip])) / 60000);
            return socket.emit('auth_error', `TOO MANY ACCOUNTS. WAIT ${minsLeft} MINS.`);
        }
        if (!data || typeof data.username !== 'string' || typeof data.password !== 'string') {
            return socket.emit('auth_error', 'Invalid input format.');
        }

        const username = data.username.trim();
        const password = data.password.trim();
        const email = data.email ? data.email.trim().toLowerCase() : ''; 
        const refCode = data.refCode ? data.refCode.trim().toUpperCase() : null; 

        if (username.length < 3 || username.length > 12) return socket.emit('auth_error', 'Username must be 3-12 chars.');
        if (password.length < 5 || password.length > 64) return socket.emit('auth_error', 'Password must be 5-64 chars.');

        // Strict Email Validation Regex
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return socket.emit('auth_error', 'Invalid email address.');

        // Check if Referral Code exists
        let sponsorId = null;
        if (refCode && refCode !== username.toUpperCase()) {
            const { data: sponsorData } = await supabase.from('users').select('id, total_referred').eq('username', refCode).single();
            if (sponsorData) {
                sponsorId = sponsorData.id;
                const newTotal = sponsorData.total_referred + 1;

                // Increment sponsor's referral count in Database
                await supabase.from('users').update({ total_referred: newTotal }).eq('id', sponsorId);

                // --- LIVE UI UPDATE ---
                if (players[sponsorId]) {
                    players[sponsorId].totalReferred = newTotal;
                    io.to(sponsorId).emit('stats_update', players[sponsorId]);
                }
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUserId = 'USR_' + crypto.randomBytes(8).toString('hex').toUpperCase();
        const account = await tronWeb.createAccount();

        const newUser = {
            id: newUserId,
            username: username.toUpperCase(),
            email: email, // <-- EMAIL SAVED HERE
            password: hashedPassword,
            balance: 0.00,
            lifetime_wagered: 0,
            lifetime_won: 0,
            net_profit: 0,
            total_bets: 0,
            total_deposited: 0.00,
            claimed_rakeback: 0.00,
            referred_by: sponsorId, 
            affiliate_earned: 0.00, 
            affiliate_claimed: 0.00, 
            total_referred: 0, 
            deposit_address: account.address.base58,
            private_key: encryptPrivateKey(account.privateKey),
            // --- LUCKY SPIN WELCOME REWARDS ---
            free_spins: 6,
            locked_bonus: 0.00,
            bonus_expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // Expires in exactly 24 hours
        };

        const { error } = await supabase.from('users').insert([newUser]);

        if (error) {
            // 1. Expected Postgres duplicate error (username or email already taken)
            if (error.code === '23505') {
                if (error.message && error.message.includes('email')) {
                    return socket.emit('auth_error', 'EMAIL ALREADY IN USE');
                }
                return socket.emit('auth_error', 'USERNAME ALREADY TAKEN');
            }

            // 2. UNEXPECTED Database issue (Supabase down, wrong credentials, etc.)
            // ONLY print to terminal if it's a real crash so your logs stay clean!
            console.error("CRITICAL Database Registration Error:", error); 
            return socket.emit('auth_error', 'Database error during registration.');
        }

        const secureToken = jwt.sign({ userId: newUserId }, process.env.JWT_SECRET, { expiresIn: '30d' });

        // Register the successful account creation to lock the IP for 15 mins
        ipRegTracker[ip] = Date.now(); 

        socket.emit('auth_success', secureToken);
    });

    socket.on('login', async (data) => {
        const ip = getClientIp(socket);
        const now = Date.now();
    
        // 1. Check if this IP is currently locked out
        if (!ipLoginFails[ip]) ipLoginFails[ip] = { count: 0, lockoutUntil: 0 };
    
        if (now < ipLoginFails[ip].lockoutUntil) {
            const minsLeft = Math.ceil((ipLoginFails[ip].lockoutUntil - now) / 60000);
            return socket.emit('auth_error', `LOCKED OUT. TRY AGAIN IN ${minsLeft} MINS.`);
        }
    
        // SECURITY 1: Strict Type Checking
        if (!data || typeof data.username !== 'string' || typeof data.password !== 'string') {
            return socket.emit('auth_error', 'Invalid input format.');
        }

        // ---> ADD THESE TWO MISSING LINES HERE <---
        const username = data.username.trim();
        const password = data.password.trim();

        // SECURITY 2: Strict Length Constraints
        if (username.length < 3 || username.length > 12 || password.length < 5 || password.length > 64) {
            return handleFailedLogin(ip, socket); // Use the helper below
        }
    
        const { data: user, error } = await supabase
            .from('users')
            .select('id, password')
            .eq('username', username.toUpperCase())
            .single();
    
        if (error || !user) {
            return handleFailedLogin(ip, socket);
        }
    
        // SECURE & NON-BLOCKING: Await the comparison
        const isValidPassword = await bcrypt.compare(password, user.password);
    
        if (!isValidPassword) {
            return handleFailedLogin(ip, socket);
        }
    
        // IF SUCCESSFUL: Reset their fail count and let them in!
        ipLoginFails[ip].count = 0; 
    
        const secureToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        socket.emit('auth_success', secureToken);
    });
    // Helper function to handle increasing strike counts for hackers
    function handleFailedLogin(ip, socket) {
        ipLoginFails[ip].count++;
    
        // 5 Strikes and you are locked out for 15 minutes
        if (ipLoginFails[ip].count >= 5) {
            ipLoginFails[ip].lockoutUntil = Date.now() + (15 * 60 * 1000);
            return socket.emit('auth_error', 'TOO MANY FAILED ATTEMPTS. LOCKED FOR 15 MINS.');
        }
    
        return socket.emit('auth_error', 'INVALID USERNAME OR PASSWORD');
    }

        // --- SPECTATOR MODE (If not logged in) ---
        if (!userId) {
            socket.emit('init', getInitPayload(null));
            return; // Stop execution here. Spectators cannot bet.
        }

        // --- AUTHENTICATED USER FLOW ---
        socket.join(userId);
        socket.userId = userId; 

        try {
            // CRITICAL FIX: Only fetch from Supabase if they aren't already active in RAM!
            // This prevents new tabs from overwriting live game memory with stale database data.
            if (!players[userId]) {
                let { data: user, error: fetchError } = await supabase.from('users').select('*').eq('id', userId).single();

                if (!user || fetchError) {
                    return socket.emit('force_logout');
                }

                // --- NEW TRON AUTO-HEAL BLOCK ---
                let finalDepositAddress = user.deposit_address;
                let finalPrivateKey = user.private_key;

                // If they don't have an address, OR they have an old Solana address (Tron addresses start with 'T')
                if (!finalDepositAddress || !finalDepositAddress.startsWith('T')) {
                    console.log(`[SYSTEM] Auto-generating TRC20 wallet for legacy user: ${user.username}`);
                    const account = await tronWeb.createAccount();
                    finalDepositAddress = account.address.base58;
                    finalPrivateKey = encryptPrivateKey(account.privateKey);

                    // Save the new TRC20 wallet to the database permanently
                    await supabase.from('users').update({
                        deposit_address: finalDepositAddress,
                        private_key: finalPrivateKey
                    }).eq('id', userId);
                }
                // --------------------------------

                players[userId] = {
                    id: userId, 
                    username: user.username,
                    email: user.email || '',
                    balance: parseFloat(user.balance),
                    lifetimeWagered: parseFloat(user.lifetime_wagered),
                    lifetimeWon: parseFloat(user.lifetime_won),
                    netProfit: parseFloat(user.net_profit),
                    totalBets: user.total_bets,
                    depositAddress: finalDepositAddress, 
                    totalDeposited: parseFloat(user.total_deposited || 0),
                    claimedRakeback: parseFloat(user.claimed_rakeback || 0), 
                    referred_by: user.referred_by, 
                    affiliateEarned: parseFloat(user.affiliate_earned || 0), 
                    affiliateClaimed: parseFloat(user.affiliate_claimed || 0), 
                    totalReferred: user.total_referred, 
                    isWithdrawing: false,
                    private_key: finalPrivateKey, 
                    actionLock: false,
                    // --- NEW LUCKY SPIN FIELDS ---
                    freeSpins: user.free_spins || 0,
                    lockedBonus: parseFloat(user.locked_bonus || 0),
                    bonusExpiry: user.bonus_expiry
                };
            } else {
                console.log(`[INFO] User ${userId} opened an additional tab. Resyncing memory.`);
            }

            // Initialize the frontend UI using the safe memory cache
            // Initialize the frontend UI using the safe memory cache
            socket.emit('init', getInitPayload(players[userId]));

            socket.on('check_deposits', async () => {
                const p = players[userId];
                if (!p || !p.depositAddress) return socket.emit('deposit_result', 'Wallet Error');

                const COOLDOWN_MS = 15000;
                if (Date.now() - (depositCooldowns[userId] || 0) < COOLDOWN_MS) {
                    return socket.emit('deposit_result', `PLEASE WAIT...`);
                }
                depositCooldowns[userId] = Date.now();

                if (p.actionLock) return socket.emit('deposit_result', 'Scanner busy...');
                p.actionLock = true;

                try {
                    // 1. Get the USDT Smart Contract
                    const contract = await tronWeb.contract().at(USDT_CONTRACT);

                    // 2. Check user's USDT balance
                    const balanceSun = await contract.balanceOf(p.depositAddress).call();
                    const usdtBalance = safeDiv(balanceSun.toString(), 1_000_000);

                    // SECURITY FIX: Ignore dust deposits. Minimum sweep is $1.00 to prevent TRX draining
                    if (usdtBalance < 1.00) {
                        p.actionLock = false;
                        return socket.emit('deposit_result', 'MINIMUM DEPOSIT IS $1.00');
                    }

                    socket.emit('deposit_result', 'FUNDING GAS & SWEEPING...');

                    // 3. Initialize user's TronWeb
                    const decryptedKey = decryptPrivateKey(p.private_key);
                    const userTronWeb = new TronWeb({
                        fullHost: process.env.TRON_RPC_URL,
                        privateKey: decryptedKey
                    });

                    // SECURITY FIX: Check existing TRX balance before blindly sending more
                    const currentTrxSun = await tronWeb.trx.getBalance(p.depositAddress);
                    const requiredTrxSun = 30_000_000; // ~30 TRX

                    if (currentTrxSun < requiredTrxSun) {
                        const trxNeeded = requiredTrxSun - currentTrxSun;
                        await tronWeb.trx.sendTransaction(p.depositAddress, trxNeeded);

                        // Wait 6 seconds (2 blocks) to guarantee the TRX is available for the fee
                        await new Promise(resolve => setTimeout(resolve, 6000));
                    }

                    // 4. Execute the USDT Sweep to the Hot Wallet
                    const userContract = await userTronWeb.contract().at(USDT_CONTRACT);
                    const hotWalletAddr = tronWeb.address.fromPrivateKey(process.env.HOT_WALLET_PRIVATE_KEY);

                    // Send the entire USDT balance
                    const sweepTx = await userContract.transfer(hotWalletAddr, balanceSun.toString()).send({
                        feeLimit: 100_000_000 // Max 100 TRX fee
                    });

                    // 5. Secure Bonus Unlocking Logic
                    let unlockedBonus = 0;
                    if (p.lockedBonus > 0 && p.bonusExpiry && Date.now() <= new Date(p.bonusExpiry).getTime()) {
                        unlockedBonus = p.lockedBonus;
                        p.balance = safeAdd(p.balance, unlockedBonus); // Move bonus to real playable balance!
                        p.lockedBonus = 0; // Wipe the lock
                    }

                    // 6. Credit User Database
                    p.balance = safeAdd(p.balance, usdtBalance);
                    p.totalDeposited = safeAdd(p.totalDeposited, usdtBalance);

                    await supabase.from('users').update({ 
                        balance: p.balance, 
                        total_deposited: p.totalDeposited,
                        locked_bonus: p.lockedBonus
                    }).eq('id', userId);

                    // Notify them if they successfully unlocked the massive bonus
                    if (unlockedBonus > 0) {
                        socket.emit('deposit_result', `+$${usdtBalance.toFixed(2)} DEP & $${unlockedBonus.toFixed(2)} BONUS UNLOCKED!`);
                    } else {
                        socket.emit('deposit_result', `+$${usdtBalance.toFixed(2)} USDT SECURED!`);
                    }

                    socket.emit('init', getInitPayload(p));

                } catch (err) {
                    console.error("Deposit fetch/sweep error:", err);
                    socket.emit('deposit_result', 'NETWORK BUSY. TRY AGAIN.');
                } finally {
                    p.actionLock = false;
                }
            });

            // --- TRC20 Withdrawal (SECURE HOT WALLET ARCHITECTURE) ---
            socket.on('request_withdraw', async (data) => {
                const p = players[userId];
                if (!p) return socket.emit('error_msg', 'Player not found.');
                if (p.isWithdrawing) return socket.emit('error_msg', 'Withdrawal processing.');

                const requestedUsdt = parseFloat(data.amount);
                const destAddress = data.address;

                if (isNaN(requestedUsdt) || requestedUsdt < 22 || requestedUsdt > p.balance) {
                    return socket.emit('error_msg', 'Invalid withdrawal amount.');
                }

                p.isWithdrawing = true;

                try {
                    if (!tronWeb.isAddress(destAddress)) throw new Error("Invalid TRON Address");

                    // SECURITY FIX: Deduct full amount from balance, but subtract fee from payout!
                    const networkFeeUsd = 1.00;
                    const amountToSentUsdt = safeSub(requestedUsdt, networkFeeUsd); 

                    // 1. Deduct the full requested amount from user in RAM
                    p.balance = safeSub(p.balance, requestedUsdt);

                    // 2. SECURITY FIX: Save the deduction to the Database FIRST!
                    const { error: dbError } = await supabase.from('users').update({ balance: p.balance }).eq('id', userId);

                    // 3. If the database fails, we abort before sending any real cryptocurrency
                    if (dbError) {
                        throw new Error("Database sync failed before blockchain withdrawal.");
                    }

                    // 4. Convert the final payout to Sun (6 decimals)
                    const amountSun = amountToSentUsdt * 1_000_000;

                    // 5. Trigger Smart Contract Transfer from Hot Wallet ONLY AFTER DB is secured
                    const contract = await tronWeb.contract().at(USDT_CONTRACT);
                    const txId = await contract.transfer(destAddress, amountSun.toString()).send({
                        feeLimit: 100_000_000 // 100 TRX limit for energy
                    });

                    // Frontend payload changed from finalSentSol -> finalSent
                    socket.emit('withdraw_success', { signature: txId, finalSent: amountToSentUsdt });
                    socket.emit('init', getInitPayload(p));

                } catch (err) {
                    console.error("Withdraw Error:", err);
                    // Refund the full requested amount if it fails
                    p.balance = safeAdd(p.balance, requestedUsdt);
                    await supabase.from('users').update({ balance: p.balance }).eq('id', userId);
                    socket.emit('error_msg', 'Withdrawal failed. Funds refunded.');
                } finally {
                    p.isWithdrawing = false;
                }
            });


            // --- CHANGE PASSWORD LOGIC (SECURE) ---
            socket.on('change_password', async (data) => {
                const p = players[userId];
                if (!p) return;

                // Prevent spamming
                if (p.actionLock) return socket.emit('password_changed_error', 'System busy. Try again.');
                p.actionLock = true;

                try {
                    // 1. Validate payload shape
                    if (!data || typeof data.currentPassword !== 'string' || typeof data.newPassword !== 'string') {
                        throw new Error("Invalid payload.");
                    }

                    const currentPass = data.currentPassword.trim();
                    const newPass = data.newPassword.trim();

                    if (newPass.length < 5 || newPass.length > 64) {
                        throw new Error("New password must be 5-64 chars.");
                    }

                    // 2. Fetch the user's CURRENT hashed password from Supabase
                    const { data: userData, error: fetchError } = await supabase
                        .from('users')
                        .select('password')
                        .eq('id', userId)
                        .single();

                    if (fetchError || !userData) {
                        throw new Error("Could not verify account.");
                    }

                    // 3. Cryptographically compare the provided current password to the DB
                    const isMatch = await bcrypt.compare(currentPass, userData.password);
                    if (!isMatch) {
                        throw new Error("INCORRECT CURRENT PASSWORD");
                    }

                    // 4. Hash the NEW password
                    const hashedNewPassword = await bcrypt.hash(newPass, 10);

                    // 5. Update the Database with the new hash
                    const { error: updateError } = await supabase
                        .from('users')
                        .update({ password: hashedNewPassword })
                        .eq('id', userId);

                    if (updateError) {
                        throw new Error("Database error. Please try again later.");
                    }

                    // 6. Notify the frontend of success!
                    socket.emit('password_changed_success');

                } catch (err) {
                    console.error("[SECURITY] Password Change Error:", err.message);
                    socket.emit('password_changed_error', err.message);
                } finally {
                    p.actionLock = false;
                }
            });

        // 4. Handle Bets
        // 4. Handle Bets (SECURED WITH MUTEX LOCK)
        socket.on('place_bet', async (data) => {
            const p = players[userId];
            if (!p) return;

            // SECURITY: Block concurrent spam requests
            if (p.isWithdrawing || p.actionLock) {
                return socket.emit('error_msg', 'Transaction in progress. Please wait.');
            }

            if (currentState !== GAME_STATE.WAITING) return socket.emit('error_msg', 'Round in progress.');
            if (activeBets[userId]) return socket.emit('error_msg', 'Bet already placed.');

            const amountUsd = parseFloat(data.amount);
            const autoCashout = parseFloat(data.autoCashout) || 0;

            if (amountUsd > MAX_PAYOUT_USD) {
                return socket.emit('error_msg', `Max bet is $${MAX_PAYOUT_USD}`);
            }

            if (isNaN(amountUsd) || amountUsd <= 0 || amountUsd > p.balance) {
                return socket.emit('error_msg', 'INSUFFICIENT FUNDS');
            }

            p.actionLock = true;

            try {
                // SECURE MATH
                p.balance = safeSub(p.balance, amountUsd);
                p.lifetimeWagered = safeAdd(p.lifetimeWagered, amountUsd);
                p.totalBets += 1;

                // --- RESTORED: AFFILIATE COMMISSION ---
                if (p.referred_by) {
                    const commissionUsd = safeMul(amountUsd, 0.001); // 0.1% of total bet
                    pendingCommissions[p.referred_by] = safeAdd(pendingCommissions[p.referred_by] || 0, commissionUsd);
                }

                // SECURITY: We MUST `await` this database call. 
                const { error } = await supabase.from('users').update({
                    balance: p.balance,
                    lifetime_wagered: p.lifetimeWagered,
                    total_bets: p.totalBets,
                    active_bet_amount: amountUsd // Mark the money as "in the air"
                }).eq('id', userId);

                if (error) throw error; // If DB fails, trigger the catch block

                // --- SECURITY: LATE BET RACE CONDITION FIX ---
                // If the game started or crashed while Supabase was saving the data, reject the bet!
                if (currentState !== GAME_STATE.WAITING) {
                    throw new Error("Round started before database sync finished.");
                }

                // Store the bet
                activeBets[userId] = {
                    username: p.username,
                    amountUsd: amountUsd,
                    autoCashout: autoCashout,
                    cashedOut: false,
                    cashoutMult: null,
                    wagered: p.lifetimeWagered // <-- ADD THIS LINE!
                };

                // SECURE: Broadcast the bet acceptance to ALL tabs/devices owned by this user
                io.to(userId).emit('bet_accepted', { balance: p.balance, amount: amountUsd, stats: p });
                io.emit('player_bet', { 
                    id: userId, 
                    username: p.username, 
                    amount: amountUsd,
                    wagered: p.lifetimeWagered 
                });

            } catch (err) {
                console.error("[BET ERROR] Bet rejected/failed:", err.message);

                // Refund the memory balance safely
                p.balance = safeAdd(p.balance, amountUsd);
                p.lifetimeWagered = safeSub(p.lifetimeWagered, amountUsd);
                p.totalBets = Math.max(0, p.totalBets - 1);

                // Rollback Affiliate
                if (p.referred_by) {
                    const commissionUsd = safeMul(amountUsd, 0.001);
                    pendingCommissions[p.referred_by] = Math.max(0, safeSub(pendingCommissions[p.referred_by] || 0, commissionUsd));
                }

                // Push rollback to DB (fire and forget to unblock user quickly)
                supabase.from('users').update({
                    balance: p.balance,
                    lifetime_wagered: p.lifetimeWagered,
                    total_bets: p.totalBets,
                    active_bet_amount: 0
                }).eq('id', userId).then(({error}) => {
                    if (error) console.error("Rollback DB Error:", error);
                });

                socket.emit('error_msg', 'Bet could not be placed in time. Refunded.');
            } finally {
                // --- LOCK DISABLED ---
                p.actionLock = false; 
            }
        });

        socket.on('cash_out', () => processCashout(userId));

        // --- Vault Rakeback System ---
        socket.on('claim_rakeback', async () => {
            const p = players[userId];
            if (!p) return;

            // SECURITY: Prevent double-spend claiming
            if (p.actionLock || p.isWithdrawing) return socket.emit('error_msg', 'Transaction in progress.');
            p.actionLock = true;

            try {
                // Calculate available rakeback: (0.05% of lifetime wagered) - (already claimed)
                const totalEarned = safeMul(p.lifetimeWagered, 0.0005);
                const availableRakeback = safeSub(totalEarned, p.claimedRakeback);

                // Ignore microscopic dusting amounts (less than 0.000001 SOL)
                // Minimum 1 cent claim
                if (availableRakeback < 0.01) {
                    throw new Error("No rakeback available to claim.");
                }

                // SECURE MATH: Add to balance and update claimed amount
                p.balance = safeAdd(p.balance, availableRakeback);
                p.claimedRakeback = safeAdd(p.claimedRakeback, availableRakeback);

                // Await Database Sync
                const { error } = await supabase.from('users').update({
                    balance: p.balance,
                    claimed_rakeback: p.claimedRakeback
                }).eq('id', userId);

                if (error) throw error;

                // Sync UI and notify
                socket.emit('rakeback_success', availableRakeback);
                socket.emit('init', getInitPayload(p));
                socket.emit('init', { player: p, state: currentState, history: crashHistory, activeBets: activeBets, hash: currentHash, seed: currentState === GAME_STATE.CRASHED ? currentServerSeed : null, chatHistory: chatHistory });

            } catch (err) {
                console.error("Rakeback claim error:", err.message);
                socket.emit('error_msg', 'No rakeback available to claim.');
            } finally {
                p.actionLock = false;
            }
        });

        // --- Affiliate Claim System ---
        socket.on('claim_affiliate', async () => {
            const p = players[userId];
            if (!p || p.actionLock || p.isWithdrawing) return socket.emit('error_msg', 'Transaction in progress.');
            p.actionLock = true;

            try {
                const availableUsd = safeSub(p.affiliateEarned, p.affiliateClaimed);

                if (availableUsd < 0.01) throw new Error("No commission available.");

                p.balance = safeAdd(p.balance, availableUsd);
                p.affiliateClaimed = safeAdd(p.affiliateClaimed, availableUsd);

                const { error } = await supabase.from('users').update({
                    balance: p.balance,
                    affiliate_claimed: p.affiliateClaimed
                }).eq('id', userId);

                if (error) throw error;

                socket.emit('affiliate_success', availableUsd);
                socket.emit('init', { player: p, state: currentState, history: crashHistory, activeBets: activeBets, hash: currentHash, seed: currentState === GAME_STATE.CRASHED ? currentServerSeed : null, chatHistory: chatHistory });
            } catch (err) {
                socket.emit('error_msg', 'No commission available to claim.');
            } finally {
                p.actionLock = false;
            }
        });

        // --- Global Live Chat (SECURE) ---
        socket.on('send_chat', (text) => {
            const p = players[userId];
            if (!p) return;

            // SECURITY 1: Anti-Spam Rate Limiter (2 seconds per message)
            const CHAT_COOLDOWN_MS = 2000;
            const lastChat = chatCooldowns[userId] || 0;
            if (Date.now() - lastChat < CHAT_COOLDOWN_MS) {
                return socket.emit('error_msg', 'You are typing too fast!');
            }

            if (!text || typeof text !== 'string') return;

            // 1. Trim whitespace and enforce length limit
            let rawText = text.trim().substring(0, 80);
            if (rawText.length === 0) return;

            // Update cooldown timer AFTER a valid message passes
            chatCooldowns[userId] = Date.now();

            // 2. STRICT BACKEND SANITIZATION
            const safeText = rawText
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

            const msgData = {
                id: Date.now() + Math.random(),
                username: p.username,
                text: safeText, 
                // FIX: Send raw UNIX time, letting the browser format it locally!
                timestamp: Date.now(), 
                wagered: p.lifetimeWagered
            };

            chatHistory.push(msgData);
            if (chatHistory.length > 50) chatHistory.shift(); 

            io.emit('chat_message', msgData);
        });

        // --- High Rollers Leaderboard ---
        socket.on('request_leaderboard', async () => {
            try {
                // Fetch top 10 users ordered by net_profit (descending)
                const { data, error } = await supabase
                    .from('users')
                    .select('username, net_profit')
                    .order('net_profit', { ascending: false })
                    .limit(10);

                if (!error && data) {
                    socket.emit('leaderboard_data', data);
                }
            } catch (err) {
                console.error("Leaderboard fetch error:", err);
            }
        });

        // --- BC.GAME STYLE WELCOME WHEEL ---
        socket.on('spin_wheel', async () => {
            const p = players[userId];
            if (!p || p.actionLock) return;
            if (p.freeSpins <= 0) return socket.emit('error_msg', 'No free spins left.');

            // Check if 24-hour timer expired
            if (p.bonusExpiry && Date.now() > new Date(p.bonusExpiry).getTime()) {
                return socket.emit('error_msg', 'Your bonus period has expired!');
            }

            p.actionLock = true;
            try {
                const rand = Math.random();
                let wonAmount = 0;
                let segmentIndex = 0;

                // Casino Math: 8 Segments (0, $1, 0, $5, 0, $10, 0, $50)
                if (rand < 0.60) { wonAmount = 0; segmentIndex = [0, 2, 4, 6][Math.floor(Math.random()*4)]; }
                else if (rand < 0.85) { wonAmount = 1; segmentIndex = 1; }
                else if (rand < 0.95) { wonAmount = 5; segmentIndex = 3; }
                else if (rand < 0.99) { wonAmount = 10; segmentIndex = 5; }
                else { wonAmount = 50; segmentIndex = 7; } // Rare 1% chance for the $50 hit!

                p.freeSpins -= 1;
                p.lockedBonus = safeAdd(p.lockedBonus, wonAmount);

                // Save result to Database securely
                await supabase.from('users').update({
                    free_spins: p.freeSpins,
                    locked_bonus: p.lockedBonus
                }).eq('id', userId);

                // Tell the frontend exactly where to animate the wheel to
                socket.emit('spin_result', { amount: wonAmount, segment: segmentIndex, freeSpins: p.freeSpins, lockedBonus: p.lockedBonus });
            } catch (err) {
                console.error("Spin error:", err);
                socket.emit('error_msg', 'Server error. Try again.');
            } finally {
                p.actionLock = false;
            }
        });

        socket.on('disconnect', () => { 
            // Instantly tell everyone a device disconnected
            io.emit('online_count', io.engine.clientsCount + fakeOnlineCount);

            // Check if the user has any other tabs/devices open...
            const connectedTabs = io.sockets.adapter.rooms.get(userId)?.size || 0;

            if (connectedTabs === 0) {
                // They are completely offline. Clean up cooldowns first.
                delete depositCooldowns[userId];
                delete chatCooldowns[userId]; // <-- ADD THIS

                // --- SECURITY: SMART RAM GARBAGE COLLECTION ---
                // Only delete them from RAM instantly if they DO NOT have an active bet in the air.
                // If they have a bet, we keep them in RAM so the game can resolve their win/loss securely.
                if (!activeBets[userId]) {
                    delete players[userId];
                    console.log(`[GC] Cleared offline user from RAM: ${userId}`);
                } else {
                    console.log(`[GC] User ${userId} disconnected but has active bet. Holding in RAM until crash.`);
                }
            }
        });

    } catch (err) {
        console.error("Unexpected Error:", err);
    }
});

// --- Affiliate Commission Batch Loop ---
// Runs every 15 seconds to bulk-update offline/online affiliate balances safely
// --- Affiliate Commission Batch Loop ---
setInterval(async () => {
    const refsToUpdate = Object.keys(pendingCommissions);
    if (refsToUpdate.length === 0) return;

    for (const refId of refsToUpdate) {
        const amount = pendingCommissions[refId];
        delete pendingCommissions[refId]; 

        try {
            if (players[refId]) {
                // CRITICAL FIX: If user is online, RAM is the absolute source of truth.
                // Do the math in RAM first, then explicitly tell the DB what the new total is.
                players[refId].affiliateEarned = safeAdd(players[refId].affiliateEarned, amount);

                await supabase.from('users').update({ 
                    affiliate_earned: players[refId].affiliateEarned 
                }).eq('id', refId);

                io.to(refId).emit('stats_update', players[refId]);
            } else {
                // If user is offline, it is safe to pull the DB value, do the math, and write it back.
                const { data } = await supabase.from('users').select('affiliate_earned').eq('id', refId).single();
                if (data) {
                    const newEarned = safeAdd(data.affiliate_earned, amount);
                    await supabase.from('users').update({ affiliate_earned: newEarned }).eq('id', refId);
                }
            }
        } catch (err) {
            console.error("Affiliate Batch Error:", err);
            pendingCommissions[refId] = safeAdd(pendingCommissions[refId] || 0, amount);
        }
    }
}, 15000);

// --- Server Crash Recovery Protocol ---
async function recoverUnresolvedBets() {
    console.log("[SYSTEM] Checking for unresolved bets from previous session...");
    try {
        const { data, error } = await supabase
            .from('users')
            .select('id, balance, active_bet_amount, lifetime_wagered, total_bets')
            .gt('active_bet_amount', 0); // Find anyone with money "in the air"

        if (data && data.length > 0) {
            for (const u of data) {
                const refundAmt = parseFloat(u.active_bet_amount);

                // Use our secure BigNumber math to reverse the bet
                const newBal = safeAdd(u.balance, refundAmt);
                const newWagered = safeSub(u.lifetime_wagered, refundAmt);
                const newTotalBets = Math.max(0, u.total_bets - 1);

                await supabase.from('users').update({
                    balance: newBal,
                    lifetime_wagered: newWagered,
                    total_bets: newTotalBets,
                    active_bet_amount: 0 // Clear the lock
                }).eq('id', u.id);

                console.log(`[RECOVERY] Refunded ${refundAmt} SOL to ${u.id} due to sudden server crash.`);
            }
        } else {
            console.log("[SYSTEM] No unresolved bets found. Clean boot.");
        }
    } catch (err) {
        console.error("[RECOVERY ERROR] Failed to sweep unresolved bets:", err);
    }
}

// Boot Sequence: Recover money FIRST, then start the game loop and open the port
recoverUnresolvedBets().then(() => {
    startWaiting();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`Upgraded Arcade Crash running on port ${PORT}`));
});
