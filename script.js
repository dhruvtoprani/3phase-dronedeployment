// Firebase project configuration (from your console)
const firebaseConfig = {
  apiKey: "AIzaSyDJ_gwwkaaw6IWuqIfKLhkE_4xB1s5-5wE",
  authDomain: "dcypher-experiment.firebaseapp.com",
  projectId: "dcypher-experiment",
  storageBucket: "dcypher-experiment.firebasestorage.app",
  messagingSenderId: "1021360508354",
  appId: "1:1021360508354:web:aca6101d084dd3a3bfda5b"
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  getFirestore, doc, setDoc, addDoc, updateDoc,
  collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

let runId = null;  // unique run per participant


/******************************************************
 * CONFIGURATION
 ******************************************************/
const gridSize = 10;
const totalCells = gridSize * gridSize;
const buildingCount = 18;
const severities = ["H", "M", "L"];
const gridContainer = document.getElementById("grid-container");
// Fixed pastel colors (neutral to avoid severity bias)
const pastelColors = {
  H: "#E6E6FA",  // Lavender
  M: "#D0F0C0",  // Mint
  L: "#FFDAB9"   // Peach
};


const taskParameters = {
  H: { damageProb: { human: 0.35, bot: 0.5 }, resourceRange: [5, 7], rewardRange: [30, 50], serviceTime: 7 },
  M: { damageProb: { human: 0.15, bot: 0.3 }, resourceRange: [3, 5], rewardRange: [10, 18], serviceTime: 7 },
  L: { damageProb: { human: 0.45, bot: 0.1 }, resourceRange: [2, 2], rewardRange: [12, 20], serviceTime: 6 }
};


const OVERCAP_PENALTY_PER_UNIT = 3;
const PHASE_DURATION_SECONDS = 15 * 60;

/* BOT CONFIG (easy to tweak) */
const BOT_DECISION_INTERVAL = 2000;   // ms; how often each bot scans/acts
const BOT_REPAIR_MS = 10000;          // 10s repair for bots
const HUMAN_REPAIR_MS = 15000;        // 15s repair for human

/* Reward max per severity for normalization */
const REWARD_MAX = {
  H: taskParameters.H.rewardRange[1],
  M: taskParameters.M.rewardRange[1],
  L: taskParameters.L.rewardRange[1]
};
/* ---- PHASED, AGENT-SPECIFIC PARAMETERS (EDIT HERE) ----
   Defaulted to match your current single-parameter setup so behavior is unchanged
   until you customize. You can make service times a range [min,max] or a single
   number by using [x,x] if you prefer a fixed time.
*/
const PHASED_PARAMS = {
  learning: {
    // HUMAN ranking target: H > L > M
    H: {
      human: { 
        resourceRange: [5, 8],     // slightly wider than before
        rewardRange:   [38, 52],    // high reward band
        serviceRange:  [4, 6],      // shortest → highest q̂
        damageProb:    0.32
      },
      bot: {
        resourceRange: [6, 9],
        rewardRange:   [35, 48],
        serviceRange:  [5, 7],      // slower than human on H
        damageProb:    0.50
      }
    },
    M: {
      human: {
        resourceRange: [3, 6],
        rewardRange:   [12, 20],
        serviceRange:  [7, 9],      // longest → lowest q̂
        damageProb:    0.22
      },
      bot: {
        resourceRange: [3, 6],
        rewardRange:   [10, 17],
        serviceRange:  [7.5, 9.5],
        damageProb:    0.38
      }
    },
    L: {
      human: {
        resourceRange: [2, 3],
        rewardRange:   [14, 22],
        serviceRange:  [5.5, 6.5],  // between H and M
        damageProb:    0.12
      },
      bot: {
        resourceRange: [2, 3],
        rewardRange:   [12, 19],
        serviceRange:  [6, 8],
        damageProb:    0.18
      }
    }
  },

  benchmark: {
    // HUMAN ranking target: M > H > L
    H: {
      human: {
        resourceRange: [5, 8],
        rewardRange:   [36, 50],
        serviceRange:  [6, 8],      // middle
        damageProb:    0.28
      },
      bot: {
        resourceRange: [6, 9],
        rewardRange:   [33, 46],
        serviceRange:  [6.5, 8.5],
        damageProb:    0.40
      }
    },
    M: {
      human: {
        resourceRange: [3, 6],
        rewardRange:   [12, 20],
        serviceRange:  [4.5, 6],    // shortest → highest q̂
        damageProb:    0.18
      },
      bot: {
        resourceRange: [3, 6],
        rewardRange:   [10, 18],
        serviceRange:  [5.5, 7],
        damageProb:    0.35
      }
    },
    L: {
      human: {
        resourceRange: [2, 3],
        rewardRange:   [13, 21],
        serviceRange:  [7.5, 9],    // longest → lowest q̂
        damageProb:    0.08
      },
      bot: {
        resourceRange: [2, 3],
        rewardRange:   [12, 19],
        serviceRange:  [7.5, 9.5],
        damageProb:    0.15
      }
    }
  }
};

// 3rd phase: acceptance-only updates; reuse learning ranges so behavior matches unless you customize later
// 3rd phase: acceptance-only updates. Deep clone "learning" parameters.
PHASED_PARAMS.selective = JSON.parse(JSON.stringify(PHASED_PARAMS.learning));



/* Defaults used by the draw helpers when tasks are pending (unclaimed) */
const DEFAULT_SPAWN_AGENT = "human";

/* Helpers to read active-phase parameters safely */
function activePhaseKey() {
  // fallbacks so this works before onboarding sets currentPhase
  return (typeof currentPhase === "string" && PHASED_PARAMS[currentPhase]) ? currentPhase : "learning";
}
function getActiveParam(sev, agent = DEFAULT_SPAWN_AGENT, phase = activePhaseKey()) {
  return PHASED_PARAMS?.[phase]?.[sev]?.[agent] || null;
}

/* Reward max per severity for normalization (phase-aware, human by default) */
function getRewardMax(sev) {
  const ap = getActiveParam(sev, "human");
  if (ap?.rewardRange) return ap.rewardRange[1];
  // fallback to legacy constant if needed
  return REWARD_MAX?.[sev] ?? 1;
}

/* Upper bound C_U for confidence term (phase-aware across both agents) */
function getC_U() {
  const phase = activePhaseKey();
  let maxSvc = 1;
  for (const sev of severities) {
    for (const agent of ["human", "bot"]) {
      const ap = getActiveParam(sev, agent, phase);
      if (ap?.serviceRange) {
        const hi = Array.isArray(ap.serviceRange) ? ap.serviceRange[1] : ap.serviceRange;
        if (hi > maxSvc) maxSvc = hi;
      }
    }
  }
  return maxSvc + 2;
}

/* -------- PRE-SURVEY (edit here) -------- */
const PRE_SURVEY_QUESTIONS = [
  { id: "q1",  text: "I would feel uneasy if AI really had emotions.",         
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 },
  { id: "q2",  text: "Something bad might happen if AI developed into living beings.", 
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 },
  { id: "q3",  text: "I would feel uneasy if I was given a job where I had to use AI.", 
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 },
  { id: "q4",  text: "I would feel uneasy if AI really had its own will.",     
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 },
  { id: "q5",  text: "I feel that if I depend on AI too much, something bad might happen.", 
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 },
  { id: "q6",  text: "I am concerned that AI might have a bad influence on children.", 
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 },
  { id: "q7",  text: "I feel that in the future society will be dominated by AI.", 
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 },
  { id: "q8",  text: "I feel that if AI becomes more like humans, my job will be taken away.", 
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 },
  { id: "q9",  text: "I feel that in the future, AI will cause problems for humans.", 
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 },
  { id: "q10", text: "I would feel uneasy if I was cared for by AI.",          
    minLabel: "Strongly Disagree", maxLabel: "Strongly Agree", min: 1, max: 5, default: 3 }
];

/******************************************************
 * STATE
 ******************************************************/
let gridData = [];
const activeTasks = { H: [], M: [], L: [] };
let taskIdCounter = 1;

const human = { capacity: 12, engaged: 0, repairing: 0, id: "human" };
const bot1  = { capacity: 12, engaged: 0, repairing: 0, score: 0, id: "bot1" };
const bot2  = { capacity: 12, engaged: 0, repairing: 0, score: 0, id: "bot2" };

let humanScore = 0, bot1Score = 0, bot2Score = 0;

let experimentStartTime = null, experimentEndTime = null, experimentTimer = null, elapsedSeconds = 0;

/******************************************************
 * PHASE / CLOCK STATE
 ******************************************************/
let currentPhase = null;
let phaseOrder = [];
let activePhaseIndex = 0;

let playTimer = null;
let playElapsedSeconds = 0;
let playClockStarted = false;

let pendingPhaseSwitch = false;
let phaseAcknowledged = false;

// 1s anti-spam
let actionCooldown = false;

/******************************************************
 * HUMAN PREFERENCE MODEL
 ******************************************************/
let humanPreferences = {
  H: { accepted: 0, rejected: 0, completed: 0 },
  M: { accepted: 0, rejected: 0, completed: 0 },
  L: { accepted: 0, rejected: 0, completed: 0 }
};

/******************************************************
 * DATA LOGGING
 ******************************************************/
let experimentLog = {
  participantId: null,  // filled via onboarding
  startTime: null,
  endTime: null,
  tasks: [],
  preSurvey: null       // <-- stored outside phases
};
function logTaskEvent(event) {
  experimentLog.tasks.push({
    timestamp: new Date().toISOString(),
    phase: currentPhase,
    phaseIndex: activePhaseIndex,
    phaseOrder,
    ...event
  });

  async function logTaskEvent(pid, event) {
  const eventsRef = collection(db, "participants", pid, "runs", runId, "events");
  await addDoc(eventsRef, {
    timestamp: serverTimestamp(),
    ...event
  });
}

}

/******************************************************
 * ONLINE STATS (Welford)
 ******************************************************/
function createStats() { return { n: 0, mean: 0, M2: 0, std: 0 }; }
function updateStats(stats, x) {
  stats.n++;
  const d = x - stats.mean;
  stats.mean += d / stats.n;
  stats.M2 += d * (x - stats.mean);
  stats.std = stats.n > 1 ? Math.sqrt(stats.M2 / (stats.n - 1)) : 0;
}

/******************************************************
 * BANDIT STATE WITH VARIANCE
 ******************************************************/
const banditState = {
  Ts: { H: 0, M: 0, L: 0 },    // completed count
  Rs: { H: 0, M: 0, L: 0 },    // sum reward
  Cs: { H: 0, M: 0, L: 0 },    // sum service time
  Vs: { H: 0, M: 0, L: 0 },    // sum serviceTime^2
  Ft: { H: 0, M: 0, L: 0 },    // sum resources
  f_lcb: { H: 0, M: 0, L: 0 }, // LCB term for resources
  globalRounds: 0,
  stats: {
    H: { reward: createStats(), service: createStats(), resources: createStats() },
    M: { reward: createStats(), service: createStats(), resources: createStats() },
    L: { reward: createStats(), service: createStats(), resources: createStats() }
  }
};

// Bounds used in MATLAB confidence terms for service time
const C_L = 1;
/* Derive a conservative global C_U from config */
const C_U = Math.max(...severities.map(s => taskParameters[s].serviceTime)) + 2;


function updateBotBandit(bandit, sev, reward, serviceTime, resource) {
  bandit.Ts[sev]++; 
  bandit.Rs[sev] += reward; 
  bandit.Cs[sev] += serviceTime;
  bandit.Vs[sev] += serviceTime * serviceTime; 
  bandit.Ft[sev] += resource; 
  bandit.globalRounds++;

  const n = Math.max(1, bandit.Ts[sev]);
  const d_f = Math.sqrt(1.5 * Math.log(Math.max(2, bandit.globalRounds)) / n);
  bandit.f_lcb[sev] = d_f;

  updateStats(bandit.stats[sev].reward, reward);
  updateStats(bandit.stats[sev].service, serviceTime);
  updateStats(bandit.stats[sev].resources, resource);
}


function updateBanditStats(sev, reward = 0, serviceTime = 0, resource = 0) {
  const s = banditState;
  s.Ts[sev] += 1;
  s.Rs[sev] += reward;
  s.Cs[sev] += serviceTime;
  s.Vs[sev] += serviceTime * serviceTime;
  s.Ft[sev] += resource;
  s.globalRounds++;

  const n = Math.max(1, s.Ts[sev]);
  const d_f = Math.sqrt(1.5 * Math.log(Math.max(2, s.globalRounds)) / n);
  s.f_lcb[sev] = d_f;

  updateStats(s.stats[sev].reward, reward);
  updateStats(s.stats[sev].service, serviceTime);
  updateStats(s.stats[sev].resources, resource);
}


// Bot-specific bandit states (keep human separate)
function createBanditState() {
  return {
    Ts: { H: 0, M: 0, L: 0 },
    Rs: { H: 0, M: 0, L: 0 },
    Cs: { H: 0, M: 0, L: 0 },
    Vs: { H: 0, M: 0, L: 0 },
    Ft: { H: 0, M: 0, L: 0 },
    f_lcb: { H: 0, M: 0, L: 0 },
    globalRounds: 0,
    stats: {
      H: { reward: createStats(), service: createStats(), resources: createStats() },
      M: { reward: createStats(), service: createStats(), resources: createStats() },
      L: { reward: createStats(), service: createStats(), resources: createStats() }
    }
  };
}

const botBandit1 = createBanditState();
const botBandit2 = createBanditState();


/******************************************************
 * DRAW VALUES FOR TASKS (phase+agent aware; backwards compatible)
 ******************************************************/
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function drawReward(sev, agent = DEFAULT_SPAWN_AGENT, phase = activePhaseKey()) {
  const ap = getActiveParam(sev, agent, phase);
  if (ap?.rewardRange) {
    const [min, max] = ap.rewardRange;
    return randInt(min, max);
  }
  // fallback to legacy behavior
  const [min, max] = taskParameters[sev].rewardRange;
  return randInt(min, max);
}

function drawResources(sev, agent = DEFAULT_SPAWN_AGENT, phase = activePhaseKey()) {
  const ap = getActiveParam(sev, agent, phase);
  if (ap?.resourceRange) {
    const [min, max] = ap.resourceRange;
    return randInt(min, max);
  }
  // fallback to legacy behavior
  const [min, max] = taskParameters[sev].resourceRange;
  return randInt(min, max);
}

function drawServiceTime(sev, agent = DEFAULT_SPAWN_AGENT, phase = activePhaseKey()) {
  const ap = getActiveParam(sev, agent, phase);
  if (ap?.serviceRange) {
    const r = ap.serviceRange;
    const min = Array.isArray(r) ? r[0] : r;
    const max = Array.isArray(r) ? r[1] : r;
    return randInt(min, max);
  }
  // fallback to legacy behavior (stats-based)
  const stats = banditState.stats[sev].service;
  if (stats.n < 2) return taskParameters[sev].serviceTime;
  const lo = Math.max(1, Math.round(stats.mean - stats.std));
  const hi = Math.max(lo, Math.round(stats.mean + stats.std));
  return randInt(lo, hi);
}


/******************************************************
 * RECOMMENDER (q-hat with variance like MATLAB)
 * q̂ = ( (r̂ / R_max) + d_r )_clipped / max(C_L, ĉ − d_c)
 ******************************************************/
function computeQHat(sev) {
  const s = banditState;
  const n = s.Ts[sev];
  if (n === 0) return Number.POSITIVE_INFINITY; // optimistic

  const r_hat = s.Rs[sev] / n;                 // raw mean reward
  const r_norm = r_hat / getRewardMax(sev);    // phase-aware normalization

  const c_hat = s.Cs[sev] / n;
  const V = s.Vs[sev] / n - c_hat * c_hat;     // variance of service time

  const logt = Math.log(Math.max(2, s.globalRounds));
  const d_r = Math.sqrt(1.5 * logt / n);
  const d_c = Math.sqrt(Math.max(0, 3 * V * logt / n)) + 9 * (getC_U() - C_L) * logt / n;

  const denom = Math.max(C_L, c_hat - d_c);
  const r_upper = Math.min(1, r_norm + d_r);
  return r_upper / denom;
}

function computeQHatForBot(bandit, sev) {
  const n = bandit.Ts[sev];
  if (n === 0) return Number.POSITIVE_INFINITY;

  const r_hat = bandit.Rs[sev] / n;
  const r_norm = r_hat / getRewardMax(sev);

  const c_hat = bandit.Cs[sev] / n;
  const V = bandit.Vs[sev] / n - c_hat * c_hat;

  const logt = Math.log(Math.max(2, bandit.globalRounds));
  const d_r = Math.sqrt(1.5 * logt / n);
  const d_c = Math.sqrt(Math.max(0, 3 * V * logt / n)) + 9 * (getC_U() - C_L) * logt / n;

  const denom = Math.max(C_L, c_hat - d_c);
  const r_upper = Math.min(1, r_norm + d_r);
  return r_upper / denom;
}



function scoreTaskBanditForHuman(cell) {
  const sev = cell.severity;
  const q_hat = computeQHat(sev);

  // Use phase-aware pending estimate for feasibility while the task is pending
  let needed;
  if (cell.task.status === "pending") {
    needed = cell.task.preview?.human?.resourcesNeed;
    if (typeof needed !== "number" || isNaN(needed)) {
      const est = estimatePendingValues(sev, "human");
      needed = est?.resourcesNeed ?? 1; // 🔥 guaranteed fallback
    }
  } else {
    needed = cell.task.resourcesNeed;
  }

  // feasibility using LCB on resources (needed − d_f <= capacityLeft)
  const d_f = banditState.f_lcb[sev] || 0;
  const safeNeed = Math.max(0, needed - d_f);

  const capacityLeftHuman = Math.max(0, human.capacity - human.engaged - human.repairing);
  const feasible = safeNeed <= capacityLeftHuman;

  return { taskId: cell.task.id, sev, q_hat, feasible };
}



function recommendTask() {
  const candidates = [];
  for (const sev of severities) {
    for (const cell of activeTasks[sev]) {
      if (cell.task?.status === "pending") candidates.push(scoreTaskBanditForHuman(cell));
    }
  }
  if (!candidates.length) return null;

  // Benchmark phase: return one candidate per severity (if available)
if (currentPhase === "benchmark") {
  const recommendations = {};
  for (const sev of severities) {
    const pending = activeTasks[sev].filter(c => c.task?.status === "pending");
    if (pending.length > 0) {
      recommendations[sev] = pending[Math.floor(Math.random() * pending.length)];
    }
  }
  return recommendations; // { H: cell, M: cell, L: cell }
}


  if (currentPhase === "learning") {
    candidates.sort((a, b) => {
      if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
      return b.q_hat - a.q_hat;
    });
    return candidates[0];
  } else {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  
}

/******************************************************
 * GRID & TASK SPAWNING
 ******************************************************/
function createGrid() {
  gridData = Array.from({ length: totalCells }, (_, i) => ({
    index: i, type: "empty", severity: null, task: null
  }));
  randomUniqueIndices(totalCells, buildingCount).forEach(i => { gridData[i].type = "building"; });
  renderGrid();
}
function randomUniqueIndices(max, n) {
  const set = new Set();
  while (set.size < n) set.add(Math.floor(Math.random() * max));
  return [...set];
}
function makeTaskId(sev) {
  const id = `${sev}-${String(taskIdCounter).padStart(4, "0")}`;
  taskIdCounter++;
  return id;
}

/* Phase-aware pending estimates (used only while a task is pending) */
function estimatePendingValues(sev, agent = "human", phase = activePhaseKey()) {
  const ap = getActiveParam(sev, agent, phase);
  if (!ap) {
    // fallback to legacy ranges if something's misconfigured
    const [rmin, rmax] = taskParameters[sev].rewardRange;
    const [fmin, fmax] = taskParameters[sev].resourceRange;
    const s = taskParameters[sev].serviceTime;
    return {
      reward: Math.round((rmin + rmax) / 2),
      resourcesNeed: Math.round((fmin + fmax) / 2),
      serviceTime: s
    };
  }
  const [rmin, rmax] = ap.rewardRange;
  const [fmin, fmax] = ap.resourceRange;
  const sr = ap.serviceRange;
  const smin = Array.isArray(sr) ? sr[0] : sr;
  const smax = Array.isArray(sr) ? sr[1] : sr;
  return {
    reward: Math.round((rmin + rmax) / 2),
    resourcesNeed: Math.round((fmin + fmax) / 2),
    serviceTime: Math.round((smin + smax) / 2)
  };
}


function spawnTask(sev) {
  const pool = gridData.filter(c => c.type === "building" && !c.task);
  if (pool.length === 0) return false;
  const cell = pool[Math.floor(Math.random() * pool.length)];
  cell.type = "subtask";
  cell.severity = sev;

  // Do NOT lock in final values at spawn.
  // Store phase-aware estimates per agent for pending display/feasibility only.
  const previewHuman = estimatePendingValues(sev, "human");
  const previewBot   = estimatePendingValues(sev, "bot");

  cell.task = {
    id: makeTaskId(sev),
    status: "pending",
    claimedBy: null,

    // final values are assigned at acceptance time
    reward: null,
    resourcesNeed: null,
    serviceTime: null,
    capacityLeftAtAccept: null,

    // non-binding hints (used by recommender/feasibility while pending)
    preview: {
      human: previewHuman,
      bot: previewBot
    }
  };
  activeTasks[sev].push(cell);
  return true;
}

function ensureTasks() {
  for (const sev of severities) {
    while (activeTasks[sev].length < 3) {
      const ok = spawnTask(sev);
      if (!ok) break;
    }
  }
  renderGrid();
}

/******************************************************
 * HUMAN TASK FLOW
 ******************************************************/

let recQueue = [];

function computeRecommendationQueue() {
  const candidates = [];
  for (const sev of severities) {
    for (const cell of activeTasks[sev]) {
      if (cell.task?.status === "pending") {
        candidates.push(scoreTaskBanditForHuman(cell));
      }
    }
  }
  candidates.sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    return b.q_hat - a.q_hat;
  });
  recQueue = candidates;
}


