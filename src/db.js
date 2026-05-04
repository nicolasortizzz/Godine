const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Datastore = require("nedb-promises");
const bcrypt = require("bcrypt");

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

    const randomPassword = generateRandomPassword();
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

module.exports = {
  initDb,
  CREDENTIALS_FILE,
  getUserByUsername,
  activateSurveyForWeek,
  isSurveyActiveForWeek,
  hasUserAnsweredWeek,
  saveSurveyResponse,
  getAllResponses,
  getUserResponses
};
