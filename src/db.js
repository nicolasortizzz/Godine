const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcrypt");

const CREDENTIALS_FILE = "Las credenciales son privadas. Contactar al administrador.";

const DEFAULT_USERS = [
  { username: "admin", role: "admin" },
  { username: "nico", role: "user" },
  { username: "manu", role: "user" },
  { username: "coco", role: "user" },
  { username: "mateo", role: "user" },
  { username: "mauro", role: "user" },
  { username: "murry", role: "user" },
  { username: "pedro", role: "user" },
  { username: "tomi", role: "user" },
  { username: "lucas", role: "user" },
  { username: "tete", role: "user" },
  { username: "pita", role: "user" },
  { username: "jula", role: "user" },
  { username: "tahiel", role: "user" },
  { username: "tincho", role: "user" },
  { username: "lucas_coco", role: "user" }
];

let client;
let db;
let initialized = false;

function normalizeUsername(u) {
  return String(u || "").trim().toLowerCase();
}

function generateRandomPassword(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.randomBytes(length * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function generatePassword(username) {
  return generateRandomPassword();
}



async function connect() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Falta la variable de entorno MONGODB_URI");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db();
  return db;
}

async function initDb() {
  if (initialized) return;
  await connect();

  const users = db.collection("users");
  const surveyWindows = db.collection("survey_windows");
  const responses = db.collection("responses");
  const answers = db.collection("answers");

  await users.createIndex({ username: 1 }, { unique: true });
  await surveyWindows.createIndex({ week_key: 1 }, { unique: true });
  await responses.createIndex({ unique_user_week: 1 }, { unique: true });

  for (const seed of DEFAULT_USERS) {
    const username = normalizeUsername(seed.username);
    const existing = await users.findOne({ username });
    if (existing) continue;
    const password = generatePassword(username);
    const password_hash = bcrypt.hashSync(password, 10);
    await users.insertOne({ username, password_hash, role: seed.role, created_at: new Date().toISOString() });
  }

  // attach to module-level variables for other functions
  module.exports._collections = { users: db.collection("users"), surveyWindows: db.collection("survey_windows"), responses: db.collection("responses"), answers: db.collection("answers") };
  initialized = true;
}

function getCollections() {
  if (!initialized) throw new Error("DB not initialized");
  return module.exports._collections;
}

async function getUserByUsername(username) {
  await initDb();
  const users = getCollections().users;
  const normalized = normalizeUsername(username);
  const u = await users.findOne({ username: normalized });
  if (!u) return null;
  return { id: u._id.toString(), username: u.username, role: u.role, password_hash: u.password_hash };
}

async function isSurveyActiveForWeek(weekKey) {
  await initDb();
  const sw = getCollections().surveyWindows;
  const r = await sw.findOne({ week_key: weekKey });
  return Boolean(r && r.active === 1);
}

async function activateSurveyForWeek(weekKey, adminId) {
  await initDb();
  const sw = getCollections().surveyWindows;
  await sw.updateOne({ week_key: weekKey }, { $set: { week_key: weekKey, active: 1, activated_by: adminId, activated_at: new Date().toISOString() } }, { upsert: true });
}

async function resetSurveyForWeek(weekKey, adminId) {
  await initDb();
  const { responses, answers, surveyWindows } = getCollections();
  const respCursor = await responses.find({ week_key: weekKey }).toArray();
  const respIds = respCursor.map((r) => r._id);
  if (respIds.length > 0) {
    await answers.deleteMany({ response_id: { $in: respIds } });
    await responses.deleteMany({ week_key: weekKey });
  }
  await surveyWindows.updateOne({ week_key: weekKey }, { $set: { week_key: weekKey, active: 1, activated_by: adminId, activated_at: new Date().toISOString() } }, { upsert: true });
}

async function hasUserAnsweredWeek(userId, weekKey) {
  await initDb();
  const responses = getCollections().responses;
  const r = await responses.findOne({ user_id: userId, week_key: weekKey });
  return Boolean(r);
}

async function saveSurveyResponse(userId, weekKey, answersArr) {
  await initDb();
  const { responses, answers } = getCollections();
  const res = await responses.insertOne({ user_id: userId, week_key: weekKey, unique_user_week: `${userId}::${weekKey}`, submitted_at: new Date().toISOString() });
  const docs = answersArr.map((opt, i) => ({ response_id: res.insertedId, question_number: i + 1, option_value: opt }));
  if (docs.length) await answers.insertMany(docs);
}

async function getAllResponses() {
  await initDb();
  const { users, responses, answers } = getCollections();
  const allResponses = await responses.find({}).sort({ submitted_at: -1 }).toArray();
  const respIds = allResponses.map((r) => r._id);
  const allAnswers = await answers.find({ response_id: { $in: respIds } }).sort({ question_number: 1 }).toArray();
  const usersList = await users.find({}).toArray();
  const usersById = new Map(usersList.map((u) => [u._id.toString(), u.username]));
  const answersByResponse = new Map();
  allAnswers.forEach((a) => { const list = answersByResponse.get(a.response_id.toString()) || []; list.push(a); answersByResponse.set(a.response_id.toString(), list); });
  const rows = [];
  allResponses.forEach((r) => {
    const list = answersByResponse.get(r._id.toString()) || [];
    list.forEach((a) => rows.push({ response_id: r._id.toString(), week_key: r.week_key, submitted_at: r.submitted_at, username: usersById.get(r.user_id) || "desconocido", question_number: a.question_number, option_value: a.option_value }));
  });
  return rows;
}

async function getUserResponses(userId) {
  await initDb();
  const { responses, answers } = getCollections();
  const userResponses = await responses.find({ user_id: userId }).sort({ submitted_at: -1 }).toArray();
  const respIds = userResponses.map((r) => r._id);
  const allAnswers = respIds.length ? await answers.find({ response_id: { $in: respIds } }).sort({ question_number: 1 }).toArray() : [];
  const responseMap = new Map(userResponses.map((r) => [r._id.toString(), r]));
  const rows = [];
  allAnswers.forEach((a) => {
    const resp = responseMap.get(a.response_id.toString());
    if (!resp) return;
    rows.push({ response_id: resp._id.toString(), week_key: resp.week_key, submitted_at: resp.submitted_at, question_number: a.question_number, option_value: a.option_value });
  });
  rows.sort((a, b) => {
    if (a.submitted_at === b.submitted_at) return a.question_number - b.question_number;
    return a.submitted_at < b.submitted_at ? 1 : -1;
  });
  return rows;
}

async function getWeekResponses(weekKey) {
  await initDb();
  const { users, responses, answers } = getCollections();
  const weekResponses = await responses.find({ week_key: weekKey }).sort({ submitted_at: -1 }).toArray();
  const respIds = weekResponses.map((r) => r._id);
  const allAnswers = respIds.length ? await answers.find({ response_id: { $in: respIds } }).sort({ question_number: 1 }).toArray() : [];
  const usersList = await users.find({}).toArray();
  const usersById = new Map(usersList.map((u) => [u._id.toString(), u.username]));
  const answersByResponse = new Map();
  allAnswers.forEach((a) => { const list = answersByResponse.get(a.response_id.toString()) || []; list.push(a); answersByResponse.set(a.response_id.toString(), list); });
  const rows = [];
  weekResponses.forEach((r) => {
    const list = answersByResponse.get(r._id.toString()) || [];
    list.forEach((a) => rows.push({ username: usersById.get(r.user_id) || "desconocido", question_number: a.question_number, option_value: a.option_value }));
  });
  return rows;
}

module.exports = {
  initDb,
  CREDENTIALS_FILE,
  getUserByUsername,
  activateSurveyForWeek,
  resetSurveyForWeek,
  isSurveyActiveForWeek,
  hasUserAnsweredWeek,
  saveSurveyResponse,
  getAllResponses,
  getUserResponses,
  getWeekResponses
};