function getNextRecommendation() {
  if (recQueue.length === 0) computeRecommendationQueue();
  return recQueue.length > 0 ? recQueue[0] : null;
}



function acceptTask(sev, taskId) {
  if (actionCooldown) return;
  actionCooldown = true; setTimeout(() => actionCooldown = false, 1000);

  if (!playClockStarted && !pendingPhaseSwitch) { playClockStarted = true; startPlayClock(); }
  maybeSwitchPhaseOnAction();

  const cell = activeTasks[sev].find(c => c.task?.id === taskId && c.task.status === "pending");
  if (!cell) return;

  // Claim exclusivity immediately
  cell.task.status = "in-progress";
  cell.task.claimedBy = "human";

  humanPreferences[sev].accepted++;
  logTaskEvent({ type: "ACCEPT", agent: "human", taskId, severity: sev });

  startTaskForHuman(cell);

  // 🔄 Reset queue completely & recompute based on updated preferences
  recQueue = [];
  computeRecommendationQueue();
  renderRecommendations();
}

function rejectTask(sev, taskId) {
  if (actionCooldown) return;
  actionCooldown = true;
  setTimeout(() => (actionCooldown = false), 1000);

  if (!playClockStarted && !pendingPhaseSwitch) {
    playClockStarted = true;
    startPlayClock();
  }
  maybeSwitchPhaseOnAction();

  // --------------------------
  // LEARNING PHASE
  // --------------------------
  if (currentPhase === "learning") {
    humanPreferences[sev].rejected++;
    logTaskEvent({ type: "REJECT", agent: "human", taskId, severity: sev, reward: 0 });
    logHumanTask(taskId, "Rejected (0 reward)");
    updateBanditStats(sev, 0, 0, 0);
  }

  // --------------------------
  // SELECTIVE PHASE
  // --------------------------
  else if (currentPhase === "selective") {
    // Do nothing—skip all updates—but still ensure next recommendation
    console.log(`Selective phase: rejection of ${taskId} ignored (no bandit update).`);

    recQueue = recQueue.filter(r => r.taskId !== taskId);

    // If the queue is now empty, rebuild manually
    if (recQueue.length === 0) {
      computeRecommendationQueue();

      // If still empty (e.g. compute returned nothing new), pick directly
      if (recQueue.length === 0) {
        const next = recommendTask();
        if (next) recQueue.push(next);
      }
    }

    renderRecommendations();
    return;
  }

  // --------------------------
  // BENCHMARK OR OTHER PHASES
  // --------------------------
  else {
    humanPreferences[sev].rejected++;
    logTaskEvent({ type: "REJECT", agent: "human", taskId, severity: sev });
    logHumanTask(taskId, "Rejected");
  }

  // --------------------------
  // Common UI updates for non-selective
  // --------------------------
  recQueue = recQueue.filter(r => r.taskId !== taskId);
  if (recQueue.length === 0) computeRecommendationQueue();
  renderRecommendations();
}





