const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const bcrypt = require("bcrypt");

const PASSWORD_SEED_VERSION = 2;
const CREDENTIALS_FILE = "(ver logs del servidor)";

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

let mongoClient;
let mongoDb;

async function getDb() {
  if (mongoDb) return mongoDb;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Falta la variable de entorno MONGODB_URI");
  mongoClient = new MongoClient(uri);
  await mongoClient.connect();
  mongoDb = mongoClient.db();
  await mongoDb.collection("users").createIndex({ username: 1 }, { unique: true });
  await mongoDb.collection("survey_windows").createIndex({ week_key: 1 }, { unique: true });
  await mongoDb.collection("responses").createIndex({ unique_user_week: 1 }, { unique: true });
  return mongoDb;
}

function newId() {
  return crypto.randomUUID();
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
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

function generateDeterministicPassword(username, seed, length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const hash = crypto.createHash("sha256").update(seed + ":" + username).digest();
  let out = "";
  for (let i = 0; i < hash.length && out.length < length; i += 1) {
    out += alphabet[hash[i] % alphabet.length];
  }
  return out;
}

function generatePassword(username) {
  const seed = process.env.PASSWORD_SEED;
  if (seed) return generateDeterministicPassword(username, seed);
  return generateRandomPassword();
}

let initialized = false;

async function initDb() {
  if (initialized) return;
  const db = await getDb();
  const users = db.collection("users");

  const generatedCredentials = [];

  for (const seed of DEFAULT_USERS) {
    const username = normalizeUsername(seed.username);
    const existing = await users.findOne({ username });
    const randomPassword = generatePassword(username);
    const passwordHash = bcrypt.hashSync(randomPassword, 10);

    if (existing) {
      if (existing.password_seed_version === PASSWORD_SEED_VERSION) continue;
      await users.updateOne(
        { username },
        { $set: { password_hash: passwordHash, role: seed.role, password_seed_version: PASSWORD_SEED_VERSION } }
      );
      generatedCredentials.push({ username, password: randomPassword });
      continue;
    }

    await users.insertOne({
      _id: newId(),
      username,
      password_hash: passwordHash,
      role: seed.role,
      password_seed_version: PASSWORD_SEED_VERSION,
      created_at: new Date().toISOString()
    });
    generatedCredentials.push({ username, password: randomPassword });
  }

  if (generatedCredentials.length > 0) {
    console.log("=== CREDENCIALES GENERADAS ===");
    generatedCredentials.forEach((e) => console.log(`  ${e.username} / ${e.password}`));
    console.log("==============================");
  }

  initialized = true;
}

async function getUserByUsername(username) {
  await initDb();
  const db = await getDb();
  const normalized = normalizeUsername(username);
  const user = await db.collection("users").findOne({ username: normalized });
  if (!user) return null;
  return { ...user, id: user._id };
}

async function isSurveyActiveForWeek(weekKey) {
  await initDb();
  const db = await getDb();
  const row = await db.collection("survey_windows").findOne({ week_key: weekKey });
  return Boolean(row && row.active === 1);
}

async function activateSurveyForWeek(weekKey, adminId) {
  await initDb();
  const db = await getDb();
  await db.collection("survey_windows").updateOne(
    { week_key: weekKey },
    { $set: { week_key: weekKey, active: 1, activated_by: adminId, activated_at: new Date().toISOString() } },
    { upsert: true }
  );
}

async function resetSurveyForWeek(weekKey, adminId) {
  await initDb();
  const db = await getDb();
  const responses = await db.collection("responses").find({ week_key: weekKey }).toArray();
  const responseIds = responses.map((r) => r._id);
  if (responseIds.length > 0) {
    await db.collection("answers").deleteMany({ response_id: { $in: responseIds } });
  }
  await db.collection("responses").deleteMany({ week_key: weekKey });
  await activateSurveyForWeek(weekKey, adminId);
}

async function hasUserAnsweredWeek(userId, weekKey) {
  await initDb();
  const db = await getDb();
  const row = await db.collection("responses").findOne({ user_id: userId, week_key: weekKey });
  return Boolean(row);
}

async function saveSurveyResponse(userId, weekKey, answers) {
  await initDb();
  const db = await getDb();
  const responseId = newId();
  await db.collection("responses").insertOne({
    _id: responseId,
    user_id: userId,
    week_key: weekKey,
    unique_user_week: `${userId}::${weekKey}`,
    submitted_at: new Date().toISOString()
  });

  for (let i = 0; i < answers.length; i += 1) {
    await db.collection("answers").insertOne({
      _id: newId(),
      response_id: responseId,
      question_number: i + 1,
      option_value: answers[i]
    });
  }
}

async function getAllResponses() {
  await initDb();
  const db = await getDb();
  const users = await db.collection("users").find({}).toArray();
  const usersById = new Map(users.map((u) => [u._id, u.username]));
  const responses = await db.collection("responses").find({}).sort({ submitted_at: -1 }).toArray();
  const responseIds = responses.map((r) => r._id);
  const answers = await db.collection("answers").find({ response_id: { $in: responseIds } }).sort({ question_number: 1 }).toArray();
  const answersByResponse = new Map();
  answers.forEach((a) => {
    const list = answersByResponse.get(a.response_id) || [];
    list.push(a);
    answersByResponse.set(a.response_id, list);
  });

  const rows = [];
  responses.forEach((response) => {
    const answerList = answersByResponse.get(response._id) || [];
    answerList.forEach((answer) => {
      rows.push({
        response_id: response._id,
        week_key: response.week_key,
        submitted_at: response.submitted_at,
        username: usersById.get(response.user_id) || "desconocido",
        question_number: answer.question_number,
        option_value: answer.option_value
      });
    });
  });
  return rows;
}

async function getUserResponses(userId) {
  await initDb();
  const db = await getDb();
  const responses = await db.collection("responses").find({ user_id: userId }).sort({ submitted_at: -1 }).toArray();
  const responseIds = responses.map((r) => r._id);
  const answers = await db.collection("answers").find({ response_id: { $in: responseIds } }).sort({ question_number: 1 }).toArray();
  const responseMap = new Map(responses.map((r) => [r._id, r]));

  const rows = [];
  answers.forEach((answer) => {
    const response = responseMap.get(answer.response_id);
    if (!response) return;
    rows.push({
      response_id: response._id,
      week_key: response.week_key,
      submitted_at: response.submitted_at,
      question_number: answer.question_number,
      option_value: answer.option_value
    });
  });

  rows.sort((a, b) => {
    if (a.submitted_at === b.submitted_at) return a.question_number - b.question_number;
    return a.submitted_at < b.submitted_at ? 1 : -1;
  });
  return rows;
}

async function getWeekResponses(weekKey) {
  await initDb();
  const db = await getDb();
  const users = await db.collection("users").find({}).toArray();
  const usersById = new Map(users.map((u) => [u._id, u.username]));
  const responses = await db.collection("responses").find({ week_key: weekKey }).sort({ submitted_at: -1 }).toArray();
  const responseIds = responses.map((r) => r._id);
  const answers = await db.collection("answers").find({ response_id: { $in: responseIds } }).sort({ question_number: 1 }).toArray();
  const answersByResponse = new Map();
  answers.forEach((a) => {
    const list = answersByResponse.get(a.response_id) || [];
    list.push(a);
    answersByResponse.set(a.response_id, list);
  });

  const rows = [];
  responses.forEach((response) => {
    const answerList = answersByResponse.get(response._id) || [];
    answerList.forEach((answer) => {
      rows.push({
        username: usersById.get(response.user_id) || "desconocido",
        question_number: answer.question_number,
        option_value: answer.option_value
      });
    });
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


const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..");

fs.mkdirSync(DATA_DIR, { recursive: true });

const usersDb = Datastore.create({
  filename: path.join(DATA_DIR, "db_users.json"),
  autoload: true
});
const surveyWindowsDb = Datastore.create({
  filename: path.join(DATA_DIR, "db_survey_windows.json"),
  autoload: true
});
const responsesDb = Datastore.create({
  filename: path.join(DATA_DIR, "db_responses.json"),
  autoload: true
});
const answersDb = Datastore.create({
  filename: path.join(DATA_DIR, "db_answers.json"),
  autoload: true
});

usersDb.ensureIndex({ fieldName: "username", unique: true });
surveyWindowsDb.ensureIndex({ fieldName: "week_key", unique: true });
responsesDb.ensureIndex({ fieldName: "unique_user_week", unique: true });

let initialized = false;
const PASSWORD_SEED_VERSION = 2;
const CREDENTIALS_FILE = path.join(DATA_DIR, "generated_credentials.txt");

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

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
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

function generateDeterministicPassword(username, seed, length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const hash = crypto.createHash("sha256").update(seed + ":" + username).digest();
  let out = "";
  for (let i = 0; i < hash.length && out.length < length; i += 1) {
    out += alphabet[hash[i] % alphabet.length];
  }
  return out;
}

function generatePassword(username) {
  const seed = process.env.PASSWORD_SEED;
  if (seed) {
    return generateDeterministicPassword(username, seed);
  }
  return generateRandomPassword();
}

function writeCredentialsFile(generated) {
  const lines = [
    "Credenciales generadas automaticamente",
    `Fecha: ${new Date().toISOString()}`,
    "",
    "IMPORTANTE: guarda estas claves en un lugar seguro.",
    ""
  ];

  generated.forEach((entry) => {
    lines.push(`${entry.username} / ${entry.password}`);
  });

  fs.writeFileSync(CREDENTIALS_FILE, `${lines.join("\n")}\n`, "utf8");
}

async function initDb() {
  if (initialized) {
    return;
  }

  const generatedCredentials = [];

  for (let i = 0; i < DEFAULT_USERS.length; i += 1) {
    const seed = DEFAULT_USERS[i];
    const username = normalizeUsername(seed.username);
    const existing = await usersDb.findOne({ username });

    const randomPassword = generatePassword(username);
    const passwordHash = bcrypt.hashSync(randomPassword, 10);

    if (existing) {
      if (existing.password_seed_version === PASSWORD_SEED_VERSION) {
        continue;
      }

      await usersDb.update(
        { _id: existing._id },
        {
          $set: {
            password_hash: passwordHash,
            role: seed.role,
            password_seed_version: PASSWORD_SEED_VERSION
          }
        }
      );

      generatedCredentials.push({ username, password: randomPassword });
      continue;
    }

    await usersDb.insert({
      username,
      password_hash: passwordHash,
      role: seed.role,
      password_seed_version: PASSWORD_SEED_VERSION,
      created_at: new Date().toISOString()
    });

    generatedCredentials.push({ username, password: randomPassword });
  }

  if (generatedCredentials.length > 0) {
    writeCredentialsFile(generatedCredentials);
    console.log("=== CREDENCIALES GENERADAS ===");
    generatedCredentials.forEach((entry) => {
      console.log(`  ${entry.username} / ${entry.password}`);
    });
    console.log("==============================");
  }

  initialized = true;
}

async function getUserByUsername(username) {
  await initDb();
  const normalized = normalizeUsername(username);
  const user = await usersDb.findOne({ username: normalized });
  if (!user) {
    return null;
  }
  return {
    ...user,
    id: user._id
  };
}

async function isSurveyActiveForWeek(weekKey) {
  await initDb();
  const row = await surveyWindowsDb.findOne({ week_key: weekKey });
  return Boolean(row && row.active === 1);
}

async function activateSurveyForWeek(weekKey, adminId) {
  await initDb();
  await surveyWindowsDb.update(
    { week_key: weekKey },
    {
      $set: {
        week_key: weekKey,
        active: 1,
        activated_by: adminId,
        activated_at: new Date().toISOString()
      }
    },
    { upsert: true }
  );
}

async function resetSurveyForWeek(weekKey, adminId) {
  await initDb();
  const responses = await responsesDb.find({ week_key: weekKey });
  for (const r of responses) {
    await answersDb.remove({ response_id: r._id }, { multi: true });
  }
  await responsesDb.remove({ week_key: weekKey }, { multi: true });
  await activateSurveyForWeek(weekKey, adminId);
}

async function hasUserAnsweredWeek(userId, weekKey) {
  await initDb();
  const row = await responsesDb.findOne({ user_id: userId, week_key: weekKey });
  return Boolean(row);
}

async function saveSurveyResponse(userId, weekKey, answers) {
  await initDb();

  const response = await responsesDb.insert({
    user_id: userId,
    week_key: weekKey,
    unique_user_week: `${userId}::${weekKey}`,
    submitted_at: new Date().toISOString()
  });

  for (let i = 0; i < answers.length; i += 1) {
    await answersDb.insert({
      response_id: response._id,
      question_number: i + 1,
      option_value: answers[i]
    });
  }
}

async function getAllResponses() {
  await initDb();

  const users = await usersDb.find({});
  const usersById = new Map(users.map((u) => [u._id, u.username]));
  const responses = await responsesDb.find({}).sort({ submitted_at: -1 });
  const answers = await answersDb.find({}).sort({ question_number: 1 });
  const answersByResponse = new Map();

  answers.forEach((a) => {
    const list = answersByResponse.get(a.response_id) || [];
    list.push(a);
    answersByResponse.set(a.response_id, list);
  });

  const rows = [];
  responses.forEach((response) => {
    const answerList = answersByResponse.get(response._id) || [];
    answerList.forEach((answer) => {
      rows.push({
        response_id: response._id,
        week_key: response.week_key,
        submitted_at: response.submitted_at,
        username: usersById.get(response.user_id) || "desconocido",
        question_number: answer.question_number,
        option_value: answer.option_value
      });
    });
  });

  return rows;
}

async function getUserResponses(userId) {
  await initDb();

  const responses = await responsesDb.find({ user_id: userId }).sort({ submitted_at: -1 });
  const responseIds = responses.map((r) => r._id);
  const answers = await answersDb.find({ response_id: { $in: responseIds } }).sort({ question_number: 1 });
  const responseMap = new Map(responses.map((r) => [r._id, r]));

  const rows = [];
  answers.forEach((answer) => {
    const response = responseMap.get(answer.response_id);
    if (!response) {
      return;
    }
    rows.push({
      response_id: response._id,
      week_key: response.week_key,
      submitted_at: response.submitted_at,
      question_number: answer.question_number,
      option_value: answer.option_value
    });
  });

  rows.sort((a, b) => {
    if (a.submitted_at === b.submitted_at) {
      return a.question_number - b.question_number;
    }
    return a.submitted_at < b.submitted_at ? 1 : -1;
  });

  return rows;
}

async function getWeekResponses(weekKey) {
  await initDb();
  const users = await usersDb.find({});
  const usersById = new Map(users.map((u) => [u._id, u.username]));
  const responses = await responsesDb.find({ week_key: weekKey }).sort({ submitted_at: -1 });
  const responseIds = responses.map((r) => r._id);
  const answers = await answersDb.find({ response_id: { $in: responseIds } }).sort({ question_number: 1 });
  const answersByResponse = new Map();

  answers.forEach((a) => {
    const list = answersByResponse.get(a.response_id) || [];
    list.push(a);
    answersByResponse.set(a.response_id, list);
  });

  const rows = [];
  responses.forEach((response) => {
    const answerList = answersByResponse.get(response._id) || [];
    answerList.forEach((answer) => {
      rows.push({
        username: usersById.get(response.user_id) || "desconocido",
        question_number: answer.question_number,
        option_value: answer.option_value
      });
    });
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
