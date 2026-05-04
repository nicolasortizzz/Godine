const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");

const { requireAuth, requireAdmin } = require("./auth");
const {
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
} = require("./db");
const { VALID_OPTIONS, QUESTION_COUNT, QUESTIONS } = require("./constants");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "cambia-esto-en-produccion",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
  })
);

function getWeekKey(date = new Date()) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

function historyToCsv(rows, includeUsername) {
  const header = includeUsername
    ? ["usuario", "semana", "fecha", "pregunta", "opcion"]
    : ["semana", "fecha", "pregunta", "opcion"];

  const lines = [header.map(escapeCsvValue).join(",")];

  rows.forEach((row) => {
    const base = [row.week_key, row.submitted_at, row.question_number, row.option_value];
    const values = includeUsername ? [row.username, ...base] : base;
    lines.push(values.map(escapeCsvValue).join(","));
  });

  return `${lines.join("\n")}\n`;
}

async function buildDashboardState(user) {
  const weekKey = getWeekKey();
  const active = await isSurveyActiveForWeek(weekKey);
  const alreadyAnswered = await hasUserAnsweredWeek(user.id, weekKey);

  return {
    weekKey,
    active,
    alreadyAnswered,
    canAnswer: active && !alreadyAnswered
  };
}

app.get("/", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  return res.redirect("/dashboard");
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  return res.render("login", { error: null });
});

app.post("/login", async (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = await getUserByUsername(username);

  if (!user) {
    return res.status(401).render("login", { error: "Usuario o contraseña inválidos" });
  }

  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) {
    return res.status(401).render("login", { error: "Usuario o contraseña inválidos" });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role
  };

  return res.redirect("/dashboard");
});

app.post("/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/dashboard", requireAuth, async (req, res) => {
  const user = req.session.user;
  const state = await buildDashboardState(user);
  const weekRows = await getWeekResponses(state.weekKey);

  let historyRows = [];
  if (user.role === "admin") {
    historyRows = await getAllResponses();
  } else {
    historyRows = await getUserResponses(user.id);
  }

  return res.render("dashboard", {
    user,
    state,
    weekRows,
    historyRows
  });
});

app.get("/export-week", requireAuth, async (req, res) => {
  const user = req.session.user;
  const weekKey = getWeekKey();
  const rows = await getWeekResponses(weekKey);
  const showUsername = user.role === "admin";

  const header = showUsername ? ["usuario", "pregunta", "opcion"] : ["pregunta", "opcion"];
  const lines = [header.map(escapeCsvValue).join(",")];
  rows.forEach((row) => {
    const values = showUsername
      ? [row.username, row.question_number, row.option_value]
      : [row.question_number, row.option_value];
    lines.push(values.map(escapeCsvValue).join(","));
  });
  const csv = `${lines.join("\n")}\n`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=semana_${weekKey}.csv`);
  return res.send(csv);
});

app.get("/export-history", requireAuth, async (req, res) => {
  const user = req.session.user;
  const rows = user.role === "admin"
    ? await getAllResponses()
    : await getUserResponses(user.id);

  const csv = historyToCsv(rows, user.role === "admin");
  const dateTag = new Date().toISOString().slice(0, 10);
  const scope = user.role === "admin" ? "global" : user.username;
  const filename = `historial_${scope}_${dateTag}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  return res.send(csv);
});

app.get("/survey", requireAuth, async (req, res) => {
  const user = req.session.user;
  const state = await buildDashboardState(user);

  if (!state.active) {
    return res.status(403).send("La encuesta no está activa esta semana.");
  }

  if (state.alreadyAnswered) {
    return res.status(403).send("Ya respondiste la encuesta esta semana.");
  }

  return res.render("survey", {
    user,
    weekKey: state.weekKey,
    options: VALID_OPTIONS,
    questions: QUESTIONS,
    error: null,
    oldAnswers: {}
  });
});

app.post("/survey", requireAuth, async (req, res) => {
  const user = req.session.user;
  const state = await buildDashboardState(user);

  if (!state.active) {
    return res.status(403).send("La encuesta no está activa esta semana.");
  }

  if (state.alreadyAnswered) {
    return res.status(403).send("Ya respondiste la encuesta esta semana.");
  }

  const answers = [];
  const oldAnswers = {};

  for (let i = 1; i <= QUESTION_COUNT; i += 1) {
    const key = `q${i}`;
    const value = req.body[key];
    oldAnswers[key] = value;

    if (!VALID_OPTIONS.includes(value)) {
      return res.status(400).render("survey", {
        user,
        weekKey: state.weekKey,
        options: VALID_OPTIONS,
        questions: QUESTIONS,
        error: "Debes seleccionar una opción válida en todas las preguntas.",
        oldAnswers
      });
    }

    answers.push(value);
  }

  const uniqueAnswers = new Set(answers);
  if (uniqueAnswers.size !== QUESTION_COUNT) {
    return res.status(400).render("survey", {
      user,
      weekKey: state.weekKey,
      options: VALID_OPTIONS,
      questions: QUESTIONS,
      error: "No puedes repetir nombres. Debes elegir 7 personas distintas.",
      oldAnswers
    });
  }

  try {
    await saveSurveyResponse(user.id, state.weekKey, answers);
  } catch (err) {
    return res.status(409).render("survey", {
      user,
      weekKey: state.weekKey,
      options: VALID_OPTIONS,
      questions: QUESTIONS,
      error: "No se pudo guardar. Es posible que ya respondieras esta semana.",
      oldAnswers
    });
  }

  return res.render("survey_success", { weekKey: state.weekKey });
});

app.get("/admin", requireAdmin, async (req, res) => {
  const weekKey = getWeekKey();
  const active = await isSurveyActiveForWeek(weekKey);
  return res.render("admin", {
    weekKey,
    active,
    message: null,
    error: null
  });
});

app.post("/admin/activate", requireAdmin, async (req, res) => {
  const weekKey = getWeekKey();
  const wasActive = await isSurveyActiveForWeek(weekKey);

  await resetSurveyForWeek(weekKey, req.session.user.id);

  const msg = wasActive
    ? "Encuesta reiniciada correctamente. Todos los usuarios pueden volver a responder."
    : "Encuesta activada correctamente para esta semana.";

  return res.render("admin", {
    weekKey,
    active: true,
    message: msg,
    error: null
  });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    console.log(`Credenciales iniciales disponibles en: ${CREDENTIALS_FILE}`);
  });
});