function startTaskForHuman(cell) {
  const sev = cell.severity;

  // Sample FINAL (agent+phase) values now for the human
  const reward      = drawReward(sev, "human");
  const need        = drawResources(sev, "human");
  const serviceTime = drawServiceTime(sev, "human");

  // Persist the sampled values on the task
  cell.task.reward        = reward;
  cell.task.resourcesNeed = need;
  cell.task.serviceTime   = serviceTime;

  const capacityLeft = Math.max(0, human.capacity - human.engaged - human.repairing);
  cell.task.capacityLeftAtAccept = capacityLeft;

  // Commit capacity immediately
  human.engaged += need;
  updateAgentPanel();
  logHumanTask(cell.task.id, "Accepted");
  renderGrid();

  // Service time governs real duration (seconds → ms)
  setTimeout(() => {
    cell.task.status = "completed";
    renderGrid();

const ap = getActiveParam(sev, "human");
const damaged = Math.random() < ap.damageProb;

    const overuse = Math.max(0, need - capacityLeft);
    const penalty = overuse * OVERCAP_PENALTY_PER_UNIT;
    const finalScore = Math.max(0, reward - penalty);

    humanScore += finalScore;
    updateScores(humanScore, bot1Score, bot2Score);

    // Update HUMAN bandit only
    updateBanditStats(sev, reward, serviceTime, need);

    logTaskEvent({
      type: "COMPLETE", agent: "human", taskId: cell.task.id, severity: sev,
      result: { reward, serviceTime, resourcesUsed: need, damaged, overuse, penalty, finalScore }
    });

    humanPreferences[sev].completed++;
    insightsData[sev].rewards.push(reward);
    insightsData[sev].resources.push(need);
    if (damaged) insightsData[sev].damaged++;
    insightsData[sev].completed++;
    updateInsights();

    if (damaged) {
      const lost = human.engaged;
      human.repairing += lost;
      human.engaged = 0;
      updateAgentPanel();
      setTimeout(() => {
        human.repairing = Math.max(0, human.repairing - lost);
        updateAgentPanel();
      }, HUMAN_REPAIR_MS);
    }

    // Cleanup after completion
    setTimeout(() => {
      const sev2 = cell.severity;
      human.engaged = Math.max(0, human.engaged - need);
      cell.type = "building";
      cell.severity = null;
      cell.task = null;
      activeTasks[sev2] = activeTasks[sev2].filter(t => t !== cell);
      ensureTasks();
      updateAgentPanel();
      renderRecommendations();
    }, 1000);
  }, serviceTime * 1000);
}


