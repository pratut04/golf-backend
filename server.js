require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./db");

console.log("Db test Started");
(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ DB CONNECTED:", res.rows[0]);
  } catch (err) {
    console.error("❌ DB ERROR:", err);
  }
})();

const app = express();


// ✅ CORS FIX (FINAL)
app.use(cors({
  origin: "https://golf-frontend-mu.vercel.app",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

app.use(express.json());



// ✅ TEST ROUTE
app.get("/", (req, res) => {
  res.send("API running");
});


// ================== REGISTER ==================
app.post("/users", async (req, res) => {
  try {
    const { email, password } = req.body;

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (email, password) VALUES ($1, $2) RETURNING *",
      [email, hash]
    );

    res.json(result.rows[0]);

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Register failed" });
  }
});


// ================== LOGIN ==================
app.post("/login", async (req, res) => {
  try {
    console.log("BODY:", req.body); // 👈 DEBUG

    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    console.log("DB RESULT:", result.rows); // 👈 DEBUG

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = result.rows[0];

    console.log("USER:", user); // 👈 DEBUG

    let isMatch = false;

    if (!user.password) {
      throw new Error("Password missing in DB");
    }

    if (user.password.startsWith("$2b$")) {
      isMatch = await bcrypt.compare(password, user.password);
    } else {
      isMatch = password === user.password;
    }

    if (!isMatch) {
      return res.status(400).json({ error: "Wrong password" });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email
      }
    });

  } catch (err) {
    console.error("LOGIN ERROR FULL:", err); // 👈 VERY IMPORTANT
    res.status(500).json({ error: err.message });
  }
});
/* ================= USERS ================= */

app.get("/users", async (req, res) => {
  const result = await pool.query("SELECT id,email FROM users");
  res.json(result.rows);
});

/* ================= SCORES ================= */

app.post("/scores", async (req, res) => {
  const { user_id, score } = req.body;

  await pool.query(
    "INSERT INTO scores (user_id,score) VALUES ($1,$2)",
    [user_id, score]
  );

  res.json({ message: "Score added" });
});

app.get("/scores", async (req, res) => {
  const result = await pool.query("SELECT * FROM scores");
  res.json(result.rows);
});

/* ================= SUBSCRIBE ================= */

app.post("/subscribe", async (req, res) => {
  const { user_id } = req.body;

  const result = await pool.query(
    "UPDATE users SET subscription_status='active' WHERE id=$1 RETURNING *",
    [user_id]
  );

  res.json(result.rows[0]);
});

/* ================= CHARITIES ================= */

app.get("/charities", async (req, res) => {
  const result = await pool.query("SELECT * FROM charities");
  res.json(result.rows);
});

app.post("/select-charity", async (req, res) => {
  const { user_id, charity_id } = req.body;

  await pool.query(
    "UPDATE users SET charity_id=$1 WHERE id=$2",
    [charity_id, user_id]
  );

  res.json({ message: "Charity selected" });
});

/* ================= DASHBOARD ================= */

app.get("/dashboard/:id", async (req, res) => {
  const id = req.params.id;

  const user = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
  const scores = await pool.query("SELECT * FROM scores WHERE user_id=$1", [id]);

  res.json({
    user: user.rows[0],
    scores: scores.rows
  });
});

/* ================= DRAW ================= */

app.post("/draw", async (req, res) => {
  const number = Math.floor(Math.random() * 100);

  const result = await pool.query(
    "INSERT INTO draws (numbers) VALUES ($1) RETURNING *",
    [number]
  );

  res.json(result.rows[0]);
});

/* ================= RESULT ================= */

app.post("/check-result", async (req, res) => {
  const { user_id } = req.body;

  const draw = await pool.query(
    "SELECT * FROM draws ORDER BY id DESC LIMIT 1"
  );

  const scores = await pool.query(
    "SELECT * FROM scores WHERE user_id=$1",
    [user_id]
  );

  let win = false;

  scores.rows.forEach(s => {
    if (s.score === draw.rows[0].numbers) win = true;
  });

  res.json({
    result: win ? "WIN 🎉" : "LOSE 😢",
    number: draw.rows[0].numbers
  });
});

/* ================= LEADERBOARD ================= */

app.get("/leaderboard", async (req, res) => {
  const result = await pool.query(`
    SELECT u.email, MAX(s.score) as best_score
    FROM scores s
    JOIN users u ON u.id = s.user_id
    GROUP BY u.email
    ORDER BY best_score DESC
    LIMIT 5
  `);

  res.json(result.rows);
});

/* ================= SERVER ================= */

app.listen(5000, () => console.log("Server running 🚀"));