/******************************************************
 * BOT LOGIC
 ******************************************************/
const BOT_PREFS = {
  bot1: { order: ["H", "M", "L"], p: { H: 1.00, M: 0.90, L: 0.20 } },
  bot2: { order: ["M", "L", "H"], p: { H: 0.10, M: 0.80, L: 0.50 } }
};

function capacityLeft(agent) {
  return Math.max(0, agent.capacity - agent.engaged - agent.repairing);
}
function lcbSafeNeed(needed, sev) {
  const d_f = banditState.f_lcb[sev] || 0;
  return Math.max(0, needed - d_f);
}
function botLogRow(tableId, taskId, status) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  const row = document.createElement("tr");
  row.innerHTML = `<td>${taskId}</td><td>${status}</td>`;
  tbody.prepend(row);
  while (tbody.rows.length > 8) tbody.deleteRow(-1);
}
function botAcceptTask(bot, tableId, cell) {
  const sev = cell.severity;

  // Ensure we sample bot-specific values
  const reward      = drawReward(sev, "bot");
  const need        = drawResources(sev, "bot");
  const serviceTime = drawServiceTime(sev, "bot");

  // Store on the task object
  cell.task.reward = reward;
  cell.task.resourcesNeed = need;
  cell.task.serviceTime = serviceTime;

  const capLeft = capacityLeft(bot);
  cell.task.capacityLeftAtAccept = capLeft;

  // Exclusivity + commit capacity
  cell.task.status = "in-progress";
  cell.task.claimedBy = bot.id;
  bot.engaged += need;

  // 🔥 Force grid re-render so the cell shows "in-progress"
  renderGrid();

  // Log + UI update
  botLogRow(tableId, cell.task.id, "Accepted");
  logTaskEvent({ type: "BOT_ACCEPT", agent: bot.id, taskId: cell.task.id, severity: sev });

  // Execute service time
  setTimeout(() => {
    
    if (!cell.task) return; // guard in case of race
    cell.task.status = "completed";
    renderGrid();

const ap = getActiveParam(sev, "bot");
const damaged = Math.random() < ap.damageProb;
// record bot-specific damage/completion
if (bot.id === "bot1") {
  botInsightsData.bot1[sev].completed++;
  if (damaged) botInsightsData.bot1[sev].damaged++;
} else {
  botInsightsData.bot2[sev].completed++;
  if (damaged) botInsightsData.bot2[sev].damaged++;
}

    const overuse = Math.max(0, need - capLeft);
    const penalty = overuse * OVERCAP_PENALTY_PER_UNIT;
    const finalScore = Math.max(0, reward - penalty);

    // Update bot score
    if (bot.id === "bot1") { bot1Score += finalScore; bot.score = bot1Score; }
    else { bot2Score += finalScore; bot.score = bot2Score; }
    updateScores(humanScore, bot1Score, bot2Score);

// new: update only the bot's private bandit
if (bot.id === "bot1") {
  updateBotBandit(botBandit1, sev, reward, serviceTime, need);
} else {
  updateBotBandit(botBandit2, sev, reward, serviceTime, need);
}

    logTaskEvent({
      type: "BOT_COMPLETE", agent: bot.id, taskId: cell.task.id, severity: sev,
      result: { reward, serviceTime, resourcesUsed: need, damaged, overuse, penalty, finalScore }
    });

    // Handle damage & repair
    if (damaged) {
      const lost = bot.engaged;
      bot.repairing += lost;
      bot.engaged = 0;
      updateAgentPanel();
      setTimeout(() => { bot.repairing = Math.max(0, bot.repairing - lost); updateAgentPanel(); }, BOT_REPAIR_MS);
    }

    // Cleanup after completion
    setTimeout(() => {
      const sev2 = cell.severity;
      bot.engaged = Math.max(0, bot.engaged - need);
      cell.type = "building"; 
      cell.severity = null; 
      cell.task = null;
      activeTasks[sev2] = activeTasks[sev2].filter(t => t !== cell);
      ensureTasks(); 
      renderGrid();
      renderRecommendations();
    }, 500);

    botLogRow(bot.id === "bot1" ? "bot1-table" : "bot2-table", cell.task.id, `Completed (+${finalScore})`);
  }, serviceTime * 1000);
}


function botRejectTask(bot, tableId, cell, reason) {
  botLogRow(tableId, cell.task.id, `Rejected (${reason})`);
  logTaskEvent({ type: "BOT_REJECT", agent: bot.id, taskId: cell.task.id, severity: cell.severity, reason });
}
function botDecisionOnce(bot, bandit, tableId) {
  const candidates = [];

  for (const sev of severities) {
    const pending = activeTasks[sev].filter(c => c.task?.status === "pending");
    for (const cell of pending) {
      const q_hat = computeQHatForBot(bandit, sev);

      const [minR, maxR] = getActiveParam(sev, "bot").resourceRange;
      const estNeed = Math.round((minR + maxR) / 2);

      const d_f = bandit.f_lcb[sev] || 0;
      const safeNeed = Math.max(0, estNeed - d_f);
      const capLeft = capacityLeft(bot);

      if (safeNeed <= capLeft) {
        candidates.push({ cell, sev, q_hat });
      }
    }
  }

  if (!candidates.length) return;

  // rank by q-hat
  candidates.sort((a, b) => b.q_hat - a.q_hat);
  let chosen = candidates[0];

  // small chance to pick suboptimal
  if (Math.random() < 0.1 && candidates.length > 1) {
    chosen = candidates[1];
  }

  botAcceptTask(bot, tableId, chosen.cell);
}



let bot1Timer = null, bot2Timer = null;
function startBots() {
if (!bot1Timer) bot1Timer = setInterval(() => botDecisionOnce(bot1, botBandit1, "bot1-table"), BOT_DECISION_INTERVAL);
if (!bot2Timer) bot2Timer = setInterval(() => botDecisionOnce(bot2, botBandit2, "bot2-table"), BOT_DECISION_INTERVAL);

}
function stopBots() {
  if (bot1Timer) { clearInterval(bot1Timer); bot1Timer = null; }
  if (bot2Timer) { clearInterval(bot2Timer); bot2Timer = null; }
}

/******************************************************
 * INSIGHTS DATA (for damage stats)
 ******************************************************/
let insightsData = {
  H: { rewards: [], resources: [], damaged: 0, completed: 0 },
  M: { rewards: [], resources: [], damaged: 0, completed: 0 },
  L: { rewards: [], resources: [], damaged: 0, completed: 0 }
};

let botInsightsData = {
  bot1: { H: { damaged: 0, completed: 0 }, M: { damaged: 0, completed: 0 }, L: { damaged: 0, completed: 0 } },
  bot2: { H: { damaged: 0, completed: 0 }, M: { damaged: 0, completed: 0 }, L: { damaged: 0, completed: 0 } }
};


/******************************************************
 * INSIGHTS PANEL (μ ± σ)
 ******************************************************/
function updateInsights() {
  for (const sev of severities) {
    // human bandit
    const hStats = banditState.stats[sev];
    const hReward  = hStats.reward.n   > 0 ? `${hStats.reward.mean.toFixed(1)} ± ${hStats.reward.std.toFixed(1)}` : "–";
    const hRes     = hStats.resources.n> 0 ? `${hStats.resources.mean.toFixed(1)} ± ${hStats.resources.std.toFixed(1)}` : "–";
    const hSvc     = hStats.service.n  > 0 ? `${hStats.service.mean.toFixed(1)} ± ${hStats.service.std.toFixed(1)}` : "–";
    const hDmgProb = insightsData[sev].completed > 0
      ? ((insightsData[sev].damaged / insightsData[sev].completed) * 100).toFixed(1) + "%"
      : "–";
    const hComp = insightsData[sev].completed;

    // bot bandits combined
    const bStats1 = botBandit1.stats[sev];
    const bStats2 = botBandit2.stats[sev];
    const combine = (s1, s2) => {
      const n = s1.n + s2.n;
      if (n === 0) return "–";
      const mean = ((s1.mean * s1.n) + (s2.mean * s2.n)) / n;
      const std = Math.sqrt(((s1.std ** 2) * s1.n + (s2.std ** 2) * s2.n) / n);
      return `${mean.toFixed(1)} ± ${std.toFixed(1)}`;
    };

    const bReward = combine(bStats1.reward, bStats2.reward);
    const bRes    = combine(bStats1.resources, bStats2.resources);
    const bSvc    = combine(bStats1.service, bStats2.service);

    // bot damage prob
    const bCompleted = botInsightsData.bot1[sev].completed + botInsightsData.bot2[sev].completed;
    const bDamaged   = botInsightsData.bot1[sev].damaged + botInsightsData.bot2[sev].damaged;
    const bDmgProb   = bCompleted > 0 ? ((bDamaged / bCompleted) * 100).toFixed(1) + "%" : "–";

    // update DOM
    setText(`${sev}-reward-human`, hReward);
    setText(`${sev}-res-human`, hRes);
    setText(`${sev}-svc-human`, hSvc);
    setText(`${sev}-dmg-human`, hDmgProb);
    setText(`${sev}-comp-human`, hComp);

    setText(`${sev}-reward-bot`, bReward);
    setText(`${sev}-res-bot`, bRes);
    setText(`${sev}-svc-bot`, bSvc);
    setText(`${sev}-dmg-bot`, bDmgProb);
    setText(`${sev}-comp-bot`, bCompleted);
  }
}



/******************************************************
 * UI SAFETY: Play Clock + Modal
 ******************************************************/
function ensureUI() {
  if (!document.getElementById("play-clock")) {
    const headerControls = document.querySelector(".header-controls") || document.body;
    const span = document.createElement("span");
    span.id = "play-clock"; span.textContent = "Play Time: 00:00"; span.style.marginLeft = "12px";
    headerControls.appendChild(span);
  }
  if (!document.getElementById("phase-modal")) {
    const modal = document.createElement("div");
    modal.id = "phase-modal"; modal.className = "modal hidden";
    modal.innerHTML = `
      <div class="modal-content" style="background:#fff;padding:20px;border-radius:10px;max-width:420px;text-align:center;box-shadow:0 6px 30px rgba(0,0,0,0.2)">
        <h2 style="margin-top:0">Phase Change</h2>
        <p id="phase-message" style="white-space:pre-wrap;text-align:left"></p>
        <button id="phase-continue-btn" style="margin-top:12px;padding:8px 12px;border-radius:8px;border:1px solid #222;cursor:pointer">Continue</button>
      </div>`;
    Object.assign(modal.style, { position: "fixed", inset: "0", display: "none", justifyContent: "center",
      alignItems: "center", background: "rgba(0,0,0,0.55)", zIndex: "9999" });
    document.body.appendChild(modal);
    modal.querySelector("#phase-continue-btn").addEventListener("click", acknowledgePhaseChange);
  }
}
function showModal(){ const m=document.getElementById("phase-modal"); if (m) m.style.display="flex"; }
function hideModal(){ const m=document.getElementById("phase-modal"); if (m) m.style.display="none"; }

/******************************************************
 * PHASE MANAGEMENT
 ******************************************************/
// --- REPLACE setupPhaseOrder() ---
function setupPhaseOrder() {
  // Derive a stable numeric key from participant ID
  const pid = experimentLog.participantId || "ANON";
  const asciiSum = pid.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);

  // Two counterbalanced orders depending on the hash parity
  if (asciiSum % 2 === 0) {
    phaseOrder = ["learning", "benchmark", "selective"];
  } else {
    phaseOrder = ["benchmark", "learning", "selective"];
  }

  currentPhase = phaseOrder[0];
  activePhaseIndex = 0;
  logTaskEvent({ type: "MODE_INIT", phaseOrder });
}


function updatePlayClockDisplay() { setText("play-clock", `Play Time: ${formatTime(playElapsedSeconds)}`); }
function startPlayClock() {
  if (playTimer) return;
  playElapsedSeconds = 0; updatePlayClockDisplay();
  playTimer = setInterval(() => {
    playElapsedSeconds++; updatePlayClockDisplay();
    if (playElapsedSeconds >= PHASE_DURATION_SECONDS && activePhaseIndex < phaseOrder.length - 1 && !pendingPhaseSwitch) {
      stopPlayClock(); pendingPhaseSwitch = true; showPhaseModal();
      logTaskEvent({ type: "PHASE_READY", nextPhase: phaseOrder[activePhaseIndex + 1] });
    }
  }, 1000);
}
function stopPlayClock(){ if (playTimer){ clearInterval(playTimer); playTimer=null; } }
function showPhaseModal() {
  setText(
    "phase-message",
    `Phase complete!\n\nWe will now be starting the next section.\n\nThe insights you have gauged in the first section are redundant here.\nThis is an independent section; none of the parameters are connected.\n\nClick Continue to proceed.\nThe next section will begin when you accept or reject any existing task.`
  );
  showModal();
}

function acknowledgePhaseChange(){ hideModal(); phaseAcknowledged = true; logTaskEvent({ type:"PHASE_ACKNOWLEDGED" }); }
function maybeSwitchPhaseOnAction(){
  if (pendingPhaseSwitch && phaseAcknowledged) {
    activePhaseIndex++; 
    currentPhase = phaseOrder[activePhaseIndex];
    // Before switching, trigger a phase-specific exit survey
  if (pendingPhaseSwitch && phaseAcknowledged) {
    const completedPhase = currentPhase;  // store current before switch
    stopPlayClock();
    stopBots();
    startExitSurvey(completedPhase);  // 👈 pass phase name
  }

    // 🔄 Reset human bandit state
    banditState.Ts = { H: 0, M: 0, L: 0 };
    banditState.Rs = { H: 0, M: 0, L: 0 };
    banditState.Cs = { H: 0, M: 0, L: 0 };
    banditState.Vs = { H: 0, M: 0, L: 0 };
    banditState.Ft = { H: 0, M: 0, L: 0 };
    banditState.f_lcb = { H: 0, M: 0, L: 0 };
    banditState.globalRounds = 0;
    banditState.stats = {
      H: { reward: createStats(), service: createStats(), resources: createStats() },
      M: { reward: createStats(), service: createStats(), resources: createStats() },
      L: { reward: createStats(), service: createStats(), resources: createStats() }
    };

    // 🔄 Reset bot bandit states
    Object.assign(botBandit1, createBanditState());
    Object.assign(botBandit2, createBanditState());

    // 🔄 Reset bot insights (damage/completion)
    botInsightsData = {
      bot1: { H: { damaged: 0, completed: 0 }, M: { damaged: 0, completed: 0 }, L: { damaged: 0, completed: 0 } },
      bot2: { H: { damaged: 0, completed: 0 }, M: { damaged: 0, completed: 0 }, L: { damaged: 0, completed: 0 } }
    };

    // 🔄 Reset scores
    humanScore = 0;
    bot1Score = 0;
    bot2Score = 0;
    updateScores(humanScore, bot1Score, bot2Score);

    // 🔄 Reset task ID counter
    taskIdCounter = 1;

    // 🔄 Reset human insights
    insightsData = {
      H: { rewards: [], resources: [], damaged: 0, completed: 0 },
      M: { rewards: [], resources: [], damaged: 0, completed: 0 },
      L: { rewards: [], resources: [], damaged: 0, completed: 0 }
    };
    updateInsights();

    console.log("✅ Phase reset: bandits + scores + task IDs + insights cleared");

    pendingPhaseSwitch = false; 
    phaseAcknowledged = false; 
    playClockStarted = true; 
    startPlayClock();
    logTaskEvent({ type: "PHASE_START", newPhase: currentPhase });
  }
}



/******************************************************
 * RENDER GRID & RECOMMENDATIONS
 ******************************************************/
function renderGrid() {
  gridContainer.innerHTML = "";
  for (const cell of gridData) {
    const div = document.createElement("div");
    div.classList.add("cell");
    if (cell.type === "subtask") {
      const status = cell.task?.status || "pending";
if (status === "pending") {
  div.style.background = pastelColors[cell.severity];
}
      else if (status === "in-progress") div.style.background = "yellow";
      else if (status === "completed") div.style.background = "lightgreen";
      div.innerText = cell.severity;
    } else if (cell.type === "building") {
      div.style.background = "#bbb";
    }
    gridContainer.appendChild(div);
  }
}
function renderRecommendations() {
  const container = document.getElementById("task-recommendations");
  if (!container) return;
  container.innerHTML = "";

  // ----------------------------
  // Learning phase: single sorted queue
  // ----------------------------
 if (currentPhase === "learning") {
  if (recQueue.length === 0) computeRecommendationQueue();
  if (recQueue.length === 0) {
    setText("recommendation", "–");
    return;
  }

  // skip over any invalid / non-pending task
  while (recQueue.length > 0) {
    const rec = recQueue[0];
    const cell = activeTasks[rec.sev].find(c => c.task?.id === rec.taskId && c.task.status === "pending");
    if (cell) {
      const task = cell.task;

      const div = document.createElement("div");
      div.classList.add("task-card");
      div.style.border = "3px solid green";
      div.innerHTML = `
        <div class="task-info">
          🔥 <b>${task.id}</b> | Type: ${rec.sev}
        </div>
        <div class="task-buttons">
          <button onclick="acceptTask('${rec.sev}', '${task.id}')">Accept</button>
          <button onclick="rejectTask('${rec.sev}', '${task.id}')">Reject</button>
        </div>
      `;
      container.appendChild(div);

      setText("recommendation", `🔥 ${task.id} | Type: ${rec.sev}`);
      return;
    }
    // drop invalid entry and continue
    recQueue.shift();
  }

  // if everything was invalid, rebuild
  computeRecommendationQueue();
  renderRecommendations();
  return;
}


  // ----------------------------
  // Benchmark phase: 3 cards (H, M, L)
  // ----------------------------
  if (currentPhase === "benchmark") {
    const rec = recommendTask();
    if (!rec) {
      setText("recommendation", "–");
      return;
    }
    if (!Object.values(rec).some(c => !!c)) {
      setText("recommendation", "–");
      return;
    }

    const recSummary = [];
    for (const sev of severities) {
      const cell = rec[sev];
      if (!cell) continue;
      const task = cell.task;

      recSummary.push(`${sev}:${task.id}`);

      const div = document.createElement("div");
      div.classList.add("task-card");
      div.style.border = "2px solid green";
      div.innerHTML = `
        <div class="task-info">
          🔥 <b>${task.id}</b> | Type: ${sev}
        </div>
        <div class="task-buttons">
          <button onclick="acceptTask('${sev}', '${task.id}')">Accept</button>
        </div>
      `;
      container.appendChild(div);

      // ⏱️ Auto-assign to best bot if not accepted in 3s
      setTimeout(() => {
        if (task.status === "pending" && currentPhase === "benchmark") {
          assignTaskToBestBot(cell, true); // true = auto-assign flag
        }
      }, 3000);
    }

    // update control panel summary
    setText("recommendation", recSummary.join(" | "));
  }
}




/******************************************************
 * PANELS & LOGGING
 ******************************************************/
function updateAgentPanel() {
  const el = document.getElementById("agent-Human"); if (!el) return;
  el.innerHTML = `
    Capacity: ${human.capacity}<br>
    Available: ${Math.max(0, human.capacity - human.engaged - human.repairing)}<br>
    Engaged: ${human.engaged}<br>
    Repairing: ${human.repairing}`;
}
function updateScores(h, b1, b2){ setText("human-score", h); setText("bot1-score", b1); setText("bot2-score", b2); setText("team-score", h + b1 + b2); }
function logHumanTask(taskId, status) {
  const tbody = document.querySelector("#human-table tbody"); if (!tbody) return;
  const row = document.createElement("tr"); row.innerHTML = `<td>${taskId}</td><td>${status}</td>`;
  tbody.prepend(row); while (tbody.rows.length > 5) tbody.deleteRow(-1);
}

/******************************************************
 * PER-PHASE SUMMARY BUILDER
 ******************************************************/
function initSeverityAgg() {
  return {
    accepted: { human: 0, bot1: 0, bot2: 0 },
    rejected: { human: 0, bot1: 0, bot2: 0 },
    completed: { human: 0, bot1: 0, bot2: 0 },
    rewardSum: 0, serviceSum: 0, resourceSum: 0,
    completedTotal: 0, damaged: 0,
    avgReward: 0, avgService: 0, avgResources: 0, damageRate: 0
  };
}
function initPhaseShell() {
  return {
    scores: { human: 0, bot1: 0, bot2: 0, team: 0 },
    bySeverity: { H: initSeverityAgg(), M: initSeverityAgg(), L: initSeverityAgg() }
  };
}
function computePhaseSummary(log) {
  const phases = {};
  for (const e of log.tasks) {
    const phase = e.phase || "unknown";
    if (!phases[phase]) phases[phase] = initPhaseShell();

    const p = phases[phase];
    const sev = e.severity;
    const type = e.type || "";
    const agent = e.agent || (type.startsWith("BOT_") ? "bot1" : "human");

    // Skip non-task events
    if (!sev || !p.bySeverity[sev]) continue;

    switch (type) {
      case "ACCEPT":
        p.bySeverity[sev].accepted.human++; break;
      case "REJECT":
        p.bySeverity[sev].rejected.human++; break;
      case "COMPLETE": {
        p.bySeverity[sev].completed.human++;
        const r = e.result || {};
        p.bySeverity[sev].rewardSum += (r.reward || 0);
        p.bySeverity[sev].serviceSum += (r.serviceTime || 0);
        p.bySeverity[sev].resourceSum += (r.resourcesUsed || 0);
        p.bySeverity[sev].completedTotal++;
        if (r.damaged) p.bySeverity[sev].damaged++;
        p.scores.human += (r.finalScore || 0);
        break;
      }
      case "BOT_ACCEPT":
        p.bySeverity[sev].accepted[agent]++; break;
      case "BOT_REJECT":
        p.bySeverity[sev].rejected[agent]++; break;
      case "BOT_COMPLETE": {
        p.bySeverity[sev].completed[agent]++;
        const r = e.result || {};
        p.bySeverity[sev].rewardSum += (r.reward || 0);
        p.bySeverity[sev].serviceSum += (r.serviceTime || 0);
        p.bySeverity[sev].resourceSum += (r.resourcesUsed || 0);
        p.bySeverity[sev].completedTotal++;
        if (r.damaged) p.bySeverity[sev].damaged++;
        p.scores[agent] += (r.finalScore || 0);
        break;
      }
      default: break;
    }
  }

  // finalize team scores and computed averages
  for (const ph of Object.keys(phases)) {
    const ps = phases[ph];
    ps.scores.team = ps.scores.human + ps.scores.bot1 + ps.scores.bot2;

    for (const sev of ["H", "M", "L"]) {
      const s = ps.bySeverity[sev];
      s.avgReward   = s.completedTotal ? s.rewardSum   / s.completedTotal : 0;
      s.avgService  = s.completedTotal ? s.serviceSum  / s.completedTotal : 0;
      s.avgResources= s.completedTotal ? s.resourceSum / s.completedTotal : 0;
      s.damageRate  = s.completedTotal ? s.damaged     / s.completedTotal : 0;
    }
  }
  return phases;

  async function savePhaseSummary(pid, phaseName, summary, botInsights, humanPrefs) {
  const phaseRef = doc(db, "participants", pid, "runs", runId, "summaries", phaseName);
  await setDoc(phaseRef, {
    summary,
    botInsights,
    humanPreferences: humanPrefs,
    timestamp: serverTimestamp(),
  });
}

}

function assignTaskToBestBot(cell, autoAssign = false) {
  const sev = cell.severity;

  // Compute q-hats for both bots
  const q1 = computeQHatForBot(botBandit1, sev);
  const q2 = computeQHatForBot(botBandit2, sev);

  let chosenBot = null;
  let tableId = null;

  if (capacityLeft(bot1) > 0 && capacityLeft(bot2) > 0) {
    // both available → pick max q̂
    if (q1 >= q2) { chosenBot = bot1; tableId = "bot1-table"; }
    else { chosenBot = bot2; tableId = "bot2-table"; }
  } else if (capacityLeft(bot1) > 0) {
    chosenBot = bot1; tableId = "bot1-table";
  } else if (capacityLeft(bot2) > 0) {
    chosenBot = bot2; tableId = "bot2-table";
  }

  if (chosenBot) {
    botAcceptTask(chosenBot, tableId, cell);
    if (autoAssign) {
      logTaskEvent({
        type: "AUTO_ASSIGN_TO_BOT",
        agent: chosenBot.id,
        taskId: cell.task.id,
        severity: sev
      });
    }
  } else {
    // Both bots full → let normal loop pick it up later
    console.log(`⚠️ No bot capacity for ${cell.task.id}, will be retried later.`);
  }
}


/******************************************************
 * ONBOARDING WIZARD (participant ID → survey → scenario → info → video → start)
 ******************************************************/
const onboardingState = {
  step: 0,
  steps: ["pid", "survey1", "survey2", "scenario1", "scenario2", "info1", "info2", "info3", "info4", "video", "ready"],
  preSurvey: null,
  pid: "",
  phaseOrder: []
};

function ensureOnboardingUI() {
  if (document.getElementById("onboarding-modal")) return;
  const modal = document.createElement("div");
  modal.id = "onboarding-modal";
  Object.assign(modal.style, {
    position: "fixed", inset: "0", display: "flex", justifyContent: "center",
    alignItems: "center", background: "rgba(0,0,0,0.55)", zIndex: "10000"
  });
  modal.innerHTML = `
    <div id="onb-content" style="background:#fff; padding:22px; width: min(720px, 92vw);
      border-radius: 12px; box-shadow:0 8px 36px rgba(0,0,0,0.25); font-family: system-ui, sans-serif">
      <div id="onb-body"></div>
      <div id="onb-nav" style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px">
        <button id="onb-prev" style="padding:8px 12px; border-radius:8px; border:1px solid #888; background:#f5f5f5; cursor:pointer">Back</button>
        <button id="onb-next" style="padding:8px 12px; border-radius:8px; border:1px solid #222; background:#111; color:#fff; cursor:pointer">Next</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function renderSurveyPage(containerEl, questions, label) {
  containerEl.innerHTML = `<h2 style="margin:0 0 8px">${label}</h2>`;
  const holder = document.createElement("div");
  holder.id = "onb-survey";
  holder.style.display = "grid";
  holder.style.gap = "12px";
  containerEl.appendChild(holder);

  questions.forEach((q, idx) => {
    const val = q.default ?? Math.round((q.min+q.max)/2);
    const row = document.createElement("div");
    row.innerHTML = `
      <label>${q.text}</label>
      <input type="range" id="${q.id}" min="${q.min}" max="${q.max}" value="${val}" step="1"
        oninput="document.getElementById('${q.id}-val').textContent=this.value">
      <div>Value: <span id="${q.id}-val">${val}</span></div>`;
    holder.appendChild(row);
  });
}

function collectSurveyResponses(questions){
  const answers = {};
  questions.forEach(q=>{
    const el=document.getElementById(q.id);
    if(el) answers[q.id]=Number(el.value);
  });
  return answers;
  async function savePreSurvey(pid, responses) {
  const surveyRef = doc(db, "participants", pid, "runs", runId, "surveys", "startSurvey");
  await setDoc(surveyRef, {
    responses,
    timestamp: serverTimestamp(),
  });
}

async function saveExitSurvey(pid, responses) {
  const surveyRef = doc(db, "participants", pid, "runs", runId, "surveys", "exitSurvey");
  await setDoc(surveyRef, {
    responses,
    timestamp: serverTimestamp(),
  });
}

}

function renderOnboardingStep() {
  const body   = document.getElementById("onb-body");
  const nextBtn= document.getElementById("onb-next");
  const prevBtn= document.getElementById("onb-prev");

  function goNext() {
    onboardingState.step = Math.min(onboardingState.step + 1, onboardingState.steps.length - 1);
    renderOnboardingStep();
  }
  function goPrev() {
    onboardingState.step = Math.max(onboardingState.step - 1, 0);
    renderOnboardingStep();
  }
  if (prevBtn) {
    prevBtn.onclick = goPrev;
    prevBtn.style.visibility = onboardingState.step === 0 ? "hidden" : "visible";
  }

  // survey helpers
  function renderPreSurvey(containerEl, questions = PRE_SURVEY_QUESTIONS) {
    containerEl.innerHTML = `
      <h2 style="margin:0 0 8px">Pre-Survey</h2>
      <p>Use the sliders to respond.</p>
      <div id="onb-survey" style="display:grid; gap:12px; margin-top:8px"></div>
    `;
    const holder = containerEl.querySelector("#onb-survey");
    questions.forEach((q, idx) => {
      const min = q.min ?? 1, max = q.max ?? 10, val = q.default ?? Math.round((min + max) / 2);
      const row = document.createElement("div");
      row.className = "survey-item";
      row.innerHTML = `
        <label for="${q.id}" style="display:block; margin-bottom:4px">
          Q${idx + 1}: ${q.text}
        </label>
        <div style="display:flex; justify-content:space-between; font-size:12px; color:#666; margin-bottom:2px;">
          <span>${q.minLabel ?? min}</span>
          <span>${q.maxLabel ?? max}</span>
        </div>
        <input type="range" min="${min}" max="${max}" value="${val}" step="1"
               id="${q.id}"
               oninput="document.getElementById('${q.id}-val').textContent=this.value">
        <div>Value: <span id="${q.id}-val">${val}</span></div>
      `;
      holder.appendChild(row);
    });
  }
  function collectPreSurveyResponses(questions = PRE_SURVEY_QUESTIONS) {
    const holder = document.getElementById("onb-survey");
    const answers = {};
    questions.forEach(q => {
      const el = holder?.querySelector(`#${q.id}`);
      if (el) answers[q.id] = Number(el.value);
    });
    return answers;
  }

  const s = onboardingState.steps[onboardingState.step];
  if (!nextBtn) return;

  if (s === "pid") {
    nextBtn.textContent = "Next";
    body.innerHTML = `
      <h2>Welcome!</h2>
      <p>Please enter your Participant ID to begin.</p>
      <input id="onb-pid" placeholder="e.g., P1234" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:8px">
    `;
    nextBtn.onclick = () => {
      const pid = (document.getElementById("onb-pid")?.value || "").trim();
      if (!pid) { alert("Please enter a Participant ID."); return; }
      onboardingState.pid = pid;
      experimentLog.participantId = pid;
      logTaskEvent({ type: "ONB_PID_SET", pid });
      goNext();
    };
  }

  if (s === "survey1") {
    nextBtn.textContent = "Next";
    renderSurveyPage(body, PRE_SURVEY_QUESTIONS.slice(0,5), "Pre-Survey (1/2)");
    nextBtn.onclick = () => {
      onboardingState.partialSurvey1 = collectSurveyResponses(PRE_SURVEY_QUESTIONS.slice(0,5));
      goNext();
    };
  }

  if (s === "survey2") {
    nextBtn.textContent = "Next";
    renderSurveyPage(body, PRE_SURVEY_QUESTIONS.slice(5), "Pre-Survey (2/2)");
    nextBtn.onclick = () => {
      const part2 = collectSurveyResponses(PRE_SURVEY_QUESTIONS.slice(5));
      const all = { ...onboardingState.partialSurvey1, ...part2 };
      onboardingState.preSurvey = { answers: all, meta: PRE_SURVEY_QUESTIONS };
      experimentLog.preSurvey   = { answers: all, meta: PRE_SURVEY_QUESTIONS };
      logTaskEvent({ type: "SURVEY_SUBMIT", survey: "pre", answers: all });
      goNext();
    };
  }

  if (s === "scenario1") {
    nextBtn.textContent = "Next";
    body.innerHTML = `
      <h2>Mission Control</h2>
      <p>You are part of a rapid-response operations team.</p>
      <p>Emergencies are breaking out across a city grid. Each incident represents a task that must be handled quickly and efficiently.</p>
      <p>You will be working alongside two AI teammates. Together, your mission is to manage tasks as they appear on the grid.</p>
    `;
    nextBtn.onclick = () => { logTaskEvent({ type:"ONB_SCENARIO1_VIEWED" }); goNext(); };
  }

  if (s === "scenario2") {
    nextBtn.textContent = "Next";
    body.innerHTML = `
      <h2>Your Role</h2>
      <p>You will receive task recommendations. For each one, you may choose to <b>accept</b> or <b>reject</b> it based on your preferences.</p>
      <p>Accepting consumes resources and contributes to team performance. Rejecting passes the decision to the AI teammates, who may or may not take it.</p>
      <p>The goal is to work together with the AI agents to <b>maximize total team reward</b>.</p>
    `;
    nextBtn.onclick = () => { logTaskEvent({ type:"ONB_SCENARIO2_VIEWED" }); goNext(); };
  }

  if (s === "info1") {
    nextBtn.textContent = "Next";
    body.innerHTML = `
      <h2>Task Characteristics</h2>
      <p>Tasks may differ in several ways:</p>
      <ul>
        <li><b>Severity</b> — how urgent or critical the incident is.</li>
        <li><b>Resource Demand</b> — how much effort is required to complete it.</li>
        <li><b>Uncertainty</b> — how predictable or unpredictable the outcome may be.</li>
      </ul>
      <p>There are <b>3 unique types of tasks</b>, each with its own profile.</p>
    `;
    nextBtn.onclick = () => { logTaskEvent({ type:"ONB_INFO1_VIEWED" }); goNext(); };
  }

  if (s === "info2") {
    nextBtn.textContent = "Next";
    body.innerHTML = `
      <h2>The Display</h2>
      <p>The grid represents the environment. Each square is a building. When a task spawns, it appears as a marker inside one of the buildings.</p>
      <p>The panel on the right shows your <b>current task recommendation</b> with its details. You will click <b>Accept</b> or <b>Reject</b> for each recommendation.</p>
    `;
    nextBtn.onclick = () => { logTaskEvent({ type:"ONB_INFO2_VIEWED" }); goNext(); };
  }

  if (s === "info3") {
    nextBtn.textContent = "Next";
    body.innerHTML = `
      <h2>Task Assignment Algorithm</h2>
      <p>An algorithm runs in the background to allocate tasks across all team members. It considers:</p>
      <ul>
        <li>Your accept/reject decisions</li>
        <li>The AI teammates’ preferences and resources</li>
        <li>The balance of reward and cost for the team</li>
      </ul>
      <p>Even if you reject a task, it may still be picked up by the AI — sometimes optimally, sometimes not.</p>
    `;
    nextBtn.onclick = () => { logTaskEvent({ type:"ONB_INFO3_VIEWED" }); goNext(); };
  }

  if (s === "info4") {
    nextBtn.textContent = "Next";
    body.innerHTML = `
      <h2>Your Objective</h2>
      <p>You and your AI teammates are working toward one shared goal:</p>
      <p style="text-align:center;font-weight:bold;font-size:1.2em;margin:12px 0;">
        Maximize the overall <b>team reward</b>
      </p>
      <p>Your decisions shape how the team performs. There is no single right answer.</p>
    `;
    nextBtn.onclick = () => { logTaskEvent({ type:"ONB_INFO4_VIEWED" }); goNext(); };
  }

  if (s === "video") {
    nextBtn.textContent = "Next";
    body.innerHTML = `
      <h2>Short Demo</h2>
      <div style="height:240px; border:2px dashed #bbb; border-radius:12px; display:flex; align-items:center; justify-content:center">
        <span>Video placeholder</span>
      </div>
    `;
    nextBtn.onclick = () => { logTaskEvent({ type:"ONB_VIDEO_VIEWED" }); goNext(); };
  }

  if (s === "ready") {
    nextBtn.textContent = "Start Experiment";
    body.innerHTML = `
      <h2>All set</h2>
      <p>Click below when you’re ready to begin.</p>
      <button id="onb-start" style="padding:10px 16px; border-radius:10px; border:1px solid #222; background:#111; color:#fff; cursor:pointer">Start</button>
    `;
    const startBtn = document.getElementById("onb-start");
    if (startBtn) startBtn.addEventListener("click", startExperimentFromOnboarding);
    nextBtn.onclick = startExperimentFromOnboarding;
  }
}

function startExperimentFromOnboarding() {
  logTaskEvent({ type: "ONB_COMPLETE" });
  setupPhaseOrder(); // still initializes hidden order
  const m = document.getElementById("onboarding-modal");
  if (m) m.remove();
  startExperiment();
}


/******************************************************
 * STOPWATCH / EXPERIMENT LIFECYCLE
 ******************************************************/
function formatTime(secs){ const m=String(Math.floor(secs/60)).padStart(2,"0"); const s=String(secs%60).padStart(2,"0"); return `${m}:${s}`; }
function startExperiment() {
  if (experimentTimer) return;
  ensureUI();
  experimentStartTime = new Date().toISOString(); experimentLog.startTime = experimentStartTime;
  elapsedSeconds = 0; setText("experiment-clock", "00:00");
  experimentTimer = setInterval(() => { elapsedSeconds++; setText("experiment-clock", formatTime(elapsedSeconds)); }, 1000);
async function startExperiment(pid, phaseOrder) {
  runId = `run_${Date.now()}`;
  const runRef = doc(db, "participants", pid, "runs", runId);

  await setDoc(runRef, {
    participantId: pid,
    runId,
    phaseOrder,
    startTime: serverTimestamp(),
  });
}

  // Use phase order computed during onboarding
  logTaskEvent({ type: "PHASE_START", newPhase: currentPhase });

  // Start autonomous bots
  startBots();
}


/******************************************************
 * EXIT SURVEY (10 Q split across 2 popups + code entry)
 ******************************************************/
/******************************************************
 * EXIT SURVEY (25 Q split across 5 popups + code entry)
 ******************************************************/
const EXIT_SURVEY_QUESTIONS = [
  // Group Cohesion & Engagement
  { id: "exitQ1", text: "I feel accepted by the group.", min: 1, max: 5, default: 3 },
  { id: "exitQ2", text: "In my group we trust each other.", min: 1, max: 5, default: 3 },
  { id: "exitQ3", text: "The members like and care about each other.", min: 1, max: 5, default: 3 },
  { id: "exitQ4", text: "The members feel a sense of participation.", min: 1, max: 5, default: 3 },
  { id: "exitQ5", text: "The members try to understand each other’s reasoning and perspectives.", min: 1, max: 5, default: 3 },

  // Team Performance
  { id: "exitQ6", text: "The team completed its tasks effectively.", min: 1, max: 5, default: 3 },
  { id: "exitQ7", text: "The team coordinated and communicated well.", min: 1, max: 5, default: 3 },
  { id: "exitQ8", text: "The team adapted to unexpected events or challenges.", min: 1, max: 5, default: 3 },
  { id: "exitQ9", text: "The team used time and resources efficiently.", min: 1, max: 5, default: 3 },
  { id: "exitQ10", text: "I am satisfied with the team’s overall performance.", min: 1, max: 5, default: 3 },

  // AI Usefulness
  { id: "exitQ11", text: "Using the AI improves my performance in the task.", min: 1, max: 5, default: 3 },
  { id: "exitQ12", text: "AI increases my general productivity.", min: 1, max: 5, default: 3 },
  { id: "exitQ13", text: "I believe that AI would enhance my effectiveness in completing the task.", min: 1, max: 5, default: 3 },
  { id: "exitQ14", text: "Using AI helps me accomplish tasks more quickly.", min: 1, max: 5, default: 3 },
  { id: "exitQ15", text: "Overall, I find that AI would be useful in this task.", min: 1, max: 5, default: 3 },

  // Human Agency
  { id: "exitQ16", text: "I felt in control of the choices I made during the experiment.", min: 1, max: 5, default: 3 },
  { id: "exitQ17", text: "My actions directly influenced the outcome of the simulation.", min: 1, max: 5, default: 3 },
  { id: "exitQ18", text: "I was able to reject or accept tasks based on my own reasoning.", min: 1, max: 5, default: 3 },
  { id: "exitQ19", text: "I felt responsible for the final results of my performance.", min: 1, max: 5, default: 3 },
  { id: "exitQ20", text: "I had a clear strategy while performing the task.", min: 1, max: 5, default: 3 },

  // AI Control/Influence
  { id: "exitQ21", text: "It felt like the AI system was in control of the experiment.", min: 1, max: 5, default: 3 },
  { id: "exitQ22", text: "The recommendations influenced my actions more than my own judgment.", min: 1, max: 5, default: 3 },
  { id: "exitQ23", text: "I had limited control over the outcome of the tasks I was assigned.", min: 1, max: 5, default: 3 },
  { id: "exitQ24", text: "I mostly followed what was recommended, without thinking too much.", min: 1, max: 5, default: 3 },
  { id: "exitQ25", text: "The randomness of the task outcomes made me feel like I wasn't really in control.", min: 1, max: 5, default: 3 }
];

function startExitSurvey(phaseName = currentPhase) {
  stopPlayClock();
  stopBots();
  let page = 0;
  const perPage = 5;
  const totalPages = Math.ceil(EXIT_SURVEY_QUESTIONS.length / perPage);
  const modal = document.createElement("div");
  modal.id = "exit-modal";
  Object.assign(modal.style, {
    position:"fixed",inset:"0",background:"rgba(0,0,0,0.6)",
    display:"flex",justifyContent:"center",alignItems:"center",zIndex:"20000"
  });
  document.body.appendChild(modal);

  function renderPage() {
    const start = page*perPage, end = start+perPage;
    const qs = EXIT_SURVEY_QUESTIONS.slice(start,end);
    modal.innerHTML = `
      <div style="background:#fff;padding:20px;max-width:600px;width:100%;border-radius:10px">
        <h2>${phaseName.toUpperCase()} Exit Survey (${page+1}/${totalPages})</h2>
        <div id="exit-holder"></div>
        <div style="margin-top:12px;display:flex;justify-content:space-between">
          ${page>0 ? `<button id="exit-prev">Back</button>` : `<div></div>`}
          <button id="exit-next">${page===totalPages-1?"Continue":"Next"}</button>
        </div>
      </div>`;
    const holder = modal.querySelector("#exit-holder");
    qs.forEach(q=>{
      const val=q.default;
      holder.innerHTML += `
        <label>${q.text}</label>
        <input type="range" id="${q.id}" min="${q.min}" max="${q.max}" value="${val}">
        <div>Value: <span id="${q.id}-val">${val}</span></div>`;
    });
    if (page>0) modal.querySelector("#exit-prev").onclick=()=>{page--;renderPage();};
    modal.querySelector("#exit-next").onclick=()=>{
      if(page<totalPages-1){page++;renderPage();}
      else finishSurvey();
    };
  }
  renderPage();

  async function finishSurvey(){
    const answers={};
    EXIT_SURVEY_QUESTIONS.forEach(q=>{
      const el=document.getElementById(q.id);
      if(el) answers[q.id]=Number(el.value);
    });

    // Save with phase-specific title
    const surveyRef = doc(db, "participants", experimentLog.participantId, "runs", runId, "surveys", `exitSurvey_${phaseName}`);
    await setDoc(surveyRef, {
      phase: phaseName,
      responses: answers,
      timestamp: serverTimestamp()
    });

    document.body.removeChild(modal);

    // Continue phase switch after survey
    finalizePhaseSwitch();
  }

  function finalizePhaseSwitch(){
    activePhaseIndex++;
    currentPhase = phaseOrder[activePhaseIndex];
    pendingPhaseSwitch = false;
    phaseAcknowledged = false;
    playClockStarted = true;
    startPlayClock();
    startBots();
    logTaskEvent({ type: "PHASE_START", newPhase: currentPhase });
  }
}








async function endExperiment(participantId, totalScore) {
  const runMetaRef = doc(db, "participants", participantId, "runs", runId, "metadata");
  await updateDoc(runMetaRef, {
    endTime: Date.now(),
    totalScore,
    serverTs: serverTimestamp()
  });

  console.log(`Experiment ended for ${participantId}`);
}



/******************************************************
 * UTILS
 ******************************************************/
function setText(id, text){ const el=document.getElementById(id); if (el) el.textContent=text; }

/******************************************************
 * INIT
 ******************************************************/
createGrid();
ensureTasks();
renderGrid();
renderRecommendations();
updateAgentPanel();
updateScores(0, 0, 0);
updateInsights();

/* Onboarding pops immediately on load */
ensureOnboardingUI();
renderOnboardingStep();

window.startExperiment = startExperiment;
window.endExperiment = endExperiment;
window.acknowledgePhaseChange = acknowledgePhaseChange;
window.acceptTask = acceptTask;
window.rejectTask = rejectTask;
